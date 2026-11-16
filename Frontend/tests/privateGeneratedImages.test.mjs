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
            if(name==='react')return {useEffect(){},useRef:()=>({current:null}),useState:value=>[value && typeof value==='object' && 'activated' in value?{...value,activated:visible}:value,()=>{}]};
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
    const owner={uid:'alice'},scope={user:owner,auth:{currentUser:owner},pageMounted:{current:true},generatedImages:[],hasGroupedPreview:false};
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

// Actual component, hook and loader with offline React/observer/Firebase primitives.
function lifecycle(){
 const auth={currentUser:{uid:'alice'}},listeners=new Set(),observers=[],calls=[],created=[],revoked=[],slots=[],effects=[];
 let cursor=0,dirty=false,tree,props={value:resultAddress(0),uid:'alice',index:0};
 const react={
  useRef(){const i=cursor++;return slots[i]??={current:{}};},
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],next=>{const v=typeof next==='function'?next(slots[i]):next;if(!Object.is(v,slots[i])){slots[i]=v;dirty=true;}}];},
  useEffect(setup,deps){const i=cursor++,old=effects[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j])))effects[i]={deps,setup,cleanup:old?.cleanup,pending:true};},
 };
 class Observer{
  constructor(callback){this.callback=callback;this.connected=false;observers.push(this);}
  observe(){this.connected=true;} disconnect(){this.connected=false;}
  notify(visible,queued=false){if(this.connected||queued)this.callback([{isIntersecting:visible}]);}
 }
 const sdk={ref:(_,path='')=>({bucket:'demo',fullPath:path}),
  getMetadata:async()=>{calls.push('metadata');return {contentType:'image/png',size:5};},
  getBlob:async()=>{calls.push('blob');return {type:'image/png',size:5};}};
 const modules={};
 function load(path){const module={exports:{}};vm.runInNewContext(compile(read(path)),{module,exports:module.exports,queueMicrotask,IntersectionObserver:Observer,
  URL:{createObjectURL(){const url=`blob:lifecycle-${created.length}`;created.push(url);return url;},revokeObjectURL:url=>revoked.push(url)},
  require(name){if(name==='react')return react;if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
   if(name==='firebase/storage')return sdk;
   if(name==='firebase/auth')return {onAuthStateChanged:(_,cb)=>{listeners.add(cb);return()=>listeners.delete(cb);}};
   if(name==='../firebase/auth')return {__esModule:true,default:auth};
   if(name==='../firebase/storage')return {__esModule:true,default:{}};
   if(name==='./storageReferences')return modules.resolver;
   if(name==='../services/privateImages')return modules.reader;
   if(name==='../../hooks/usePrivateImage')return modules.hook;
   throw Error(name);}});return module.exports;}
 modules.resolver=load('services/storageReferences.ts');modules.reader=load('services/privateImages.ts');modules.hook=load('hooks/usePrivateImage.ts');
 const Component=load('pages/ImageGeneration/PrivateGeneratedImage.tsx').default;
 function flush(){let rounds=0;do{dirty=false;cursor=0;tree=Component(props);for(const e of effects.filter(Boolean))if(e.pending){e.pending=false;e.cleanup?.();e.cleanup=e.setup();}assert.ok(++rounds<20,'render loop');}while(dirty);}
 flush();return {calls,created,revoked,observers,sdk,get child(){return tree.props.children;},
  render(next={}){props={...props,...next};flush();},
  async settle(){await new Promise(resolve=>setImmediate(resolve));flush();},
  notify(v){observers.at(-1).notify(v);flush();},
  change(user){auth.currentUser=user;for(const cb of [...listeners])cb(user);flush();},
  strictReplay(){for(const e of effects.filter(Boolean)){e.cleanup?.();e.cleanup=e.setup();}flush();},
  unmount(){for(const e of effects.filter(Boolean))e.cleanup?.();},
 };
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('visibility loads once; scrolling and parent prompt/config renders keep the same Blob URL',async()=>{
 const s=lifecycle();await s.settle();assert.deepEqual(s.calls,[]);s.notify(false);await s.settle();assert.deepEqual(s.calls,[]);
 s.notify(true);await s.settle();assert.equal(s.child.type,'img');const url=s.child.props.src;
 assert.equal(s.observers[0].connected,false);s.observers[0].notify(false,true);s.render({prompt:'changed',quantity:9});s.notify(true);await s.settle();
 assert.equal(s.child.props.src,url);assert.deepEqual(s.calls,['metadata','blob']);assert.deepEqual(s.revoked,[]);
 s.unmount();await tick();assert.deepEqual(s.revoked,[url]);
});
test('new image identity waits for visibility and discards callbacks from the previous observer',async()=>{
 const s=lifecycle();s.notify(true);await s.settle();const old=s.child.props.src;
 s.render({value:resultAddress(1)});assert.notEqual(s.child.type,'img');s.observers[0].notify(true,true);await s.settle();
 assert.equal(s.calls.length,2);assert.deepEqual(s.revoked,[old]);s.notify(true);await s.settle();
 assert.equal(s.child.type,'img');assert.notEqual(s.child.props.src,old);assert.equal(s.calls.length,4);s.unmount();
});
for(const user of [null,{uid:'bob'},{uid:'alice'}])test(`session change invalidates loaded image (${user?.uid??'logout'})`,async()=>{
 const s=lifecycle();s.notify(true);await s.settle();const url=s.child.props.src;s.change(user);
 assert.notEqual(s.child.type,'img');assert.deepEqual(s.revoked,[url]);s.render({uid:user?.uid??'alice'});await s.settle();assert.notEqual(s.child.type,'img');s.unmount();
});
test('late download after unmount cannot allocate an Object URL',async()=>{
 const s=lifecycle();let finish;s.sdk.getBlob=()=>new Promise(resolve=>{finish=resolve;});s.notify(true);await s.settle();s.unmount();await tick();
 finish({type:'image/png',size:5});await tick();assert.deepEqual(s.created,[]);
});
test('StrictMode effect replay retains active read without persistent reload',async()=>{
 const s=lifecycle();s.strictReplay();s.notify(true);s.strictReplay();await s.settle();assert.equal(s.child.type,'img');const url=s.child.props.src;
 s.notify(false);s.render();await s.settle();assert.equal(s.child.props.src,url);assert.deepEqual(s.calls,['metadata','blob']);assert.deepEqual(s.revoked,[]);s.unmount();
});
test('network errors remain visible without automatic retry when leaving the viewport',async()=>{
 const s=lifecycle();let reads=0;s.sdk.getBlob=async()=>{reads++;throw Error('private diagnostic');};s.notify(true);await s.settle();
 assert.equal(s.child.props.role,'alert');assert.ok(!JSON.stringify(s.child).includes('private diagnostic'));s.notify(false);s.render();await s.settle();
 assert.equal(s.child.props.role,'alert');assert.equal(reads,1);s.unmount();
});

