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
    const resultModule = { exports: {} };
    const resultSource = readFileSync(new URL('../src/pages/FaceSwap/faceSwapResult.ts', import.meta.url), 'utf8');
    vm.runInNewContext(ts.transpileModule(resultSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
        module: resultModule, exports: resultModule.exports, AbortController,
        Date: { now: () => now }, require: () => module.exports,
        setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); waits.push(delay); return key; },
        clearTimeout(key) { timers.delete(key); },
    });
    async function run(fetch, options = {}, timeout = 60000) {
        let done = false, result, failure;
        resultModule.exports.resolveFaceSwapResult('789', fetch, { ...options, timeoutMs: timeout })
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
const http = (status, detail) => ({ response: { status, data: { detail } } });
const valid = { success: true, status: 'SUCCEEDED', task_id: '789', file_url: 'https://media.invalid/result.jpg' };
for (const error of [http(502, 'Não foi possível consultar o resultado na Deep.'), http(502, 'Não foi possível confirmar o estado financeiro na Deep.'), http(503), http(504), {code:'ETIMEDOUT'}, {code:'ECONNABORTED'}, {code:'ERR_NETWORK'}]) test(`transient result failure resumes: ${JSON.stringify(error)}`, async () => {
    const clock = setup(); let calls = 0, active = 0; const ids = [];
    const result = await clock.run(async (id, signal) => {
        ids.push(id); assert.equal(++active, 1); assert.equal(signal.aborted, false);
        try { if (++calls === 1) throw error; return valid; } finally { active--; }
    });
    assert.equal(result.file_url, valid.file_url); assert.deepEqual(ids, ['789', '789']); assert.equal(clock.now(), 4000);
});
test('three failed requests stop without claiming a charge or refund', async () => {
    const clock = setup(); let calls = 0;
    await assert.rejects(clock.run(async () => { calls++; throw http(502); }), /podem ter sido cobrados.*Não inicie/);
    assert.equal(calls, 3); assert.equal(clock.now(), 12000);
});
test('two failures then success stop immediately at the third request', async () => {
    const clock = setup(); let calls = 0;
    assert.equal((await clock.run(async () => { if (++calls < 3) throw http(503); return valid; })).file_url, valid.file_url);
    assert.equal(calls, 3); assert.equal(clock.now(), 12000);
});
for (const error of [400,401,403,404,409,422].map(status => http(status)).concat([
    http(502, 'A Deep retornou uma tarefa inválida.'),
    http(502, 'Estado do resultado incompatível com a operação confirmada.'),
    http(502, 'Resposta inválida da Deep.'),
    http(502, 'A Deep concluiu a tarefa sem retornar a URL do resultado.'),
    http(503, 'Vínculo financeiro incompleto.'),
    http(503, 'Vínculo financeiro incompatível com a tarefa consultada.'),
    {code:'ERR_CANCELED'},
])) test(`definitive result failure is not retried: ${JSON.stringify(error)}`, async () => {
    const clock = setup(); let calls = 0;
    await assert.rejects(clock.run(async () => { calls++; throw error; }), value => value === error);
    assert.equal(calls, 1);
});
for (const value of [null, {}, {file_url:'blob:invalid'}, {...valid,task_id:'999'}]) test(`invalid result is not retried: ${JSON.stringify(value)}`, async () => {
    const clock = setup(); let calls = 0;
    await assert.rejects(clock.run(async () => { calls++; return value; })); assert.equal(calls, 1);
});
test('abort in flight aborts request and prevents later attempts', async () => {
    const clock = setup(), controller = new AbortController(); let calls = 0, signal;
    await assert.rejects(clock.run(async (_id, value) => { calls++; signal = value; clock.schedule(() => controller.abort(), 1000); return new Promise(() => {}); }, {signal:controller.signal}), /interrompida/);
    assert.equal(calls, 1); assert.equal(signal.aborted, true);
});
test('abort during recovery wait clears timers', async () => {
    const clock = setup(), controller = new AbortController(); let calls = 0;
    await assert.rejects(clock.run(async () => { calls++; clock.schedule(() => controller.abort(), 1000); throw http(503); }, {signal:controller.signal}), /interrompida/);
    assert.equal(calls, 1); assert.equal(clock.now(), 1000);
});
test('logout or unmount stops subsequent result requests', async () => {
    const clock = setup(); let current = true, calls = 0;
    await assert.rejects(clock.run(async () => { calls++; current = false; throw http(503); }, {isCurrent:()=>current}), /interrompida/);
    assert.equal(calls, 1);
});
test('result deadline includes backoff and aborts stalled requests', async () => {
    const clock = setup(); let signal;
    await assert.rejects(clock.run(async (_id,value) => { signal=value; return new Promise(()=>{}); }), /podem ter sido cobrados/);
    assert.equal(clock.now(), 60000); assert.equal(signal.aborted,true);
    const short = setup(); let calls=0;
    await assert.rejects(short.run(async()=>{calls++; throw http(503);},{},2000));
    assert.equal(short.now(),2000); assert.equal(calls,1);
});
for (const value of [{...valid,status:'FAILED'},{...valid,success:false}]) test('inconsistent successful HTTP response stops without retry',async()=>{
    const clock=setup();let calls=0;
    await assert.rejects(clock.run(async()=>{calls++;return value;}),/inválido/);
    assert.equal(calls,1);
});
