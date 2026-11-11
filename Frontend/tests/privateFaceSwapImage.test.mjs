import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const read=path=>readFileSync(new URL(`../src/${path}`,import.meta.url),'utf8');
const source=read('pages/FaceSwap/PrivateFaceSwapImage.tsx');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function render(image){
    const module={exports:{}},calls=[],effects=[],urls=[];
    vm.runInNewContext(code,{module,exports:module.exports,require(name){
        if(name==='react')return {useState:value=>[value,()=>{}],useEffect:callback=>effects.push(callback)};
        if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
        if(name==='../../hooks/usePrivateImage')return {usePrivateImage:(...args)=>{calls.push(args);return image;}};
        throw Error(name);
    }});
    const tree=module.exports.default({value:'https://firebase.invalid/reference?token=legacy',uid:'alice',onUrlChange:url=>urls.push(url)});
    return {tree,calls,effects,urls};
}
test('successful display and existing open button receive only the shared local blob URL',()=>{
    const state=render({status:'success',url:'blob:private'});
    assert.equal(state.tree.type,'img');assert.equal(state.tree.props.src,'blob:private');
    assert.equal(state.calls[0][1],'alice');assert.equal(state.calls[0][2],true);
    const cleanup=state.effects[0]();assert.deepEqual(state.urls,['blob:private']);
    cleanup();assert.deepEqual(state.urls,['blob:private','']);
    assert.ok(!JSON.stringify(state.tree).includes('token='));
});
for(const message of ['Permission denied','Object missing','Authentication failed'])test(`saved image read failure: ${message}`,()=>{
    const {tree}=render({status:'error',message});
    assert.equal(tree.props.role,'alert');assert.match(JSON.stringify(tree),/concluído/);
    assert.match(JSON.stringify(tree),/preservada/);assert.ok(!JSON.stringify(tree).includes('token='));
});
test('private read loading is distinct from generation failure',()=>{
    assert.equal(render({status:'loading'}).tree.props.role,'status');
});
test('page gates image reader by confirmed type and saved reference',()=>{
    const page=read('pages/FaceSwap/FaceSwap.tsx');
    assert.ok(page.includes('activeResult.kind === "image" && activeResult.reference'));
    assert.ok(page.includes('value={activeResult.reference}'));
    assert.ok(!page.includes('src={resultUrl}'));
    assert.ok(!source.includes('getDownloadURL'));
    assert.ok(!source.includes('createObjectURL')); // Only shared service owns URLs.
});
