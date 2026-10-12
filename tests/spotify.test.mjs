import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spotifyUri, spotifySong, SoloistControl, createSpotifyManager } from '../spotify_music.js';
const { restoreState } = createRequire(import.meta.url)('../spotify_runtime.cjs');
const uri = 'spotify:track:3chBLXLQgj1KB2h1KgQxmF';
const item = { uri, decorations: { identity: { name: 'Baby 123' }, playback: { duration_ms: 176105 }, creators: [{ entity: { decorations: { identity: { name: 'RAPROJECT SIX' } } } }] } };

test('Spotify links preserve exact identity and reject lookalikes and unsupported entities', () => {
  assert.equal(spotifyUri('https://open.spotify.com/intl-en/track/3chBLXLQgj1KB2h1KgQxmF?si=abc'), uri);
  assert.equal(spotifyUri('https://open.spotify.com/playlist/4NKYNvRkGkbe45PPK3Usoi'), 'spotify:playlist:4NKYNvRkGkbe45PPK3Usoi');
  for (const value of ['https://open.spotify.com.evil.test/track/3chBLXLQgj1KB2h1KgQxmF', 'https://user@open.spotify.com/track/3chBLXLQgj1KB2h1KgQxmF', 'http://open.spotify.com/track/3chBLXLQgj1KB2h1KgQxmF', 'spotify:artist:3chBLXLQgj1KB2h1KgQxmF']) assert.equal(spotifyUri(value), null);
  assert.equal(spotifySong(item, '123').duration, 176.105);
  assert.equal(spotifySong(item, '123').url, 'https://open.spotify.com/track/3chBLXLQgj1KB2h1KgQxmF');
});
test('private state restore rejects traversal and keeps contents inside its destination', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-state-test-'));
  const encode = x => gzipSync(Buffer.from(JSON.stringify(x))).toString('base64');
  try {
    assert.throws(() => restoreState(encode({'cache/../../escape':'YQ=='}),dir), /Unsafe/);
    restoreState(encode({'settings/prefs':'dGVzdA=='}),dir);
    assert.equal(fs.readFileSync(path.join(dir,'settings/prefs'),'utf8'),'test');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('control waits for the matching acknowledgement and refuses unauthenticated playback', async () => {
  class WS {
    constructor() { queueMicrotask(() => this.onmessage?.({data:JSON.stringify({type:'auth_state',logged_in:WS.logged})})); }
    send(text) { const x=JSON.parse(text); queueMicrotask(()=>{this.onmessage({data:JSON.stringify({type:'playback_state',status:'paused'})});this.onmessage({data:JSON.stringify({type:'command_result',command:x.command})});}); }
    close() {}
    static logged = true;
  }
  const control=new SoloistControl('ws://127.0.0.1:1',WS);
  assert.equal((await control.request('play',{uri})).command,'play');
  WS.logged=false; await assert.rejects(control.request('play',{uri}),/pairing/);
});

function fixture() {
  const commands=[],messages=[];
  let playback={status:'paused',is_active:true,item,context:{uri},position:{position_ms:0}};
  const rt={parec:'fixture',env:{},close:async()=>{},control:{
    request:async(command,fields={})=>{commands.push([command,fields]);if(command==='get_auth_state')return{logged_in:true};if(command==='play')playback={...playback,status:'playing',context:{uri:fields.uri||uri}};if(command==='pause')playback.status='paused';return command==='get_state'?playback:{};},
    watch:()=>()=>{}
  }};
  const channel={id:'voice',permissionsFor:()=>({has:()=>true})};
  const connection=new EventEmitter();connection.subscribe=()=>{};connection.destroy=()=>{};
  const player=new EventEmitter();player.play=()=>{};player.stop=()=>{};
  const audio=new EventEmitter();audio.stdout=new PassThrough();audio.kill=()=>{};
  const api={joinVoiceChannel:()=>connection,entersState:async()=>{},VoiceConnectionStatus:{Ready:'ready'},createAudioPlayer:()=>player,NoSubscriberBehavior:{Pause:'pause'},createAudioResource:x=>x,StreamType:{Raw:'raw'}};
  const interaction=(query=uri,commandName='play',voiceId='voice')=>({commandName,guildId:'guild',inGuild:()=>true,user:{id:'123456789012345678'},channel:{send:async m=>messages.push(m)},guild:{members:{me:{},fetch:async()=>({voice:{channel,channelId:voiceId}})}},memberPermissions:{has:()=>false},options:{getString:()=>query,getInteger:()=>1},deferReply:async()=>{},reply:async m=>messages.push(m),editReply:async m=>messages.push(m)});
  return {commands,messages,interaction,rt,api,audio};
}
test('original Spotify track starts voice, announces, queues tracks, and stops with access checks',async()=>{
  const f=fixture(), m=createSpotifyManager({}, {runtimeFactory:async()=>f.rt,voiceApi:f.api,spawnImpl:()=>f.audio});
  try {
    await m.play(f.interaction()); assert.equal(m.has('guild'),true);
    assert.ok(f.commands.some(([c,p])=>c==='play'&&p.uri===uri));
    assert.equal(f.messages.filter(x=>x.embeds).length,2);
    await m.play(f.interaction()); assert.ok(f.commands.some(([c])=>c==='add_to_queue'));
    await m.control(f.interaction(uri,'stop','other'));assert.equal(m.has('guild'),true);
    await m.control(f.interaction(uri,'stop'));assert.equal(m.has('guild'),false);
  } finally { await m.close(); }
});
test('existing YouTube queue blocks Spotify without sending playback commands',async()=>{
  const f=fixture(),m=createSpotifyManager({}, {runtimeFactory:async()=>f.rt,voiceApi:f.api});
  await m.play(f.interaction(),{legacyBusy:()=>true});assert.equal(f.commands.length,0);assert.equal(m.has('guild'),false);
});
test('stop during startup prevents later voice or playback dispatch',async()=>{
  const f=fixture();let release;const gate=new Promise(r=>release=r);
  const m=createSpotifyManager({}, {runtimeFactory:async()=>{await gate;return f.rt;},voiceApi:f.api,spawnImpl:()=>f.audio});
  const pending=m.play(f.interaction());
  for(let i=0;i<10&&!m.has('guild');i++)await new Promise(r=>setImmediate(r));
  await m.control(f.interaction(uri,'stop'));release();await pending;
  assert.equal(f.commands.some(([c])=>c==='play'),false);assert.equal(m.has('guild'),false);
  await m.close();
});
