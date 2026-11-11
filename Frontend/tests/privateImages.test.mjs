// Real resolver and loader with offline Firebase/Auth/URL primitives.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const read = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const compile = value => ts.transpileModule(value, { compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS,
} }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
const address = (name='one.png', token=true) => `https://firebasestorage.googleapis.com/v0/b/demo/o/users%2Falice%2Fimages%2F${name}${token ? '?token=private-token' : ''}`;
function setup() {
    const auth = { currentUser: { uid:'alice' } }, authListeners = new Set();
    const calls = [], created = [], revoked = [];
    const storage = {};
    const sdk = {
        ref: (_,path='') => ({ bucket:'demo', fullPath:path }),
        getMetadata: async reference => { calls.push(['metadata',reference]); return { contentType:'image/png',size:5 }; },
        getBlob: async (reference,limit) => { calls.push(['blob',reference,limit]); return { type:'image/png',size:5 }; },
        getDownloadURL() { throw new Error('Token fallback forbidden'); },
    };
    const resolver = { exports:{} }, module = { exports:{} };
    const common = { queueMicrotask, console:new Proxy({}, { get() { throw Error('No logging'); } }),
        URL:{ createObjectURL: blob => { const url=`blob:local-${created.length}`; created.push({url,blob}); return url; },
            revokeObjectURL:url => revoked.push(url) },
        require(name) {
            if(name==='firebase/storage') return sdk;
            if(name==='firebase/auth') return { onAuthStateChanged: (_,callback) => {
                authListeners.add(callback); return () => authListeners.delete(callback);
            } };
            if(name==='../firebase/auth') return { __esModule:true,default:auth };
            if(name==='../firebase/storage') return { __esModule:true,default:storage };
            if(name==='./storageReferences') return resolver.exports;
            throw Error(`Unexpected module ${name}`);
        },
    };
    vm.runInNewContext(compile(read('services/storageReferences.ts')), {...common,module:resolver,exports:resolver.exports});
    vm.runInNewContext(compile(read('services/privateImages.ts')), {...common,module,exports:module.exports});
    return { sdk,calls,created,revoked,auth,subscribe:module.exports.subscribePrivateImage,
        change(user) { auth.currentUser=user; for(const callback of [...authListeners]) callback(user); } };
}
for(const token of [true,false]) test(`private own image with ${token?'legacy token':'token-free reference'}`,async()=>{
    const s=setup(), states=[];
    const stop=s.subscribe(address('one.png',token),'alice',state=>states.push(state));
    await tick();
    assert.equal(states[0].status,'loading');
    assert.equal(states.at(-1).url,'blob:local-0');
    assert.equal(s.calls[1][1].fullPath,'users/alice/images/one.png');
    assert.ok(!JSON.stringify(s.calls).includes('private-token'));
    stop(); await tick();
    assert.deepEqual(s.revoked,['blob:local-0']);
});
for(const [name,value,uid] of [
    ['other owner',address().replace('alice','bob'),'alice'],['invalid','https://external.invalid/a.png','alice'],
    ['wrong session',address(),'bob'],
]) test(`rejects ${name} before reading Storage`,async()=>{
    const s=setup(),states=[];
    s.subscribe(value,uid,state=>states.push(state)); await tick();
    assert.equal(states.at(-1).status,'error'); assert.equal(s.calls.length,0);
});
test('anonymous session cannot read',async()=>{
    const s=setup(),states=[]; s.change(null);
    s.subscribe(address(),'alice',state=>states.push(state)); await tick();
    assert.equal(states.at(-1).status,'error'); assert.equal(s.calls.length,0);
});
for(const code of ['storage/unauthorized','storage/object-not-found','storage/unauthenticated']) {
    test(`handles ${code} without fallback or sensitive details`,async()=>{
        const s=setup(),states=[];
        s.sdk.getBlob=async()=>{ throw { code,message:'private-token private-url' }; };
        s.subscribe(address(),'alice',state=>states.push(state)); await tick();
        assert.equal(states.at(-1).status,'error');
        assert.ok(!JSON.stringify(states).includes('private-token'));
        assert.equal(s.created.length,0);
    });
}
test('shares active reads across legacy and token-free references, releases only last subscriber',async()=>{
    const s=setup(),a=[],b=[];
    const stopA=s.subscribe(address(),'alice',state=>a.push(state));
    const stopB=s.subscribe(address('one.png',false),'alice',state=>b.push(state));
    await tick();
    assert.equal(s.calls.filter(([kind])=>kind==='blob').length,1);
    assert.equal(a.at(-1).url,b.at(-1).url);
    stopA();await tick();assert.equal(s.revoked.length,0);
    stopB();await tick();assert.equal(s.revoked.length,1);
});
test('unmounted subscriber never receives late result or allocates a URL',async()=>{
    const s=setup(),states=[];let finish;
    s.sdk.getBlob=()=>new Promise(resolve=>{finish=resolve;});
    const stop=s.subscribe(address(),'alice',state=>states.push(state));await tick();
    stop();await tick();finish({type:'image/png',size:5});await tick();
    assert.equal(states.length,1);assert.equal(s.created.length,0);
});
for(const next of [null,{uid:'bob'},{uid:'alice'}]) test(`invalidates late data on auth change ${next?.uid??'logout'}`,async()=>{
    const s=setup(),states=[];let finish;
    s.sdk.getBlob=()=>new Promise(resolve=>{finish=resolve;});
    s.subscribe(address(),'alice',state=>states.push(state));await tick();
    s.change(next);finish({type:'image/png',size:5});await tick();
    assert.equal(states.at(-1).status,'error');assert.equal(s.created.length,0);
});
test('logout revokes visible images and does not share cache with another session',async()=>{
    const s=setup(),states=[];
    s.subscribe(address(),'alice',state=>states.push(state));await tick();
    s.change(null);assert.deepEqual(s.revoked,['blob:local-0']);
    assert.equal(states.at(-1).status,'error');
    s.change({uid:'alice'});
    const stop=s.subscribe(address(),'alice',()=>{});await tick();
    assert.equal(s.created.length,2);stop();await tick();
});
test('multiple images use at most three concurrent downloads',async()=>{
    const s=setup(),pending=[],stops=[];let active=0,max=0;
    s.sdk.getBlob=()=>{active++;max=Math.max(max,active);return new Promise(resolve=>pending.push(()=>{active--;resolve({type:'image/png',size:5});}));};
    for(let n=0;n<9;n++)stops.push(s.subscribe(address(`${n}.png`),'alice',()=>{}));
    await tick();assert.equal(pending.length,3);
    for(let n=0;n<9;n++){pending.shift()();await tick();}
    assert.equal(max,3);assert.equal(s.created.length,9);
    for(const stop of stops)stop();await tick();assert.equal(s.revoked.length,9);
});
test('rejects legacy videos before downloading or attempting image display',async()=>{
    const s=setup(),states=[];
    s.sdk.getMetadata=async()=>({contentType:'video/mp4',size:5});
    s.sdk.getBlob=()=>assert.fail('must not download video as image');
    s.subscribe(address('legacy.mp4'),'alice',state=>states.push(state));await tick();
    assert.equal(states.at(-1).status,'error');assert.match(states.at(-1).message,/Vídeos legados/);
    assert.equal(s.created.length,0);
});
test('limits per-image size and active object URL bytes',async()=>{
    const s=setup(),states=[],stops=[];
    s.sdk.getMetadata=async()=>({contentType:'image/png',size:33*1024*1024});
    s.subscribe(address('large.png'),'alice',state=>states.push(state));await tick();
    assert.equal(states.at(-1).status,'error');assert.equal(s.created.length,0);
    s.sdk.getMetadata=async()=>({contentType:'image/png',size:32*1024*1024,generation:'1'});
    s.sdk.getBlob=async()=>({type:'image/png',size:32*1024*1024});
    for(let n=0;n<5;n++)stops.push(s.subscribe(address(`bounded-${n}.png`),'alice',state=>states.push(state)));
    await tick();assert.equal(s.created.length,4);assert.equal(states.at(-1).status,'error');
    for(const stop of stops)stop();await tick();assert.equal(s.revoked.length,4);
});

