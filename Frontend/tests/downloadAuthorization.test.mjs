// Execute the real library handler with an offline Axios substitute.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/pages/Library/Library.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('Library.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleDownload') handler = node.getText(ast);
    ts.forEachChild(node, visit);
}
visit(ast);
const transpile = source => ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText;
for (const type of ['face-swap', 'image-generation', 'video-generation', 'failure']) {
    test(`library authenticated download: ${type}`, async () => {
        const calls = [], states = [], links = [];
        const context = {
            user: { uid: 'alice' }, auth: {currentUser:{uid:'alice'}}, setDownloadError() {}, downloadingId: null, isLibraryVideo: item => item.type === 'video-generation' || item.mediaType === 'video',
            setDownloadingId: value => states.push(value),
            api: { get: async (url, options) => {
                calls.push({ url, options });
                if (type === 'failure') throw new Error('401');
                return { data: 'blob', headers: { 'content-disposition': 'attachment; filename="result.bin"' } };
            } },
            URL: { createObjectURL: () => 'blob:local', revokeObjectURL() {} },
            document: { createElement: () => {
                const link = { click() {}, remove() {} }; links.push(link); return link;
            }, body: { appendChild() {} } },
        };
        vm.createContext(context);
        vm.runInContext(transpile(handler), context);
        await context.handleDownload({ id: 'item', type });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, '/download/alice/item');
        assert.equal(calls[0].options.responseType, 'blob');
        assert.deepEqual(states, ['item', null]);
        if (type === 'failure') assert.equal(links.length, 0);
        else assert.equal(links[0].download, 'result.bin');
    });
}
test('Axios interceptor attaches Firebase token to header, never URL', async () => {
    let interceptor;
    const client = { interceptors: { request: { use: value => { interceptor = value; } } } };
    const apiSource = readFileSync(new URL('../src/api/api.ts', import.meta.url), 'utf8')
        .replace('import.meta.env.VITE_API_URL', '"http://localhost"');
    vm.runInNewContext(transpile(apiSource), {
        exports: {}, require: name => ({ __esModule: true, default: name === 'axios'
            ? { create: () => client }
            : { currentUser: { getIdToken: async () => 'test-token' } } }),
    });
    const headers = new Map();
    const config = await interceptor({ url: '/download/alice/item', headers });
    assert.equal(headers.get('Authorization'), 'Bearer test-token');
    assert.equal(config.url, '/download/alice/item');
});

for(const item of [
    {id:'face-video',type:'face-swap',mediaType:'video',videoUrl:'https://firebasestorage.googleapis.com/old?token=private'},
    {id:'generated-video',type:'video-generation',videoUrl:'https://firebasestorage.googleapis.com/old?token=private'},
    {id:'legacy-video',type:'face-swap',imageUrl:'https://firebasestorage.googleapis.com/old?token=private'},
])test(`native authorized video download without buffering: ${item.id}`,async()=>{
    const calls=[],links=[],states=[],errors=[];
    const session={uid:'alice'};
    const access={url:'https://storage.googleapis.com/demo/video?X-Goog-Signature=signature',mediaType:'video',contentType:'video/webm',
        filename:'xia-face-swap-20990101-120000.webm',expiresAt:'2099-01-01T12:00:00Z'};
    class NoBlobURL extends URL {static createObjectURL(){assert.fail('must not buffer video');}}
    const context={user:session,auth:{currentUser:session},downloadingId:null,
        setDownloadingId:value=>states.push(value),setDownloadError:value=>errors.push(value),URL:NoBlobURL,
        api:{get:async(...args)=>{calls.push(args);return {headers:{'content-type':'application/json'},data:{text:async()=>JSON.stringify(access)}};}},
        document:{createElement:()=>{const link={click(){},remove(){}};links.push(link);return link;},body:{appendChild(){}}},
    };
    vm.createContext(context);vm.runInContext(transpile(handler),context);await context.handleDownload(item);
    assert.equal(calls.length,1);assert.equal(calls[0][0],`/download/alice/${item.id}`);
    assert.equal(calls[0][1].params.delivery,'direct');
    assert.ok(!JSON.stringify(calls).includes('token='));
    assert.equal(links.length,1);assert.equal(links[0].href,access.url);assert.equal(links[0].download,access.filename);
    assert.equal(links[0].referrerPolicy,'no-referrer');assert.deepEqual(states,[item.id,null]);assert.deepEqual(errors,['']);
});

test('invalid native access response has no fallback and reports controlled error',async()=>{
    const session={uid:'alice'},errors=[];
    const context={user:session,auth:{currentUser:session},downloadingId:null,setDownloadingId(){},setDownloadError:value=>errors.push(value),URL,
        api:{get:async()=>({headers:{'content-type':'application/json'},data:{text:async()=>JSON.stringify({url:'https://firebasestorage.googleapis.com/old?token=private'})}})},
        document:{createElement:()=>assert.fail('invalid URL must not be used')},
    };
    vm.createContext(context);vm.runInContext(transpile(handler),context);
    await context.handleDownload({id:'item',type:'face-swap',mediaType:'video'});
    assert.match(errors.at(-1),/Não foi possível/);assert.ok(!errors.at(-1).includes('private'));
});

test('logout while access response is being decoded cannot initiate a private download',async()=>{
    const session={uid:'alice'},auth={currentUser:session};
    const context={user:session,auth,downloadingId:null,setDownloadingId(){},setDownloadError(){},URL,
        api:{get:async()=>({headers:{'content-type':'application/json'},data:{text:async()=>{
            auth.currentUser=null;
            return JSON.stringify({url:'https://storage.googleapis.com/demo/v?X-Goog-Signature=s',filename:'xia-face-swap-20990101-120000.mp4',
                mediaType:'video',contentType:'video/mp4',expiresAt:'2099-01-01T12:00:00Z'});
        }}})},document:{createElement:()=>assert.fail('late response must be ignored')},
    };
    vm.createContext(context);vm.runInContext(transpile(handler),context);
    await context.handleDownload({id:'item',type:'face-swap',mediaType:'video'});
});
