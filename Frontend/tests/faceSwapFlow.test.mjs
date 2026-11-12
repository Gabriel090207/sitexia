import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
const module = { exports: {} };
vm.runInNewContext(compile(read('../src/pages/FaceSwap/faceSwapPolling.ts')), { module, exports: module.exports, URL, setTimeout, clearTimeout });
const helpers = module.exports;
const intentModule = { exports: {} };
vm.runInNewContext(compile(read('../src/pages/FaceSwap/faceSwapIntent.ts')), {
    module: intentModule, exports: intentModule.exports, URL, crypto: webcrypto,
    require: () => helpers,
});
const intents = intentModule.exports;
const { waitForFaceSwap } = helpers;
for (const field of ['status', 'taskStatus']) {
    for (const status of ['FAILED', 'UNKNOWN', 'unexpected', undefined]) {
        test(`${field}: stops on ${status}`, async () => {
            let calls = 0;
            await assert.rejects(waitForFaceSwap(async () => { calls++; return { [field]: status }; }, field, 'teste', 200, 0));
            assert.equal(calls, 1);
        });
    }
    test(`${field}: pending/running/succeeded`, async () => {
        const states = ['PENDING', 'RUNNING', 'SUCCEEDED'];
        assert.equal((await waitForFaceSwap(async () => ({ [field]: states.shift() }), field, 'teste', 200, 0))[field], 'SUCCEEDED');
    });
}
test('HTTP error stops polling without retry', async () => {
    let calls = 0;
    await assert.rejects(waitForFaceSwap(async () => { calls++; throw new Error('HTTP'); }, 'status', 'teste', 200, 0), /HTTP/);
    assert.equal(calls, 1);
});
for (const [name, fetch] of [['stalled', () => new Promise(() => {})], ['pending', async () => ({ status: 'PENDING' })]]) {
    test(`${name} request reaches deadline`, async () => {
        await assert.rejects(waitForFaceSwap(fetch, 'status', 'teste', 20, 0), /limite de espera/);
    });
}
const source = read('../src/pages/FaceSwap/FaceSwap.tsx');
const ast = ts.createSourceFile('FaceSwap.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleGenerateSwap') handler = node.getText(ast);
    ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(handler);
