// Offline regression tests: never import index.js, log in, or contact a provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bebot-regression-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = path.join(tmp, 'engine');
process.env.BEBOT_DATA_DIR = path.join(tmp, 'stats');
process.env.YTDLP_PATH = '/not-used/offline-fixture';
process.env.YOUTUBE_FALLBACK = 'off';
// Offline fixtures must not inherit private authentication from the deployment.
delete process.env.YOUTUBE_COOKIES;
delete process.env.COOKIES_FILE;
const require = createRequire(import.meta.url);
const dt = require('distube');
const { StreamRelay } = require('../beatra_engine/src/music/relay.js');
const plugins = require('../beatra_engine/src/music/plugins.js');
const { RecentTracks, titleKey } = require('../beatra_engine/src/music/recommendations.js');
const diag = require('../beatra_engine/src/core/diagnostics.js');
const { createMusicManager } = await import('../music.js');
const { buildNowPlayingEmbed, buildRequestEmbed, announceNowPlaying } = await import('../music_embeds.js');
const { MusicSessions } = await import('../music_session.js');
const { instrumentMusic } = await import('../music_runtime.js');
const { matchesAlternative, configureSoundCloud, bounded } = await import('../music_sources.js');
const { commandsJSON } = await import('../commands.js');
const tests = [], results = [], audio = [];
const test = (group, name, fn) => tests.push({ group, name, fn });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const waitFor = async check => { for (let i=0;i<100;i++) { if(check()) return; await delay(5); } throw Error('Test condition timed out'); };
const gid = '123456789012345678', vid = '123456789012345679';
const song = (name = 'Example Artist Example Song', id = 'abcdefghijk') => new dt.Song({ id, name, source: 'youtube',
  url: `https://www.youtube.com/watch?v=${id}`, duration: 240, playFromSource: true, uploader: { name: 'Example Artist' } });
const recommendationRunner = (entries, onMix = () => {}) => async target => {
  if (target.includes('&list=')) { onMix(target); return {entries}; }
  const entry=entries.find(e=>e.id===new URL(target).searchParams.get('v'));
  if(!entry)throw Error('Unexpected extraction');
  return {...entry,url:'https://example.invalid/audio',format_id:'251'};
};

