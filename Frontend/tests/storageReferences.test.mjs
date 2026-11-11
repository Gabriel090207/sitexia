// Real resolver, mocked SDK and Auth: no app initialization or remote requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/services/storageReferences.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText;
const bucket = 'configured-bucket.firebasestorage.app';
const address = (path, query = '') => `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}${query}`;
function setup(uid = 'alice') {
    const auth = { currentUser: uid ? { uid } : null };
    const references = [];
    const storage = {};
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports,
        console: new Proxy({}, { get() { throw new Error('Resolver must not log'); } }),
        require(name) {
            if (name === 'firebase/storage') return { ref(instance, path) {
                assert.equal(instance, storage);
                const reference = { bucket, fullPath: path ?? '' };
                if (path !== undefined) references.push(reference);
                return reference;
            } };
            if (name === '../firebase/storage') return { __esModule: true, default: storage };
            if (name === '../firebase/auth') return { __esModule: true, default: auth };
            throw new Error(`Unexpected dependency: ${name}`);
        },
    });
    return { resolve: module.exports.resolveStorageReference, auth, references };
}

for (const path of ['users/alice/swaps/1700000000000.jpg',
                    'users/alice/images/batch/0/1700000000000.png',
                    'users/alice/videos/1700000000000.mp4']) {
    for (const query of ['', '?alt=media&token=old-private-token']) {
        test(`accepts result ${path}, ${query ? 'legacy token' : 'token-free'}`, () => {
            const { resolve, references } = setup();
            const result = resolve(address(path, query), 'alice');
            assert.equal(result.bucket, bucket);
            assert.equal(result.fullPath, path);
            assert.equal(references.length, 1);
            assert.ok(!JSON.stringify(result).includes('old-private-token'));
        });
    }
}

test('legacy records without type and current library shapes need no schema conversion', () => {
    const { resolve } = setup();
    for (const record of [
        { imageUrl: address('users/alice/swaps/old.jpg', '?token=legacy') },
        { id: 'i', type: 'image-generation', imageUrl: address('users/alice/images/batch/0/new.png') },
        { id: 'v', type: 'video-generation', taskId: '123', videoUrl: address('users/alice/videos/video.mp4') },
    ]) {
        const reference = resolve(record.imageUrl ?? record.videoUrl, 'alice');
        assert.ok(reference.fullPath.startsWith('users/alice/'));
    }
});

const valid = address('users/alice/images/file.png');
for (const [label, input] of [
    ['other bucket', valid.replace(bucket, 'another-bucket')],
    ['other owner', address('users/bob/images/file.png')],
    ['UID prefix', address('users/alice-other/images/file.png')],
    ['external URL', 'https://external.invalid/file.png'],
    ['host suffix', valid.replace('googleapis.com', 'googleapis.com.evil')],
    ['userinfo', valid.replace('https://', 'https://alice@')],
    ['port', valid.replace('googleapis.com', 'googleapis.com:443')],
    ['HTTP', valid.replace('https:', 'http:')],
    ['temporary input', address('face-swap/alice/file.png')],
    ['unauthorized result directory', address('users/alice/private/file.png')],
    ['empty filename', address('users/alice/images/')],
    ['dot traversal', address('users/alice/images/../bob/file.png')],
    ['dot segment', address('users/alice/images/./file.png')],
    ['raw traversal', `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/users/alice/images/../file.png`],
    ['empty segment', address('users/alice/images//file.png')],
    ['backslash', address('users/alice/images/\\file.png')],
    ['double encoding', address('users/alice/images/%2e%2e/file.png')],
    ['encoded separator twice', address('users/alice/images/a%2fb.png')],
    ['invalid escape', valid.replace('file.png', '%ZZ.png')],
    ['invalid UTF8', valid.replace('file.png', '%C0%AF.png')],
    ['encoded control', address('users/alice/images/a\n.png')],
    ['raw control', valid + '\n'],
    ['leading whitespace', ' ' + valid],
    ['fragment', valid + '#token=old-private-token'],
    ['gs scheme', `gs://${bucket}/users/alice/images/file.png`],
    ['plain path', 'users/alice/images/file.png'],
    ['null', null], ['number', 5], ['object', { imageUrl: valid }],
]) {
    test(`rejects ${label} without returning an object reference`, () => {
        const { resolve, references } = setup();
        assert.throws(() => resolve(input, 'alice'), /inválida|autorizada/);
        assert.equal(references.length, 0);
    });
}

test('requires active matching Firebase user and rejects stale account', () => {
    const { resolve, references, auth } = setup();
    assert.throws(() => resolve(valid, 'bob'), /conta original/);
    auth.currentUser = { uid: 'bob' };
    assert.throws(() => resolve(valid, 'alice'), /conta original/);
    auth.currentUser = null;
    assert.throws(() => resolve(valid, 'alice'), /conta original/);
    assert.equal(references.length, 0);
});

test('tokens are neither reused nor exposed in errors or SDK references', () => {
    const { resolve, references } = setup();
    const a = resolve(valid + '?alt=media&token=old-private-token', 'alice');
    const b = resolve(valid, 'alice');
    assert.equal(a.fullPath,b.fullPath);
    assert.ok(!JSON.stringify(references).includes('old-private-token'));
    try {
        resolve(address('users/bob/images/file.png','?token=old-private-token'), 'alice');
        assert.fail('must reject');
    } catch (error) {
        assert.ok(!error.message.includes('old-private-token'));
        assert.ok(!error.message.includes('https://'));
    }
});
