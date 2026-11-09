import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL(
    '../src/pages/ImageGeneration/processImageResults.ts', import.meta.url,
), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText, { module, exports: module.exports, URL });
const { processImageResults } = module.exports;

function services(failUpload = -1, failRegister = -1) {
    const uploads = [], saved = [], registered = [];
    return {
        uploads, saved, registered,
        upload: async (url, folder) => {
            const index = uploads.length;
            uploads.push({ url, folder });
            if (index === failUpload) throw new Error('storage/download failure');
            return `https://storage.example/${index}.png`;
        },
        onSaved: url => saved.push(url),
        register: async (uid, url, type) => {
            if (url.endsWith(`/${failRegister}.png`)) throw new Error('library failure');
            registered.push({ uid, url, type });
        },
    };
}
const urls = count => Array.from({ length: count }, (_, i) => `https://example.com/${i}.png`);
for (const count of [1, 4, 9, 5, 10]) {
    test(`processes all ${count} images, including additional grids`, async () => {
        const mocks = services();
        const outcome = await processImageResults(urls(count), 'user', 'batch', mocks);
        assert.equal(mocks.saved.length, count);
        assert.equal(mocks.registered.length, count);
        assert.equal(new Set(mocks.uploads.map(item => item.folder)).size, count);
        assert.ok(mocks.registered.every(item => item.type === 'image-generation'));
        assert.equal(outcome.uploadFailures + outcome.libraryFailures, 0);
    });
}
for (const value of [undefined, null, [], 'https://example.com', [null],
    ['invalid'], ['javascript:alert(1)'], ['data:image/png;base64,abc'],
    ['https://user:password@example.com/a.png'], [...urls(1), 'invalid']]) {
    test(`rejects invalid response ${JSON.stringify(value)} before upload`, async () => {
        const mocks = services();
        await assert.rejects(processImageResults(value, 'user', 'batch', mocks));
        assert.equal(mocks.uploads.length, 0);
        assert.equal(mocks.registered.length, 0);
    });
}
test('upload failure preserves successes and continues without registering failed image', async () => {
    const mocks = services(1);
    const outcome = await processImageResults(urls(4), 'user', 'batch', mocks);
    assert.equal(outcome.uploadFailures, 1);
    assert.equal(mocks.uploads.length, 4);
    assert.equal(mocks.saved.length, 3);
    assert.equal(mocks.registered.length, 3);
    assert.ok(!mocks.registered.some(item => item.url.endsWith('/1.png')));
});
test('library failure preserves saved image for display and reports partial failure', async () => {
    const mocks = services(-1, 1);
    const outcome = await processImageResults(urls(4), 'user', 'batch', mocks);
    assert.equal(outcome.libraryFailures, 1);
    assert.equal(mocks.saved.length, 4);
    assert.equal(mocks.registered.length, 3);
});
