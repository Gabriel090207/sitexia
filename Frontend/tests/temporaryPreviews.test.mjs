import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/pages/FaceSwap/FaceSwap.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('FaceSwap.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects = new Map();
function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect') {
        const dependency = node.arguments[1]?.getText(ast);
        if (dependency === '[selectedFile]' || dependency === '[selectedFace]') {
            effects.set(dependency.slice(1,-1), node.arguments[0].getText(ast));
        }
    }
    ts.forEachChild(node, visit);
}
visit(ast);
for (const [selected,setter,preview] of [['selectedFile','setFilePreview','filePreview'],['selectedFace','setFacePreview','facePreview']]) {
    test(`${selected}: preview is a local Blob URL with cleanup`, () => {
        const values = [], revoked = [];
        const file = { name: 'private.png' };
        const scope = { [selected]: file, [setter]: value => values.push(value),
            URL: { createObjectURL(value) { assert.equal(value,file); return 'blob:local'; },
                revokeObjectURL(value) { revoked.push(value); } } };
        vm.createContext(scope);
        vm.runInContext(`globalThis.effect = ${effects.get(selected)}`,scope);
        const cleanup = scope.effect();
        assert.deepEqual(values,['blob:local']);
        cleanup();
        assert.deepEqual(revoked,['blob:local']);
        scope[selected] = null;
        assert.equal(scope.effect(),undefined);
        assert.equal(values.at(-1),'');
        assert.ok(source.includes(`src={${preview}}`));
    });
}
