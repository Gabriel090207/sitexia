import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../src/pages/ImageGeneration/ImageGeneration.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('ImageGeneration.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const elements=[];
function visit(node){if(ts.isJsxElement(node))elements.push(node);ts.forEachChild(node,visit);}
visit(ast);
const attr=(node,name)=>node.openingElement.attributes.properties.find(value=>value.name?.text===name);
const cls=node=>attr(node,'className')?.initializer?.text;
const upload=elements.find(node=>cls(node)==='image-generation-upload');
const preview=elements.find(node=>cls(node)==='image-generation-upload image-generation-reference-preview');
const invoke=(node,name,event,scope={})=>{
    const handler=attr(node,name).initializer.expression.getText(ast);
    const code=ts.transpileModule(`(${handler})(event);`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText;
    vm.runInNewContext(code,{event,...scope});
};
test('optional reference dropzone has one keyboard target without nested interactive controls',()=>{
    assert.ok(upload);assert.ok(preview);
    assert.equal(attr(upload,'role').initializer.text,'button');
    assert.match(attr(upload,'aria-label').initializer.text,/opcional/);
    assert.equal(attr(upload,'tabIndex').initializer.expression.getText(ast),'0');
    const nested=elements.filter(node=>node.pos>upload.pos&&node.end<upload.end);
    assert.equal(nested.some(node=>node.openingElement.tagName.getText(ast)==='button'),false);
    assert.match(source,/Adicione uma imagem opcional/);
});
test('click, Enter and Space activate the original selector once; Space does not scroll',()=>{
    let opened=0,prevented=0;
    const scope={openFileSelector:()=>opened++};
    invoke(upload,'onClick',{},scope);
    for(const key of ['Enter',' ','Escape'])invoke(upload,'onKeyDown',{key,preventDefault:()=>prevented++},scope);
    assert.equal(opened,3);assert.equal(prevented,2);
});
test('drag and drop retains the existing drop handler',()=>{
    let prevented=0,dropped;
    invoke(upload,'onDragOver',{preventDefault:()=>prevented++});
    const event={dataTransfer:{files:[]}};
    invoke(upload,'onDrop',event,{handleDrop:value=>{dropped=value;}});
    assert.equal(prevented,1);assert.equal(dropped,event);
});
test('preview actions remain separate, accessible and call original change/remove functions',()=>{
    const change=elements.find(node=>cls(node)==='image-generation-reference-change');
    const remove=elements.find(node=>cls(node)==='image-generation-reference-remove');
    let changed=0,removed=0;
    assert.equal(attr(change,'type').initializer.text,'button');
    assert.equal(attr(remove,'type').initializer.text,'button');
    assert.equal(attr(remove,'aria-label').initializer.text,'Remover imagem');
    assert.equal(attr(preview,'onClick'),undefined);
    invoke(change,'onClick',{}, {openFileSelector:()=>changed++});
    invoke(remove,'onClick',{}, {removeReferenceImage:()=>removed++});
    assert.equal(changed,1);assert.equal(removed,1);
});
