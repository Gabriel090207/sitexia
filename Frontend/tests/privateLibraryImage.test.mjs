// Exercise actual visibility effect and JSX branches with lightweight hook mocks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const read = file => readFileSync(new URL(`../src/${file}`,import.meta.url),'utf8');
const compile = source => ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;

test('image starts on demand, uses only local URL, stops observing on unmount',()=>{
    let visible=false,index=0,effect,observerCallback,disconnected=false,received;
    const state={status:'success',url:'blob:private'};
    const module={exports:{}};
    class Observer {
        constructor(callback,options){observerCallback=callback;assert.equal(options.rootMargin,'200px');}
        observe(){}
        disconnect(){disconnected=true;}
    }
    vm.runInNewContext(compile(read('pages/Library/PrivateLibraryImage.tsx')),{module,exports:module.exports,IntersectionObserver:Observer,
        require(name){
            if(name==='react')return {
                useRef:()=>({current:{}}),useEffect:callback=>{effect=callback;},
                useState:()=>index++===0?[visible,value=>{visible=value;}]:['',()=>{}],
            };
            if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
            if(name==='../../hooks/usePrivateImage')return {usePrivateImage:(value,uid,enabled)=>{received={value,uid,enabled};return enabled?state:{status:'loading'};}};
            throw Error(name);
        },
    });
    const props={value:'https://firebasestorage.googleapis.com/old?token=private',uid:'alice',alt:'Imagem gerada'};
    let tree=module.exports.default(props);
    assert.equal(received.enabled,false);
    assert.equal(tree.props.children.type,'span');
    const cleanup=effect();
    observerCallback([{isIntersecting:true}]);index=0;
    tree=module.exports.default(props);
    assert.equal(received.enabled,true);
    assert.equal(tree.props.children.type,'img');
    assert.equal(tree.props.children.props.src,'blob:private');
    assert.ok(!JSON.stringify(tree).includes('token='));
    observerCallback([{isIntersecting:false}]);index=0;
    tree=module.exports.default(props);assert.equal(tree.props.children.type,'span');
    cleanup();assert.equal(disconnected,true);
});

test('hook ignores callbacks after unmount and hides previous-user state immediately',()=>{
    const module={exports:{}},auth={currentUser:{uid:'alice'}};
    let state=null,effect,callback,stopped=0,updates=0;
    vm.runInNewContext(compile(read('hooks/usePrivateImage.ts')),{module,exports:module.exports,
        require(name){
            if(name==='react')return {useState:()=>[state,value=>{state=value;updates++;}],useEffect:value=>{effect=value;}};
            if(name==='../firebase/auth')return {__esModule:true,default:auth};
            if(name==='../services/privateImages')return {subscribePrivateImage:(_value,_uid,listener)=>{callback=listener;return()=>{stopped++;};}};
            throw Error(name);
        },
    });
    const hook=module.exports.usePrivateImage;
    assert.equal(hook('reference','alice',false).status,'loading');
    effect();assert.equal(callback,undefined);
    hook('reference','alice',true);const cleanup=effect();
    callback({status:'success',url:'blob:alice'});
    assert.equal(hook('reference','alice',true).url,'blob:alice');
    auth.currentUser={uid:'bob'};
    assert.equal(hook('reference','bob',true).status,'loading');
    assert.equal(hook('reference','alice',true).status,'loading');
    cleanup();const before=updates;callback({status:'success',url:'blob:late'});
    assert.equal(updates,before);assert.equal(stopped,1);
});

test('library keeps video player and authenticated download separate from private images',()=>{
    const source=read('pages/Library/Library.tsx');
    assert.ok(source.includes('<PrivateLibraryVideo'));
    assert.ok(source.includes('itemId={item.id}'));
    assert.ok(source.includes('<PrivateLibraryImage'));
    assert.ok(!source.includes('src={item.imageUrl}'));
    assert.ok(source.includes('api.get<Blob>'));
    assert.ok(!read('services/privateImages.ts').includes('getDownloadURL'));
});
