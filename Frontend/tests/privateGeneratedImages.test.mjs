// Actual processor, result component and page callbacks; no Firebase/network I/O.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const read = path => readFileSync(new URL(`../src/${path}`,import.meta.url),'utf8');
const compile = code => ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const processor={exports:{}};
vm.runInNewContext(compile(read('pages/ImageGeneration/processImageResults.ts')),{module:processor,exports:processor.exports,URL});
function render(props,state={status:'success',url:'blob:private'},visible=true){
    const module={exports:{}},calls=[];
    vm.runInNewContext(compile(read('pages/ImageGeneration/PrivateGeneratedImage.tsx')),{module,exports:module.exports,
        require(name){
            if(name==='react')return {useEffect(){},useRef:()=>({current:null}),useState:value=>[value===false?visible:value,()=>{}]};
            if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
            if(name==='../../hooks/usePrivateImage')return {usePrivateImage:(value,uid,enabled)=>{
                calls.push({value,uid,enabled});return enabled?state:{status:'loading'};
            }};
            throw Error(name);
        },
    });
    return {tree:module.exports.default(props),calls};
}
const resultAddress=(index,token=true)=>`https://firebasestorage.googleapis.com/v0/b/demo/o/users%2Falice%2Fimages%2Fbatch%2F${index}%2Fresult.png${token?'?token=old-secret':''}`;
for(const count of [1,4,9,5,10])test(`private presentation preserves ${count} ordered results including extra grids`,async()=>{
    const saved=[],registered=[];
    const outcome=await processor.exports.processImageResults(Array.from({length:count},(_,index)=>`https://provider.invalid/${index}.png`),'alice','batch',{
        upload:async(_url,folder)=>resultAddress(Number(folder.split('/').at(-1))),
        onSaved:url=>saved.push(url),register:async(...args)=>registered.push(args),
    });
    assert.equal(outcome.total,count);assert.equal(saved.length,count);assert.equal(registered.length,count);
    for(const [index,value]of saved.entries()){
        assert.equal(value,resultAddress(index));
        const {tree,calls}=render({value,uid:'alice',index},{status:'success',url:`blob:result-${index}`});
        assert.equal(tree.props.children.type,'img');
        assert.equal(tree.props.children.props.src,`blob:result-${index}`);
        assert.equal(tree.props.children.props.alt,`Imagem gerada ${index+1}`);
        assert.equal(calls[0].value,value);
        assert.equal(calls[0].uid,'alice');
        assert.ok(!JSON.stringify(tree).includes('old-secret'));
    }
});
for(const token of [true,false])test(`same private reader handles ${token?'legacy token':'token-free'} reference`,()=>{
    const value=resultAddress(0,token);
    const {tree,calls}=render({value,uid:'alice',index:0});
    assert.equal(calls[0].value,value);assert.equal(tree.props.children.props.src,'blob:private');
});
for(const message of ['Erro de permissão','Objeto inexistente','Falha de autenticação'])test(`read failure: ${message} preserves saved result and avoids public fallback`,()=>{
    const {tree}=render({value:resultAddress(0),uid:'alice',index:0},{status:'error',message});
    assert.equal(tree.props.children.type,'p');assert.equal(tree.props.children.props.role,'alert');
    assert.match(JSON.stringify(tree),/salva/);assert.match(JSON.stringify(tree),/preservado/);
    assert.ok(!JSON.stringify(tree).includes('token='));
    assert.ok(!JSON.stringify(tree).includes('https://'));
});
test('offscreen image waits for demand through shared hook',()=>{
    const {tree,calls}=render({value:resultAddress(0),uid:'alice',index:0},undefined,false);
    assert.equal(calls[0].enabled,false);assert.equal(tree.props.children.props.role,'status');
});
test('partial upload, registration and read failures preserve saved order',async()=>{
    const saved=[],registered=[];let index=0;
    const outcome=await processor.exports.processImageResults(['https://provider.invalid/0','https://provider.invalid/1','https://provider.invalid/2'],'alice','batch',{
        upload:async()=>{const i=index++;if(i===1)throw Error('upload');return resultAddress(i);},
        onSaved:url=>saved.push(url),register:async(_uid,url)=>{if(url===resultAddress(2))throw Error('register');registered.push(url);},
    });
    assert.deepEqual(saved,[resultAddress(0),resultAddress(2)]);
    assert.deepEqual(registered,[resultAddress(0)]);
    assert.equal(outcome.uploadFailures,1);assert.equal(outcome.libraryFailures,1);
    const cards=saved.map((value,index)=>render({value,uid:'alice',index},index?{status:'error',message:'read failed'}:undefined).tree);
    assert.equal(cards.length,2);assert.equal(cards[0].props.children.type,'img');assert.equal(cards[1].props.children.props.role,'alert');
});

const source=read('pages/ImageGeneration/ImageGeneration.tsx');
const ast=ts.createSourceFile('ImageGeneration.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let onSaved,visibleExpression;
function visit(node){
    if(ts.isPropertyAssignment(node)&&node.name.getText(ast)==='onSaved')onSaved=node.initializer.getText(ast);
    if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='visibleImages')visibleExpression=node.initializer.getText(ast);
    ts.forEachChild(node,visit);
}
visit(ast);
test('page discards late presentation callbacks after account change or unmount',()=>{
    const owner={uid:'alice'},scope={user:owner,auth:{currentUser:owner},pageMounted:{current:true},generatedImages:[]};
    scope.setGeneratedImages=update=>{scope.generatedImages=update(scope.generatedImages);};
    vm.createContext(scope);vm.runInContext(compile(`globalThis.saved = ${onSaved};`),scope);
    scope.saved(resultAddress(0));assert.equal(scope.generatedImages.length,1);
    scope.auth.currentUser={uid:'bob'};scope.saved(resultAddress(1));assert.equal(scope.generatedImages.length,1);
    scope.auth.currentUser=owner;scope.pageMounted.current=false;scope.saved(resultAddress(2));assert.equal(scope.generatedImages.length,1);
    scope.user={uid:'bob'};
    assert.equal(vm.runInContext(visibleExpression,scope).length,0);
    scope.user=null;assert.equal(vm.runInContext(visibleExpression,scope).length,0);
    // Even a new login to the same UID cannot inherit the old session's cards.
    scope.user={uid:'alice'};assert.equal(vm.runInContext(visibleExpression,scope).length,0);
});
test('page delegates individual results and retains existing processing and warnings',()=>{
    assert.ok(source.includes('<PrivateGeneratedImage'));
    assert.ok(!source.includes('src={url}'));
    assert.ok(source.includes('result.imageUrls'));
    assert.ok(source.includes('register: createLibraryImage'));
    assert.ok(source.includes('outcome.uploadFailures'));
    assert.ok(source.includes('outcome.libraryFailures'));
    assert.ok(!read('pages/ImageGeneration/PrivateGeneratedImage.tsx').includes('getDownloadURL'));
});
