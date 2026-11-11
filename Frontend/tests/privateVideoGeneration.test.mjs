import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/pages/VideoGeneration/VideoGeneration.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('VideoGeneration.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['handleGenerateVideo', 'registerSavedVideo', 'retryVideoRegistration'];
const functions = [];
function visit(node) {
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
        user, auth: { currentUser: user }, pageMounted: { current: true },
        generationInFlight: { current: false }, registrationInFlight: { current: false },
        activeVideo: null, isUploading: false, activeMode: 'image-to-video', imageUrl: 'input-reference',
        prompt: 'prompt', duration: 5, currentSourceVideo: { id: 'source-document', taskId: 'source-task' }, db: {},
        setError: x => errors.push(x), setGeneratedVideo: x => { results.push(x); scope.activeVideo = x; },
        setIsGenerating() {}, setIsRegistering() {}, setGenerationStatus() {},
        getGenerationErrorMessage: (_error, fallback) => fallback,
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
    ['reference-to-video', 'reference', ['input-reference', 'prompt', 5]],
    ['text-to-video', 'text', ['prompt', 'input-reference', 5]],
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