test('returning to an earlier reference also waits for a new visibility activation',async()=>{
 const s=lifecycle();s.notify(true);await s.settle();s.render({value:resultAddress(1)});s.render({value:resultAddress(0)});
 await s.settle();assert.notEqual(s.child.type,'img');assert.equal(s.calls.length,2);
 s.notify(true);await s.settle();assert.equal(s.child.type,'img');assert.equal(s.calls.length,4);s.unmount();
});

for(const [quantity,count] of [[1,1],[4,5],[9,10],[4,4],[9,9]])test(`page presents ${quantity} individual images from ${count} files without changing saved records`,async()=>{
 const user={uid:'alice'},scope={user,auth:{currentUser:user},pageMounted:{current:true},generatedImages:[],hasGroupedPreview:count===quantity+1};
 scope.setGeneratedImages=update=>{scope.generatedImages=update(scope.generatedImages);};
 vm.createContext(scope);vm.runInContext(compile(`globalThis.saved = ${onSaved};`),scope);
 const registered=[];
 await processor.exports.processImageResults(Array.from({length:count},(_,i)=>`https://provider.invalid/${i}.png`),'alice','batch',{
  upload:async(_url,folder)=>resultAddress(Number(folder.split('/').at(-1))),
  register:async(_uid,url)=>registered.push(url),onSaved:scope.saved,
 });
 const visible=vm.runInContext(visibleExpression,scope);
 assert.equal(scope.generatedImages.length,count);assert.equal(registered.length,count);assert.equal(visible.length,quantity);
 const expected=Array.from({length:quantity},(_,i)=>resultAddress(i+(scope.hasGroupedPreview?1:0)));
 assert.deepEqual(Array.from(visible,image=>image.url),expected);
});
test('a failed montage upload never hides the first successfully saved individual image',async()=>{
 const user={uid:'alice'},scope={user,auth:{currentUser:user},pageMounted:{current:true},generatedImages:[],hasGroupedPreview:true};
 scope.setGeneratedImages=update=>{scope.generatedImages=update(scope.generatedImages);};
 vm.createContext(scope);vm.runInContext(compile(`globalThis.saved = ${onSaved};`),scope);
 await processor.exports.processImageResults(Array.from({length:5},(_,i)=>`https://provider.invalid/${i}.png`),'alice','batch',{
  upload:async(_url,folder)=>{const index=Number(folder.split('/').at(-1));if(index===0)throw Error('upload failed');return resultAddress(index);},
  register:async()=>{},onSaved:scope.saved,
 });
 assert.equal(vm.runInContext(visibleExpression,scope).length,4);
});
