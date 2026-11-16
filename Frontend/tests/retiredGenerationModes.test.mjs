import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const read=path=>readFileSync(new URL(`../src/${path}`,import.meta.url),'utf8');
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
const source=read('pages/ImageGeneration/ImageGeneration.tsx');
const ast=ts.createSourceFile('ImageGeneration.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let handler;
function find(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='handleGenerateImage')handler=node.getText(ast);ts.forEachChild(node,find);}
find(ast);
test('image page has no Anime or redundant style selector and retains optional reference',()=>{
    assert.doesNotMatch(source,/Anime|anime|setImageStyle|imageStyles\.map|image-generation-style-grid/);
    assert.match(source,/Adicione uma imagem opcional/);
    assert.match(source,/className="image-generation-quantity"/);
    assert.match(source,/<PrivateGeneratedImage/);
});
test('image handler always sends Realista even with obsolete Anime state',async()=>{
    const user={uid:'alice'},calls=[],registrations=[],uploads=[];
    const processor={exports:{}};
    vm.runInNewContext(compile(read('pages/ImageGeneration/processImageResults.ts')),{module:processor,exports:processor.exports,URL});
    const scope={user,prompt:'prompt',quantity:1,imageStyle:'anime',generationInFlight:{current:false},
        pageMounted:{current:true},auth:{currentUser:user},crypto:{randomUUID:()=> 'batch'},
        setIsGenerating(){},setGeneratedImages(){},setError(value){assert.equal(value,'');},
        createTextToImage:async(...args)=>{calls.push(args);return {taskId:'task'};},
        waitForImageTask:async()=>({imageUrls:['https://provider.invalid/image']}),
        processImageResults:processor.exports.processImageResults,
        uploadImageFromUrl:async(...args)=>{uploads.push(args);return 'private-reference';},
        createLibraryImage:async(...args)=>registrations.push(args),
    };
    vm.runInNewContext(compile(handler+'\nglobalThis.run=handleGenerateImage;'),scope);
    await scope.run();
    assert.deepEqual(calls,[['prompt','realistic',1]]);
    assert.equal(uploads.length,1);
    assert.deepEqual(registrations,[['alice','private-reference','image-generation']]);
});
