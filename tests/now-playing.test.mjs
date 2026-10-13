import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNowPlayingEmbed, createNowPlayingAnnouncer } from '../music_embeds.js';
import { spotifyPosition } from '../spotify_music.js';
const song={name:'Example song',source:'spotify',duration:180,url:'https://open.spotify.com/track/3chBLXLQgj1KB2h1KgQxmF'};
const drain=()=>new Promise(r=>setImmediate(r));

test('progress clamps at the end, handles live audio, and interpolates Spotify only while playing',()=>{
 assert.match(buildNowPlayingEmbed({currentTime:65},song).data.description,/1:05 \/ 3:00.*1:55 left/);
 assert.match(buildNowPlayingEmbed({currentTime:999},song).data.description,/3:00 \/ 3:00.*0:00 left/);
 assert.match(buildNowPlayingEmbed({paused:true},song).data.title,/Paused/);
 assert.match(buildNowPlayingEmbed({}, {...song,isLive:true}).data.description,/LIVE/);
 const state={status:'playing',position:{position_ms:45000,timestamp_ms:1000,speed:1}};
 assert.equal(spotifyPosition(state,6000),50);
 assert.equal(spotifyPosition({...state,status:'paused'},6000),45);
});

test('one card is edited, freezes on pause, finishes, and clears its timer',async()=>{
 let tick,cleared=0,position=0,paused=false;const sent=[],edits=[];
 const a=createNowPlayingAnnouncer({schedule:fn=>(tick=fn,1),cancel:()=>cleared++});
 const channel={send:async p=>{sent.push(p);return{edit:async p=>edits.push(p)};}};
 a.start('guild',channel,song,()=>({currentTime:position,paused}));await drain();
 position=30;tick();await drain();assert.equal(sent.length,1);assert.match(edits.at(-1).embeds[0].data.description,/0:30/);
 paused=true;tick();await drain();assert.match(edits.at(-1).embeds[0].data.title,/Paused/);
 const count=edits.length;tick();await drain();assert.equal(edits.length,count);
 a.stop('guild','✓ Finished');await drain();assert.equal(cleared,1);assert.match(edits.at(-1).embeds[0].data.description,/3:00 \/ 3:00/);
 tick();await drain();assert.equal(edits.length,count+1);
});

test('ending while initial send is pending retires the late card; failed edits stop retries',async()=>{
 let tick,resolve;const edits=[];
 const a=createNowPlayingAnnouncer({schedule:fn=>(tick=fn,1),cancel:()=>{}});
 a.start('guild',{send:()=>new Promise(r=>resolve=r)},song,()=>({currentTime:20}));
 tick();a.stop('guild','⏹ Stopped');resolve({edit:async p=>edits.push(p)});await drain();
 assert.match(edits.at(-1).embeds[0].data.title,/Stopped/);
 let failures=0;
 a.start('guild',{send:async()=>({edit:async()=>{failures++;throw Error('Deleted');}})},song,()=>({currentTime:failures+1}));
 await drain();a.stop('guild');await drain();assert.equal(failures,1);a.close();
});
