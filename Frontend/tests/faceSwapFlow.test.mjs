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
        sessionReady: true, auth: { currentUser: { uid: 'user' } }, intentsRef: { current: { uid: 'user', items: [] } },
        recoverSwapTask: (intent, original, remember, services) => intents.recoverSwapTask(intent, original, remember,
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
    scope.rememberIntent = intent => { scope.intentsRef.current.items = [...scope.intentsRef.current.items.filter(item => item.key !== intent.key), { ...intent }]; };
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

function memoryStorage() {
    const data = new Map();
    return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
}
const inputs = {
    original: 'https://firebasestorage.googleapis.com/v0/b/demo/o/face-swap%2Fuser%2Foriginal.png?token=original-secret',
    target: 'https://firebasestorage.googleapis.com/v0/b/demo/o/face-swap-faces%2Fuser%2Fface.png?token=face-secret',
    mediaType: 'image', duration: null,
};
test('new intent uses UUID, same inputs preserve key, changed inputs generate another', () => {
    const first = intents.selectIntent([], inputs);
    assert.match(first.key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(intents.selectIntent([first], { ...inputs, target: inputs.target.replace('face-secret', 'rotated') }).key, first.key);
    assert.notEqual(intents.selectIntent([first], { ...inputs, target: inputs.target.replace('face.png', 'new.png') }).key, first.key);
});
test('refresh only restores state, strips token URLs, isolates accounts and makes no calls', () => {
    const storage = memoryStorage();
    const first = intents.selectIntent([], inputs);
    first.materialId = '123'; first.sourceFaceId = '456'; first.phase = 'task-requested';
    intents.storeIntent(storage, 'user', [], first);
    const restored = intents.loadIntents(storage, 'user');
    assert.equal(restored[0].key, first.key);
    assert.equal(restored[0].materialId, '123');
    assert.equal(intents.loadIntents(storage, 'another-user').length, 0);
    assert.ok(!JSON.stringify([...storage.data.values()]).includes('secret'));
    assert.ok(!JSON.stringify([...storage.data.values()]).includes('token='));
});
test('existing task resumes GET polling without material recreation or task POST', async () => {
    const state = prepare();
    const intent = { ...intents.selectIntent([], inputs), materialId: '123', sourceFaceId: '456', taskId: '789', phase: 'task-known' };
    await state.scope.run(intent);
    assert.ok(!state.calls.includes('material'));
    assert.ok(!state.calls.includes('task'));
    assert.equal(state.results.length, 0);
});
test('creation timeout preserves key and exact intent for explicit recovery', async () => {
    const state = prepare({ createSwapTask: async (...args) => { state.calls.push(['submit', ...args]); throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); } });
    await state.scope.run();
    const preserved = state.scope.intentsRef.current.items[0];
    assert.equal(preserved.phase, 'task-requested');
    assert.equal(state.calls.filter(call => Array.isArray(call) && call[0] === 'submit').length, 1);
    const key = preserved.key;
    let replayArgs;
    state.scope.createSwapTask = async (...args) => { replayArgs = args; return { taskId: '789' }; };
    await state.scope.run(preserved);
    assert.equal(replayArgs.at(-1), key);
    assert.equal(state.calls.filter(call => call === 'material').length, 1);
    assert.equal(state.scope.intentsRef.current.items[0].materialId, '123');
});
for (const [status, code, message] of [
    [409, 'operation_pending_or_cancelled', /sem confirmação|cancelada/],
    [409, undefined, /conflito/], [422, undefined, /rejeitou/],
    [502, 'submission_unconfirmed', /reserva pode continuar/],
]) {
    test(`HTTP ${status}/${code} preserves operation without automatic retry`, async () => {
        let posts = 0;
        const state = prepare({ createSwapTask: async () => { posts++; throw { response: { status, data: { detail: { code } } } }; } });
        await state.scope.run();
        assert.equal(posts, 1);
        assert.match(state.errors.at(-1), message);
        assert.equal(state.scope.intentsRef.current.items[0].phase, 'task-requested');
        assert.equal(state.loading.at(-1), false);
    });
}
test('unconfirmed material is not automatically recreated after reload', async () => {
    const intent = { ...intents.selectIntent([], inputs), phase: 'material-requested' };
    const state = prepare();
    await state.scope.run(intent);
    assert.match(state.errors.at(-1), /material.*sem confirmação/);
    assert.ok(!state.calls.includes('material'));
    assert.ok(!state.calls.includes('task'));
});
test('saved task recovery does not upload or register again', async () => {
    const intent = { ...intents.selectIntent([], inputs), taskId: '789', phase: 'task-known', saved: true };
    const state = prepare();
    await state.scope.run(intent);
    assert.equal(state.results.length, 0);
    assert.equal(state.calls.length, 0);
});
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

test('changing original or media parameters starts a distinct intent', () => {
    const first = intents.selectIntent([], inputs);
    for (const change of [
        { original: inputs.original.replace('original.png', 'another.png') },
        { mediaType: 'video', duration: 16 },
    ]) assert.notEqual(intents.selectIntent([first], { ...inputs, ...change }).key, first.key);
});
test('corrupt session data fails closed instead of silently losing keys', () => {
    const storage = memoryStorage();
    storage.setItem('xia:face-swap:intents:v1:user', '{invalid');
    assert.throws(() => intents.loadIntents(storage, 'user'), /operações preservadas/);
});
test('pending attempts are not evicted when session reaches its limit', () => {
    const storage = memoryStorage();
    let records = [];
    for (let i = 0; i < 20; i++) {
        const intent = intents.selectIntent([], { ...inputs, target: inputs.target.replace('face.png', `${i}.png`) });
        records = intents.storeIntent(storage, 'user', records, intent);
    }
    const before = storage.getItem('xia:face-swap:intents:v1:user');
    assert.throws(() => intents.storeIntent(storage, 'user', records, intents.selectIntent([], inputs)), /operações pendentes/);
    assert.equal(storage.getItem('xia:face-swap:intents:v1:user'), before);
});
test('session persistence failure prevents any material or task request', async () => {
    const state = prepare();
    state.scope.rememberIntent = () => { throw new helpers.FaceSwapFlowError('Não foi possível preservar a operação'); };
    await state.scope.run();
    assert.equal(state.calls.length, 0);
    assert.equal(state.loading.at(-1), false);
});

// Removing transport tokens must preserve the same persisted user intention.
test('token-free references recover existing token-based intention without a new key', () => {
    const old = intents.selectIntent([], inputs);
    const storage = memoryStorage();
    intents.storeIntent(storage, 'user', [], old);
    const loaded = intents.loadIntents(storage, 'user');
    const recovered = intents.selectIntent(loaded, { ...inputs,
        original: inputs.original.split('?')[0], target: inputs.target.split('?')[0] });
    assert.equal(recovered.key, old.key);
    assert.equal(recovered.original, old.original);
    assert.equal(recovered.target, old.target);
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
test('upload failure leaves manual recovery without registering a nonexistent image',async()=>{
    const state=prepare({saveFaceSwapResult:async()=>{throw Error('Storage');}});
    await state.scope.run();
    assert.equal(state.scope.presentation.kind,'image');
    assert.equal(state.scope.presentation.reference,undefined);
    assert.ok(!state.calls.some(call=>Array.isArray(call)&&call[0]==='library'));
    assert.equal(state.calls.filter(call=>call==='task').length,1);
    assert.match(state.errors.at(-1),/recuperação manual/);
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
test('completed saved task without a local reference is not uploaded a second time',async()=>{
    const intent={...intents.selectIntent([],inputs),taskId:'789',phase:'task-known',saved:true};
    const state=prepare();await state.scope.run(intent);
    assert.equal(state.calls.length,0);
    assert.equal(state.scope.presentation.reference,undefined);
    assert.equal(state.results.length,0);
});

test('recovering a saved video after registration failure does not upload or create another task',async()=>{
    const url='https://provider.invalid/result.mp4';
    const state=prepare({getSwapTask:async()=>({taskStatus:'SUCCEEDED',videoUrl:url}),getSwapResult:async()=>({file_url:url}),
        createLibraryVideo:async()=>{throw Error('Firestore');}});
    await state.scope.run();
    assert.equal(state.scope.presentation.reference,'saved');assert.match(state.errors.at(-1),/concluído e salvo/);
    const intent=state.scope.intentsRef.current.items[0];
    state.scope.activeResult=state.scope.presentation;
    state.scope.createLibraryVideo=async(...args)=>{state.calls.push(['library-video',...args]);return 'recovered-library-id';};
    await state.scope.run(intent);
    assert.equal(state.calls.filter(call=>call==='task').length,1);
    assert.equal(state.calls.filter(call=>call==='upload').length,1);
    assert.equal(state.scope.intentsRef.current.items[0].saved,true);
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
for(const saved of [true,false])test(`manual recovery finds a confirmed library video without duplicate upload/registration (saved=${saved})`,async()=>{
    const url='https://provider.invalid/output.mp4',lookups=[];
    const intent={...intents.selectIntent([],inputs),taskId:'789',phase:'task-known',saved};
    const state=prepare({getSwapTask:async()=>({taskStatus:'SUCCEEDED',videoUrl:url}),getSwapResult:async()=>({file_url:url}),
        findFaceSwapVideo:async(...args)=>{lookups.push(args);return {id:'real-existing-id',reference:'existing-reference'};}});
    await state.scope.run(intent);
    assert.deepEqual(lookups,[['user','789']]);assert.equal(state.calls.length,0);
    assert.equal(state.scope.presentation.libraryItemId,'real-existing-id');
    assert.equal(state.scope.presentation.reference,'existing-reference');assert.equal(state.results.length,0);
});
test('confirmed current-session ID is reused without a query or another upload',async()=>{
    const url='https://provider.invalid/output.mp4';
    const state=prepare({getSwapTask:async()=>({taskStatus:'SUCCEEDED',videoUrl:url}),getSwapResult:async()=>({file_url:url})});
    await state.scope.run();
    const count=state.calls.length;
    state.scope.activeResult=state.scope.presentation;
    state.scope.findFaceSwapVideo=async()=>{throw Error('should not query');};
    await state.scope.run(state.scope.intentsRef.current.items[0]);
    assert.equal(state.calls.length,count);assert.equal(state.scope.presentation.libraryItemId,'actual-library-id');
});
test('logout during recovery query ignores the old library response',async()=>{
    const url='https://provider.invalid/output.mp4';let finish;
    const state=prepare({getSwapTask:async()=>({taskStatus:'SUCCEEDED',videoUrl:url}),getSwapResult:async()=>({file_url:url}),
        findFaceSwapVideo:()=>new Promise(resolve=>{finish=resolve;})});
    const intent={...intents.selectIntent([],inputs),taskId:'789',phase:'task-known',saved:true};
    const pending=state.scope.run(intent);
    while(!finish)await new Promise(resolve=>setTimeout(resolve,1));
    state.scope.auth.currentUser=null;finish({id:'private-id',reference:'saved'});await pending;
    assert.equal(state.scope.presentation,undefined);assert.equal(state.calls.length,0);
});
test('Face Swap reuses native private player and removes provider playback fallback',()=>{
    assert.ok(source.includes('<PrivateLibraryVideo'));
    assert.ok(source.includes('itemId={activeResult.libraryItemId}'));
    assert.ok(source.includes('uid={activeResult.owner.uid}'));
    assert.ok(!source.includes('setResultUrl('));
    assert.ok(source.includes('<PrivateFaceSwapImage'));
    assert.ok(!source.includes('<video')); // One existing player/controller only.
});