function fakeSpawn(mode) {
  let child;
  return { get child() { return child; }, spawn() {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.killed = false;
    const end = code => { if (child.killed) return; child.exitCode = code; child.stdout.end(); child.stderr.end(); child.emit('close', code, null); };
    child.kill = () => { if(child.killed) return; child.killed = true; child.stdout.end(); child.stderr.end(); child.emit('close', null, 'SIGKILL'); };
    setImmediate(() => {
      if (child.killed) return;
      if (mode === 'empty') return end(0);
      if (mode === 'refuse') { child.stderr.write('ERROR: HTTP Error 403: Forbidden'); return end(1); }
      if (mode === 'silent') return;
      child.stdout.write(Buffer.from('audio-bytes'));
      if (mode === 'complete') setTimeout(() => end(0), 25);
      if (mode === 'partial') setTimeout(() => { if(child.killed) return; child.stderr.write('ERROR: HTTP Error 403: Forbidden'); end(1); }, 50);
    });
    return child;
  } };
}
let serial=0;
function relayFixture(mode) { const f = fakeSpawn(mode); return { f, r: new StreamRelay({ dir:path.join(tmp, `relay-${serial++}`), spawnImpl:f.spawn }) }; }
for (const mode of ['complete','partial','empty','refuse']) test('relay', `${mode} stream has the correct HTTP and terminal outcome`, async () => {
  const {r,f}=relayFixture(mode);
  try {
    const u=await r.register({url:'https://example.invalid/fixture',attemptId:'fixture'});
    if (['empty','refuse'].includes(mode)) {
      await assert.rejects(r.warm(u), mode==='empty' ? /no audio/ : /403/);
      assert.equal(r.resultFor(u).outcome,'failed'); assert.ok(r.errorFor(u));
    } else {
      await r.warm(u);
      if(mode==='complete') { const res=await fetch(u); assert.equal(await res.text(),'audio-bytes'); assert.equal(r.resultFor(u).outcome,'completed'); }
      else { await assert.rejects(async()=>{const res=await fetch(u); await res.text();}); assert.equal(r.resultFor(u).outcome,'failed'); assert.match(r.errorFor(u).message,/403/); }
    }
    assert.equal(r.downloads.size,0); assert.notEqual(f.child.exitCode,null);
  } finally {r.close();}
});
test('relay','small download completed before FFmpeg attaches still drains all bytes',async()=>{
  const {r}=relayFixture('complete');try{const u=await r.register({url:'https://example.invalid/a'});await r.warm(u);await delay(50);assert.equal(await (await fetch(u)).text(),'audio-bytes');}finally{r.close();}
});
test('relay','cancellation before first byte promptly rejects and removes private info file',async()=>{
  const {r,f}=relayFixture('silent'); const ac=new AbortController();
  try { const u=await r.register({info:{url:'https://example.invalid/a?sig=private',format_id:'251'},signal:ac.signal});
    const file=[...r.entries.values()][0].infoFile;assert.equal(fs.statSync(file).mode&0o777,0o600);
    const warming=r.warm(u);ac.abort();await assert.rejects(warming,{name:'AbortError'});
    await waitFor(()=>!fs.existsSync(file));assert.equal(f.child.killed,true);assert.equal(r.entries.size,0);assert.equal(r.downloads.size,0);
  }finally{r.close();}
});
test('relay','cancellation during HTTP delivery terminates downloader and response',async()=>{
  const {r,f}=relayFixture('hold');const ac=new AbortController();try{const u=await r.register({url:'https://example.invalid/a',signal:ac.signal});await r.warm(u);const res=await fetch(u);ac.abort();await assert.rejects(res.text());assert.equal(f.child.killed,true);assert.equal(r.downloads.size,0);}finally{r.close();}
});
test('relay','warm timeout, unused warm hold and close kill subprocesses',async()=>{
  for(const mode of ['silent','hold']){const {r,f}=relayFixture(mode);try{const u=await r.register({url:'https://example.invalid/a'});if(mode==='silent')await assert.rejects(r.warm(u,{timeoutMs:20}),/No audio/);else{await r.warm(u,{holdMs:20});await delay(40);}assert.equal(f.child.killed,true);}finally{r.close();}}
  const {r,f}=relayFixture('hold');const u=await r.register({url:'https://example.invalid/a'});await r.warm(u);const res=await fetch(u);r.close();await assert.rejects(res.text());assert.equal(f.child.killed,true);assert.equal(r.downloads.size,0);assert.equal(r.entries.size,0);assert.equal(fs.existsSync(r.dir),false);
});
test('relay','consumer disconnect and duplicate close leave no downloader',async()=>{
  const {r,f}=relayFixture('hold');const u=await r.register({url:'https://example.invalid/a'});await r.warm(u);const res=await fetch(u);await res.body.cancel();await waitFor(()=>f.child.killed);r.close();r.close();assert.equal(r.downloads.size,0);await assert.rejects(r.register({url:'x'}),/closed/);
});
test('relay','downloader spawn error and failed warm registration are cleaned',async()=>{
  const r=new StreamRelay({dir:path.join(tmp,'missing-binary'),binary:'/missing/yt-dlp'});
  try{await assert.rejects(plugins.relayStream(r,{url:'https://example.invalid/a'}),/ENOENT/);assert.equal(r.entries.size,0);assert.equal(r.downloads.size,0);}finally{r.close();}
});
test('relay','actual FFmpeg decodes complete and interrupted synthetic WAV streams',async()=>{
  const ff=process.env.TEST_FFMPEG_PATH || '/usr/bin/ffmpeg'; const wav=path.join(tmp,'tone.wav');
  const gen=spawnSync(ff,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2','-ar','48000','-ac','2','-y',wav]);assert.equal(gen.status,0,'A local FFmpeg binary is required for this integration test');
  const fixture=path.join(tmp,'download.cjs');fs.writeFileSync(fixture,"const fs=require('node:fs');const b=fs.readFileSync(process.argv[2]);const partial=process.argv[3]==='partial';process.stdout.write(partial?b.subarray(0,Math.floor(b.length/2)):b,()=>setTimeout(()=>{if(partial)process.stderr.write('ERROR: synthetic interrupted download\\n');process.exit(partial?1:0);},100));");
  for(const mode of ['full','partial']){
    let child;const r=new StreamRelay({dir:path.join(tmp,'real-'+mode),spawnImpl:()=>child=spawn(process.execPath,[fixture,wav,mode],{stdio:['ignore','pipe','pipe']})});
    try{const u=await r.register({url:'https://example.invalid/synthetic',attemptId:'audio-'+mode});await r.warm(u);
      const output=await new Promise((resolve,reject)=>{let bytes=0;const f=spawn(ff,['-v','error','-reconnect','0','-reconnect_streamed','0','-i',u,'-ar','48000','-ac','2','-f','s16le','pipe:1']);f.stdout.on('data',b=>bytes+=b.length);f.stderr.resume();f.on('error',reject);f.on('close',code=>resolve({code,bytes}));});
      if(mode==='full'){assert.equal(output.code,0);assert.equal(output.bytes,384000);assert.equal(r.resultFor(u).outcome,'completed');}
      else{assert.ok(output.bytes<384000);assert.equal(r.resultFor(u).outcome,'failed');assert.match(r.errorFor(u).message,/interrupted/);}
      assert.equal(r.downloads.size,0);audio.push({mode,ffmpegExit:output.code,decodedBytes:output.bytes,decodedSeconds:output.bytes/192000,downloaderExit:child.exitCode,relayOutcome:r.resultFor(u).outcome});
    }finally{r.close();}
  }
});

function harness({resolve,attach,join,recommendations}={}) {
  const player=new EventEmitter();player.setMaxListeners(1);let creates=0,plays=0,left=0;
  player.options={ffmpeg:{path:'/usr/bin/ffmpeg',args:{}},savePreviousSongs:false};player.debug=()=>{};
  player.emitError=(e,q,s)=>player.emit('error',e,q,s);
  const voice=new EventEmitter(); const channel={id:vid,guildId:gid,type:2,permissionsFor:()=>({has:()=>true})};
  channel.guild={id:gid,members:{me:{voice:{channel}}}};
  Object.assign(voice,{id:gid,channelId:vid,channel,join:async()=>{if(join)await join();},audioPlayer:new EventEmitter(),connection:new EventEmitter(),playbackTime:0});
  voice.audioPlayer.state={status:'idle'};voice.connection.state={status:'ready'};
  voice.play=async stream=>{plays++;voice.stream=stream;voice.audioPlayer.state={status:'playing',resource:stream.audioResource};}; // no subprocess/network in command tests
  voice.stop=()=>{if(voice.audioPlayer.state.status!=='idle'){voice.audioPlayer.state={status:'idle'};voice.emit('finish');}};
  voice.pause=()=>{voice.audioPlayer.state.status='paused';};voice.unpause=()=>{voice.audioPlayer.state.status='playing';};
  let joined=false;
  player.voices={create:()=>{creates++;joined=true;return voice;},get:()=>joined?voice:undefined,leave:()=>{left++;joined=false;voice.stream?.kill();}};
  const actualHandler=new dt.DisTubeHandler(player);
  player.handler={resolve:async(q,o)=>{
    if(q instanceof dt.Song || q instanceof dt.Playlist) return actualHandler.resolve(q,o);
    const s=resolve?await resolve(q,o):song(q);s.metadata=o.metadata;return s;
  },attachStreamInfo:async s=>{if(attach)await attach(s);s.stream.url='http://127.0.0.1:9/unused';}};
  player.queues=new dt.QueueManager(player);player.getQueue=id=>player.queues.get(id);
  player.play=dt.DisTube.prototype.play.bind(player);
  const relay={errorFor:()=>null,discard(){},close(){}};
  const manager=createMusicManager({},{engineFactory:async()=>({instance:player,relay}),statsFactory:()=>({flush(){}}),recommendations});
  const interaction=(command='play',query='Example Artist Example Song',voiceId=vid)=>{
    const replies=[];const user={id:'123456789012345680'};const member={id:user.id,user,guild:channel.guild,voice:{channelId:voiceId,channel:{...channel,id:voiceId}}};
    return {commandName:command,guildId:gid,user,guild:{members:{me:{},fetch:async()=>member}},channel:{id:'123456789012345681',guildId:gid,type:0,nsfw:false,isThread:()=>false,send:async()=>{}},memberPermissions:{has:()=>false},inGuild:()=>true,
      options:{getString:()=>query,getInteger:()=>1},replies,reply:async x=>replies.push(x),editReply:async x=>replies.push(x),deferReply:async()=>{}};
  };
  return {manager,player,voice,interaction,counts:()=>({creates,plays,left})};
}
test('queue','simultaneous plays create one real DisTube queue and one listener set',async()=>{
  const gate=deferred();const h=harness({join:()=>gate.promise});
  try{const a=h.interaction('play','First requested song'),b=h.interaction('play','Second requested song');const pa=h.manager.play(a),pb=h.manager.play(b);await waitFor(()=>h.counts().creates===1);gate.resolve();await Promise.all([pa,pb]);
    assert.equal(h.counts().creates,1);assert.equal(h.voice.listenerCount('finish'),1);assert.equal(h.player.getQueue(gid).songs.length,2);assert.match(a.replies.at(-1).embeds[0].data.description,/First requested song/);assert.match(b.replies.at(-1).embeds[0].data.description,/Second requested song/);
  }finally{gate.resolve();await h.manager.close();}
});
for(const command of ['stop','leave'])test('queue',`${command} cancels pending metadata and queued requests; late result cannot revive`,async()=>{
  const gate=deferred();let resolutions=0;const h=harness({resolve:async q=>{resolutions++;await gate.promise;return song(q);}});
  try{const a=h.manager.play(h.interaction()),b=h.manager.play(h.interaction());await waitFor(()=>resolutions===1);const stop=h.interaction(command);if(command==='stop')await h.manager.stop(stop);else await h.manager.control(stop);gate.resolve();await Promise.all([a,b]);await delay(10);
    assert.equal(h.counts().plays,0);assert.equal(h.counts().creates,0);assert.equal(resolutions,1);assert.match(stop.replies.at(-1),/Stopped/);
    // Explicit NEW requests after cancellation work.
    await h.manager.play(h.interaction());assert.equal(h.counts().plays,1);
  }finally{gate.resolve();await h.manager.close();}
});
test('queue','stop during delayed voice join prevents late stream dispatch',async()=>{
  const gate=deferred();const h=harness({join:()=>gate.promise});try{const play=h.manager.play(h.interaction());await waitFor(()=>h.counts().creates===1);const stopped=h.manager.stop(h.interaction('stop'));await delay(5);gate.resolve();await Promise.all([play,stopped]);await delay(10);assert.equal(h.counts().plays,0);assert.equal(h.player.getQueue(gid),undefined);assert.equal(h.voice.listenerCount('finish'),0);}finally{gate.resolve();await h.manager.close();}
});
test('queue','skip during stream extraction refuses mutation; stop aborts extraction',async()=>{
  let entered=false;const h=harness({attach:s=>{entered=true;return bounded(()=>new Promise(()=>{}),s._bebotSignal);}});
  try{const play=h.manager.play(h.interaction());await waitFor(()=>entered);const i=h.interaction('skip');await h.manager.control(i);assert.match(i.replies.at(-1).content,/still loading/);assert.equal(h.player.getQueue(gid).songs.length,1);await h.manager.stop(h.interaction('stop'));await play;assert.equal(h.counts().plays,0);assert.equal(h.player.getQueue(gid),undefined);}finally{await h.manager.close();}
});
test('queue','skip and next each advance exactly once, including final track',async()=>{
  const h=harness();try{await h.manager.play(h.interaction('play','First song'));await h.manager.play(h.interaction('play','Second song'));await h.manager.play(h.interaction('play','Third song'));await h.manager.control(h.interaction('skip'));await waitFor(()=>h.counts().plays===2);assert.equal(h.player.getQueue(gid).songs[0].name,'Second song');await h.manager.control(h.interaction('next'));await waitFor(()=>h.counts().plays===3);assert.equal(h.player.getQueue(gid).songs[0].name,'Third song');await h.manager.control(h.interaction('skip'));assert.equal(h.player.getQueue(gid),undefined);}finally{await h.manager.close();}
});
test('queue','real DisTube failure event cannot yield a success-style play reply',async()=>{
  const h=harness({attach:async()=>{throw Error('HTTP 403');}});try{const i=h.interaction();await h.manager.play(i);assert.match(i.replies.at(-1).content,/could not be completed/);assert.equal(h.counts().plays,0);await delay(5);assert.equal(h.player.getQueue(gid),undefined);}finally{await h.manager.close();}
});
test('queue','failed queued track advances to the following song without app double-skip',async()=>{
  const h=harness({attach:async s=>{if(s.name==='Bad song')throw Error('403');}});try{await h.manager.play(h.interaction('play','First song'));await h.manager.play(h.interaction('play','Bad song'));await h.manager.play(h.interaction('play','Last song'));h.voice.stop();await waitFor(()=>h.counts().plays===2);assert.equal(h.player.getQueue(gid).songs[0].name,'Last song');assert.equal(h.player.getQueue(gid).songs.length,1);}finally{await h.manager.close();}
});
test('queue','voice disconnect invalidates queued attempt signals and removes listeners',async()=>{
  const h=harness();try{await h.manager.play(h.interaction());const old=h.player.getQueue(gid).songs[0].metadata.signal;h.voice.emit('disconnect');await delay(5);assert.equal(old.aborted,true);assert.equal(h.player.getQueue(gid),undefined);assert.equal(h.voice.listenerCount('finish'),0);assert.equal(h.voice.audioPlayer.listenerCount('stateChange'),0);}finally{await h.manager.close();}
});
test('queue','permissions reject other voice channels and unauthorized stop/skip',async()=>{
  const h=harness();try{await h.manager.play(h.interaction());const p=h.interaction('play','Other song','999999999999999999');await h.manager.play(p);assert.match(p.replies.at(-1).content,/could not be completed/);const s=h.interaction('stop','x','999999999999999999');await h.manager.stop(s);assert.match(s.replies.at(-1),/Join the bot/);const k=h.interaction('skip','x','999999999999999999');await h.manager.control(k);assert.match(k.replies.at(-1),/Join my voice/);assert.equal(h.player.getQueue(gid).songs.length,1);}finally{await h.manager.close();}
});
test('queue','pause, resume, empty queue and pagination keep their existing behavior',async()=>{
  const h=harness();try{const empty=h.interaction('queue');await h.manager.control(empty);assert.match(empty.replies.at(-1).content,/empty/);await h.manager.play(h.interaction());await h.manager.control(h.interaction('pause'));assert.equal(h.player.getQueue(gid).paused,true);await h.manager.control(h.interaction('resume'));assert.equal(h.player.getQueue(gid).paused,false);const p=h.interaction('queue');p.options.getInteger=()=>2;await h.manager.control(p);assert.match(p.replies.at(-1).content,/does not exist/);}finally{await h.manager.close();}
});
test('queue','bounded lookup ignores late resolution after cancellation',async()=>{
  const gate=deferred(),ac=new AbortController();const p=bounded(()=>gate.promise,ac.signal);ac.abort();await assert.rejects(p,{name:'AbortError'});gate.resolve('late');await delay(0);
});
test('queue','pending requests are bounded and rejected task does not poison lock',async()=>{
  const s=new MusicSessions({maxPending:1});const gate=deferred();s.reserve(gid,vid);const p=s.run(gid,()=>gate.promise);assert.throws(()=>s.reserve(gid,vid),/Too many/);gate.resolve();await p;await assert.rejects(s.run(gid,()=>{throw Error('fixture');}));assert.equal(await s.run(gid,()=>42),42);await s.close();assert.throws(()=>s.reserve(gid,vid),/shutting down/);
});

for(const value of [undefined,'off','false','soundcloud'])test('fallback',`fallback setting ${String(value)} is explicit and defaults off`,()=>{
  const env={...process.env};if(value===undefined)delete env.YOUTUBE_FALLBACK;else env.YOUTUBE_FALLBACK=value;
  const r=spawnSync(process.execPath,['-e',"console.log(require('./beatra_engine/src/config.js').youtubeFallback)"],{cwd:root,env,encoding:'utf8'});assert.equal(r.status,0);assert.equal(r.stdout.trim(),String(value==='soundcloud'));
});
test('fallback','disabled YouTube fallback exposes original refusal without substitution',async()=>{
  const yt=new plugins.YouTubePlugin({runner:async()=>{throw Error("Sign in to confirm you're not a bot");},relay:{},fallback:null});await assert.rejects(yt.searchSong('Example Song'),/Sign in/);const s=song();s.plugin=yt;await assert.rejects(yt.getStreamURL(s),/Sign in/);
});
test('fallback','matching rejects unrelated, cover, ambiguous and duration-mismatched tracks',()=>{
  const s={name:'Example Artist Example Song',uploader:{name:'Example Artist'},duration:240};assert.equal(matchesAlternative('Example Artist Example Song',s),true);
  for(const candidate of [{...s,name:'Unrelated song',uploader:{name:'Someone'}},{...s,name:s.name+' cover'},{...s,duration:30},{...s,duration:100}])assert.equal(matchesAlternative('Example Artist Example Song',candidate,{name:'Example Song',artist:'Example Artist',duration:240}),false);
  assert.equal(matchesAlternative('Style',{name:'Style',duration:240}),false);
});
function scFixture(track,mediaUrl='https://cdn.example.invalid/full') {let downloads=0;const sc={relay:{},searchSong:async()=>({name:'Example Artist Example Song',duration:240}),soundcloud:{util:{resolveTrack:async()=>track,getStreamLink:async()=>mediaUrl}}};configureSoundCloud(sc,{relayStream:async()=>{downloads++;return 'http://127.0.0.1/fixture';},proxyFor:()=>null});return {sc,downloads:()=>downloads};}
const fullTrack=()=>({policy:'ALLOW',streamable:true,duration:240000,full_duration:240000,media:{transcodings:[{snipped:false,duration:240000,format:{protocol:'hls'},preset:'opus_0_0',url:'https://api.example.invalid/media'}]}});
test('fallback','full-length SoundCloud transcode uses relay',async()=>{const h=scFixture(fullTrack());assert.match(await h.sc.getStreamURL(song()),/127.0.0.1/);assert.equal(h.downloads(),1);});
for(const mode of ['preview','drm','drm-flag','policy','unknown','opaque-preview'])test('fallback',`SoundCloud ${mode} rejected before any download`,async()=>{
  const track=fullTrack();if(mode==='preview'){track.media.transcodings[0].duration=30000;track.media.transcodings[0].snipped=true;}if(mode==='drm')track.media.transcodings[0].preset='encrypted_drm';if(mode==='drm-flag')track.media.transcodings[0].drm=true;if(mode==='policy')track.policy='SNIP';if(mode==='unknown')delete track.media.transcodings[0].snipped;
  const h=scFixture(track,mode==='opaque-preview'?'https://cdn.example.invalid/preview/audio':'https://cdn.example.invalid/full');await assert.rejects(h.sc.getStreamURL(song()));assert.equal(h.downloads(),0);
});
test('fallback','enabled stream alternative replaces metadata with actual selected source',async()=>{
  const alternative=song('Example Artist Example Song');alternative.source='soundcloud';alternative.duration=239;const fallback={searchSong:async()=>alternative,getStreamURL:async()=> 'http://127.0.0.1/alternative'};
  const yt=new plugins.YouTubePlugin({runner:async()=>{throw Error('403');},relay:{},fallback});const s=song();s.plugin=yt;await yt.getStreamURL(s);assert.equal(s.source,'soundcloud');assert.equal(s.duration,239);assert.equal(s.plugin,fallback);
});
test('fallback','expired cache TTL is zero and failed relay invalidates extraction cache',async()=>{
  assert.equal(plugins.streamTtl('https://cdn.example.invalid/a?expire=1'),0);let extracts=0,discarded=0;
  const yt=new plugins.YouTubePlugin({runner:async()=>{extracts++;return {id:'abcdefghijk',url:'https://cdn.example.invalid/a',format_id:'251'};},relay:{register:async()=> 'relay',warm:async()=>{throw Error('403');},discard:()=>discarded++}});const s=song();s.plugin=yt;await assert.rejects(yt.getStreamURL(s));await assert.rejects(yt.getStreamURL(s));assert.equal(extracts,2);assert.equal(discarded,2);
});
test('fallback','autoplay still requests recommendations related to the seed',async()=>{let target;const yt=new plugins.YouTubePlugin({runner:recommendationRunner([{id:'abcdefghijk',duration:240},{id:'bbbbbbbbbbb',duration:200},{id:'ccccccccccc',duration:30}],t=>target=t),relay:{}});const list=await yt.getRelatedSongs(song());assert.match(target,/list=RDabcdefghijk/);assert.deepEqual(list.map(s=>s.id),['bbbbbbbbbbb']);});

test('diagnostics','redaction removes secrets, proxies and signed URLs; object dumps are dropped',()=>{
  process.env.TEST_SECRET='secret-fixture-only';const raw='secret-fixture-only https://cdn.example.invalid/a?sig=private socks5://u:p@proxy.invalid';const clean=diag.redact(raw);assert.ok(!clean.includes('secret-fixture-only'));assert.ok(!clean.includes('sig='));assert.ok(!clean.includes('u:p'));
  assert.ok(!diag.redact('Authorization: Bearer other-sensitive-value').includes('other-sensitive-value'));
  assert.ok(!diag.redact('Cookie: a=one; b=two').includes('two'));
  const lines=[],log=console.log;try{console.log=x=>lines.push(x);diag.event('playback',{stage:'test',attemptId:'fixture',mediaUrl:raw,metadata:{secret:raw},reason:raw});}finally{console.log=log;delete process.env.TEST_SECRET;}
  assert.equal(lines.length,1);const data=JSON.parse(lines[0]);assert.equal(data.mediaUrl,undefined);assert.equal(data.metadata,undefined);assert.ok(!lines[0].includes('sig='));
});
test('diagnostics','interrupted relay is reported as failed even after normal DisTube finish event',()=>{
  const player=new EventEmitter();player.handler={attachStreamInfo:async()=>{}};const events=[];const rt=instrumentMusic(player,{sessions:new MusicSessions(),relay:{errorFor:()=>Error('403'),discard(){}},report:(_n,f)=>events.push(f)});const s=song();rt.prepare(s,{guildId:gid});player.emit('finishSong',{id:gid},s);player.emit('finishSong',{id:gid},s);assert.equal(events.length,1);assert.equal(events[0].outcome,'failed');assert.equal(events[0].reason,'HTTP_403');assert.ok(events[0].attemptId);rt.close();
});
test('diagnostics','separate metadata, retrieval, FFmpeg and voice stages share a playback ID',async()=>{
  const player=new EventEmitter(),events=[];player.handler={resolve:async()=>song(),attachStreamInfo:async s=>{s.stream.url='http://127.0.0.1/fixture';}};const sessions=new MusicSessions();const rt=instrumentMusic(player,{sessions,relay:{errorFor:()=>null,discard(){}},report:(_n,f)=>events.push(f)});
  const s=await rt.resolve('query',{metadata:{guildId:gid,signal:sessions.reserve(gid,vid)}});
  const voice={audioPlayer:new EventEmitter(),connection:new EventEmitter(),play:async stream=>{stream.spawn();}};voice.connection.state={status:'ready'};const q={id:gid,songs:[s],voice};player.emit('initQueue',q);await player.handler.attachStreamInfo(s);
  const proc=new EventEmitter();proc.stdout=new PassThrough();const stream={audioResource:{playbackDuration:2000},spawn(){this.process=proc;},kill(){}};
  await voice.play(stream);proc.stdout.write('pcm');voice.audioPlayer.emit('stateChange',{}, {status:'playing',resource:stream.audioResource});proc.emit('close',0,null);player.emit('finishSong',q,s);
  for(const stage of ['metadata_lookup','stream_retrieval','ffmpeg_decoding','discord_voice','track_completion'])assert.ok(events.some(e=>e.stage===stage),stage);
  assert.equal(new Set(events.map(e=>e.attemptId)).size,1);assert.ok(events.some(e=>e.outcome==='bytes_observed'));rt.close();
});
test('diagnostics','cancellation after async voice preflight prevents FFmpeg spawn',async()=>{
  const player=new EventEmitter();player.handler={attachStreamInfo:async s=>{s.stream.url='local';}};const sessions=new MusicSessions();const rt=instrumentMusic(player,{sessions,relay:{errorFor:()=>null,discard(){}},report(){}});const s=song();rt.prepare(s,{guildId:gid,signal:sessions.reserve(gid,vid)});const gate=deferred();const voice={audioPlayer:new EventEmitter(),connection:new EventEmitter(),play:async stream=>{await gate.promise;stream.spawn();}};player.emit('initQueue',{id:gid,songs:[s],voice});await player.handler.attachStreamInfo(s);let spawned=0,killed=0;const stream={audioResource:{},spawn(){spawned++;},kill(){killed++;}};const p=voice.play(stream);sessions.cancel(gid);gate.resolve();await assert.rejects(p,{name:'AbortError'});assert.equal(spawned,0);assert.equal(killed,1);rt.close();
});

test('queue','stop racing skip cannot restart old queued tracks',async()=>{
  const h=harness();try{await h.manager.play(h.interaction('play','First song'));await h.manager.play(h.interaction('play','Second song'));await Promise.all([h.manager.control(h.interaction('skip')),h.manager.stop(h.interaction('stop'))]);const count=h.counts().plays;await delay(20);assert.equal(h.counts().plays,count);assert.equal(h.player.getQueue(gid),undefined);}finally{await h.manager.close();}
});
test('queue','shutdown cancels waiting work, leaves voice and blocks fresh requests',async()=>{
  let entered=false;const h=harness({attach:s=>{entered=true;return bounded(()=>new Promise(()=>{}),s._bebotSignal);}});
  const play=h.manager.play(h.interaction());await waitFor(()=>entered);await h.manager.close();await play;assert.equal(h.player.getQueue(gid),undefined);assert.equal(h.voice.listenerCount('finish'),0);const i=h.interaction();await h.manager.play(i);assert.match(i.replies.at(-1).content,/cancelled|could not be completed/);assert.equal(h.counts().plays,0);
});
test('queue','yt-dlp metadata cancellation and timeout terminate a real fixture process',async()=>{
  const fixture=path.join(tmp,'fake-ytdlp');fs.writeFileSync(fixture,'#!'+process.execPath+'\n'+"const fs=require('node:fs');fs.writeFileSync(process.env.FIXTURE_PID,String(process.pid));setInterval(()=>{},1000);\n",{mode:0o700});
  for(const mode of ['cancel','timeout']){
    const pidfile=path.join(tmp,mode+'.pid');
    const code=`const fs=require('node:fs');const {runJson}=require('./beatra_engine/src/music/ytdlp.js');(async()=>{const ac=new AbortController();let timer;if(${JSON.stringify(mode)}==='cancel')timer=setInterval(()=>{if(fs.existsSync(process.env.FIXTURE_PID)){clearInterval(timer);ac.abort();}},5);try{await runJson('fixture',[],{signal:ac.signal,timeoutMs:300});process.exitCode=2;}catch(e){console.log(e.name);}finally{clearInterval(timer);}})();`;
    const result=spawnSync(process.execPath,['-e',code],{cwd:root,env:{...process.env,YTDLP_PATH:fixture,FIXTURE_PID:pidfile},encoding:'utf8',timeout:5000});assert.equal(result.status,0);assert.match(result.stdout,mode==='cancel'?/AbortError/:/YtDlpError/);const pid=Number(fs.readFileSync(pidfile));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  }
});


test('queue','stop before voice-member lookup completes also invalidates the earlier play',async()=>{
  const h=harness(),gate=deferred();try{const i=h.interaction();const fetch=i.guild.members.fetch;i.guild.members.fetch=async()=>{await gate.promise;return fetch();};const p=h.manager.play(i);await delay(0);const stopping=h.interaction('stop');await h.manager.stop(stopping);gate.resolve();await p;assert.match(stopping.replies.at(-1),/Stopped/);assert.equal(h.counts().creates,0);assert.equal(h.counts().plays,0);assert.match(i.replies.at(-1).content,/cancelled/);}finally{gate.resolve();await h.manager.close();}
});


test('fallback','actual DisTube resolver cannot silently search SoundCloud when YouTube returns null',async()=>{
  let searches=0;const sc=new plugins.RelayedSoundCloudPlugin({relay:{}});sc.searchSong=async()=>{searches++;return song();};configureSoundCloud(sc,{relayStream:async()=> 'unused',proxyFor:()=>null});
  const yt=new plugins.YouTubePlugin({runner:async()=>({entries:[]}),relay:{},fallback:null});const base={plugins:[yt,sc],debug(){}};const handler=new dt.DisTubeHandler(base);
  await assert.rejects(handler.resolve('Example Artist Example Song',{metadata:{attemptId:'null-fixture'}}));assert.equal(searches,0);
  yt.fallback=sc;const result=await handler.resolve('Example Artist Example Song');assert.ok(result);assert.equal(searches,1);
});
test('diagnostics','provider bot-challenge category keeps its attempt ID through DisTube search error masking',async()=>{
  const yt=new plugins.YouTubePlugin({runner:async()=>{throw Error("Sign in to confirm you're not a bot");},relay:{}});const handler=new dt.DisTubeHandler({plugins:[yt],debug(){}});const lines=[],log=console.log;
  try{console.log=x=>lines.push(x);await assert.rejects(handler.resolve('Example Artist Example Song',{metadata:{attemptId:'lookup-fixture'}}));}finally{console.log=log;}
  const e=lines.map(x=>{try{return JSON.parse(x);}catch{return {};}}).find(e=>e.event==='metadata_provider_error');assert.equal(e.attemptId,'lookup-fixture');assert.equal(e.reason,'SOURCE_CHALLENGE');
});


test('followup','DisTube second resolve preserves server, cancellation signal and attempt ID at retrieval',async()=>{
  const player=new EventEmitter();player.handler={attachStreamInfo:async()=>{}};
  const sessions=new MusicSessions(),rt=instrumentMusic(player,{sessions,relay:{errorFor:()=>null,discard(){}},report(){}});
  try {
    const s=song(),signal=sessions.reserve(gid,vid),r=rt.prepare(s,{guildId:gid,signal});
    await new dt.DisTubeHandler(player).resolve(s,{metadata:undefined});
    assert.equal(s.metadata,undefined,'real DisTube exhibits the original overwrite');
    await player.handler.attachStreamInfo(s);
    assert.equal(s.metadata.guildId,gid);assert.equal(s.metadata.signal,signal);assert.equal(s.metadata.attemptId,r.id);
  }finally{rt.close();}
});
test('followup','missing track metadata uses error event queue context without throwing',()=>{
  const player=new EventEmitter();player.handler={attachStreamInfo:async()=>{}};let discarded=0,notified;
  const rt=instrumentMusic(player,{sessions:new MusicSessions(),relay:{errorFor:()=>null,discard(){discarded++;}},report(){},notice(id){assert.equal(id,gid);notified=id;}});
  try{const s=song();rt.prepare(s);assert.doesNotThrow(()=>player.emit('error',Error('403'),{id:gid},s));assert.equal(notified,gid);assert.equal(discarded,1);assert.equal(rt.errors.get(s).message,'403');}finally{rt.close();}
});
test('followup','startup stays within DisTube listener limit without raising it',async()=>{
  const h=harness();try{await h.manager.init();assert.equal(h.player.getMaxListeners(),1);for(const event of ['playSong','disconnect','deleteQueue'])assert.equal(h.player.listenerCount(event),1,event);}finally{await h.manager.close();}
});
test('followup','structured diagnostics include readable redacted message and severity',()=>{
  const lines=[],log=console.log;
  try{console.log=x=>lines.push(x);diag.event('playback',{stage:'stream_retrieval',outcome:'failed',reason:'HTTP_403',attemptId:'test-id',mediaUrl:'https://secret.invalid/?sig=private'});diag.event('runtime',{node:process.version});}finally{console.log=log;}
  const [a,b]=lines.map(x=>JSON.parse(x));assert.equal(a.level,'error');assert.match(a.message,/stream_retrieval failed HTTP_403 attempt=test-id/);assert.equal(b.level,'info');assert.ok(b.message.length);assert.ok(!lines.join('').includes('secret.invalid'));
});
for(const kind of ['throw','reject'])test('followup',`notification ${kind} cannot abort actual DisTube recovery to successor`,async()=>{
  const h=harness({attach:async s=>{if(s.name==='Bad song')throw Error('HTTP 403');}});
  try{
    await h.manager.play(h.interaction('play','First song'));
    const q=h.player.getQueue(gid);let called=0;q.textChannel.send=payload=>{if(payload.content)called++;if(kind==='throw')throw Error('Discord unavailable');return Promise.reject(Error('Discord unavailable'));};
    await h.manager.play(h.interaction('play','Bad song'));await h.manager.play(h.interaction('play','Last song'));
    h.voice.stop();await waitFor(()=>h.counts().plays===2);await delay(0);
    assert.equal(q.songs[0].name,'Last song');assert.equal(called,1);
  }finally{await h.manager.close();}
});
test('followup','queued song with lost metadata recovers server from its exact queue',async()=>{
  const h=harness();try{
    await h.manager.play(h.interaction());const q=h.player.getQueue(gid),s=song('Unprepared next song');q.addToQueue(s);
    h.voice.stop();await waitFor(()=>h.counts().plays===2);assert.equal(s.metadata.guildId,gid);assert.ok(s.metadata.signal);assert.ok(s.metadata.attemptId);
  }finally{await h.manager.close();}
});
test('followup','reused track gets a new attempt ID while retaining original cancellation signal',async()=>{
  const h=harness();try{
    await h.manager.play(h.interaction());const q=h.player.getQueue(gid),s=q.songs[0],old={...s.metadata};q.setRepeatMode(1);
    h.voice.stop();await waitFor(()=>h.counts().plays===2);assert.equal(s.metadata.guildId,gid);assert.notEqual(s.metadata.attemptId,old.attemptId);assert.equal(s.metadata.signal,old.signal);
    await h.manager.stop(h.interaction('stop'));assert.equal(old.signal.aborted,true);
  }finally{await h.manager.close();}
});
test('followup','actual playlist resolver keeps distinct per-track attempts and cancellation context',async()=>{
  const h=harness({resolve:()=>new dt.Playlist({source:'youtube',name:'Fixture',songs:[song('First'),song('Second','bbbbbbbbbbb')]})});
  try{
    await h.manager.play(h.interaction());const q=h.player.getQueue(gid),first={...q.songs[0].metadata},second=q.songs[1];
    h.voice.stop();await waitFor(()=>h.counts().plays===2);
    assert.equal(second.metadata.guildId,gid);assert.equal(second.metadata.signal,first.signal);assert.notEqual(second.metadata.attemptId,first.attemptId);
    await h.manager.stop(h.interaction('stop'));assert.equal(first.signal.aborted,true);
  }finally{await h.manager.close();}
});
test('followup','missing all server context fails explicitly without undefined queue lookup or pending entry',async()=>{
  const player=new EventEmitter();let lookups=0,discarded=0;player.getQueue=()=>{lookups++;throw Error('must not be called');};player.handler={attachStreamInfo:async()=>{throw Error('must not retrieve');}};
  const sessions=new MusicSessions(),rt=instrumentMusic(player,{sessions,relay:{errorFor:()=>null,discard(){discarded++;}},report(){},notice(){throw Error('must not notify without server');}});
  try{const s=song();await assert.rejects(player.handler.attachStreamInfo(s),{code:'MISSING_GUILD_CONTEXT'});assert.equal(lookups,0);assert.equal(rt.pending.size,0);assert.equal(sessions.states.has(undefined),false);assert.doesNotThrow(()=>player.emit('error',rt.errors.get(s),undefined,s));assert.equal(discarded,1);}finally{rt.close();}
});
test('followup','cancelled context remains cancelled after DisTube clears metadata',async()=>{
  const player=new EventEmitter();let retrieved=0;player.handler={attachStreamInfo:async()=>{retrieved++;}};
  const sessions=new MusicSessions(),rt=instrumentMusic(player,{sessions,relay:{errorFor:()=>null,discard(){}},report(){}});
  try{const s=song();rt.prepare(s,{guildId:gid,signal:sessions.reserve(gid,vid)});await new dt.DisTubeHandler(player).resolve(s,{metadata:undefined});sessions.cancel(gid);await assert.rejects(player.handler.attachStreamInfo(s),{name:'AbortError'});assert.equal(retrieved,0);assert.equal(rt.pending.size,0);}finally{rt.close();}
});


test('followup','actual autoplay transition retains server and signal with a fresh attempt ID',async()=>{
  let seed;const plugin=new plugins.YouTubePlugin({runner:recommendationRunner([{id:'bbbbbbbbbbb',title:'Related song',duration:200}],target=>seed=target),relay:{}});
  const h=harness();h.player.handler._getPluginFromSong=async()=>plugin;
  try{
    await h.manager.play(h.interaction());const q=h.player.getQueue(gid),first={...q.songs[0].metadata};q.toggleAutoplay();
    h.voice.stop();await waitFor(()=>h.counts().plays===2);const next=q.songs[0];
    assert.match(seed,/list=RDabcdefghijk/);assert.equal(next.id,'bbbbbbbbbbb');assert.equal(next.metadata.guildId,gid);assert.equal(next.metadata.signal,first.signal);assert.notEqual(next.metadata.attemptId,first.attemptId);
    await h.manager.stop(h.interaction('stop'));assert.equal(first.signal.aborted,true);
  }finally{await h.manager.close();}
});
test('followup','unavailable autoplay recommendation removes queue without undefined server error',async()=>{
  const h=harness();h.player.handler._getPluginFromSong=async()=>({getRelatedSongs:async()=>[]});
  try{await h.manager.play(h.interaction());const q=h.player.getQueue(gid);q.toggleAutoplay();h.voice.stop();await waitFor(()=>!h.player.getQueue(gid));assert.equal(h.counts().plays,1);assert.equal(h.voice.audioPlayer.listenerCount('stateChange'),0);}finally{await h.manager.close();}
});

test('announcements','first track, natural completion and skip announce once each; enqueue and pause/resume do not',async()=>{
  const h=harness(),sent=[];
  try {
    const first=h.interaction('play','First song');first.channel.send=async p=>sent.push(p);
    await h.manager.play(first);assert.equal(sent.length,1);
    await h.manager.play(h.interaction('play','Second song'));
    await h.manager.play(h.interaction('play','Third song'));assert.equal(sent.length,1);
    await h.manager.control(h.interaction('pause'));await h.manager.control(h.interaction('resume'));assert.equal(sent.length,1);
    h.voice.stop();await waitFor(()=>sent.length===2);
    await h.manager.control(h.interaction('skip'));await waitFor(()=>sent.length===3);
    assert.deepEqual(sent.map(p=>p.embeds[0].data.description.match(/\[(.*?)\]/)[1]),['First song','Second song','Third song']);
    for(const p of sent)assert.deepEqual(p.allowedMentions.parse,[]);
    assert.equal(h.player.listenerCount('playSong'),1);
    await h.manager.stop(h.interaction('stop'));assert.equal(sent.length,3);
  } finally {await h.manager.close();}
});
test('announcements','playlist and repeated track announce at each new start',async()=>{
  const h=harness({resolve:()=>new dt.Playlist({source:'youtube',name:'Fixture',songs:[song('First'),song('Second','bbbbbbbbbbb')]})}),sent=[];
  try {
    const i=h.interaction();i.channel.send=async p=>sent.push(p);await h.manager.play(i);assert.equal(sent.length,1);
    assert.equal(sent[0].embeds[0].data.fields,undefined);
    h.voice.stop();await waitFor(()=>sent.length===2);
    h.player.getQueue(gid).setRepeatMode(1);h.voice.stop();await waitFor(()=>sent.length===3);
    assert.equal(sent[1].embeds[0].data.description,sent[2].embeds[0].data.description);
  } finally {await h.manager.close();}
});
test('announcements','a second YouTube playlist appends after all tracks of the first without restarting audio',async()=>{
 const h=harness({resolve:name=>new dt.Playlist({source:'youtube',name,songs:[song(name+' one'),song(name+' two','bbbbbbbbbbb')]})});
 try {
  await h.manager.play(h.interaction('play','Playlist A'));
  const first=h.player.getQueue(gid).songs[0];
  await h.manager.play(h.interaction('play','Playlist B'));
  assert.equal(h.counts().plays,1);assert.equal(h.player.getQueue(gid).songs[0],first);
  assert.deepEqual(h.player.getQueue(gid).songs.map(s=>s.name),['Playlist A one','Playlist A two','Playlist B one','Playlist B two']);
  h.voice.stop();await waitFor(()=>h.counts().plays===2);
  h.voice.stop();await waitFor(()=>h.counts().plays===3);
  assert.equal(h.player.getQueue(gid).songs[0].name,'Playlist B one');
 }finally{await h.manager.close();}
});
test('announcements','autoplay successor announces without another request',async()=>{
  const h=harness(),sent=[];
  const plugin=new plugins.YouTubePlugin({runner:recommendationRunner([{id:'bbbbbbbbbbb',title:'Related song',duration:200}]),relay:{}});
  h.player.handler._getPluginFromSong=async()=>plugin;
  try {
    const i=h.interaction();i.channel.send=async p=>sent.push(p);await h.manager.play(i);
    h.player.getQueue(gid).toggleAutoplay();h.voice.stop();await waitFor(()=>sent.length===2);
    assert.match(sent[1].embeds[0].data.description,/Related song/);
  } finally {await h.manager.close();}
});
for(const kind of ['throw','reject','pending'])test('announcements',`Discord send ${kind} never blocks playback or queue advancement`,async()=>{
  const h=harness();let sends=0;
  try {
    const i=h.interaction('play','First');i.channel.send=()=>{sends++;if(kind==='throw')throw Error('Missing permissions');if(kind==='reject')return Promise.reject(Error('Network error'));return new Promise(()=>{});};
    await h.manager.play(i);assert.equal(h.counts().plays,1);assert.equal(sends,1);
    await h.manager.play(h.interaction('play','Second'));h.voice.stop();await waitFor(()=>h.counts().plays===2);await delay(0);
    assert.equal(sends,2);assert.equal(h.player.getQueue(gid).songs[0].name,'Second');
  } finally {await h.manager.close();}
});
test('announcements','failed extraction never emits a Now Playing announcement',async()=>{
  const h=harness({attach:async()=>{throw Error('403');}}),sent=[];
  try {const i=h.interaction();i.channel.send=async p=>sent.push(p);await h.manager.play(i);assert.equal(sent.length,0);assert.equal(h.counts().plays,0);} finally {await h.manager.close();}
});
test('announcements','nowplaying uses the same design and pause state with a readable position',async()=>{
  const h=harness();try {
    await h.manager.play(h.interaction());h.voice.playbackTime=65;
    await h.manager.control(h.interaction('pause'));
    const i=h.interaction('nowplaying');let deferred;i.deferReply=async options=>{deferred=options;};await h.manager.control(i);
    assert.deepEqual(deferred,{},'nowplaying must be public');
    const e=i.replies.at(-1).embeds[0].toJSON();assert.match(e.title,/Paused/);
    assert.match(e.description,/1:05 \/ 4:00/);
    assert.equal(e.fields,undefined);assert.equal(e.author,undefined);assert.equal(e.footer,undefined);
  } finally {await h.manager.close();}
});
test('announcements','embeds validate missing metadata, live streams, hostile long text and invalid URLs',async()=>{
  for(const s of [{},{name:'[x] @everyone '.repeat(500),url:'javascript:alert(1)',thumbnail:'not a URL',duration:Infinity},
    {name:'Live',isLive:true,url:'https://youtube.com/watch?v=abcdefghijk'},
    {name:'Long URL',url:'https://example.com/'+ 'x'.repeat(1800),thumbnail:'https://example.com/cover.png'}]){
    const q={songs:[s,s],voiceChannel:{id:vid}};
    const json=buildNowPlayingEmbed(q,s).toJSON();buildRequestEmbed(s).toJSON();
    assert.ok(json.description.length<=4096);assert.equal(json.fields,undefined);
    assert.ok(!json.description.includes('javascript:'));if(s.isLive)assert.match(json.description,/LIVE/);
  }
  await announceNowPlaying({},{});
  await announceNowPlaying({textChannel:{send(){throw Error('fail');}}},{},()=>{throw Error('logger failed');});
});

test('autoplay','recent IDs and alternate uploads with normalized titles are excluded',()=>{
  const history=new RecentTracks();
  const old=song('Sweet - Cigarettes After Sex (Official Music Video)','aaaaaaaaaaa');history.remember(gid,old);
  const duplicate=song('Cigarettes After Sex / Sweet [Lyrics]','bbbbbbbbbbb');
  const fresh=song('Another artist - New track','ccccccccccc');
  const seed=song('Seed track','ddddddddddd');
  assert.equal(titleKey(old),titleKey(duplicate));
  assert.deepEqual(history.select(gid,[old,duplicate,seed,fresh],seed).map(s=>s.id),[fresh.id]);
  assert.equal(history.select('another-server',[old],seed).length,1);
});
test('autoplay','queued tracks, prior queue IDs and duplicate candidates are excluded',()=>{
  const history=new RecentTracks();const seed=song('Seed','aaaaaaaaaaa');
  const queued=song('Queued track','bbbbbbbbbbb'),previous=song('Old track','ccccccccccc'),fresh=song('Fresh song','ddddddddddd');
  const duplicate=song('Fresh song (Official Audio)','eeeeeeeeeee');
  assert.deepEqual(history.select(gid,[queued,previous,fresh,fresh,duplicate],seed,{songs:[queued],previousSongs:[{id:previous.id}]}).map(s=>s.id),[fresh.id]);
});
test('autoplay','selection varies the recommendation order without changing its contents',()=>{
  const history=new RecentTracks({random:()=>0});const seed=song('Seed','aaaaaaaaaaa');
  const songs=[song('First fresh','bbbbbbbbbbb'),song('Second fresh','ccccccccccc'),song('Third fresh','ddddddddddd')];
  const selected=history.select(gid,songs,seed);assert.equal(selected[0],songs[1]);assert.equal(songs[0].name,'First fresh');assert.equal(new Set(selected).size,3);
});
test('autoplay','history has bounded per-server memory and survives queue deletion',()=>{
  const history=new RecentTracks({limit:2,maxGuilds:2});const a=song('Alpha','aaaaaaaaaaa'),b=song('Beta','bbbbbbbbbbb'),c=song('Gamma','ccccccccccc');
  history.remember(gid,a);history.remember(gid,b);history.remember(gid,c);
  assert.equal(history.guilds.get(gid).length,2);assert.equal(history.select(gid,[a],c).length,1);assert.equal(history.select(gid,[b],c).length,0);
  history.remember('two',a);history.remember('three',b);assert.equal(history.guilds.size,2);
});
test('autoplay','YouTube requests a broader pool, preserves context and returns no repeated fallback',async()=>{
  const history=new RecentTracks();let argsSeen,optionsSeen;
  const seed=song('Seed','aaaaaaaaaaa');const ac=new AbortController();seed.metadata={guildId:gid,signal:ac.signal};history.remember(gid,song('Old track','bbbbbbbbbbb'));
  const plugin=new plugins.YouTubePlugin({relay:{},recommendations:history,runner:async(target,args,options)=>{argsSeen=args;optionsSeen=options;return {entries:[{id:'bbbbbbbbbbb',title:'Old track',duration:200},{id:'ccccccccccc',title:'Old track (Lyrics)',duration:200}]};}});
  assert.deepEqual(await plugin.getRelatedSongs(seed),[]);assert.deepEqual(argsSeen,['--flat-playlist','--playlist-end','40']);assert.equal(optionsSeen.signal,ac.signal);
});
test('autoplay','cancellation during recommendation lookup rejects before candidates reach the queue',async()=>{
  const ac=new AbortController(),seed=song();seed.metadata={guildId:gid,signal:ac.signal};
  const plugin=new plugins.YouTubePlugin({relay:{},runner:async()=>{ac.abort();return {entries:[{id:'bbbbbbbbbbb',title:'Fresh song',duration:200}]};}});
  await assert.rejects(plugin.getRelatedSongs(seed),{name:'AbortError'});
});
test('autoplay','actual automatic transitions avoid duplicate uploads and end cleanly when all candidates were played',async()=>{
  const recommendations=new RecentTracks(),h=harness({recommendations}),sent=[];
  const entries=[{id:'aaaaaaaaaaa',title:'Sweet - Cigarettes After Sex (Official Music Video)',duration:200},{id:'bbbbbbbbbbb',title:'Sweet - Cigarettes After Sex (Lyrics)',duration:200},{id:'ccccccccccc',title:'A fresh different song',duration:200}];
  const plugin=new plugins.YouTubePlugin({recommendations,relay:{},getQueue:()=>h.player.getQueue(gid),runner:recommendationRunner(entries)});
  h.player.handler._getPluginFromSong=async()=>plugin;
  try {
    const i=h.interaction('play','Sweet - Cigarettes After Sex (Official Music Video)');i.channel.send=async p=>sent.push(p);await h.manager.play(i);
    h.player.getQueue(gid).toggleAutoplay();h.voice.stop();await waitFor(()=>h.counts().plays===2);
    assert.equal(h.player.getQueue(gid).songs[0].id,'ccccccccccc');assert.equal(sent.length,2);
    h.voice.stop();await waitFor(()=>!h.player.getQueue(gid));assert.equal(h.counts().plays,2);
    assert.match(sent.at(-1).content,/could not load a fresh recommendation/);
    // A new queue retains the recent history but the user may deliberately replay.
    await h.manager.play(h.interaction('play','Sweet - Cigarettes After Sex (Official Music Video)'));assert.equal(h.counts().plays,3);
    const recent=recommendations.select(gid,[song('A fresh different song','ccccccccccc')],song('New seed','ddddddddddd'));
    assert.equal(recent.length,0);
  } finally {await h.manager.close();}
});

test('autoplay-check','challenged recommendation is skipped; next candidate audio metadata is reused',async()=>{
  const entries=[{id:'bbbbbbbbbbb',title:'Blocked song',duration:200},{id:'ccccccccccc',title:'Playable song',duration:210}];
  const calls=[],base=recommendationRunner(entries),recommendations=new RecentTracks({random:()=>.999});let relayed;
  const p=new plugins.YouTubePlugin({recommendations,runner:async(target,args,options)=>{calls.push({target,options});if(target==='https://www.youtube.com/watch?v=bbbbbbbbbbb')throw Error("Sign in to confirm you're not a bot");return base(target);},
    relay:{register:async value=>{relayed=value;return 'relay';},warm:async()=> 'relay'}});
  const seed=song();seed.metadata={guildId:gid,signal:new AbortController().signal};
  const [next]=await p.getRelatedSongs(seed);assert.equal(next.id,'ccccccccccc');assert.equal(calls.length,3);
  assert.equal(await p.getStreamURL(next),'relay');assert.equal(calls.length,3);assert.equal(relayed.info.id,'ccccccccccc');
  assert.equal(calls[1].options.timeoutMs,8000);assert.equal(calls[2].options.timeoutMs,8000);
  await p.getRelatedSongs(seed);assert.equal(calls.filter(c=>c.target==='https://www.youtube.com/watch?v=bbbbbbbbbbb').length,1,'failed candidate cooldown');
});
test('autoplay-check','all challenged candidates are bounded to three exact IDs with no title search',async()=>{
  let extracts=0;const ids=['bbbbbbbbbbb','ccccccccccc','ddddddddddd','eeeeeeeeeee'];
  const p=new plugins.YouTubePlugin({relay:{},runner:async target=>{assert.ok(!target.startsWith('ytsearch'));if(target.includes('&list='))return {entries:ids.map((id,i)=>({id,title:'Different song '+i,duration:200}))};extracts++;throw Error("Sign in to confirm you're not a bot");}});
  assert.deepEqual(await p.getRelatedSongs(song()),[]);assert.equal(extracts,3);
});
test('autoplay-check','stop during candidate validation cancels without selecting another candidate',async()=>{
  const ac=new AbortController();let extracts=0;const seed=song();seed.metadata={guildId:gid,signal:ac.signal};
  const p=new plugins.YouTubePlugin({relay:{},runner:async target=>{if(target.includes('&list='))return {entries:[{id:'bbbbbbbbbbb',title:'First candidate',duration:200},{id:'ccccccccccc',title:'Second candidate',duration:200}]};extracts++;ac.abort();throw ac.signal.reason;}});
  await assert.rejects(p.getRelatedSongs(seed),{name:'AbortError'});assert.equal(extracts,1);assert.equal(p.rejectedRecommendations.entries.size,0);
});
test('autoplay-check','mismatched video identity and missing audio formats are rejected',async()=>{
  for(const info of [{id:'ccccccccccc',url:'https://example.invalid/audio',format_id:'251'},{id:'bbbbbbbbbbb'}]){
    const p=new plugins.YouTubePlugin({relay:{},runner:async target=>target.includes('&list=')?{entries:[{id:'bbbbbbbbbbb',title:'A candidate',duration:200}]}:info});
    assert.deepEqual(await p.getRelatedSongs(song()),[]);
  }
});
test('autoplay-check','real automatic handoff skips a challenged candidate without killing playback',async()=>{
  const recommendations=new RecentTracks({random:()=>.999}),h=harness({recommendations}),sent=[];
  const entries=[{id:'bbbbbbbbbbb',title:'Blocked candidate',duration:200},{id:'ccccccccccc',title:'Working candidate',duration:200}];
  const base=recommendationRunner(entries);
  const p=new plugins.YouTubePlugin({recommendations,getQueue:()=>h.player.getQueue(gid),relay:{},runner:async target=>{if(target==='https://www.youtube.com/watch?v=bbbbbbbbbbb')throw Error("Sign in to confirm you're not a bot");return base(target);}});
  h.player.handler._getPluginFromSong=async()=>p;
  try{const i=h.interaction();i.channel.send=async payload=>sent.push(payload);await h.manager.play(i);h.player.getQueue(gid).toggleAutoplay();h.voice.stop();await waitFor(()=>h.counts().plays===2);
    assert.equal(h.player.getQueue(gid).songs[0].id,'ccccccccccc');assert.equal(sent.length,2);assert.match(sent[1].embeds[0].data.description,/Working candidate/);
  }finally{await h.manager.close();}
});
test('autoplay-check','unavailable recommendation notice cannot interrupt queue cleanup',async()=>{
  for(const kind of ['throw','reject']){const h=harness();h.player.handler._getPluginFromSong=async()=>({getRelatedSongs:async()=>[]});
    try{await h.manager.play(h.interaction());const q=h.player.getQueue(gid);q.textChannel.send=()=>{if(kind==='throw')throw Error('Discord unavailable');return Promise.reject(Error('Discord unavailable'));};q.toggleAutoplay();h.voice.stop();await waitFor(()=>!h.player.getQueue(gid));await delay(0);assert.equal(h.counts().plays,1);}finally{await h.manager.close();}
  }
});
test('exact-link','both reported link forms preserve the exact ID and never invoke title-search recovery',async()=>{
  for(const suffix of ['', '&list=RD_m7MiuCqVxk&start_radio=1']){
    const calls=[],error=Error("Sign in to confirm you're not a bot");
    const p=new plugins.YouTubePlugin({relay:{},runner:async target=>{calls.push(target);throw error;}});
    await assert.rejects(p.resolve('https://www.youtube.com/watch?v=_m7MiuCqVxk'+suffix),e=>e===error);
    assert.deepEqual(calls,['https://www.youtube.com/watch?v=_m7MiuCqVxk']);assert.equal(p.recoverVideoLink,undefined);
  }
});

test('exact-link','direct video stream refusal cannot substitute SoundCloud even when fallback is configured',async()=>{
  let fallbackCalls=0,calls=0;
  const p=new plugins.YouTubePlugin({relay:{},fallback:{searchSong:async()=>{fallbackCalls++;return song('Wrong upload');}},runner:async()=>{
    calls++;if(calls===1)return {id:'_m7MiuCqVxk',title:'Requested exact upload',duration:276};throw Error("Sign in to confirm you're not a bot");
  }});
  const s=await p.resolve('https://youtu.be/_m7MiuCqVxk');assert.equal(s.exactVideoId,'_m7MiuCqVxk');
  p.skipYouTubeUntil=Date.now()+60000;
  await assert.rejects(p.getStreamURL(s),/Sign in/);assert.equal(calls,2);assert.equal(fallbackCalls,0);
});
test('exact-link','a different resolved video identity is never accepted for a pasted link',async()=>{
  const p=new plugins.YouTubePlugin({relay:{},runner:async()=>({id:'c1gtzwJydhM',title:'Other upload',duration:276})});
  await assert.rejects(p.resolve('https://youtu.be/_m7MiuCqVxk'),/identity/);
});

test('controls','loop repeats songs and queues without toggling off on a repeated command',async()=>{
 const h=harness();try {
  await h.manager.play(h.interaction('play','First'));await h.manager.play(h.interaction('play','Second'));
  const q=h.player.getQueue(gid);
  await h.manager.control(h.interaction('loop','song','other'));assert.equal(q.repeatMode,0);
  await h.manager.control(h.interaction('loop','song'));await h.manager.control(h.interaction('loop','song'));
  assert.equal(q.repeatMode,1);assert.equal(h.counts().plays,1);
  h.voice.stop();await waitFor(()=>h.counts().plays===2);assert.equal(q.songs[0].name,'First');
  await h.manager.control(h.interaction('loop','queue'));await h.manager.control(h.interaction('loop','queue'));
  assert.equal(q.repeatMode,2);
  h.voice.stop();await waitFor(()=>h.counts().plays===3);assert.equal(q.songs[0].name,'Second');
  h.voice.stop();await waitFor(()=>h.counts().plays===4);assert.equal(q.songs[0].name,'First');
  const status=h.interaction('loop',null,'other');await h.manager.control(status);assert.match(status.replies.at(-1).content,/Queue/);assert.equal(q.repeatMode,2);
  await h.manager.control(h.interaction('loop','off'));assert.equal(q.repeatMode,0);
  h.voice.stop();await waitFor(()=>h.counts().plays===5);h.voice.stop();await waitFor(()=>!h.player.getQueue(gid));
 }finally{await h.manager.close();}
});

test('preservation','all 37 commands have handlers and unrelated files remain unchanged',()=>{
  assert.equal(commandsJSON.length,37);assert.equal(new Set(commandsJSON.map(c=>c.name)).size,37);const index=fs.readFileSync(path.join(root,'index.js'),'utf8');for(const c of commandsJSON)assert.match(index,new RegExp(`case ["']${c.name}["']:`));
  const baseline=JSON.parse(fs.readFileSync(path.join(root,'tests/preserved-sha256.json')));for(const [name,hash] of Object.entries(baseline))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex'),hash,name);
});

for(const {group,name,fn} of tests.filter(t=>(!process.env.TEST_GROUP || t.group===process.env.TEST_GROUP) && (!process.env.TEST_NAME || new RegExp(process.env.TEST_NAME).test(t.name)))){const start=Date.now();try{await fn();results.push({group,name,status:'PASS',ms:Date.now()-start});console.log('PASS',group,name);}catch(error){results.push({group,name,status:'FAIL',error:error.stack});console.error('FAIL',group,name,error.stack);}}
const out=process.env.TEST_REPORT_DIR||path.join(root,'test-results');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'test-results.json'),JSON.stringify({node:process.version,distube:dt.version,note:'Offline mocks, actual DisTube.play and Song/Playlist resolver plus Queue/QueueManager, loopback HTTP, synthetic local FFmpeg audio. No YouTube/Discord voice validation.',results,audio},null,2)+'\n');
console.log(`${results.filter(r=>r.status==='PASS').length}/${results.length} tests passed. Report: ${out}`);
fs.rmSync(tmp,{recursive:true,force:true});process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
