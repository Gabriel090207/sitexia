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
        if ((dependency === '[selectedFile]' || dependency === '[selectedFace]')
            && node.arguments[0].getText(ast).includes('URL.createObjectURL')) {
            effects.set(dependency.slice(1,-1), node.arguments[0].getText(ast));
        }
    }
    ts.forEachChild(node, visit);
}
visit(ast);
for (const [selected,setter,preview] of [['selectedFile','setFilePreview','filePreview'],['selectedFace','setFacePreview','facePreview']]) {
    test(`${selected}: preview is a local Blob URL with cleanup`, () => {
        const values = [], revoked = [];
        const file = { name: 'private.png', type: 'image/png' };
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


test('obsolete video selection is cleared without generating a preview or task', () => {
    let clearEffect;
    function find(node) {
        if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
            && node.arguments[0].getText(ast).includes('setVideoDuration(0)')) clearEffect = node.arguments[0].getText(ast);
        ts.forEachChild(node, find);
    }
    find(ast);
    assert.ok(clearEffect);
    const changes=[];
    const scope={selectedFile:{type:'video/mp4'},setSelectedFile:value=>changes.push(['file',value]),
        setFileUrl:value=>changes.push(['url',value]),setVideoDuration:value=>changes.push(['duration',value])};
    vm.runInNewContext(`globalThis.effect = ${clearEffect}`,scope);
    scope.effect();
    assert.deepEqual(changes,[['file',null],['url',''],['duration',0]]);
    changes.length=0;
    scope.selectedFile={type:'image/jpeg'};
    scope.effect();
    assert.deepEqual(changes,[]);
});
