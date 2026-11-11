import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/services/scopedUploads.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText;
function setup(uid = 'alice') {
    const auth = { currentUser: uid ? { uid } : null };
    const writes = [];
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, crypto: webcrypto,
        require(path) {
            if (path === 'firebase/storage') return {
                ref: (_storage, path) => ({ path, fullPath: path, bucket: "test-bucket" }),
                uploadBytes: async (object, file) => { writes.push({ path: object.path, file }); },
                getDownloadURL: () => { throw new Error("Temporary uploads must never obtain download tokens"); },
            };
            if (path === '../firebase/auth') return { __esModule: true, default: auth };
            if (path === '../firebase/storage') return { __esModule: true, default: {} };
            throw Error(`Unexpected dependency: ${path}`);
        },
    });
    return { upload: module.exports.uploadScopedFile, auth, writes };
}
for (const folder of ['face-swap', 'face-swap-faces', 'video-generation']) {
    test(`${folder}: authenticated UID, distinct crypto UUIDs, extension and token-free reference`, async () => {
        const { upload, writes } = setup();
        const file = { name: 'portrait.PNG', type: 'image/png' };
        const url = await upload(file, folder, 'alice');
        await upload(file, folder, 'alice');
        assert.equal(writes.length, 2);
        assert.match(writes[0].path, new RegExp(`^${folder}/alice/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.PNG$`));
        assert.notEqual(writes[0].path, writes[1].path);
        assert.equal(writes[0].file, file);
        assert.equal(url, `https://firebasestorage.googleapis.com/v0/b/test-bucket/o/${encodeURIComponent(writes[0].path)}`);
        assert.equal(new URL(url).search, "");
        assert.equal(new URL(url).hash, "");
    });
}
test('different users cannot select another UID', async () => {
    const alice = setup(), bob = setup('bob');
    await alice.upload({ name: 'a.png' }, 'face-swap', 'alice');
    await bob.upload({ name: 'b.png' }, 'face-swap', 'bob');
    assert.ok(alice.writes[0].path.startsWith('face-swap/alice/'));
    assert.ok(bob.writes[0].path.startsWith('face-swap/bob/'));
    await assert.rejects(bob.upload({ name: 'b.png' }, 'face-swap', 'alice'), /login/);
    assert.equal(bob.writes.length, 1);
});
test('anonymous, pending context and signed-out sessions never call uploadBytes', async () => {
    const anonymous = setup(null);
    await assert.rejects(anonymous.upload({ name: 'a.png' }, 'face-swap', 'alice'), /login/);
    assert.equal(anonymous.writes.length, 0);
    const session = setup();
    await assert.rejects(session.upload({ name: 'a.png' }, 'face-swap', undefined), /login/);
    session.auth.currentUser = null;
    await assert.rejects(session.upload({ name: 'a.png' }, 'face-swap', 'alice'), /login/);
    assert.equal(session.writes.length, 0);
});
test('invalid paths cannot write; extensionless names remain supported', async () => {
    const session = setup();
    await assert.rejects(session.upload({ name: 'a.png' }, '../other', 'alice'), /inválido/);
    assert.equal(session.writes.length, 0);
    await session.upload({ name: 'portrait' }, 'face-swap-faces', 'alice');
    assert.match(session.writes[0].path, /^face-swap-faces\/alice\/[0-9a-f-]+$/);
    const invalid = setup('alice/other');
    await assert.rejects(invalid.upload({ name: 'a.png' }, 'face-swap', 'alice/other'), /inválido/);
    assert.equal(invalid.writes.length, 0);
});
