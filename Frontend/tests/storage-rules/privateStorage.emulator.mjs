// Real Storage Emulator only. No credentials, production project or remote URLs.
// Use firebase emulators:exec --project demo-xiaswap-private-rules --only storage
// --config Frontend/tests/storage-rules/firebase.json "node --test .../privateStorage.emulator.mjs"
// STORAGE_RULES_TEST_MODULE_ROOT optionally locates already-installed test tooling.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
const projectId = 'demo-xiaswap-private-rules';
if (process.env.FIREBASE_STORAGE_EMULATOR_HOST !== '127.0.0.1:9398'
    || process.env.GCLOUD_PROJECT !== projectId) throw Error('Requires isolated demo Storage Emulator');
const require = process.env.STORAGE_RULES_TEST_MODULE_ROOT
    ? createRequire(`${process.env.STORAGE_RULES_TEST_MODULE_ROOT}/package.json`)
    : createRequire(import.meta.url);
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { ref, uploadBytes, getBytes, getMetadata, deleteObject, updateMetadata, listAll } = require('firebase/storage');
let env;
const storage = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).storage();
const denied = action => assert.rejects(action, error => error.code === 'storage/unauthorized');
const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const uuid = '550e8400-e29b-41d4-a716-446655440000';
const seed = path => env.withSecurityRulesDisabled(context => uploadBytes(ref(context.storage(), path), bytes, { contentType: 'image/png' }));
before(async () => {
    env = await initializeTestEnvironment({ projectId, storage: { host: '127.0.0.1', port: 9398,
        rules: readFileSync(new URL('../../../storage.rules', import.meta.url), 'utf8') } });
});
beforeEach(async () => env.clearStorage());
after(async () => { if (env) await env.cleanup(); });
for (const folder of ['face-swap', 'face-swap-faces', 'video-generation']) {
    const path = `${folder}/alice/${uuid}.png`;
    test(`${folder}: owner creates UUID input and reads bytes/metadata`, async () => {
        const object = ref(storage('alice'), path);
        await uploadBytes(object, bytes, { contentType: 'image/png' });
        assert.deepEqual(new Uint8Array(await getBytes(object)), bytes);
        assert.equal((await getMetadata(object)).contentType, 'image/png');
    });
    test(`${folder}: anonymous and other-user reads/uploads denied`, async () => {
        await seed(path);
        for (const uid of [undefined, 'bob']) {
            await denied(getBytes(ref(storage(uid), path)));
            await denied(getMetadata(ref(storage(uid), path)));
            await denied(uploadBytes(ref(storage(uid), `${folder}/alice/550e8400-e29b-41d4-a716-446655440001.png`), bytes));
        }
    });
    test(`${folder}: owner overwrite, metadata update and deletion denied`, async () => {
        await seed(path);
        const object = ref(storage('alice'), path);
        await denied(uploadBytes(object, new Uint8Array([9])));
        await denied(updateMetadata(object, { contentType: 'text/plain' }));
        await denied(deleteObject(object));
        assert.deepEqual(new Uint8Array(await getBytes(object)), bytes);
    });
    test(`${folder}: existing nested inputs owner-only; new nested inputs denied`, async () => {
        const nested = `${folder}/alice/legacy/nested/file.png`;
        await seed(nested);
        assert.deepEqual(new Uint8Array(await getBytes(ref(storage('alice'), nested))), bytes);
        for (const uid of [undefined, 'bob']) await denied(getBytes(ref(storage(uid), nested)));
        await denied(uploadBytes(ref(storage('alice'), `${folder}/alice/nested/new.png`), bytes));
    });
    test(`${folder}: malformed create, unscoped legacy read and all listing denied`, async () => {
        await seed(`${folder}/legacy.png`);
        for (const uid of [undefined, 'alice', 'bob']) {
            await denied(getBytes(ref(storage(uid), `${folder}/legacy.png`)));
            for (const prefix of ['', folder, `${folder}/alice`]) await denied(listAll(ref(storage(uid), prefix)));
        }
        await denied(uploadBytes(ref(storage('alice'), `${folder}/alice/not-uuid.png`), bytes));
    });
}
for (const [folder, mime] of [['swaps', 'image/png'], ['images', 'image/png'], ['videos', 'video/mp4']]) {
    for (const nested of [false, true]) {
        test(`results ${folder} nested=${nested}: owner upload/read, others denied`, async () => {
            const path = `users/alice/${folder}/${nested ? 'batch/0/' : ''}result.bin`;
            const object = ref(storage('alice'), path);
            await uploadBytes(object, bytes, { contentType: mime });
            assert.deepEqual(new Uint8Array(await getBytes(object)), bytes);
            assert.equal((await getMetadata(object)).contentType, mime);
            for (const uid of [undefined, 'bob']) {
                await denied(getBytes(ref(storage(uid), path)));
                await denied(uploadBytes(ref(storage(uid), path), bytes));
                await denied(deleteObject(ref(storage(uid), path)));
                await denied(listAll(ref(storage(uid), `users/alice/${folder}`)));
            }
        });
    }
    test(`results ${folder}: existing owner update/delete/list permissions preserved`, async () => {
        const path = `users/alice/${folder}/existing/file.bin`;
        await seed(path);
        const object = ref(storage('alice'), path);
        await uploadBytes(object, bytes);
        await updateMetadata(object, { customMetadata: { synthetic: 'true' } });
        assert.equal((await listAll(ref(storage('alice'), `users/alice/${folder}/existing`))).items.length, 1);
        await deleteObject(object);
    });
}
test('Face Swap final video is owner-readable in swaps path', async () => {
    const path = 'users/alice/swaps/result.mp4';
    await uploadBytes(ref(storage('alice'), path), bytes, { contentType: 'video/mp4' });
    assert.equal((await getMetadata(ref(storage('alice'), path))).contentType, 'video/mp4');
    await denied(getBytes(ref(storage('bob'), path)));
});
test('unknown paths and another-user namespaces denied for all client operations', async () => {
    for (const path of ['uploads/legacy', 'unknown/alice/file', 'users/alice/unknown/file']) {
        await seed(path);
        for (const uid of [undefined, 'alice', 'bob']) {
            const object = ref(storage(uid), path);
            await denied(getBytes(object)); await denied(uploadBytes(object, bytes)); await denied(deleteObject(object));
        }
    }
});
