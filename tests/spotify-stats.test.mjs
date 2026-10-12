import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createMusicManager} from '../music.js';
import {createSpotifyManager} from '../spotify_music.js';
import {createListeningStats} from '../music_stats.js';

const first='spotify:track:3chBLXLQgj1KB2h1KgQxmF';
const second='spotify:track:57Z71Snhwx82laEb6rdZPB';
const item=(uri,name)=>({uri,decorations:{identity:{name},playback:{duration_ms:180000}}});

test('Spotify and autoplay credit listeners, tracks and friends, persist, and exclude inactive playback',async()=>{
 const dir=fs.mkdtempSync(path.join(process.cwd(),'bebot-spotify-stats-'));
 const oldDir=process.env.BEBOT_DATA_DIR,oldNow=Date.now;process.env.BEBOT_DATA_DIR=dir;
 let now=0;Date.now=()=>now;
 const members=new Map([['alice',{id:'alice',user:{bot:false}}],['bob',{id:'bob',user:{bot:false}}],['bot',{id:'bot',user:{bot:true}}]]);
 const channel={id:'voice',members,permissionsFor:()=>({has:()=>true})};
 const guild={id:'guild',channels:{cache:new Map([['voice',channel]])},members:{me:{},fetch:async()=>({voice:{channel,channelId:'voice'}})}};
 const client={guilds:{cache:new Map([['guild',guild]])}};
 const connection=Object.assign(new EventEmitter(),{state:{status:'ready'},subscribe(){},destroy(){this.state={status:'destroyed'};}});
 const player=Object.assign(new EventEmitter(),{state:{status:'idle'},play(){this.state={status:'playing'};},stop(){this.state={status:'idle'};}});
 const audio=Object.assign(new EventEmitter(),{stdout:new PassThrough(),kill(){}});
 let state={status:'paused',is_active:true,item:item(first,'First song'),context:{uri:first}},watch;
 const rt={env:{},parec:'fixture',close:async()=>{},control:{watch:cb=>{watch=cb;return()=>{};},request:async(command)=>{
  if(command==='get_auth_state')return{logged_in:true};
  if(command==='get_state')return structuredClone(state);
  if(command==='play')state.status='playing';if(command==='pause')state.status='paused';return{};
 }}};
 const voice={joinVoiceChannel:()=>connection,entersState:async()=>{},VoiceConnectionStatus:{Ready:'ready'},createAudioPlayer:()=>player,NoSubscriberBehavior:{Pause:'pause'},createAudioResource:x=>x,StreamType:{Raw:'raw'}};
 let spotify;
 const music=createMusicManager(client,{spotifyFactory:c=>(spotify=createSpotifyManager(c,{runtimeFactory:async()=>rt,voiceApi:voice,spawnImpl:()=>audio}))});
 const interaction={inGuild:()=>true,guildId:'guild',user:{id:'alice'},guild,channel:{send:async()=>{}},options:{getString:()=>first},deferReply:async()=>{},editReply:async()=>{}};
 const sample=()=>{now+=20000;music.stats._tickForTests();};
 const refresh=async()=>{watch({type:'track_changed'});await new Promise(r=>setImmediate(r));};
 try {
  sample();assert.equal(music.stats.profile('guild','alice').totalMs,0);
  await music.play(interaction);sample();
  assert.equal(music.stats.profile('guild','alice').totalMs,20000);
  assert.equal(music.stats.profile('guild','bot').totalMs,0);
  state.item=item(second,'Autoplay song');await refresh();sample();
  const profile=music.stats.profile('guild','alice');
  assert.equal(profile.totalMs,40000);assert.equal(profile.tracks.length,2);
  assert.ok(profile.tracks.some(x=>x.url.endsWith(second.split(':')[2])));
  assert.deepEqual(profile.friends,[{id:'bob',ms:40000}]);
  assert.equal(spotify.getListeningQueue('another-guild'),null);
  members.delete('bob');sample();assert.equal(music.stats.profile('guild','bob').totalMs,40000);
  state.status='paused';await refresh();sample();assert.equal(music.stats.profile('guild','alice').totalMs,60000);
  state.status='playing';await refresh();player.state={status:'buffering'};sample();assert.equal(music.stats.profile('guild','alice').totalMs,60000);
  player.state={status:'playing'};connection.state={status:'disconnected'};sample();assert.equal(music.stats.profile('guild','alice').totalMs,60000);
  connection.state={status:'ready'};await spotify.close();sample();assert.equal(music.stats.profile('guild','alice').totalMs,60000);
  await music.stats.flush();
  const reloaded=createListeningStats(client,()=>null);assert.equal(reloaded.profile('guild','alice').totalMs,60000);
 } finally {await music.close();Date.now=oldNow;if(oldDir===undefined)delete process.env.BEBOT_DATA_DIR;else process.env.BEBOT_DATA_DIR=oldDir;fs.rmSync(dir,{recursive:true,force:true});}
});

test('profile adapter still exposes the existing YouTube queue when Spotify is inactive',async()=>{
 let provider;
 const queue={playing:true,paused:false,songs:[{name:'YouTube'}]};
 const engine=Object.assign(new EventEmitter(),{handler:{attachStreamInfo:async()=>{}},getQueue:()=>queue,voices:{get:()=>({channelId:'voice'})},queues:{collection:new Map()}});
 const music=createMusicManager({}, {engineFactory:async()=>({instance:engine,relay:{close(){}}}),statsFactory:(_client,getPlayer)=>{provider=getPlayer;return{flush:async()=>{}};}});
 try {await music.init();assert.equal(provider().getQueue('guild'),queue);assert.equal(provider().voices.get('guild').channelId,'voice');}
 finally {await music.close();}
});