for (const mime of ['image/png','image/jpeg','image/webp']) {
    test(`bounded SDK empty MIME is restored from validated ${mime} metadata`,async()=>{
        const s=setup(),states=[];
        s.sdk.getMetadata=async()=>({contentType:mime,size:5,generation:'1'});
        const bounded=new Blob(['12345']);
        s.sdk.getBlob=async(_reference,limit)=>{assert.equal(limit,32*1024*1024);return bounded;};
        const stop=s.subscribe(address(),'alice',state=>states.push(state));await tick();
        assert.equal(states.at(-1).status,'success');assert.equal(s.created[0].blob.type,mime);
        assert.equal(await s.created[0].blob.text(),'12345');assert.equal(s.created[0].blob.size,5);
        stop();await tick();assert.equal(s.revoked.length,1);
    });
    test(`already-correct ${mime} Blob is preserved without rewriting`,async()=>{
        const s=setup();
        s.sdk.getMetadata=async()=>({contentType:mime,size:5,generation:'1'});
        const blob=new Blob(['12345'],{type:mime});
        blob.slice=()=>assert.fail('correct MIME must not be rewritten');
        s.sdk.getBlob=async()=>blob;
        const stop=s.subscribe(address(),'alice',()=>{});await tick();
        assert.equal(s.created[0].blob,blob);stop();await tick();
    });
}
for(const mime of ['image/jpeg','video/mp4','text/html','application/octet-stream'])test(`nonempty conflicting Blob MIME ${mime} is rejected`,async()=>{
    const s=setup(),states=[];
    s.sdk.getBlob=async()=>new Blob(['12345'],{type:mime});
    s.subscribe(address(),'alice',state=>states.push(state));await tick();
    assert.equal(states.at(-1).status,'error');assert.equal(s.created.length,0);
});
for(const bytes of ['','1234','123456'])test(`received size ${bytes.length} cannot masquerade as metadata size 5`,async()=>{
    const s=setup(),states=[];s.sdk.getBlob=async()=>new Blob([bytes]);
    s.subscribe(address(),'alice',state=>states.push(state));await tick();
    assert.equal(states.at(-1).status,'error');assert.equal(s.created.length,0);
});
for(const size of [0,-1,1.5,NaN,33*1024*1024])test(`invalid or excessive metadata size ${size} rejects before download`,async()=>{
    const s=setup(),states=[];s.sdk.getMetadata=async()=>({contentType:'image/png',size});
    s.sdk.getBlob=()=>assert.fail('must retain bounded download');
    s.subscribe(address(),'alice',state=>states.push(state));await tick();
    assert.equal(states.at(-1).status,'error');assert.equal(s.created.length,0);
});
test('exact-limit slice cannot hide a larger replacement object',async()=>{
    const s=setup(),states=[];let reads=0;
    s.sdk.getMetadata=async()=>++reads===1?{contentType:'image/png',size:32*1024*1024,generation:'1'}:
        {contentType:'image/png',size:33*1024*1024,generation:'2'};
    s.sdk.getBlob=async()=>({type:'',size:32*1024*1024,slice:()=>assert.fail('truncated data must not be accepted')});
    s.subscribe(address(),'alice',state=>states.push(state));await tick();
    assert.equal(reads,2);assert.equal(states.at(-1).status,'error');assert.equal(s.created.length,0);
});
test('logout before an empty-MIME response prevents restoration and local URLs',async()=>{
    const s=setup(),states=[];let finish;
    s.sdk.getBlob=()=>new Promise(resolve=>{finish=resolve;});
    s.subscribe(address(),'alice',state=>states.push(state));await tick();s.change(null);
    finish({type:'',size:5,slice:()=>assert.fail('must ignore late result')});await tick();
    assert.equal(states.at(-1).status,'error');assert.equal(s.created.length,0);
});
test('stable exact-limit object with empty MIME is accepted after version check',async()=>{
    const s=setup(),states=[];let reads=0;
    const size=32*1024*1024;
    s.sdk.getMetadata=async()=>{reads++;return {contentType:'image/png',size,generation:'7'};};
    s.sdk.getBlob=async(_reference,limit)=>{
        assert.equal(limit,size);
        return {type:'',size,slice:(start,end,type)=>{
            assert.equal(start,0);assert.equal(end,size);assert.equal(type,'image/png');return {type,size};
        }};
    };
    const stop=s.subscribe(address(),'alice',state=>states.push(state));await tick();
    assert.equal(reads,2);assert.equal(states.at(-1).status,'success');assert.equal(s.created[0].blob.type,'image/png');
    stop();await tick();assert.equal(s.revoked.length,1);
});
