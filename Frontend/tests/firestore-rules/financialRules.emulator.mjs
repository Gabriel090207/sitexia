// Isolated real Auth/Firestore SDK calls; never loads application credentials.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
const projectId = 'demo-xiaswap-financial-rules';
if (process.env.GCLOUD_PROJECT !== projectId || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:9498'
    || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9497') throw Error('Requires isolated demo emulators');
const require = process.env.FIRESTORE_RULES_TEST_MODULE_ROOT
    ? createRequire(`${process.env.FIRESTORE_RULES_TEST_MODULE_ROOT}/package.json`) : createRequire(import.meta.url);
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signOut } = require('firebase/auth');
const { getFirestore, connectFirestoreEmulator, doc, collection, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
    query, where, orderBy, limit, serverTimestamp, increment, writeBatch, Timestamp, terminate } = require('firebase/firestore');
let env, alice, bob, signedOut;
const sessions = [];
const denied = promise => assert.rejects(promise, error => error.code === 'permission-denied');
const seed = (path, data) => env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), path), data));
const profile = uid => ({ uid, email: 'synthetic@example.invalid', displayName: '', photoURL: '', plan: 'free', credits: 0, createdAt: serverTimestamp() });
async function session(login) {
    const app = initializeApp({ projectId, apiKey: 'demo-only-key' }, randomUUID());
    const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9497', { disableWarnings: true });
    const db = getFirestore(app); connectFirestoreEmulator(db, '127.0.0.1', 9498);
    const value = { app, auth, db }; sessions.push(value);
    if (login) await createUserWithEmailAndPassword(auth, `${randomUUID()}@example.invalid`, 'synthetic-test-password');
    value.uid = auth.currentUser?.uid;
    return value;
}
before(async () => {
    env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 9498,
        rules: readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8') } });
    alice = await session(true); bob = await session(true); signedOut = await session(false);
});
beforeEach(async () => {
    await env.clearFirestore();
    for (const s of [alice, bob]) await seed(`users/${s.uid}`, { ...profile(s.uid), credits: 10, reservedCredits: 2 });
});
after(async () => {
    await Promise.all(sessions.map(async s => { await signOut(s.auth); await terminate(s.db); await deleteApp(s.app); }));
    if (env) await env.cleanup();
});
test('own profile/balance get allowed; other account, signed-out and global queries denied', async () => {
    assert.equal((await getDoc(doc(alice.db, 'users', alice.uid))).data().credits, 10);
    for (const s of [bob, signedOut]) await denied(getDoc(doc(s.db, 'users', alice.uid)));
    await denied(getDocs(collection(alice.db, 'users')));
});
test('existing login merge updates profile without touching financial fields', async () => {
    await setDoc(doc(alice.db, 'users', alice.uid), { email: 'updated@example.invalid', displayName: 'Synthetic', photoURL: '' }, { merge: true });
    const data = (await getDoc(doc(alice.db, 'users', alice.uid))).data();
    assert.equal(data.credits, 10); assert.equal(data.reservedCredits, 2);
});
for (const change of [{ credits: 1000 }, { credits: increment(1) }, { reservedCredits: 0 }, { reservedCredits: -1 },
    { plan: 'paid' }, { subscriptionStatus: 'active' }, { credits: 12, reservedCredits: 0 }, { uid: 'forged' }]) {
    test(`financial/profile privilege update denied: ${Object.keys(change).join(',')}`, async () => {
        await denied(updateDoc(doc(alice.db, 'users', alice.uid), change));
        assert.equal((await getDoc(doc(alice.db, 'users', alice.uid))).data().credits, 10);
    });
}
test('cannot delete/recreate financial user or replace it with profile-only data', async () => {
    const object = doc(alice.db, 'users', alice.uid);
    await denied(deleteDoc(object));
    await denied(setDoc(object, { email: null, displayName: '', photoURL: '' }));
    const batch = writeBatch(alice.db); batch.update(object, { credits: 999 }); batch.set(doc(alice.db, 'users', alice.uid, 'swaps', 'fake'), { imageUrl: 'reference', createdAt: serverTimestamp() });
    await denied(batch.commit());
});
test('signup allows only existing zero-credit free bootstrap contract', async () => {
    await env.withSecurityRulesDisabled(context => deleteDoc(doc(context.firestore(), 'users', bob.uid)));
    await denied(setDoc(doc(bob.db, 'users', bob.uid), { ...profile(bob.uid), credits: 1 }));
    await denied(setDoc(doc(bob.db, 'users', bob.uid), { ...profile(bob.uid), reservedCredits: 0 }));
    await denied(setDoc(doc(bob.db, 'users', bob.uid), { ...profile(bob.uid), plan: 'paid' }));
    await setDoc(doc(bob.db, 'users', bob.uid), profile(bob.uid));
    assert.equal((await getDoc(doc(bob.db, 'users', bob.uid))).data().credits, 0);
});
const financialPaths = uid => ['generations/reservation', 'topups/payment', 'topups/payment/payment_attempts/attempt',
    'credit_transactions/transaction', 'subscriptions/subscription', `users/${uid}/subscriptions/subscription`,
    'face_swap_tasks/task', 'face_swap_materials/material'];
