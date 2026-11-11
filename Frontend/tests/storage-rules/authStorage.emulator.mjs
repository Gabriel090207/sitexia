// Real Auth-issued emulator ID tokens + real Storage Rules evaluation.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
const projectId = 'demo-xiaswap-private-rules';
if (process.env.FIREBASE_STORAGE_EMULATOR_HOST !== '127.0.0.1:9398'
    || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9397'
    || process.env.GCLOUD_PROJECT !== projectId) throw Error('Requires demo Auth and Storage Emulators');
const require = process.env.STORAGE_RULES_TEST_MODULE_ROOT
    ? createRequire(`${process.env.STORAGE_RULES_TEST_MODULE_ROOT}/package.json`) : createRequire(import.meta.url);
const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, signInAnonymously, signOut } = require('firebase/auth');
const { getStorage, connectStorageEmulator, ref, uploadBytes, getBytes, getMetadata, deleteObject, listAll } = require('firebase/storage');
const sessions = [];
const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const denied = promise => assert.rejects(promise, error => error.code === 'storage/unauthorized');
let owner, other, anonymous;
async function session(login) {
    const app = initializeApp({ apiKey: 'demo-only-key', projectId, storageBucket: `${projectId}.appspot.com` }, randomUUID());
    const auth = getAuth(app);
    connectAuthEmulator(auth, 'http://127.0.0.1:9397', { disableWarnings: true });
    const storage = getStorage(app);
    connectStorageEmulator(storage, '127.0.0.1', 9398);
    const value = { app, auth, storage }; sessions.push(value);
    if (login) await signInAnonymously(auth);
    return value;
}
before(async () => { owner = await session(true); other = await session(true); anonymous = await session(false); });
after(async () => { await Promise.all(sessions.map(async s => { await signOut(s.auth); await deleteApp(s.app); })); });
for (const folder of ['face-swap', 'face-swap-faces', 'video-generation']) {
    test(`real Auth token: private immutable ${folder}`, async () => {
        const uid = owner.auth.currentUser.uid;
        const path = `${folder}/${uid}/${randomUUID()}.png`;
        const object = ref(owner.storage, path);
        await uploadBytes(object, bytes, { contentType: 'image/png' });
        assert.deepEqual(new Uint8Array(await getBytes(object)), bytes);
        assert.equal((await getMetadata(object)).contentType, 'image/png');
        for (const s of [other, anonymous]) {
            await denied(getBytes(ref(s.storage, path)));
            await denied(uploadBytes(ref(s.storage, `${folder}/${uid}/${randomUUID()}.png`), bytes));
        }
        await denied(uploadBytes(object, new Uint8Array([9])));
        await denied(deleteObject(object));
        await denied(listAll(ref(owner.storage, `${folder}/${uid}`)));
        await denied(uploadBytes(ref(owner.storage, `${folder}/${uid}/nested/${randomUUID()}.png`), bytes));
    });
}
for (const folder of ['swaps', 'images', 'videos']) {
    test(`real Auth token: private nested result ${folder}`, async () => {
        const path = `users/${owner.auth.currentUser.uid}/${folder}/batch/${randomUUID()}.bin`;
        const object = ref(owner.storage, path);
        await uploadBytes(object, bytes, { contentType: folder === 'videos' ? 'video/mp4' : 'image/png' });
        assert.deepEqual(new Uint8Array(await getBytes(object)), bytes);
        for (const s of [other, anonymous]) {
            await denied(getBytes(ref(s.storage, path)));
            await denied(uploadBytes(ref(s.storage, path), bytes));
            await denied(listAll(ref(s.storage, path.slice(0, path.lastIndexOf('/')))));
        }
    });
}
test('real Auth token: unknown namespace denied', async () => {
    await denied(uploadBytes(ref(owner.storage, `unapproved/${owner.auth.currentUser.uid}/file`), bytes));
});
test('sign-out removes access to previously owned result', async () => {
    const path = `users/${owner.auth.currentUser.uid}/images/${randomUUID()}.png`;
    const object = ref(owner.storage, path);
    await uploadBytes(object, bytes);
    await signOut(owner.auth);
    await denied(getBytes(object));
});
