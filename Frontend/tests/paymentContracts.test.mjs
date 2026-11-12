import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const read = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
const source = read('api/topups.ts');
function setup() {
    const calls = [], module = { exports: {} };
    const api = { post: async (...args) => { calls.push(['POST', ...args]); return { data: { ok: true } }; },
        get: async (...args) => { calls.push(['GET', ...args]); return { data: { credits_granted: true } }; } };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
        module, exports: module.exports, require: () => ({ __esModule: true, default: api }),
    });
    return { methods: module.exports, calls };
}
test('topup/attempt requests send package and method, never client-controlled credit/price values', async () => {
    const s = setup(); await s.methods.createTopup('starter'); await s.methods.createPaymentAttempt('topup', 'pix');
    assert.equal(JSON.stringify(s.calls), JSON.stringify([
        ['POST', '/topups', { package_id: 'starter' }],
        ['POST', '/topups/topup/payment-attempts', { payment_method: 'pix' }],
    ]));
});
test('confirmation reads authenticated backend status; provider creation is separate', async () => {
    const s = setup();
    await s.methods.createPixOrder('topup', 'attempt');
    assert.equal((await s.methods.getTopupStatus('topup')).credits_granted, true);
    assert.deepEqual(s.calls.map(x => x.slice(0, 2)), [
        ['POST', '/topups/topup/payment-attempts/attempt/order'], ['GET', '/topups/topup/status'],
    ]);
});
test('checkout does not mutate Firestore or grant credit from browser redirects', () => {
    const checkout = read('pages/Checkout/Checkout.tsx');
    assert.doesNotMatch(checkout, /setDoc\(|updateDoc\(|addDoc\(|increment\(/);
    assert.match(checkout, /credits_granted/);
    assert.match(checkout, /getTopupStatus\(/);
});
