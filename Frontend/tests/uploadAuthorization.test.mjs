// Execute actual upload handlers with mocked auth/storage; no Firebase initialization.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const transpile = source => ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText;
const helperModule = { exports: {} };
vm.runInNewContext(transpile(read('../src/utils/uploadAuthorization.ts')), {
    exports: helperModule.exports, module: helperModule,
});
const { allowAuthenticatedUpload } = helperModule.exports;
const handlers = [];
for (const [path, kind] of [
    ['../src/pages/FaceSwap/FaceSwap.tsx', 'swap'],
    ['../src/pages/VideoGeneration/VideoGeneration.tsx', 'video'],
]) {
    const source = read(path);
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = node => {
        if (kind === 'swap' && ts.isJsxAttribute(node) && node.name.getText(ast) === 'onChange'
            && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression
            && node.initializer.expression.getText(ast).includes('uploadScopedFile(')) {
            handlers.push({ name: `swap upload ${handlers.length + 1}`, body: node.initializer.expression.getText(ast) });
        }
        if (kind === 'video' && ts.isFunctionDeclaration(node) && node.name?.text === 'handleImageChange') {
            handlers.push({ name: 'video input', body: node.getText(ast).replace('async function handleImageChange', 'async function') });
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
}
assert.equal(handlers.length, 4, 'Exercise all three swap handlers and the video handler');

function prepare(body, state, duringDuration) {
    const messages = [];
    const uploads = [];
    const scope = {
        user: state.user, authLoading: state.loading,
        auth: { currentUser: state.currentUser },
        allowAuthenticatedUpload,
        setError: message => messages.push(message),
        setUploadAuthError: message => messages.push(message),
        uploadScopedFile: async (...args) => { uploads.push(args); return 'mock-url'; },
        getVideoDuration: async () => { duringDuration?.(scope); return 15; },
        URL: { createObjectURL: () => 'mock-preview' },
        console: { error() {} },
    };
    // Mock UI setters, keeping the real selection/loading/preview code executable.
    for (const name of body.matchAll(/\b(set[A-Z]\w*)\s*\(/g)) {
        scope[name[1]] ??= () => {};
    }
    scope.canUpload = () => allowAuthenticatedUpload(scope.user, scope.authLoading, scope.auth.currentUser, scope.setUploadAuthError);
    vm.runInNewContext(transpile(`globalThis.handler = (${body});`), scope);
    return { scope, messages, uploads };
}
const alice = { uid: 'alice' };
for (const handler of handlers) {
    for (const [label, state] of [
        ['anonymous / canceled or failed login', { user: null, currentUser: null, loading: false }],
        ['auth pending', { user: alice, currentUser: alice, loading: true }],
        ['signed out before React state updates', { user: alice, currentUser: null, loading: false }],
        ['changed account', { user: alice, currentUser: { uid: 'bob' }, loading: false }],
    ]) {
        test(`${handler.name}: ${label} cannot upload`, async () => {
            const { scope, uploads, messages } = prepare(handler.body, state);
            await scope.handler({ target: { files: [{ name: 'input.png', type: 'image/png' }] } });
            assert.equal(uploads.length, 0);
            assert.ok(messages.some(message => /login/.test(message)));
        });
    }
    test(`${handler.name}: authenticated upload preserves storage path`, async () => {
        const { scope, uploads } = prepare(handler.body, { user: alice, currentUser: alice, loading: false });
        const file = { name: 'input.png', type: 'image/png' };
        await scope.handler({ target: { files: [file] } });
        assert.equal(uploads.length, 1);
        assert.equal(uploads[0][0], file);
        assert.equal(uploads[0][2], 'alice');
        assert.equal(uploads[0][1], handler.name === 'video input' ? 'video-generation'
            : handler.name === 'swap upload 1' ? 'face-swap' : 'face-swap-faces');
    });
    test(`${handler.name}: canceled file selection cannot upload`, async () => {
        const { scope, uploads } = prepare(handler.body, { user: alice, currentUser: alice, loading: false });
        await scope.handler({ target: { files: [] } });
        assert.equal(uploads.length, 0);
    });
}
test('swap original: sign-out during video metadata read prevents storage upload', async () => {
    const { scope, uploads } = prepare(handlers[0].body,
        { user: alice, currentUser: alice, loading: false }, scope => { scope.auth.currentUser = null; });
    await scope.handler({ target: { files: [{ name: 'video.mp4', type: 'video/mp4' }] } });
    assert.equal(uploads.length, 0);
});
