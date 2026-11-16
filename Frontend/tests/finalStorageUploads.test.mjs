import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { imageBytes } from './fixtures/generatedImages.mjs';

const read = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
function setup({ failUploadAt, failRegisterAt, differentSnapshot = false, bytes = imageBytes("png"), mime = "image/png", decodeError = false, ok = true, response, dimensions = [2,3] } = {}) {
    const writes = [], records = [], reads = [];
    const auth = { currentUser: { uid: 'alice' } };
    let uploads = 0, registrations = 0, tokenCalls = 0;
    const bucket = 'isolated.firebasestorage.app';
    const sdk = {
        ref: (_storage, path = '') => ({ bucket, fullPath: path }),
        uploadBytes: async (reference, data, metadata) => {
            if (++uploads === failUploadAt) throw Error('simulated upload failure');
            const actual = differentSnapshot ? { bucket, fullPath: 'users/alice/videos/actual-object.mp4' } : reference;
            writes.push({ reference: actual, data, metadata });
            return { ref: actual };
        },
        getDownloadURL: () => { tokenCalls++; throw Error('Download token forbidden'); },
    };
    const dependencies = {
        'firebase/storage': sdk,
        '../firebase/storage': { __esModule: true, default: {} },
        '../firebase/auth': { __esModule: true, default: auth },
        '../firebase/firestore': { __esModule: true, default: {} },
        'firebase/firestore': {
            collection: (_db, ...parts) => parts.join('/'), serverTimestamp: () => 'timestamp',
            addDoc: async (path, data) => {
                if (++registrations === failRegisterAt) throw Error('simulated registration failure');
                records.push({ path, data }); return { id: `document-${records.length}` };
            },
        },
    };
    const load = path => {
        const module = { exports: {} };
        const code = ts.transpileModule(read(path), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
        vm.runInNewContext(code, {
            module, exports: module.exports, File, Blob, URL, Uint8Array, DataView, setTimeout, clearTimeout,
            createImageBitmap: async () => { if(decodeError) throw Error('decode failed');return {width:dimensions[0],height:dimensions[1],close(){}}; },
            console: new Proxy({}, { get() { throw Error('No logging permitted'); } }),
            fetch: async url => { reads.push(url); return response ?? { ok, blob: async () => new Blob([bytes], { type: mime }) }; },
            require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; },
        });
        return module.exports;
    };
    const references = load('services/storageReferences.ts');
    dependencies['./storageReferences'] = references;
    dependencies['./prepareGeneratedImage'] = load('services/prepareGeneratedImage.ts');
    return { ...load('services/storage.ts'), ...references, ...load('services/library.ts'),
        ...load('pages/ImageGeneration/processImageResults.ts'), writes, records, reads, auth,
        tokenCalls: () => tokenCalls };
}
for (const [folder, filename, mime] of [
    ['swaps', 'result.png', 'image/png'], ['swaps', 'result.webm', 'video/webm'],
    ['videos', 'result.mp4', 'video/mp4'],
]) {
    test(`final ${folder}/${filename}: snapshot reference without token, MIME preserved, privately resolvable`, async () => {
        const s = setup();
        const address = await s.uploadFile(new File(['synthetic'], filename, { type: mime }), `users/alice/${folder}`);
        const actual = s.writes[0].reference;
        assert.equal(address, `https://firebasestorage.googleapis.com/v0/b/${actual.bucket}/o/${encodeURIComponent(actual.fullPath)}`);
        assert.equal(new URL(address).search, '');
        assert.equal(new URL(address).hash, '');
        assert.equal(s.writes[0].data.type, mime);
        assert.equal(s.resolveStorageReference(address, 'alice').fullPath, actual.fullPath);
        assert.equal(s.tokenCalls(), 0);
        if (mime.startsWith('video/')) {
            await s.createLibraryVideo('alice', address, 'task-1', folder === 'swaps' ? 'face-swap' : 'video-generation');
            assert.equal(s.records[0].data.videoUrl, address);
            assert.equal(s.records[0].data.taskId, 'task-1');
        } else {
            await s.createLibraryImage('alice', address, 'face-swap');
            assert.equal(s.records[0].data.imageUrl, address);
        }
    });
}
test('uses actual bucket/path returned by upload, not the requested object', async () => {
    const s = setup({ differentSnapshot: true });
    const address = await s.uploadFile(new File(['x'], 'x.mp4'), 'users/alice/videos/requested');
    assert.equal(address, 'https://firebasestorage.googleapis.com/v0/b/isolated.firebasestorage.app/o/users%2Falice%2Fvideos%2Factual-object.mp4');
});
for (const count of [1, 4, 9, 10]) {
    test(`${count} images including additional grid: saved and registered in order without tokens`, async () => {
        const s = setup(); const saved = [];
        const urls = Array.from({ length: count }, (_, index) => `https://provider.invalid/image-${index}.png`);
        const result = await s.processImageResults(urls, 'alice', 'batch', {
            upload: s.uploadImageFromUrl, register: s.createLibraryImage, onSaved: value => saved.push(value),
        });
        assert.equal(result.total, count); assert.equal(result.uploadFailures, 0); assert.equal(result.libraryFailures, 0);
        assert.deepEqual(s.reads, urls);
        assert.deepEqual(s.records.map(x => x.data.imageUrl), saved);
        for (const [index, address] of saved.entries()) {
            assert.match(s.resolveStorageReference(address, 'alice').fullPath, new RegExp(`^users/alice/images/batch/${index}/`));
            assert.equal(new URL(address).search, '');
            assert.equal(s.writes[index].metadata.contentType, 'image/png');
        }
        assert.equal(s.tokenCalls(), 0);
    });
}
test('partial upload/registration failures preserve saved results and never register failed uploads', async () => {
    const s = setup({ failUploadAt: 2, failRegisterAt: 2 }); const saved = [];
    const outcome = await s.processImageResults(['https://p.invalid/1', 'https://p.invalid/2', 'https://p.invalid/3', 'https://p.invalid/4'], 'alice', 'batch', {
        upload: s.uploadImageFromUrl, register: s.createLibraryImage, onSaved: value => saved.push(value),
    });
    assert.equal(outcome.uploadFailures, 1); assert.equal(outcome.libraryFailures, 1);
    assert.equal(saved.length, 3); assert.equal(s.records.length, 2);
    assert.ok(s.records.every(x => saved.includes(x.data.imageUrl)));
});
test('new references use the same session authorization as legacy references', async () => {
    const s = setup();
    const address = await s.uploadImageFromUrl('https://provider.invalid/result', 'users/alice/images');
    assert.equal(s.resolveStorageReference(address + '?alt=media&token=legacy', 'alice').fullPath,
        s.resolveStorageReference(address, 'alice').fullPath);
    s.auth.currentUser = null;
    assert.throws(() => s.resolveStorageReference(address, 'alice'));
    s.auth.currentUser = { uid: 'bob' };
    assert.throws(() => s.resolveStorageReference(address, 'alice'));
    assert.throws(() => s.resolveStorageReference(address, 'bob'));
});
test('final upload implementation has no token API or logging fallback', () => {
    assert.doesNotMatch(read('services/storage.ts'), /getDownloadURL|console\./);
});


