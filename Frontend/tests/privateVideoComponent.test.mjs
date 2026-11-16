import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const read=path=>readFileSync(new URL('../src/'+path,import.meta.url),'utf8');
const source=read('pages/Library/PrivateLibraryVideo.tsx');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function setup({status='idle',observer=true}={}){
    let effect,intersection,refs=0,prepares=0,disposed=0,disconnected=0;
    const events=new Map();
    let bounds={width:300,height:200,top:1000,bottom:1200,left:0,right:300};
    const element={getBoundingClientRect:()=>bounds};
    const player={prepare:async()=>{prepares++;},dispose:()=>{disposed++;}};
    const module={exports:{}};
    const scope={module,exports:module.exports,window:{innerHeight:800,innerWidth:1200,
        addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)},
        require(name){
            if(name.endsWith('.css'))return {};
            if(name==='react')return {useRef:()=>({current:refs++===0?element:null}),useState:()=>[{status,message:status==='error'?'Falha controlada':undefined},()=>{}],useEffect:fn=>{effect=fn;}};
            if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
            if(name==='../../services/privateVideoPlayback')return {createPrivateVideoPlayback:(video,id,uid)=>{
                assert.equal(video,element);assert.equal(id,'item');assert.equal(uid,'alice');return player;
            }};
            throw Error(name);
        }};
    if(observer)scope.IntersectionObserver=class{
        constructor(fn){intersection=fn;}
        observe(node){assert.equal(node,element);}
        disconnect(){disconnected++;}
    };
    vm.runInNewContext(code,scope);
    const tree=module.exports.default({itemId:'item',uid:'alice'});
    const cleanup=effect();
    return {tree,events,cleanup,show:()=>intersection([{isIntersecting:true}]),hide:()=>intersection([{isIntersecting:false}]),
        setBounds:value=>{bounds=value;},counts:()=>({prepares,disposed,disconnected})};
}
function find(tree,type){if(!tree||typeof tree!=='object')return [];const children=tree.props?.children;return [...(tree.type===type?[tree]:[]),...[children].flat(Infinity).flatMap(child=>find(child,type))];}
test('visible native player has controls and no initial external play button or autoplay',()=>{
    const s=setup();const videos=find(s.tree,'video');assert.equal(videos.length,1);
    assert.equal(videos[0].props.controls,true);assert.equal(videos[0].props.playsInline,true);
    assert.equal(videos[0].props.preload,'none');assert.equal(videos[0].props.autoPlay,undefined);
    assert.equal(videos[0].props.src,undefined);assert.equal(find(s.tree,'button').length,0);
    s.cleanup();
});
test('offscreen player does not prepare until intersection and disconnects on cleanup',()=>{
    const s=setup();assert.equal(s.counts().prepares,0);s.hide();assert.equal(s.counts().prepares,0);
    s.show();assert.equal(s.counts().prepares,1);s.cleanup();assert.equal(s.counts().disposed,1);assert.equal(s.counts().disconnected,1);
});
test('error-only retry requests preparation, not playback',async()=>{
    const s=setup({status:'error'});const buttons=find(s.tree,'button');assert.equal(buttons.length,1);
    assert.equal(buttons[0].props.children,'Tentar carregar novamente');buttons[0].props.onClick();
    assert.equal(s.counts().prepares,1);s.cleanup();
});
test('loading is indicated without a play button and overlay does not capture pointer input',()=>{
    const s=setup({status:'loading'});assert.equal(find(s.tree,'button').length,0);
    assert.ok(find(s.tree,'span').some(node=>node.props.role==='status'));
    const css=read('pages/Library/PrivateLibraryVideo.css');assert.match(css,/pointer-events:\s*none/);s.cleanup();
});
test('visibility fallback does not eagerly prepare an offscreen video',()=>{
    const s=setup({observer:false});assert.equal(s.counts().prepares,0);
    s.setBounds({width:300,height:200,top:50,bottom:250,left:0,right:300});s.events.get('scroll')();assert.equal(s.counts().prepares,1);
    s.cleanup();assert.equal(s.events.size,0);
});
test('all three consumers continue to use the shared component',()=>{
    for(const path of ['pages/FaceSwap/FaceSwap.tsx','pages/VideoGeneration/VideoGeneration.tsx','pages/Library/Library.tsx'])assert.match(read(path),/<PrivateLibraryVideo\b/);
});
