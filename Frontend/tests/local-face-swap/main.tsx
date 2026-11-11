import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { signInAnonymously, signOut } from 'firebase/auth';
import { AxiosError } from 'axios';
import auth from '../../src/firebase/auth';
import { AuthProvider } from '../../src/contexts/AuthContext';
import FaceSwap from '../../src/pages/FaceSwap/FaceSwap';
import api from '../../src/api/api';
import { createMaterial, getMaterial, createSwapTask, getSwapTask, getSwapResult } from '../../src/api/swap';
import { uploadScopedFile } from './uploads';
import { uploadImageFromUrl } from '../../src/services/storage';
import { createLibraryImage } from '../../src/services/library';
import { selectIntent, loadIntents, storeIntent, recoverSwapTask, swapOperationError } from '../../src/pages/FaceSwap/faceSwapIntent';
import type { SwapIntent } from '../../src/pages/FaceSwap/faceSwapIntent';
import { waitForFaceSwap } from '../../src/pages/FaceSwap/faceSwapPolling';
import '../../src/styles/global.css';

const local = 'http://127.0.0.1:8789';
api.interceptors.request.use(config => { if (config.baseURL !== local) throw new Error('Nonlocal API blocked'); return config; });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function control(body: object) {
    const response = await fetch(local + '/__test/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Local setup failed');
}
async function state(uid = auth.currentUser!.uid) { return (await fetch(local + '/__test/state/' + uid)).json(); }
async function account(scenario = 'success', release = true) {
    await signOut(auth); const credential = await signInAnonymously(auth);
    await control({ uid: credential.user.uid, seed: true, scenario, release }); return credential.user.uid;
}
function fixtureFile() {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    return new File([bytes], 'fixture.png', { type: 'image/png' });
}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function prepared(scenario = 'success', release = true) {
    const uid = await account(scenario, release);
    const original = await uploadScopedFile(fixtureFile(), 'face-swap', uid);
    const target = await uploadScopedFile(fixtureFile(), 'face-swap-faces', uid);
    const intent = selectIntent([], { original, target, mediaType: 'image', duration: null });
    let records: SwapIntent[] = [];
    const remember = (item: SwapIntent) => { records = storeIntent(sessionStorage, uid, records, item); };
    remember(intent);
    const services = { createMaterial, getMaterial, createSwapTask,
        wait: (get: () => Promise<unknown>, field: 'status' | 'taskStatus', label: string) => waitForFaceSwap(get, field, label, 5000, 1) };
    return { uid, original, intent, remember, services };
}
async function expectStatus(action: () => Promise<unknown>, status: number) {
    try { await action(); throw new Error('Expected HTTP ' + status); }
    catch (error) { check((error as { response?: { status?: number } }).response?.status === status, 'Wrong HTTP status: ' + (error as Error).message); return error; }
}
async function waitBalance(value: string) {
    for (let i = 0; i < 100; i++) {
        if (document.querySelector('.face-swap-credits')?.textContent?.includes(value)) return;
        await pause(50);
    }
    throw new Error('Displayed balance did not update: ' + value);
}
async function suite(report: (text: string) => void) {
    let p = await prepared('success', false);
    const initial = await state();
    const task = await recoverSwapTask(p.intent, p.original, p.remember, p.services);
    let s = await state();
    check(s.user.credits === 10 && s.user.reservedCredits === 0.1, 'Reserve mismatch');
    await waitBalance('9.90');
    report('PASS upload to Storage emulator → material → reserve → task; React balance 9,9');
    const before = await state();
    const restored = loadIntents(sessionStorage, p.uid)[0];
    await pause(100);
    check((await state()).taskPosts === before.taskPosts, 'Restore caused POST');
    check(await recoverSwapTask(restored, undefined, p.remember, p.services) === task, 'Restore changed task');
    check((await state()).taskPosts === before.taskPosts, 'Known task caused POST');
    report('PASS restored task recovery without material/upload/task POST');
    await control({ uid: p.uid, release: true });
    await getSwapTask(task); await getSwapTask(task);
    const result = await getSwapResult(task);
    const saved = await uploadImageFromUrl(result.file_url, `users/${p.uid}/swaps`);
    await createLibraryImage(p.uid, saved, 'face-swap');
    s = await state();
    check(s.user.credits === 9.9 && s.user.reservedCredits === 0, 'Success charge mismatch');
    await createSwapTask(p.intent.materialId!, p.intent.sourceFaceId!, p.intent.target, 'image', null, p.intent.key);
    check((await state()).taskCreates === initial.taskCreates + 1, 'Duplicate task');
    report('PASS SUCCEEDED charged once; result saved in Storage/Firestore emulators; duplicate key recovered');
    p = await prepared('failed');
    const failed = await recoverSwapTask(p.intent, p.original, p.remember, p.services);
    await getSwapTask(failed); await getSwapTask(failed);
    s = await state(); check(s.user.credits === 10 && s.user.reservedCredits === 0, 'Failure release mismatch');
    await waitBalance('10'); report('PASS FAILED releases once; React available balance 10');
    p = await prepared();
    let drop = true;
    const interceptor = api.interceptors.response.use(response => {
        if (drop && response.config.url === '/swap/task') { drop = false; throw new AxiosError('Simulated lost HTTP response', 'ERR_NETWORK'); }
        return response;
    });
    const count = (await state()).taskCreates;
    try { await recoverSwapTask(p.intent, p.original, p.remember, p.services); throw new Error('Expected loss'); }
    catch (error) { check((error as { code?: string }).code === 'ERR_NETWORK', 'Wrong response loss error'); }
    finally { api.interceptors.response.eject(interceptor); }
    check(p.intent.phase === 'task-requested' && !p.intent.taskId, 'Intent not preserved');
    const posts = (await state()).taskPosts; await pause(100);
    check((await state()).taskPosts === posts, 'Automatic retry');
    await recoverSwapTask(p.intent, undefined, p.remember, p.services);
    check((await state()).taskCreates === count + 1, 'Recovery duplicated task');
    report('PASS lost HTTP response + network error; no auto retry; manual same-key recovery');
    const conflict = await expectStatus(() => createSwapTask(p.intent.materialId!, '6', p.intent.target, 'image', null, p.intent.key), 409);
    check(swapOperationError(conflict)?.includes('conflito'), '409 frontend mapping');
    const invalid = await expectStatus(() => api.post('/swap/task', { material_id: p.intent.materialId, source_face_id: '5', target_face_url: p.intent.target }), 422);
    check(swapOperationError(invalid)?.includes('rejeitou'), '422 frontend mapping');
    report('PASS real HTTP 409/422 contracts and frontend messages');
    p = await prepared('unconfirmed');
    const ambiguity = await expectStatus(() => recoverSwapTask(p.intent, p.original, p.remember, p.services), 502);
    check(swapOperationError(ambiguity)?.includes('reserva pode continuar'), 'Ambiguity message');
    const ambiguousCount = (await state()).taskCreates;
    await expectStatus(() => recoverSwapTask(p.intent, undefined, p.remember, p.services), 409);
    s = await state();
    check(s.taskCreates === ambiguousCount && s.user.credits === 10 && s.user.reservedCredits === 0.1, 'Ambiguous task resent/released');
    report('PASS provider timeout/lost taskId retains reserve; manual recovery pending 409, no resend');
}
function Harness() {
    const [reports, setReports] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    return <><aside style={{ padding: 20, background: '#17354a', color: 'white' }}>
        <h2>LOCAL ONLY — demo emulators / simulated DeepSwap</h2>
        <button disabled={busy} onClick={async () => {
            setBusy(true); setReports([]);
            try { await suite(text => setReports(current => [...current, text])); }
            catch (error) { setReports(current => [...current, 'FAIL ' + (error as Error).message]); }
            finally { setBusy(false); }
        }}>Run isolated integration checks</button>
        <button disabled={busy} onClick={async () => {
            await account('success', false); await pause(150);
            const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=file]'));
            for (const input of inputs.slice(0, 2)) {
                const data = new DataTransfer(); data.items.add(fixtureFile()); input.files = data.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }}>Prepare UI fixture uploads</button>
        <button disabled={busy} onClick={() => control({ uid: auth.currentUser!.uid, release: true })}>Complete simulated task</button>
        <button disabled={busy} onClick={() => location.reload()}>Refresh page (manual recovery)</button>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{reports.join('\n')}</pre>
        <p>External requests blocked by CSP. No published configuration loaded.</p>
    </aside><FaceSwap /></>;
}
await auth.authStateReady();
if (!auth.currentUser) await signInAnonymously(auth);
if (!(await state()).user) await control({ uid: auth.currentUser!.uid, seed: true });
createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter><AuthProvider><Harness /></AuthProvider></BrowserRouter></React.StrictMode>);