for(const [format,mime,expected,extension] of [
    ['jpeg','application/octet-stream','image/jpeg','jpg'],['jpeg','','image/jpeg','jpg'],
    ['jpeg','image/jpeg','image/jpeg','jpg'],['png','image/jpeg','image/png','png'],
    ['webp','text/plain','image/webp','webp'],['gif','application/octet-stream','image/gif','gif'],
    ['avif','image/png','image/avif','avif'],['bmp','','image/bmp','bmp'],
]) test(`generated ${format} with provider MIME ${mime} uploads canonical validated metadata`,async()=>{
    const s=setup({bytes:imageBytes(format),mime});
    const address=await s.uploadImageFromUrl('https://provider.invalid/wrong.mp4','users/alice/images');
    assert.equal(s.writes.length,1);assert.equal(s.writes[0].metadata.contentType,expected);
    assert.equal(s.writes[0].data.type,expected);
    assert.ok(s.writes[0].reference.fullPath.endsWith('.'+extension));
    assert.equal(s.resolveStorageReference(address,'alice').fullPath,s.writes[0].reference.fullPath);
    await s.createLibraryImage('alice',address,'image-generation');
    assert.equal(s.records[0].data.imageUrl,address);assert.equal(s.records[0].data.type,'image-generation');
    assert.equal(s.tokenCalls(),0);
});
for(const [name,bytes] of [
    ['HTML',Buffer.from('<html>error</html>')],['JSON',Buffer.from('{"error":"failed"}')],
    ['empty',Buffer.alloc(0)],['video',Buffer.from([0,0,0,24,...Buffer.from('ftypisom'),0,0,0,0,...Buffer.from('iso2mp41')])],
    ['truncated JPEG',imageBytes('jpeg').subarray(0,-2)],['truncated PNG',imageBytes('png').subarray(0,-8)],
    ['truncated WebP',imageBytes('webp').subarray(0,-2)],['oversize',Buffer.alloc(32*1024*1024+1)],
])test(`generated ${name} is rejected before upload even with image/jpeg`,async()=>{
    const s=setup({bytes,mime:'image/jpeg'});
    await assert.rejects(s.uploadImageFromUrl('https://provider.invalid/result','users/alice/images'));
    assert.equal(s.writes.length,0);assert.equal(s.records.length,0);
});
test('signature alone is insufficient: failed image decode prevents upload',async()=>{
    const s=setup({decodeError:true});
    await assert.rejects(s.uploadImageFromUrl('https://provider.invalid/result','users/alice/images'));
    assert.equal(s.writes.length,0);
});
test('provider HTTP error prevents image validation and upload',async()=>{
    const s=setup({ok:false});
    await assert.rejects(s.uploadImageFromUrl('https://provider.invalid/result','users/alice/images'),/baixar/);
    assert.equal(s.writes.length,0);
});