function prepare(overrides = {}) {
    const calls = [], errors = [], loading = [], results = [];
    const scope = {
        ...helpers, ...intents, generationInFlight: { current: false }, activeResult: null, privateImageUrl: "", pageMounted: { current: true }, resultUrl: '', canGenerate: true,
        auth: { currentUser: { uid: 'user' } },
        startSwapTask: (intent, original, services) => intents.startSwapTask(intent, original,
            { ...services, wait: (fetch, field, label) => waitForFaceSwap(fetch, field, label, 200, 0) }),
        user: { uid: 'user' }, fileUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/face-swap%2Fuser%2Foriginal.png?token=secret', faceUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/face-swap-faces%2Fuser%2Fface.png?token=secret', isVideo: false, isGif: false, videoDuration: 0,
        setIsGenerating: value => loading.push(value), setGenerationError: value => errors.push(value),
        setPrivateResult: value => { scope.presentation = value; }, setPrivateImageUrl: () => {},
        setResultUrl: value => results.push(value), window: { open() {} },
        getGenerationErrorMessage: (_error, fallback) => fallback,
        createMaterial: async () => { calls.push('material'); return { materialId: '123' }; },
        getMaterial: async () => ({ materialId: '123', status: 'SUCCEEDED', faces: [{ id: '456' }] }),
        createSwapTask: async () => { calls.push('task'); return { taskId: '789' }; },
        getSwapTask: async () => ({ taskStatus: 'SUCCEEDED', imageUrls: ['https://example.com/result.png'] }),
        getSwapResult: async () => ({ file_url: 'https://example.com/result.png' }),
        saveFaceSwapResult: async (_url,_uid,kind) => { calls.push('upload'); return {reference:'saved',mediaType:kind==='unknown'?'image':kind}; },
        createLibraryImage: async (...args) => { calls.push(['library', ...args]); },
        createLibraryVideo: async (...args) => { calls.push(['library-video', ...args]); return 'actual-library-id'; },
        findFaceSwapVideo: async () => null,
        waitForFaceSwap: (fetch, field, label) => waitForFaceSwap(fetch, field, label, 200, 0),
        ...overrides,
    };
    scope.auth.currentUser = scope.user;
    vm.runInNewContext(compile(handler + '\nglobalThis.run = handleGenerateSwap;'), scope);
    return { scope, calls, errors, loading, results };
}
for (const [name, override, message, beforeTask] of [
    ['analysis failure', { getMaterial: async () => ({ status: 'FAILED' }) }, /Falha/, true],
    ['no faces', { getMaterial: async () => ({ materialId: '123', status: 'SUCCEEDED', faces: [] }) }, /Nenhum rosto/, true],
    ['invalid faces', { getMaterial: async () => ({ materialId: '123', status: 'SUCCEEDED', faces: [null, {}] }) }, /rosto válido/, true],
    ['HTTP error', { getMaterial: async () => { throw new Error('HTTP'); } }, /Não foi possível/, true],
    ['task failed', { getSwapTask: async () => ({ taskStatus: 'FAILED' }) }, /Falha/, false],
    ['invalid result', { getSwapResult: async () => ({}) }, /URL/, false],
]) {
    test(`handler: ${name} clears loading and lock`, async () => {
        const state = prepare(override);
        await state.scope.run();
        assert.match(state.errors.at(-1), message);
        assert.deepEqual(state.loading, [true, false]);
        assert.equal(state.scope.generationInFlight.current, false);
        assert.ok(!state.calls.includes('upload'));
        if (beforeTask) assert.ok(!state.calls.includes('task'));
    });
}
for (const operation of ['saveFaceSwapResult', 'createLibraryImage']) {
    test(`handler: ${operation} failure preserves result`, async () => {
        const state = prepare({ [operation]: async () => { throw new Error('firebase'); } });
        await state.scope.run();
        assert.equal(state.results.length, 0);
        assert.match(state.errors.at(-1), /concluído.*biblioteca/);
        assert.equal(state.loading.at(-1), false);
    });
}
test('handler: concurrent clicks do not duplicate creation', async () => {
    const state = prepare();
    await Promise.all([state.scope.run(), state.scope.run()]);
    assert.equal(state.calls.filter(call => call === 'material').length, 1);
    assert.equal(state.calls.filter(call => call === 'task').length, 1);
});
test('handler: success preserves library arguments', async () => {
    const state = prepare();
    await state.scope.run();
    assert.deepEqual(state.loading, [true, false]);
    assert.deepEqual(state.results, []);
    assert.equal(state.scope.presentation.reference, 'saved');
    assert.equal(state.scope.presentation.kind, 'image');
    assert.deepEqual(state.calls.at(-1), ['library', 'user', 'saved', 'face-swap']);
    assert.equal(state.errors.at(-1), '');
});
const inputs = {
    original: 'https://firebasestorage.googleapis.com/v0/b/demo/o/face-swap%2Fuser%2Foriginal.png?token=original-secret',
    target: 'https://firebasestorage.googleapis.com/v0/b/demo/o/face-swap-faces%2Fuser%2Fface.png?token=face-secret',
    mediaType: 'image', duration: null,
};
for (const [status, code, message] of [
    [409, 'operation_pending_or_cancelled', /sem confirmação|cancelada/],
    [409, undefined, /conflito/], [422, undefined, /rejeitou/],
    [502, 'submission_unconfirmed', /reserva pode continuar/],
]) {
    test(`HTTP ${status}/${code} does not retry automatically`, async () => {
        let posts = 0;
        const state = prepare({ createSwapTask: async () => { posts++; throw { response: { status, data: { detail: { code } } } }; } });
        await state.scope.run();
        assert.equal(posts, 1);
        assert.match(state.errors.at(-1), message);
        assert.equal(state.loading.at(-1), false);
    });
}
test('API adapter sends Idempotency-Key header with unchanged body fields', async () => {
    const apiModule = { exports: {} };
    let args;
    vm.runInNewContext(compile(read('../src/api/swap.ts')), {
        module: apiModule, exports: apiModule.exports,
        require: () => ({ __esModule: true, default: { post: async (...values) => { args = values; return { data: { taskId: '789' } }; } } }),
    });
    const key = webcrypto.randomUUID();
    await apiModule.exports.createSwapTask('123', '456', inputs.target, 'image', null, key);
    assert.equal(args[0], '/swap/task');
    assert.equal(args[2].headers['Idempotency-Key'], key);
    assert.equal(args[1].material_id, '123');
});

