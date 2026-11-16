import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {imageBytes} from './fixtures/generatedImages.mjs';
const source=ts.transpileModule(readFileSync(new URL('../src/services/prepareGeneratedImage.ts',import.meta.url),'utf8'),{
    compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS},
}).outputText;
function setup(extra={}) {
    const module={exports:{}};let expiry,clears=0;
    vm.runInNewContext(source,{module,exports:module.exports,File,Blob,Uint8Array,DataView,
        setTimeout:fn=>{expiry=fn;return 1;},clearTimeout:()=>clears++, ...extra});
    return {...module.exports,expire:()=>expiry(),clears:()=>clears};
}
test('successful native decode closes bitmap and clears deadline',async()=>{
    let closed=0;
    const s=setup({createImageBitmap:async()=>({width:2,height:3,close:()=>closed++})});
    const file=await s.prepareGeneratedImage(new Blob([imageBytes('jpeg')],{type:'application/octet-stream'}));
    assert.equal(file.type,'image/jpeg');assert.equal(file.name,'generated-image.jpg');
    assert.equal(closed,1);assert.equal(s.clears(),1);
});
test('late bitmap after decode timeout is still released',async()=>{
    let finish,closed=0;
    const s=setup({createImageBitmap:()=>new Promise(resolve=>{finish=resolve;})});
    const pending=s.prepareGeneratedImage(new Blob([imageBytes('png')]));
    // arrayBuffer and signature validation finish before the decoder is invoked.
    while(!finish) await new Promise(resolve=>setImmediate(resolve));
    const rejection=assert.rejects(pending,/inválida/);
    s.expire();await rejection;
    finish({width:2,height:3,close:()=>closed++});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(closed,1);
});
for(const failed of [false,true])test(`HTML image decoder fallback cleans local URL (${failed?'failure':'success'})`,async()=>{
    const revoked=[],removed=[];
    class Image {
        naturalWidth=2;naturalHeight=3;
        set src(value){queueMicrotask(()=>{if(failed)this.onerror?.();else this.onload?.();});}
        removeAttribute(name){removed.push(name);}
    }
    const s=setup({Image,URL:{createObjectURL:()=> 'blob:local',revokeObjectURL:url=>revoked.push(url)}});
    const pending=s.prepareGeneratedImage(new Blob([imageBytes('webp')]));
    if(failed)await assert.rejects(pending,/inválida/);else assert.equal((await pending).type,'image/webp');
    assert.deepEqual(revoked,['blob:local']);assert.deepEqual(removed,['src']);assert.equal(s.clears(),1);
});