for(const dimensions of [[0,3],[2,0],[9000,9000]])test(`unsafe decoded dimensions ${dimensions} prevent upload`,async()=>{
    const s=setup({dimensions});await assert.rejects(s.uploadImageFromUrl('https://provider.invalid/result','users/alice/images'));
    assert.equal(s.writes.length,0);
});
test('oversize Content-Length is rejected before reading body',async()=>{
    let read=false;
    const s=setup({response:{ok:true,headers:{get:()=>String(32*1024*1024+1)},blob:async()=>{read=true;throw Error('unexpected');}}});
    await assert.rejects(s.uploadImageFromUrl('https://provider.invalid/result','users/alice/images'));
    assert.equal(read,false);assert.equal(s.writes.length,0);
});
test('streamed download exceeds byte limit: cancel reader and never upload',async()=>{
    let count=0,cancelled=false,released=false;
    const reader={read:async()=>({done:false,value:new Uint8Array(++count===1?32*1024*1024:1)}),
        cancel:async()=>{cancelled=true;},releaseLock:()=>{released=true;}};
    const s=setup({response:{ok:true,body:{getReader:()=>reader}}});
    await assert.rejects(s.uploadImageFromUrl('https://provider.invalid/result','users/alice/images'));
    assert.equal(cancelled,true);assert.equal(released,true);assert.equal(s.writes.length,0);
});
test('streamed JPEG without trustworthy headers uses signature and canonical metadata',async()=>{
    let consumed=false,released=false;
    const reader={read:async()=>consumed?{done:true}:(consumed=true,{done:false,value:imageBytes('jpeg')}),releaseLock:()=>{released=true;}};
    const s=setup({response:{ok:true,body:{getReader:()=>reader}}});
    await s.uploadImageFromUrl('https://provider.invalid/result','users/alice/images');
    assert.equal(released,true);assert.equal(s.writes[0].metadata.contentType,'image/jpeg');
});