for (const reference of [
    'https://firebasestorage.googleapis.com/v0/b/demo/o/users%2Fuser%2Fswaps%2Fimage.png?token=legacy',
    'https://firebasestorage.googleapis.com/v0/b/demo/o/users%2Fuser%2Fswaps%2Fimage.png',
]) test('private image presentation retains saved Firebase reference, not provider URL',async()=>{
    const state=prepare({saveFaceSwapResult:async()=>({reference,mediaType:"image"})});
    await state.scope.run();
    assert.equal(state.scope.presentation.reference,reference);
    assert.equal(state.scope.presentation.owner,state.scope.user);
    assert.equal(state.scope.presentation.kind,'image');
    assert.ok(!state.results.includes('https://example.com/result.png'));
    assert.deepEqual(state.calls.at(-1),['library','user',reference,'face-swap']);
});
test('library registration failure retains the saved reference for private display',async()=>{
    const state=prepare({createLibraryImage:async()=>{throw Error('Firestore');}});
    await state.scope.run();
    assert.equal(state.scope.presentation.reference,'saved');
    assert.match(state.errors.at(-1),/concluído e salvo.*biblioteca/);
});
test('upload failure does not register a nonexistent image',async()=>{
    const state=prepare({saveFaceSwapResult:async()=>{throw Error('Storage');}});
    await state.scope.run();
    assert.equal(state.scope.presentation.kind,'image');
    assert.equal(state.scope.presentation.reference,undefined);
    assert.ok(!state.calls.some(call=>Array.isArray(call)&&call[0]==='library'));
    assert.equal(state.calls.filter(call=>call==='task').length,1);
    assert.match(state.errors.at(-1),/não foi possível salvar/);
});
for(const change of ['logout','other-user','unmount'])test(`late result is not presented after ${change}`,async()=>{
    let finish;
    const state=prepare({getSwapResult:()=>new Promise(resolve=>{finish=resolve;})});
    const running=state.scope.run();
    while(!finish) await new Promise(resolve=>setTimeout(resolve,1));
    if(change==='unmount')state.scope.pageMounted.current=false;
    else state.scope.auth.currentUser=change==='logout'?null:{uid:'other'};
    finish({file_url:'https://example.com/result.png'});await running;
    assert.equal(state.scope.presentation,undefined);
    assert.equal(state.results.length,0);
    assert.ok(!state.calls.includes('upload'));
});
test('video retains provider opening behavior without using image presentation',async()=>{
    const state=prepare({getSwapTask:async()=>({taskStatus:'SUCCEEDED',videoUrl:'https://provider.invalid/output.mp4'}),
        getSwapResult:async()=>({file_url:'https://provider.invalid/output.mp4'})});
    await state.scope.run();
    assert.equal(state.scope.presentation.kind,'video');
    assert.equal(state.results.length,0);
    assert.equal(state.scope.presentation.libraryItemId,'actual-library-id');
    assert.deepEqual(state.calls.at(-1),['library-video','user','saved','789','face-swap']);
});
test('ambiguous task output uses the media type validated by the save helper',async()=>{
    const state=prepare({getSwapTask:async()=>({taskStatus:'SUCCEEDED'})});
    await state.scope.run();
    assert.equal(state.scope.presentation.kind,'image');
    assert.equal(state.scope.presentation.reference,'saved');
    assert.equal(state.results.length,0);
});

