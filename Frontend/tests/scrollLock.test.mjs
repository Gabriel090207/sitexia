import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const read=path=>readFileSync(new URL('../src/'+path,import.meta.url),'utf8');
const code=ts.transpileModule(read('utils/scrollLock.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023}}).outputText;
function style(initial={}){
    const values=new Map(Object.entries(initial).map(([k,v])=>[k,[v,'']]));
    return {values,getPropertyValue:k=>values.get(k)?.[0]??'',getPropertyPriority:k=>values.get(k)?.[1]??'',
        setProperty:(k,v,p='')=>values.set(k,[v,p]),removeProperty:k=>values.delete(k)};
}
function setup(gap=15){
    const body={style:style({'overflow':'clip','padding-right':'7px'})};
    body.style.setProperty('position','relative','important');
    const root={style:style({'scroll-behavior':'smooth'}),clientWidth:1000-gap};
    const beforeBody=JSON.stringify([...body.style.values]),beforeRoot=JSON.stringify([...root.style.values]);
    const scroll=[];const module={exports:{}};
    vm.runInNewContext(code,{module,exports:module.exports,document:{body,documentElement:root},
        window:{scrollX:4,scrollY:750,innerWidth:1000,getComputedStyle:()=>({paddingRight:'7px'}),
            scrollTo:(x,y)=>{if(typeof x==='object'){assert.equal(x.behavior,'instant');scroll.push([x.left,x.top]);}else{assert.equal(root.style.getPropertyValue('scroll-behavior'),'auto');scroll.push([x,y]);}}}});
    return {top:module.exports.scrollPageToTop,lock:module.exports.lockPageScroll,body,root,scroll,beforeBody,beforeRoot};
}
function restored(s){
    // Compare properties independently of insertion order.
    const sorted=x=>JSON.stringify([...x].sort());
    assert.equal(sorted(s.body.style.values),sorted(JSON.parse(s.beforeBody)));
    assert.equal(sorted(s.root.style.values),sorted(JSON.parse(s.beforeRoot)));
    assert.deepEqual(s.scroll,[[4,750]]);
}
test('lock fixes the background, compensates scrollbar and restores original styles and exact position',()=>{
    const s=setup();const release=s.lock();
    assert.equal(s.body.style.getPropertyValue('position'),'fixed');
    assert.equal(s.body.style.getPropertyValue('top'),'-750px');
    assert.equal(s.body.style.getPropertyValue('left'),'-4px');
    assert.equal(s.body.style.getPropertyValue('padding-right'),'22px');
    assert.equal(s.root.style.getPropertyValue('overflow'),'hidden');
    release();restored(s);
});
for(const order of [[0,1],[1,0]])test(`Header/modal locks cannot release each other: ${order}`,()=>{
    const s=setup();const releases=[s.lock(),s.lock()];releases[order[0]]();
    assert.equal(s.body.style.getPropertyValue('position'),'fixed');assert.equal(s.scroll.length,0);
    releases[order[0]]();assert.equal(s.scroll.length,0);
    releases[order[1]]();restored(s);
});
test('mobile scrollbar-free lock preserves existing padding and repeated mounts restore correctly',()=>{
    const s=setup(0);const release=s.lock();assert.equal(s.body.style.getPropertyValue('padding-right'),'7px');
    release();restored(s);
    const next=s.lock();next();assert.deepEqual(s.scroll,[[4,750],[4,750]]);
});
test('modal state effect owns cleanup for every close route and unmount; Header uses same lock',()=>{
    for(const [path,state] of [['pages/VideoGeneration/VideoGeneration.tsx','isVideoSelectorOpen'],['components/Header/Header.tsx','sidebarOpen']]){
        const source=read(path),ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let effect;
        function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'&&node.arguments[1]?.getText(ast)===`[${state}]`)effect=node.arguments[0].getText(ast);ts.forEachChild(node,visit);}visit(ast);
        assert.ok(effect);let locks=0,releases=0;const scope={[state]:false,lockPageScroll:()=>{locks++;return()=>releases++;}};
        vm.runInNewContext(ts.transpileModule(`globalThis.effect=${effect}`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,scope);
        assert.equal(scope.effect(),undefined);assert.equal(locks,0);
        scope[state]=true;const cleanup=scope.effect();assert.equal(locks,1);cleanup();assert.equal(releases,1);
    }
});
test('modal list scrolls within a viewport-bounded panel and contains overscroll',()=>{
    const css=read('pages/VideoGeneration/VideoGeneration.css');
    assert.match(css,/max-height:\s*calc\(100dvh - 60px\)/);
    const grid=css.slice(css.indexOf('.video-generation-selector-grid{'),css.indexOf('.video-generation-selector-item{'));
    assert.match(grid,/min-height:\s*0/);assert.match(grid,/overflow-y:\s*auto/);assert.match(grid,/overscroll-behavior-y:\s*contain/);
    assert.match(css,/\.video-generation-selector-header\{\s*flex-shrink:\s*0/);
});

test('route navigation replaces pending Header/modal restoration without releasing their locks',()=>{
 const s=setup();const a=s.lock(),b=s.lock();s.top();
 assert.equal(s.body.style.getPropertyValue('position'),'fixed');
 assert.equal(s.body.style.getPropertyValue('top'),'0px');
 a();assert.equal(s.scroll.length,1);b();assert.deepEqual(s.scroll,[[0,0],[0,0]]);
 assert.equal(s.root.style.getPropertyValue('scroll-behavior'),'smooth');
 const next=s.lock();next();assert.deepEqual(s.scroll.at(-1),[4,750]);
});
