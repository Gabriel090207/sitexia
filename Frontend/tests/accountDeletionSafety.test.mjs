// Actual Profile component, offline hook/JSX harness. No Firebase initialization.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/pages/Profile/Profile.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function setup({ user = { uid: 'alice', email: 'synthetic@example.invalid' }, data = {} } = {}) {
    const state = [{ uid: user?.uid, email: user?.email, displayName: 'Synthetic', photoURL: '', ...data }, false, false, false];
    let hook = 0; const calls = [], timers = [];
    const module = { exports: {} };
    const forbidden = () => { calls.push('forbidden'); throw Error('No destructive or remote actions permitted'); };
    const jsx = (type, props) => ({ type, props });
    vm.runInNewContext(code, { module, exports: module.exports,
        fetch: forbidden, setTimeout: callback => timers.push(callback),
        require(name) {
            if (name.endsWith('.css')) return {};
            if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
            if (name === 'react') return { useEffect() {}, useState(initial) {
                const slot = hook++;
                if (!(slot in state)) state[slot] = initial;
                return [state[slot], value => { state[slot] = value; }];
            } };
            if (name === 'react-router-dom') return { Link: 'Link', useNavigate: forbidden };
            if (name === 'firebase/firestore') return { doc: forbidden, getDoc: forbidden, deleteDoc: forbidden };
            if (name === 'firebase/auth') return { deleteUser: forbidden, signOut: forbidden, sendPasswordResetEmail: forbidden };
            if (name === '../../contexts/AuthContext') return { useAuth: () => ({ user, loading: false }) };
            if (name === '../../utils/formatCredits') return { formatCredits: value => String(value) };
            if (name.startsWith('../../firebase/')) return { __esModule: true, default: {} };
            if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => key });
            throw Error('Unexpected dependency ' + name);
        },
    });
    return { calls, timers, state, render() { hook = 0; return module.exports.default(); } };
}
function all(node) {
    if (!node || typeof node !== 'object') return [];
    const children = [node.props?.children].flat(Infinity);
    return [node, ...children.flatMap(all)];
}
function text(node) {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (!node || typeof node !== 'object') return '';
    return [node.props?.children].flat(Infinity).map(text).join(' ');
}
for (const [label, data] of [['zero balance', { credits: 0 }], ['balance/history', { credits: 15, reservedCredits: 0 }],
    ['pending reservation/task', { credits: 15, reservedCredits: 2 }], ['payment present', { credits: 10, paymentStatus: 'approved' }]]) {
    test(`deletion is safely unavailable with ${label}; repeated actions preserve session/data`, () => {
        const s = setup({ data }); const original = JSON.stringify(s.state[0]);
        for (let attempt = 0; attempt < 2; attempt++) {
            const trigger = all(s.render()).find(node => node.type === 'button' && node.props.className === 'profile-delete');
            trigger.props.onClick();
            const modal = s.render();
            assert.match(text(modal), /Exclusão de conta indisponível/);
            assert.match(text(modal), /Sua conta e seus dados não foram excluídos/);
            assert.doesNotMatch(text(modal), /todos os seus dados serão removidos/);
            assert.equal(all(modal).some(node => node.props?.className === 'profile-confirm'), false);
            all(modal).find(node => node.props?.className === 'profile-cancel').props.onClick();
            while (s.timers.length) s.timers.shift()();
        }
        assert.equal(JSON.stringify(s.state[0]), original);
        assert.deepEqual(s.calls, []);
    });
}
test('signed-out profile offers no account deletion control or request', () => {
    const s = setup({ user: null });
    assert.equal(s.render(), null); assert.deepEqual(s.calls, []);
});
test('no financial delete, Auth deletion, new endpoint or misleading reauthentication error remains', () => {
    assert.doesNotMatch(source, /deleteDoc|deleteUser|handleDeleteAccount|navigate\(|fetch\(|axios/);
    assert.doesNotMatch(source, /faça login novamente antes de excluir/);
    assert.match(source, /sendPasswordResetEmail/);
});