test('private video playback receives actual ID returned by registration, never a fabricated task ID',async()=>{
    const url='https://provider.invalid/output.mp4';
    const state=prepare({getSwapTask:async()=>({taskStatus:'SUCCEEDED',videoUrl:url}),
        getSwapResult:async()=>({file_url:url}),createLibraryVideo:async()=> 'firestore-random-document-id'});
    await state.scope.run();
    assert.equal(state.scope.presentation.libraryItemId,'firestore-random-document-id');
    assert.equal(state.scope.presentation.taskId,'789');
    assert.equal(state.scope.presentation.reference,'saved');assert.equal(state.results.length,0);
});
test('failed registration preserves video reference without granting playback',async()=>{
    const url='https://provider.invalid/output.mp4';
    const state=prepare({getSwapTask:async()=>({taskStatus:'SUCCEEDED',videoUrl:url}),getSwapResult:async()=>({file_url:url}),
        createLibraryVideo:async()=>{throw Error('denied');}});
    await state.scope.run();
    assert.equal(state.scope.presentation.reference,'saved');assert.equal(state.scope.presentation.libraryItemId,undefined);
    assert.match(state.errors.at(-1),/concluído e salvo.*registro/);
});
test('Face Swap reuses native private player and removes provider playback fallback',()=>{
    assert.ok(source.includes('<PrivateLibraryVideo'));
    assert.ok(source.includes('itemId={activeResult.libraryItemId}'));
    assert.ok(source.includes('uid={activeResult.owner.uid}'));
    assert.ok(!source.includes('setResultUrl('));
    assert.ok(source.includes('<PrivateFaceSwapImage'));
    assert.ok(!source.includes('<video')); // One existing player/controller only.
});

for (const [mediaType, duration] of [['image', null], ['gif', null], ['video', 16]]) {
    test(`new ${mediaType} generations use current files and distinct idempotency keys`, async () => {
        const submitted = [], originals = [];
        const state = prepare({ isVideo: mediaType === 'video', isGif: mediaType === 'gif', videoDuration: duration,
            createMaterial: async url => { originals.push(url); return {materialId:'123'}; },
            createSwapTask: async (...args) => { submitted.push(args); return {taskId:'789'}; } });
        await state.scope.run();
        const firstOriginal = state.scope.fileUrl;
        state.scope.fileUrl = firstOriginal.replace('original.png', 'current.png');
        state.scope.faceUrl = state.scope.faceUrl.replace('face.png', 'current-face.png');
        await state.scope.run();
        assert.deepEqual(originals, [firstOriginal, state.scope.fileUrl]);
        assert.equal(submitted.length, 2);
        assert.notEqual(submitted[0][5], submitted[1][5]);
        assert.match(submitted[0][5], /^[0-9a-f-]{36}$/);
        assert.equal(submitted[1][2], state.scope.faceUrl.split('?')[0]);
        assert.equal(submitted[1][3], mediaType);
        assert.equal(submitted[1][4], duration);
    });
}
test('Face Swap has no persisted intentions, restoration, or recovery controls', () => {
    const flow = read('../src/pages/FaceSwap/faceSwapIntent.ts');
    assert.doesNotMatch(source + flow, /sessionStorage|localStorage|loadIntents|storeIntent|pendingIntents|sessionReady|recoverSwapTask|recupera|Recupera/);
    assert.equal(intents.loadIntents, undefined);
    assert.equal(intents.storeIntent, undefined);
    assert.equal(intents.recoverSwapTask, undefined);
});
test('submission failure sends once and clears the active lock', async () => {
    let posts = 0;
    const state = prepare({createSwapTask: async () => { posts++; throw Error('network'); }});
    await state.scope.run();
    assert.equal(posts, 1);
    assert.deepEqual(state.loading, [true, false]);
    assert.equal(state.scope.generationInFlight.current, false);
});

