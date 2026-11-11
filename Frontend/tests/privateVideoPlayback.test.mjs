// Execute the real controller with offline Auth/Axios/media primitives.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../src/services/privateVideoPlayback.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
    let now=Date.parse('2026-11-10T12:00:00Z'),number=0;
    const timers=new Map(),events=new Map(),authListeners=new Set(),documentEvents=new Map();
    const calls=[],states=[];
    const auth={currentUser:{uid:'alice'}};
    const document={visibilityState:'visible',addEventListener:(key,fn)=>documentEvents.set(key,fn),removeEventListener:key=>documentEvents.delete(key)};
    const video={src:'',paused:true,currentTime:0,volume:.6,muted:false,playbackRate:1,duration:60,
        addEventListener:(key,fn)=>events.set(key,fn),removeEventListener:key=>events.delete(key),
        emit:key=>events.get(key)?.(),
        async play(){this.paused=false;this.emit('play');},
        pause(){if(!this.paused){this.paused=true;queueMicrotask(()=>this.emit('pause'));}},
        removeAttribute(){this.src='';},load(){this.currentTime=0;},
    };
    const api={post:async(...args)=>{
        calls.push(args);
        return {data:{url:`https://storage.googleapis.com/demo/private.mp4?X-Goog-Signature=secret-${calls.length}`,
            expiresAt:new Date(now+1800000).toISOString(),expiresInSeconds:1800,mediaType:'video',contentType:'video/mp4',origin:'video-generation'}};
    }};
    const original=api.post;
    const module={exports:{}};
    class Clock extends Date {static now(){return now;}}
    vm.runInNewContext(code,{module,exports:module.exports,Date:Clock,URL,AbortController,document,
        setTimeout:(fn,delay)=>{const id=++number;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
        console:new Proxy({},{get(){throw Error('Must not log signed URLs');}}),
        require(name){
            if(name==='firebase/auth')return {onAuthStateChanged:(_,fn)=>{authListeners.add(fn);return()=>authListeners.delete(fn);}};
            if(name==='../firebase/auth')return {__esModule:true,default:auth};
            if(name==='../api/api')return {__esModule:true,default:api};
            throw Error(name);
        },
    });
    const player=module.exports.createPrivateVideoPlayback(video,'real-doc-id','alice',state=>states.push(state));
    return {player,video,api,calls,states,timers,original,
        advance:ms=>{now+=ms;},visible:()=>documentEvents.get('visibilitychange')?.(),
        change:user=>{auth.currentUser=user;for(const fn of [...authListeners])fn(user);},
        metadata:async()=>{video.emit('loadedmetadata');await tick();},
    };
}
test('signs only on demand, using the real document ID with authenticated Axios',async()=>{
    const s=setup();assert.equal(s.calls.length,0);assert.equal(s.video.src,'');
    await s.player.play();await s.metadata();
    assert.equal(s.calls.length,1);assert.equal(s.calls[0][0],'/media/real-doc-id/video-access');
    assert.equal(s.calls[0][1],undefined);assert.equal(s.calls[0][2].timeout,15000);
    assert.ok(s.video.src.startsWith('https://storage.googleapis.com/'));
    assert.equal(s.video.paused,false);assert.equal(s.states.at(-1).status,'ready');s.player.dispose();
});
for(const status of [401,403,404,415,503,undefined])test(`controlled access error ${status??'network'}`,async()=>{
    const s=setup();s.api.post=async()=>{throw {response:{status},message:'secret-signature private-token'};};
    await s.player.play();assert.equal(s.states.at(-1).status,'error');assert.equal(s.video.src,'');
    assert.ok(!JSON.stringify(s.states).includes('secret-signature'));s.player.dispose();
});
test('expired access renews and restores seek position, volume and playback state',async()=>{
    const s=setup();await s.player.play();await s.metadata();
    s.video.currentTime=27;s.video.volume=.3;s.video.muted=true;s.video.playbackRate=1.25;
    s.advance(1800001);s.visible();await tick();
    assert.equal(s.calls.length,2);await s.metadata();
    assert.equal(s.video.currentTime,27);assert.equal(s.video.volume,.3);assert.equal(s.video.muted,true);
    assert.equal(s.video.playbackRate,1.25);assert.equal(s.video.paused,false);s.player.dispose();
});
test('paused expired access waits for a user action, then resumes at prior time',async()=>{
    const s=setup();await s.player.play();await s.metadata();s.video.currentTime=12;s.video.pause();await tick();
    s.advance(1800001);s.visible();await tick();assert.equal(s.calls.length,1);
    await s.player.play();await s.metadata();assert.equal(s.video.currentTime,12);assert.equal(s.calls.length,2);s.player.dispose();
});
test('renewal at a paused seek preserves pause',async()=>{
    const s=setup();await s.player.play();await s.metadata();s.video.pause();await tick();
    s.video.currentTime=42;s.advance(1800001);s.video.emit('seeking');await tick();await s.metadata();
    assert.equal(s.video.currentTime,42);assert.equal(s.video.paused,true);s.player.dispose();
});
test('renewal requests do not overlap',async()=>{
    const s=setup();let finish;
    s.api.post=(...args)=>new Promise(resolve=>{finish=()=>s.original(...args).then(resolve);});
    const a=s.player.play(),b=s.player.play();assert.equal(s.calls.length,0);
    finish();await Promise.all([a,b]);assert.equal(s.calls.length,1);s.player.dispose();
});
for(const next of [null,{uid:'bob'},{uid:'alice'}])test(`auth change clears playback and ignores late response: ${next?.uid??'logout'}`,async()=>{
    const s=setup();let finish;
    s.api.post=(...args)=>new Promise(resolve=>{finish=()=>s.original(...args).then(resolve);});
    const pending=s.player.play();s.change(next);finish();await pending;
    assert.equal(s.video.src,'');assert.equal(s.video.paused,true);assert.equal(s.states.at(-1).status,'error');s.player.dispose();
});
test('logout while playing removes source and cancels renewal timer',async()=>{
    const s=setup();await s.player.play();await s.metadata();assert.equal(s.timers.size,1);
    s.change(null);assert.equal(s.video.src,'');assert.equal(s.video.paused,true);assert.equal(s.timers.size,0);s.player.dispose();
});
test('unmount aborts request and never publishes the late response',async()=>{
    const s=setup();let finish;
    s.api.post=(...args)=>new Promise(resolve=>{finish=()=>s.original(...args).then(resolve);});
    const pending=s.player.play();s.player.dispose();const before=s.states.length;
    finish();await pending;assert.equal(s.calls[0][2].signal.aborted,true);
    assert.equal(s.states.length,before);assert.equal(s.video.src,'');
});
test('browser decode error is reported without an automatic signing loop',async()=>{
    const s=setup();await s.player.play();await s.metadata();s.video.emit('error');await tick();
    assert.equal(s.states.at(-1).status,'error');assert.equal(s.calls.length,1);assert.equal(s.video.src,'');s.player.dispose();
});
test('expired media error gets one renewal, and failure never loops',async()=>{
    const s=setup();await s.player.play();await s.metadata();s.advance(1800001);
    s.api.post=async()=>{throw Error('offline');};s.video.emit('error');await tick();
    assert.equal(s.states.at(-1).status,'error');s.video.emit('error');await tick();
    assert.equal(s.video.src,'');s.player.dispose();
});
test('timer renews only while playing',async()=>{
    const s=setup();await s.player.play();await s.metadata();
    const timer=[...s.timers.values()][0];assert.ok(timer.delay>0);s.advance(timer.delay);timer.fn();await tick();
    assert.equal(s.calls.length,2);await s.metadata();s.video.pause();await tick();assert.equal(s.timers.size,0);s.player.dispose();
});
for(const value of ['https://firebasestorage.googleapis.com/v0/b/demo/o/old.mp4?token=legacy',
                    'https://external.invalid/video.mp4','http://storage.googleapis.com/private?X-Goog-Signature=secret']) {
    test('never falls back to token or unrelated URLs from an invalid response',async()=>{
        const s=setup();s.api.post=async()=>({data:{url:value,expiresAt:'2099-01-01T00:00:00Z',expiresInSeconds:1800,mediaType:'video',contentType:'video/mp4'}});
        await s.player.play();assert.equal(s.states.at(-1).status,'error');assert.equal(s.video.src,'');s.player.dispose();
    });
}
test('player uses no persistence, full-file downloads or public fallback',()=>{
    for(const forbidden of ['localStorage','sessionStorage','getDownloadURL','getBlob','console.'])assert.ok(!source.includes(forbidden));
    const page=readFileSync(new URL('../src/pages/Library/Library.tsx',import.meta.url),'utf8');
    assert.ok(page.includes('itemId={item.id}'));assert.ok(!page.includes('src={item.videoUrl}'));
    assert.ok(page.includes('<PrivateLibraryImage'));assert.ok(page.includes('api.get<Blob>'));
    const component=readFileSync(new URL('../src/pages/Library/PrivateLibraryVideo.tsx',import.meta.url),'utf8');
    assert.ok(component.includes('controls playsInline preload="none"'));assert.ok(component.includes('player.dispose()'));
});
