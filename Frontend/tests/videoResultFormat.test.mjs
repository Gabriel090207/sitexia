import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023}}).outputText;
// Container identification fixture; native media events are explicitly simulated.
const mp4 = new Uint8Array([0,0,0,24,...Buffer.from('ftypisom'),0,0,0,0,...Buffer.from('iso2mp41')]);
function setup({valid=true,width=960,height=1632,duration=5,stalled=false}={}) {
    const blobs=[],revoked=[],videos=[];let timeout;
    const scope={module:{exports:{}},File,Uint8Array,DataView,
        setTimeout: fn => {timeout=fn;return 1;}, clearTimeout:()=>{timeout=undefined;},
        URL:{createObjectURL:blob=>{blobs.push(blob);return 'blob:local';},revokeObjectURL:url=>revoked.push(url)},
        document:{createElement:tag=>{
            assert.equal(tag,'video');
            const video={videoWidth:width,videoHeight:height,duration,src:'',pause(){},
                removeAttribute(){this.src='';},load(){if(this.src&&!stalled)queueMicrotask(()=>valid?this.onloadeddata?.():this.onerror?.());}};
            videos.push(video);return video;
        }},
    };
    scope.exports=scope.module.exports;
    vm.runInNewContext(compile(read('../src/pages/VideoGeneration/prepareVideoFile.ts')),scope);
    return {prepare:scope.module.exports.prepareVideoFile,blobs,revoked,videos,expire:()=>timeout?.()};
}
for(const type of ['video/mp4','application/octet-stream',''])test(`validated MP4 uses video/mp4: ${type||'absent'}`,async()=>{
    const s=setup();const file=await s.prepare(new Blob([mp4],{type}));
    assert.equal(file.type,'video/mp4');assert.match(file.name,/\.mp4$/);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()),mp4);
    assert.equal(s.blobs[0],file);assert.deepEqual(s.revoked,['blob:local']);
    assert.equal(s.videos[0].src,'');assert.equal(s.videos[0].onloadeddata,null);
});
for(const type of ['application/octet-stream','','video/mp4'])for(const bytes of ['<html>error</html>','{"error":true}','arbitrary',mp4.slice(0,15)])test(`invalid bytes rejected for ${type||'absent'}`,async()=>{
    const s=setup();await assert.rejects(s.prepare(new Blob([bytes],{type})));
    assert.equal(s.blobs.length,0);
});
for(const options of [{valid:false},{width:0,height:0},{duration:Infinity},{duration:0}])test(`MP4 brand alone does not prove a playable video: ${JSON.stringify(options)}`,async()=>{
    const s=setup(options);await assert.rejects(s.prepare(new Blob([mp4],{type:'application/octet-stream'})));
    assert.deepEqual(s.revoked,['blob:local']);
});
for(const type of ['video/webm','video/quicktime','video/ogg','video/x-m4v','video/x-matroska','video/x-msvideo','video/avi','video/mpeg','video/x-ms-wmv'])test(`preserves supported browser-validated format ${type}`,async()=>{
    const s=setup();const file=await s.prepare(new Blob(['container bytes'],{type}));
    assert.equal(file.type,type);assert.ok(!file.name.endsWith('.mp4'));
});
test('empty, HTML, JSON and unsupported declarations never reach media loading',async()=>{
    const s=setup();
    for(const blob of [new Blob([],{type:'video/mp4'}),new Blob([mp4],{type:'text/html'}),new Blob([mp4],{type:'application/json'}),new Blob([mp4],{type:'video/unknown'})])await assert.rejects(s.prepare(blob));
    assert.equal(s.blobs.length,0);
});
test('stalled media validation expires and cleans up the local URL',async()=>{
    const s=setup({stalled:true});const pending=s.prepare(new Blob([mp4],{type:'video/mp4'}));
    while(!s.videos.length)await new Promise(resolve=>setImmediate(resolve));
    s.expire();await assert.rejects(pending);assert.deepEqual(s.revoked,['blob:local']);
});
test('real videoUrlToFile delegates the response blob and stops on HTTP errors',async()=>{
    const source=read('../src/pages/VideoGeneration/VideoGeneration.tsx');
    const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let fn;
    function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='videoUrlToFile')fn=node.getText(ast);ts.forEachChild(node,visit);}visit(ast);
    const blob=new Blob([mp4],{type:'application/octet-stream'});const prepared={};let checks=0,ok=true;
    const scope={fetch:async()=>({ok,blob:async()=>blob}),prepareVideoFile:async value=>{assert.equal(value,blob);checks++;return prepared;}};
    vm.runInNewContext(compile(fn+'\nglobalThis.run=videoUrlToFile;'),scope);
    assert.equal(await scope.run('https://provider.invalid/result'),prepared);assert.equal(checks,1);
    ok=false;await assert.rejects(scope.run('https://provider.invalid/result'));assert.equal(checks,1);
});