for (let i = 0; i < 8; i++) {
    test(`backend-only financial/ownership collection ${i}: even owner cannot read or write`, async () => {
        const path = financialPaths(alice.uid)[i];
        await seed(path, { userId: alice.uid, uid: alice.uid, credits: 10, status: 'pending', creditStatus: 'reserved' });
        for (const s of [alice, bob, signedOut]) {
            const object = doc(s.db, path);
            await denied(getDoc(object));
            await denied(updateDoc(object, { status: 'approved', creditStatus: 'released', credits: 999 }));
            await denied(deleteDoc(object));
            await denied(setDoc(doc(s.db, path + '-forged'), { userId: alice.uid, status: 'approved', creditsApplied: true }));
        }
    });
}
test('no financial bypass through alternate subcollections, webhook or idempotency paths', async () => {
    for (const path of [`users/${alice.uid}/generations/forged`, `users/${alice.uid}/credit_transactions/forged`,
        `users/${alice.uid}/swaps/item/financial/forged`, 'generations/reservation/idempotency/forged',
        'topups/payment/webhooks/forged', `users/${alice.uid}/profile/forged`, 'unrecognized/forged']) {
        await seed(path, { credits: 10 });
        const object = doc(alice.db, path);
        await denied(getDoc(object)); await denied(setDoc(object, { credits: 999 })); await denied(deleteDoc(object));
    }
    await denied(setDoc(doc(alice.db, 'users', alice.uid, 'swaps', 'financial'), { credits: 100, createdAt: serverTimestamp() }));
});
test('library creation/query/recovery/legacy records and owner changes preserved', async () => {
    const path = `users/${alice.uid}/swaps`;
    await setDoc(doc(alice.db, path, 'image'), { imageUrl: 'stable-reference', type: 'image-generation', createdAt: serverTimestamp() });
    await setDoc(doc(alice.db, path, 'video'), { videoUrl: 'stable-reference', type: 'face-swap', mediaType: 'video', taskId: '123', createdAt: serverTimestamp() });
    await seed(`${path}/legacy`, { imageUrl: 'legacy-token-reference', createdAt: Timestamp.now() });
    assert.equal((await getDocs(query(collection(alice.db, path), orderBy('createdAt', 'desc')))).size, 3);
    assert.equal((await getDocs(query(collection(alice.db, path), where('taskId', '==', '123'), limit(5)))).docs[0].id, 'video');
    await updateDoc(doc(alice.db, path, 'image'), { imageUrl: 'new-reference' });
    await deleteDoc(doc(alice.db, path, 'image'));
    for (const s of [bob, signedOut]) {
        await denied(getDocs(collection(s.db, path)));
        await denied(getDoc(doc(s.db, path, 'video')));
        await denied(setDoc(doc(s.db, path, 'fake'), { imageUrl: 'fake', createdAt: serverTimestamp() }));
    }
});
test('admin seeding can update balances denied to client SDK (rules bypass)', async () => {
    await seed(`users/${alice.uid}`, { ...profile(alice.uid), credits: 15, reservedCredits: 4 });
    assert.equal((await getDoc(doc(alice.db, 'users', alice.uid))).data().credits, 15);
    await denied(updateDoc(doc(alice.db, 'users', alice.uid), { reservedCredits: 0 }));
});
test('another account cannot change or delete user balance/profile', async () => {
    const target = doc(bob.db, 'users', alice.uid);
    await denied(updateDoc(target, { credits: 999 }));
    await denied(setDoc(target, profile(alice.uid)));
    await denied(deleteDoc(target));
    await denied(updateDoc(target, { displayName: 'forged' }));
});
test('backend-only financial history/payment queries are denied to client', async () => {
    for (const path of ['topups', 'credit_transactions', 'generations', 'subscriptions', `users/${alice.uid}/subscriptions`]) {
        await denied(getDocs(query(collection(alice.db, path), where('uid', '==', alice.uid))));
    }
});
