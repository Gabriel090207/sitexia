import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const read=path=>readFileSync(new URL('../src/'+path,import.meta.url),'utf8');
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function queue(){const m={exports:{}};vm.runInNewContext(compile(read('pages/VideoGeneration/videoPreviewQueue.ts')),{module:m,exports:m.exports,queueMicrotask});return m.exports;}
function environment(){
    const scheduler=queue(),auth={currentUser:{uid:'alice'}},listeners=new Set(),requests=[],observers=[],timers=new Map();let seq=0;
    function card(itemId='one',renderStatus='waiting'){
        const events=new Map(),states=[];let effect,callback,disposed=0,paused=0;
        const root={addEventListener(){},removeEventListener(){}};
        const video={src:'',videoWidth:640,videoHeight:360,preload:'none',
            pause(){paused++;},closest:()=>root,
            addEventListener:(k,f)=>events.set(k,f),removeEventListener:k=>events.delete(k)};
        const player={prepare:async()=>{requests.push(itemId);video.src='https://storage.googleapis.com/demo?X-Goog-Signature=synthetic';callback({status:'ready'});},
            dispose:()=>{disposed++;video.src='';}};
        const module={exports:{}};
        vm.runInNewContext(compile(read('pages/VideoGeneration/PrivateVideoPreview.tsx')),{module,exports:module.exports,
            setTimeout:(fn)=>{const id=++seq;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
            IntersectionObserver:class{constructor(fn,options){assert.equal(options.root,root);this.notify=fn;observers.push(this);}observe(v){assert.equal(v,video);}disconnect(){this.disconnected=true;}},
            window:{removeEventListener(){}},
            require(name){
                if(name==='react')return {useRef:()=>({current:video}),useState:()=>[renderStatus,x=>states.push(x)],useEffect:fn=>{effect=fn;}};
                if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
                if(name==='firebase/auth')return {onAuthStateChanged:(_,fn)=>{listeners.add(fn);return()=>listeners.delete(fn);}};
                if(name==='../../firebase/auth')return {__esModule:true,default:auth};
                if(name==='./videoPreviewQueue')return scheduler;
                if(name==='../../services/privateVideoPlayback')return {createPrivateVideoPlayback:(v,id,uid,notify)=>{
                    assert.equal(v,video);assert.equal(id,itemId);assert.equal(uid,'alice');callback=notify;return player;
                }};
                throw Error(name);
            }});
        const tree=module.exports.default({itemId,uid:'alice'});const cleanup=effect();const observer=observers.at(-1);
        return {video,tree,states,cleanup,show:()=>observer.notify([{isIntersecting:true}]),hide:()=>observer.notify([{isIntersecting:false}]),
            frame:()=>events.get('loadeddata')?.(),error:()=>events.get('error')?.(),backendError:()=>callback?.({status:'error'}),
            counts:()=>({disposed,paused}),observer};
    }
    return {card,requests,timers,change:user=>{auth.currentUser=user;for(const fn of [...listeners])fn();}};
}
function nodes(tree){if(!tree||typeof tree!=='object')return [];return [tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)];}
test('preview is decorative, paused and has no nested interactive controls',()=>{
    const s=environment(),c=s.card();const video=nodes(c.tree).find(n=>n.type==='video');
    assert.equal(video.props.controls,undefined);assert.equal(video.props.autoPlay,undefined);
    assert.equal(video.props.muted,true);assert.equal(video.props.playsInline,true);assert.equal(video.props.tabIndex,-1);
    assert.equal(video.props.src,undefined);assert.equal(nodes(c.tree).some(n=>n.type==='button'),false);
    assert.deepEqual(s.requests,[]);c.cleanup();
});
test('offscreen preview waits and repeated intersections never reauthorize in one modal session',()=>{
    const s=environment(),c=s.card('document-a');c.hide();assert.deepEqual(s.requests,[]);
    c.show();assert.deepEqual(s.requests,['document-a']);assert.notEqual(c.states.at(-1),'ready');
    c.frame();assert.equal(c.states.at(-1),'ready');assert.equal(c.video.preload,'none');
    c.hide();c.show();assert.deepEqual(s.requests,['document-a']);c.cleanup();assert.equal(c.video.src,'');
});
test('only two visible previews prepare at once, holding slots until frame availability',async()=>{
    const s=environment(),cards=Array.from({length:5},(_,i)=>s.card(String(i)));
    for(const c of cards)c.show();assert.deepEqual(s.requests,['0','1']);
    cards[0].frame();await Promise.resolve();assert.deepEqual(s.requests,['0','1','2']);
    cards[1].error();await Promise.resolve();assert.deepEqual(s.requests,['0','1','2','3']);assert.equal(cards[1].states.at(-1),'error');
    for(const c of cards)c.cleanup();
});
test('closing cancels queued work, aborts active controllers and clears observers and timers',()=>{
    const s=environment(),cards=[s.card('a'),s.card('b'),s.card('queued')];
    cards.forEach(c=>c.show());cards[2].cleanup();cards[0].cleanup();cards[1].cleanup();
    assert.deepEqual(s.requests,['a','b']);assert.equal(s.timers.size,0);
    for(const c of cards){assert.equal(c.video.src,'');assert.equal(c.observer.disconnected,true);}
});
for(const next of [null,{uid:'bob'}])test('account change clears frames and queued old-account previews',()=>{
    const s=environment(),cards=[s.card('a'),s.card('b'),s.card('queued')];cards.forEach(c=>c.show());
    s.change(next);assert.deepEqual(s.requests,['a','b']);
    for(const c of cards){assert.equal(c.video.src,'');assert.equal(c.states.at(-1),'error');c.cleanup();}
    assert.equal(s.timers.size,0);
});
for(const cause of ['backend','media','empty-frame','timeout'])test(`preview fallback releases its slot: ${cause}`,()=>{
    const s=environment(),c=s.card();c.show();
    if(cause==='backend')c.backendError();
    if(cause==='media')c.error();
    if(cause==='empty-frame'){c.video.videoWidth=0;c.frame();}
    if(cause==='timeout')[...s.timers.values()][0]();
    assert.equal(c.states.at(-1),'error');assert.equal(c.video.src,'');assert.equal(s.timers.size,0);c.cleanup();
    const fallback=nodes(s.card('fallback','error').tree).find(n=>n.props?.className==='video-generation-preview-placeholder');
    assert.equal(fallback.props.children,'Prévia indisponível');
});
test('selection remains a button with the matching private document and unchanged selection handler',()=>{
    const source=read('pages/VideoGeneration/VideoGeneration.tsx');
    assert.match(source,/<PrivateVideoPreview itemId=\{item.id\} uid=\{user\?\.uid \?\? ""\}/);
    const cards=source.slice(source.indexOf('visibleLibraryVideos.map'));
    assert.match(cards,/setSelectedSourceVideo\(item\)/);assert.match(cards,/setIsVideoSelectorOpen\(false\)/);
    assert.match(cards,/type="button"/);assert.doesNotMatch(cards,/src=\{item.videoUrl\}|<PrivateLibraryVideo/);
    const css=read('pages/VideoGeneration/VideoGeneration.css');
    assert.match(css,/overflow-y:\s*auto/);assert.match(css,/max-height:\s*calc\(100dvh/);
    assert.match(css,/\.video-generation-selector-item:focus-visible/);
});
test('queue completion and cancellation are idempotent',async()=>{
    const q=queue(),started=[],done=[];
    const cancel=Array.from({length:4},(_,i)=>q.queueVideoPreview(finish=>{started.push(i);done[i]=finish;}));
    assert.deepEqual(started,[0,1]);cancel[2]();cancel[2]();done[0]();done[0]();await Promise.resolve();assert.deepEqual(started,[0,1,3]);
    cancel.forEach(stop=>stop());
});

test('closing active cards before queued cards does not start new authorization',async()=>{
    const s=environment(),cards=[s.card('a'),s.card('b'),s.card('queued')];cards.forEach(c=>c.show());
    cards.forEach(c=>c.cleanup());await Promise.resolve();assert.deepEqual(s.requests,['a','b']);
});
test('queued preview scrolled out of view waits for a later visible entry',async()=>{
    const s=environment(),cards=[s.card('a'),s.card('b'),s.card('queued')];cards.forEach(c=>c.show());
    cards[2].hide();cards[0].frame();await Promise.resolve();assert.deepEqual(s.requests,['a','b']);
    cards[2].show();assert.deepEqual(s.requests,['a','b','queued']);cards.forEach(c=>c.cleanup());
});
