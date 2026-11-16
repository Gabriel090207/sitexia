import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/pages/VideoGeneration/VideoGeneration.tsx', import.meta.url), 'utf8');
const errorModule = {exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/pages/VideoGeneration/referenceVideoErrors.ts', import.meta.url),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023},
}).outputText,{module:errorModule,exports:errorModule.exports});
const r2vErrors = errorModule.exports;
const sharedErrorModule = {exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/utils/generationErrors.ts',import.meta.url),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023},
}).outputText,{module:sharedErrorModule,exports:sharedErrorModule.exports,Error,TypeError,
    require:()=>({isAxiosError:error=>Boolean(error?.response)})});
const sharedMessage = sharedErrorModule.exports.getGenerationErrorMessage;

let pollingFunction;

const ast = ts.createSourceFile('VideoGeneration.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['handleGenerateVideo', 'registerSavedVideo', 'retryVideoRegistration'];
const functions = [];
function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'waitForVideoTask') pollingFunction = node.getText(ast);
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(ast));
    ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(functions.length, 3);
const compiled = ts.transpileModule(functions.join('\n') + '\nglobalThis.run = handleGenerateVideo; globalThis.retry = retryVideoRegistration;', {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText;
function prepare(overrides = {}) {
    const calls = [], errors = [], results = [];
    const user = { uid: 'owner' };
    const scope = {
        ...r2vErrors, user, auth: { currentUser: user }, pageMounted: { current: true },
        generationInFlight: { current: false }, registrationInFlight: { current: false },
        activeVideo: null, isUploading: false, activeMode: 'image-to-video', imageUrl: 'input-reference',
        prompt: 'prompt', duration: 5, currentSourceVideo: { id: 'source-document', taskId: 'source-task' }, db: {},
        setError: x => errors.push(x), setGeneratedVideo: x => { results.push(x); scope.activeVideo = x; },
        setIsGenerating() {}, setIsRegistering() {}, setGenerationStatus() {},
        getGenerationErrorMessage: sharedMessage,
        createImageToVideo: async (...args) => { calls.push(['image', ...args]); return { taskId: 'new-task' }; },
        createReferenceToVideo: async (...args) => { calls.push(['reference', ...args]); return { taskId: 'new-task' }; },
        createTextToVideo: async (...args) => { calls.push(['text', ...args]); return { taskId: 'new-task' }; },
        createVideoExtend: async (...args) => { calls.push(['extend', ...args]); return { taskId: 'new-task' }; },
        waitForVideoTask: async () => ({ videoUrl: 'provider-url' }),
        videoUrlToFile: async () => ({}),
        uploadFile: async (...args) => { calls.push(['upload', ...args]); return 'firebase-reference?token=legacy'; },
        collection: (...args) => args, where: (...args) => args, limit: x => x,
        query: (...args) => { calls.push(['query', ...args]); return {}; },
        getDocs: async () => ({ docs: [] }),
        createLibraryVideo: async (...args) => { calls.push(['register', ...args]); return 'actual-document-id'; },
        ...overrides,
    };
    vm.runInNewContext(compiled, scope);
    return { scope, calls, errors, results };
}
for (const [mode, kind, args] of [
    ['image-to-video', 'image', ['input-reference', 'prompt', 5]],
    ['text-to-video', 'text', ['prompt', 5]],
    ['video-extend', 'extend', ['source-task', 'prompt', 5]],
]) {
    test(`private video: ${mode} preserves task parameters and uses actual document ID`, async () => {
        const s = prepare({ activeMode: mode });
        await s.scope.run();
        assert.deepEqual(s.calls.find(x => x[0] === kind), [kind, ...args]);
        assert.equal(s.scope.activeVideo.itemId, 'actual-document-id');
        assert.equal(s.scope.activeVideo.taskId, 'new-task');
        assert.equal(s.calls.filter(x => x[0] === 'upload').length, 1);
        assert.deepEqual(s.calls.find(x => x[0] === 'register'), ['register', 'owner', 'firebase-reference?token=legacy', 'new-task']);
    });
}
test('registration failure preserves saved reference; manual retry never uploads or creates again', async () => {
    let attempts = 0;
    const s = prepare({ createLibraryVideo: async () => { if (++attempts === 1) throw Error('network'); return 'recovered-id'; } });
    await s.scope.run();
    assert.equal(s.scope.activeVideo.reference, 'firebase-reference?token=legacy');
    assert.equal(s.scope.activeVideo.itemId, undefined);
    assert.match(s.errors.at(-1), /concluído e salvo/);
    await s.scope.run(); // a saved result blocks a second generation
    await s.scope.retry();
    assert.equal(s.scope.activeVideo.itemId, 'recovered-id');
    assert.equal(s.calls.filter(x => x[0] === 'image').length, 1);
    assert.equal(s.calls.filter(x => x[0] === 'upload').length, 1);
});
test('ambiguous registration recovers existing real ID using bounded task query', async () => {
    const s = prepare({ getDocs: async () => ({ docs: [{ id: 'existing-id', data: () => ({ type: 'video-generation', videoUrl: 'old-reference?token=old' }) }] }) });
    await s.scope.run();
    assert.equal(s.scope.activeVideo.itemId, 'existing-id');
    assert.equal(s.calls.filter(x => x[0] === 'register').length, 0);
    const lookup = s.calls.find(x => x[0] === 'query');
    assert.deepEqual(lookup[2], ['taskId', '==', 'new-task']);
    assert.equal(lookup[3], 5);
});
test('simultaneous clicks submit and save only once', async () => {
    const s = prepare();
    await Promise.all([s.scope.run(), s.scope.run()]);
    assert.equal(s.calls.filter(x => x[0] === 'image').length, 1);
    assert.equal(s.calls.filter(x => x[0] === 'register').length, 1);
});
for (const end of ['logout', 'switch', 'unmount']) {
    test(`${end} discards delayed task result`, async () => {
        const s = prepare();
        s.scope.waitForVideoTask = async () => {
            if (end === 'unmount') s.scope.pageMounted.current = false;
            else s.scope.auth.currentUser = end === 'logout' ? null : { uid: 'other' };
            return { videoUrl: 'provider-url' };
        };
        await s.scope.run();
        assert.equal(s.calls.filter(x => x[0] === 'upload').length, 0);
        assert.equal(s.results.filter(Boolean).length, 0);
    });
}
test('session changed during registration cannot present previous account result', async () => {
    const s = prepare();
    s.scope.getDocs = async () => { s.scope.auth.currentUser = { uid: 'other' }; return { docs: [] }; };
    await s.scope.run();
    assert.equal(s.calls.filter(x => x[0] === 'register').length, 0);
    assert.equal(s.results.some(x => x?.itemId), false);
});
test('page reuses private player for result and selection, with no eager media or public fallback', () => {
    assert.equal((source.match(/<PrivateLibraryVideo\b/g) || []).length, 2);
    assert.match(source, /itemId=\{activeVideo.itemId\}/);
    assert.match(source, /itemId=\{currentSourceVideo.id\}/);
    assert.doesNotMatch(source, /<video\b|getDownloadURL/);
    const selector = source.slice(source.indexOf('visibleLibraryVideos.map'));
    assert.doesNotMatch(selector, /<PrivateLibraryVideo|src=\{item.videoUrl\}/);
    assert.match(selector, /setSelectedSourceVideo\(item\)/);
    assert.match(source, /setLibraryVideos\(items.filter/);
});


function actualPolling(state) {
    vm.runInNewContext(ts.transpileModule(pollingFunction, {
        compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS},
    }).outputText,state.scope);
}
const failedMessage='A geração do vídeo não foi concluída pelo provedor. Nenhum vídeo foi produzido nesta tentativa.';
const financialMessage='Não foi possível confirmar a finalização desta geração. O estado dos créditos pode estar pendente. Não inicie outra geração para substituir esta tentativa.';
function failureState(mode, getVideoTask) {
    const loading=[],statuses=[],gets=[],waits=[];
    const state=prepare({activeMode:mode,
        setIsGenerating:value=>loading.push(value),setGenerationStatus:value=>statuses.push(value),
        getVideoTask:async id=>{gets.push(id);return getVideoTask();},
        wait:async ms=>waits.push(ms),
        videoUrlToFile:async()=>{throw Error('must not download failed result');},
    });
    actualPolling(state);
    return {...state,loading,statuses,gets,waits};
}
test('retired R2V state cannot start creation, polling, upload or registration',async()=>{
    for(const providerState of ['FAILED','RUNNING','SUCCEEDED']) {
        const state=failureState('reference-to-video',()=>({taskStatus:providerState}));
        await state.scope.run();
        assert.equal(state.errors.at(-1),'Esta modalidade está indisponível para novas gerações.');
        assert.deepEqual(state.calls,[]);assert.deepEqual(state.gets,[]);assert.deepEqual(state.loading,[]);
    }
});
for(const mode of ['image-to-video','video-extend','text-to-video']) test(`${mode} retains existing FAILED and financial error presentation`,async()=>{
    for(const failure of ['failed','financial']) {
        const state=failureState(mode,()=>{
            if(failure==='financial')throw {response:{status:503,data:{detail:{code:'financial_finalization_unconfirmed'}}}};
            return {taskStatus:'FAILED',errorMsg:'internal server error'};
        });
        await state.scope.run();
        assert.equal(state.errors.at(-1),failure==='financial'
            ? 'O serviço de geração está temporariamente indisponível. Tente novamente em alguns instantes.'
            : 'Não foi possível gerar o vídeo. Tente novamente.');
        assert.deepEqual(state.loading,[true,false]);assert.equal(state.gets.length,1);
        assert.ok(!state.calls.some(call=>['upload','register'].includes(call[0])));
    }
});
test('authorized I2V RUNNING continues existing polling and SUCCEEDED saves once',async()=>{
    const loading=[],statuses=[],gets=[],waits=[];
    const tasks=[{taskStatus:'RUNNING'},{taskStatus:'SUCCEEDED',videoUrl:'provider-url'}];
    const state=prepare({activeMode:'image-to-video',setIsGenerating:value=>loading.push(value),
        setGenerationStatus:value=>statuses.push(value),wait:async ms=>waits.push(ms),
        getVideoTask:async id=>{gets.push(id);return tasks.shift();}});
    actualPolling(state);await state.scope.run();
    assert.deepEqual(gets,['new-task','new-task']);assert.deepEqual(waits,[5000]);
    assert.ok(statuses.includes('Gerando seu vídeo...'));assert.deepEqual(loading,[true,false]);
    assert.equal(state.calls.filter(call=>call[0]==='image').length,1);
    assert.equal(state.calls.filter(call=>call[0]==='upload').length,1);
    assert.equal(state.calls.filter(call=>call[0]==='register').length,1);
});
for(const error of [
    {response:{status:503,data:{detail:'provider unavailable'}}},
    {response:{status:502,data:{detail:{code:'financial_finalization_unconfirmed'}}}},
    {code:'ERR_NETWORK'},
    Error('internal server error'),
]) test('R2V classifier leaves communication and untrusted errors to existing sanitizer',()=>{
    assert.equal(r2vErrors.getReferenceVideoErrorMessage(error),undefined);
});


test('historical error helper remains independent of new generation navigation',()=>{
    assert.equal(r2vErrors.getReferenceVideoErrorMessage({response:{status:503,data:{detail:'private-diagnostic'}}}),undefined);
});
for(const imageUrl of ['', 'stale-image-from-another-mode']) test(`T2V submits text only with image state ${imageUrl ? 'stale' : 'empty'}`,async()=>{
    const state=prepare({activeMode:'text-to-video',imageUrl});
    await state.scope.run();
    assert.deepEqual(state.calls.find(call=>call[0]==='text'),['text','prompt',5]);
    assert.equal(state.calls.filter(call=>call[0]==='text').length,1);
    assert.equal(state.calls.filter(call=>call[0]==='upload').length,1);
    assert.equal(state.scope.activeVideo.itemId,'actual-document-id');
});
test('T2V does not require media and has no upload container; I2V retains its upload',()=>{
    let media,upload;
    function find(node){
        if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='hasRequiredMedia')media=node.initializer.getText(ast);
        if(ts.isConditionalExpression(node)&&node.condition.getText(ast)==='activeMode !== "text-to-video"'
            && node.whenTrue.getText(ast).includes('video-generation-upload'))upload=node;
        ts.forEachChild(node,find);
    }
    find(ast);assert.ok(media);assert.ok(upload);
    assert.equal(upload.whenFalse.getText(ast),'null');
    for(const mode of ['text-to-video','image-to-video']){
        const scope={activeMode:mode,imageUrl:'',currentSourceVideo:null};
        vm.runInNewContext(`globalThis.required=${media}`,scope);
        assert.equal(scope.required,mode==='text-to-video');
    }
    assert.match(source,/setImageUrl\(""\)/);
});
test('T2V API adapter sends only prompt and duration',async()=>{
    const module={exports:{}};let args;
    const apiSource=readFileSync(new URL('../src/api/videoGeneration.ts',import.meta.url),'utf8');
    vm.runInNewContext(ts.transpileModule(apiSource,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{
        module,exports:module.exports,require:()=>({__esModule:true,default:{post:async(...values)=>{args=values;return {data:{taskId:'new-task'}};}}}),
    });
    await module.exports.createTextToVideo('prompt',10);
    assert.equal(args[0],'/video-generation/text-to-video');
    assert.deepEqual(Object.keys(args[1]).sort(),['duration','prompt']);
    assert.equal(args[1].prompt,'prompt');assert.equal(args[1].duration,10);
});


test('video navigation exposes exactly the three authorized modes with no R2V entry',()=>{
    assert.doesNotMatch(source,/Referência para Vídeo|reference-to-video|createReferenceToVideo/);
    const modes=[];
    function find(node){
        if(ts.isCallExpression(node)&&node.expression.getText(ast)==='handleModeChange')modes.push(node.arguments[0].text);
        ts.forEachChild(node,find);
    }
    find(ast);
    assert.deepEqual(modes.sort(),['image-to-video','text-to-video','video-extend']);
    const css=readFileSync(new URL('../src/pages/VideoGeneration/VideoGeneration.css',import.meta.url),'utf8');
    assert.match(css,/\.video-generation-modes\s*\{\s*display:grid;\s*grid-template-columns:repeat\(3,minmax\(0,1fr\)\);/);
});