test('logout during material analysis prevents task submission', async () => {
    const state = prepare({ getMaterial: async () => {
        state.scope.auth.currentUser = null;
        return {materialId:'123', status:'SUCCEEDED', faces:[{id:'456'}]};
    } });
    await state.scope.run();
    assert.ok(!state.calls.includes('task'));
    assert.equal(state.scope.generationInFlight.current, false);
});

// Inspect the real JSX and execute its file handler without browser dependencies.
const attribute = (node, name) => node.attributes.properties.find(item => item.name?.getText(ast) === name);
const fileInputs = [];
function collectFileInputs(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'input'
        && attribute(node, 'ref')?.initializer?.expression?.getText(ast) === 'fileInputRef') fileInputs.push(node);
    ts.forEachChild(node, collectFileInputs);
}
collectFileInputs(ast);
test('one file input stays outside selection/loading/preview branches and both buttons target it', () => {
    assert.equal(fileInputs.length, 1);
    const input = fileInputs[0];
    assert.equal(attribute(input, 'accept').initializer.text, 'image/*,video/*');
    assert.ok(ts.isJsxElement(input.parent));
    assert.match(input.parent.openingElement.getText(ast), /face-swap-upload-dropzone/);
    const branches = input.parent.children.find(child => ts.isJsxExpression(child)
        && child.expression && ts.isConditionalExpression(child.expression));
    assert.equal(branches.expression.condition.getText(ast), 'loadingFile');
    assert.match(branches.getText(ast), /!fileUrl/);
    const buttons = [];
    function collect(node) {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'button') buttons.push(node);
        ts.forEachChild(node, collect);
    }
    collect(branches);
    assert.equal(buttons.length, 2);
    let clicks = 0;
    for (const button of buttons) {
        const handler = attribute(button.openingElement, 'onClick').initializer.expression.getText(ast);
        vm.runInNewContext(compile(`(${handler})();`), { fileInputRef: { current: { click: () => clicks++ } } });
    }
    assert.equal(clicks, 2);
});
function uploadHandler(authorized = true) {
    const calls = [];
    const scope = {
        canUpload: () => authorized, user: {uid:'user'},
        setLoadingFile: value => calls.push(['loading',value]),
        setSelectedFile: file => calls.push(['selected',file]),
        getVideoDuration: async () => 16,
        setVideoDuration: value => calls.push(['duration',value]),
        uploadScopedFile: async (...args) => { calls.push(['upload',...args]); return 'uploaded'; },
        setFileUrl: value => calls.push(['url',value]),
    };
    const handler = attribute(fileInputs[0], 'onChange').initializer.expression.getText(ast);
    vm.runInNewContext(compile(`globalThis.change = ${handler};`), scope);
    return {change:scope.change,calls};
}
for (const type of ['image/png','image/gif','video/mp4']) test(`file selection and replacement preserve upload handling: ${type}`, async () => {
    const {change,calls} = uploadHandler();
    const file = {type};
    const input = {files:[file],value:'selected-file'};
    await change({target:input,currentTarget:input});
    assert.equal(input.value,''); // A subsequent choice of the same file can emit change.
    assert.deepEqual(calls, [['loading',true],['selected',file],['duration',type.startsWith('video/')?16:0],
        ['upload',file,'face-swap','user'],['url','uploaded'],['loading',false]]);
    input.files = [{type:'image/jpeg'}];
    await change({target:input,currentTarget:input});
    assert.equal(calls.filter(call=>call[0]==='upload').length,2);
    assert.equal(calls.filter(call=>call[0]==='selected').at(-1)[1],input.files[0]);
});
test('cancelled file selection leaves current application state untouched', async () => {
    const {change,calls} = uploadHandler();
    const input = {files:[],value:''};
    await change({target:input,currentTarget:input});
    assert.deepEqual(calls,[]);
});
test('unauthorized file selection cannot start an upload or replace application state', async () => {
    const {change,calls} = uploadHandler(false);
    const input = {files:[{type:'image/png'}],value:'file'};
    await change({target:input,currentTarget:input});
    assert.deepEqual(calls,[]);
});
