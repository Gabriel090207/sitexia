import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const read=path=>readFileSync(new URL('../src/'+path,import.meta.url),'utf8');
function setup(){
 let location={pathname:'/geracao-de-imagem',search:'',hash:''},cursor=0;
 const refs=[],effects=[],calls=[],history={scrollRestoration:'auto'},module={exports:{}};
 vm.runInNewContext(ts.transpileModule(read('routes/ScrollToTop.tsx'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
  module,exports:module.exports,window:{history},require(name){
   if(name==='react')return {useRef(value){const i=cursor++;return refs[i]??={current:value};},
    useLayoutEffect(setup,deps){const i=cursor++,old=effects[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j])))effects[i]={setup,deps,cleanup:old?.cleanup,pending:true};}};
   if(name==='react-router-dom')return {useLocation:()=>location};
   if(name==='../utils/scrollLock')return {scrollPageToTop:()=>calls.push(location.pathname)};
   throw Error(name);
  }});
 function render(next={}){location={...location,...next};cursor=0;assert.equal(module.exports.default(),null);
  for(const e of effects.filter(Boolean))if(e.pending){e.pending=false;e.cleanup?.();e.cleanup=e.setup();}}
 return {calls,history,render,replay(){for(const e of effects.filter(Boolean)){e.cleanup?.();e.cleanup=e.setup();}},unmount(){for(const e of effects.filter(Boolean))e.cleanup?.();}};
}
test('global route observer resets each new page but ignores rerenders, query changes and same-path navigation',()=>{
 const s=setup();s.render();assert.deepEqual(s.calls,['/geracao-de-imagem']);
 s.render();s.render({search:'?quantity=4'});s.render({key:'another-navigation'});assert.equal(s.calls.length,1);
 for(const pathname of ['/geracao-de-video','/biblioteca','/troca-de-rosto','/geracao-de-imagem'])s.render({pathname});
 assert.deepEqual(s.calls,['/geracao-de-imagem','/geracao-de-video','/biblioteca','/troca-de-rosto','/geracao-de-imagem']);s.unmount();
});
test('hash destinations and same-page anchors are preserved',()=>{
 const s=setup();s.render({hash:'#section'});assert.equal(s.calls.length,0);
 s.render({hash:'#other'});s.render({hash:''});assert.equal(s.calls.length,0);
 s.render({pathname:'/biblioteca',hash:'#item'});assert.equal(s.calls.length,0);
 s.render({pathname:'/geracao-de-video',hash:''});assert.deepEqual(s.calls,['/geracao-de-video']);s.unmount();
});
test('manual history restoration prevents native back/forward restoration and is restored on unmount',()=>{
 const s=setup();s.render();assert.equal(s.history.scrollRestoration,'manual');
 s.replay();assert.equal(s.history.scrollRestoration,'manual');assert.equal(s.calls.length,1);
 s.unmount();assert.equal(s.history.scrollRestoration,'auto');
});
test('router retains one global scroll component and scroll operation explicitly bypasses smooth CSS',()=>{
 assert.equal((read('routes/AppRouter.tsx').match(/<ScrollToTop\s*\/>/g)??[]).length,1);
 assert.match(read('utils/scrollLock.ts'),/window\.scrollTo\(\{ top: 0, left: 0, behavior: "instant" \}\)/);
 assert.match(read('routes/ScrollToTop.tsx'),/return null/);
});
