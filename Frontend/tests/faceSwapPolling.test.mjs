import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/pages/FaceSwap/faceSwapPolling.ts', import.meta.url), 'utf8');
function setup() {
    let now = 0, id = 0;
    const timers = new Map(), waits = [];
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
        module, exports: module.exports, URL, AbortController,
        Date: { now: () => now },
        setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); waits.push(delay); return key; },
        clearTimeout(key) { timers.delete(key); },
    });
    async function run(fetch, options = {}, timeout = 600000) {
        let done = false, result, failure;
        module.exports.waitForFaceSwap(fetch, 'taskStatus', 'teste', timeout, 2000, options)
            .then(value => { result = value; done = true; }, error => { failure = error; done = true; });
        for (let i = 0; i < 10000 && !done; i++) {
            // Flush promise chains before advancing the simulated wall clock.
            for (let j = 0; j < 20; j++) await Promise.resolve();
            if (done) break;
            const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            assert.ok(next, 'unfinished polling must have a deadline or delay');
            timers.delete(next[0]); now = next[1].at; next[1].fn();
        }
        assert.ok(done);
        assert.equal(timers.size, 0, 'all polling timers cleaned up');
        if (failure) throw failure;
        return result;
    }
    return { run, waits, now: () => now, schedule: (fn, delay) => timers.set(++id, { fn, at: now + delay }) };
}
const http = status => ({ response: { status } });
for (const error of [http(502), http(503), http(504), { code: 'ETIMEDOUT' }, { code: 'ECONNABORTED' }, { code: 'ERR_NETWORK' }]) {
    test(`transient ${JSON.stringify(error)} resumes same task without overlapping requests`, async () => {
        const clock = setup(); let calls = 0, active = 0;
        const taskId = '789'; const seen = [];
        const result = await clock.run(async signal => {
            assert.equal(signal.aborted, false);
            assert.equal(++active, 1);
            seen.push(taskId);
            try { if (++calls === 1) throw error; return { taskStatus: calls === 2 ? 'RUNNING' : 'SUCCEEDED' }; }
            finally { active--; }
        });
        assert.equal(result.taskStatus, 'SUCCEEDED');
        assert.deepEqual(seen, ['789', '789', '789']);
        assert.ok(clock.waits.includes(4000));
    });
}
test('third consecutive transient failure stops at three GET attempts', async () => {
    const clock = setup(); let calls = 0;
    await assert.rejects(clock.run(async () => { calls++; throw http(502); }), /créditos podem permanecer reservados.*Não inicie/);
    assert.equal(calls, 3);
    assert.equal(clock.now(), 14000);
    assert.ok(clock.waits.includes(8000));
});
test('successful RUNNING response resets consecutive failure count', async () => {
    const clock = setup(); let calls = 0;
    const sequence = [502, 503, 'RUNNING', 504, 502, 'SUCCEEDED'];
    const result = await clock.run(async () => { const value = sequence[calls++]; if (typeof value === 'number') throw http(value); return { taskStatus: value }; });
    assert.equal(result.taskStatus, 'SUCCEEDED'); assert.equal(calls, 6);
});
for (const status of [400, 401, 403, 404, 422]) test(`HTTP ${status} is never retried`, async () => {
    const clock = setup(); let calls = 0; const error = http(status);
    await assert.rejects(clock.run(async () => { calls++; throw error; }), value => value === error);
    assert.equal(calls, 1);
});
test('abort during request aborts its signal and stops further GETs', async () => {
    const clock = setup(), controller = new AbortController(); let calls = 0, requestSignal;
    await assert.rejects(clock.run(async signal => { calls++; requestSignal = signal; controller.abort(); return new Promise(() => {}); }, { signal: controller.signal }), /interrompido/);
    assert.equal(calls, 1); assert.equal(requestSignal.aborted, true);
});
test('session or mounted-state change stops retry', async () => {
    const clock = setup(); let current = true, calls = 0;
    await assert.rejects(clock.run(async () => { calls++; current = false; throw http(502); }, { isCurrent: () => current }), /interrompido/);
    assert.equal(calls, 1);
});
test('already aborted polling never issues a GET', async () => {
    const clock = setup(), controller = new AbortController(); controller.abort(); let calls = 0;
    await assert.rejects(clock.run(async () => { calls++; }, { signal: controller.signal }), /interrompido/);
    assert.equal(calls, 0);
});
test('retry waits remain inside deadline', async () => {
    const clock = setup(); let calls = 0;
    await assert.rejects(clock.run(async () => { calls++; throw http(502); }, {}, 5000), /limite de espera/);
    assert.equal(clock.now(), 5000); assert.equal(calls, 1);
});
test('global ten-minute deadline aborts a stalled GET', async () => {
    const clock = setup(); let signal;
    await assert.rejects(clock.run(async value => { signal = value; return new Promise(() => {}); }), /limite de espera/);
    assert.equal(clock.now(), 600000); assert.equal(signal.aborted, true);
});
for (const value of [null, {}, { taskStatus: 'UNKNOWN' }, { taskStatus: 'FAILED' }, { taskStatus: 'invalid' }]) test(`invalid or terminal response never triggers transport retries: ${JSON.stringify(value)}`, async () => {
    const clock = setup(); let calls = 0;
    await assert.rejects(clock.run(async () => { calls++; return value; })); assert.equal(calls, 1);
});

for (const detail of ['A Deep retornou uma tarefa inválida.', 'Vínculo financeiro incompatível com a tarefa consultada.']) test(`integrity errors are not retried: ${detail}`, async () => {
    const clock = setup(); let calls = 0;
    await assert.rejects(clock.run(async () => { calls++; throw { response: { status: 502, data: { detail } } }; }));
    assert.equal(calls, 1);
});


test('abort during retry backoff clears waits and prevents the next GET', async () => {
    const clock = setup(), controller = new AbortController(); let calls = 0;
    await assert.rejects(clock.run(async () => {
        calls++;
        clock.schedule(() => controller.abort(), 1000);
        throw http(502);
    }, { signal: controller.signal }), /interrompido/);
    assert.equal(calls, 1);
    assert.equal(clock.now(), 3000);
});
