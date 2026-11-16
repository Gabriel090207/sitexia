// Real saving/upload and library functions, offline provider/Storage/Firestore.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const read=path=>readFileSync(new URL(`../src/${path}`,import.meta.url),'utf8');
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
const mp4 = new Uint8Array([0,0,0,24,...Buffer.from('ftypisom'),0,0,0,0,...Buffer.from('iso2mp41')]);
function saving({mime='video/mp4',ok=true,uploadError=false,downloadError=false,empty=false,bytes=mime==='video/mp4'?mp4:'provider-bytes',mediaError=false}={}){
    const writes=[],downloads=[],refs=[];
    const referenceModule={exports:{}};
    vm.runInNewContext(compile(read('services/storageReferences.ts')),{module:referenceModule,exports:referenceModule.exports,require:()=>({})});
    const storage={exports:{}};
    vm.runInNewContext(compile(read('services/storage.ts')),{module:storage,exports:storage.exports,File,
        require(name){
            if(name==='firebase/storage')return {
                ref:(_,path)=>({bucket:'demo',fullPath:path}),uploadBytes:async(reference,file)=>{if(uploadError)throw Error('upload failed');writes.push({reference,file});return {ref:reference};},
                getDownloadURL:()=>{refs.push('forbidden');throw Error('Token URL forbidden');},
            };
            if(name==='../firebase/storage')return {__esModule:true,default:{}};
            if(name==='./storageReferences')return referenceModule.exports;
            if(name==='./prepareGeneratedImage')return {}; // Unused: Face Swap calls uploadFile, not generated-image preparation.
            throw Error(name);
        },
    });
    const videoModule={exports:{}};
    vm.runInNewContext(compile(read('pages/VideoGeneration/prepareVideoFile.ts')),{
        module:videoModule,exports:videoModule.exports,File,setTimeout,clearTimeout,
        URL:{createObjectURL:()=> 'blob:local',revokeObjectURL:()=>{}},
        document:{createElement:()=>({videoWidth:960,videoHeight:1632,duration:5,src:'',pause(){},
            removeAttribute(){this.src='';},load(){if(this.src)queueMicrotask(()=>mediaError?this.onerror?.():this.onloadeddata?.());}})},
    });
    const module={exports:{}};
    vm.runInNewContext(compile(read('pages/FaceSwap/saveFaceSwapResult.ts')),{module,exports:module.exports,File,
        fetch:async url=>{downloads.push(url);if(downloadError)throw Error('network');return {ok,blob:async()=>new Blob(empty?[]:[bytes],{type:mime})};},
        require(name){if(name==='../../services/storage')return storage.exports;if(name==='../VideoGeneration/prepareVideoFile')return videoModule.exports;throw Error(name);},
    });
    return {save:module.exports.saveFaceSwapResult,writes,downloads,refs};
}
for(const [mime,kind,extension]of [['image/png','image','png'],['image/jpeg','image','jpg'],['image/webp','image','webp'],['image/gif','image','gif'],
                                  ['video/mp4','video','mp4'],['video/webm','video','webm'],['video/quicktime','video','mov']]) {
    test(`saves ${mime} with actual MIME/extension through existing uploadFile`,async()=>{
        const s=saving({mime});const result=await s.save('https://provider.invalid/misleading.png','alice',kind);
        assert.equal(result.mediaType,kind);assert.equal(s.writes.length,1);assert.equal(s.downloads.length,1);
        assert.equal(s.writes[0].file.type,mime);assert.ok(s.writes[0].reference.fullPath.startsWith('users/alice/swaps/'));
        assert.ok(s.writes[0].reference.fullPath.endsWith('.'+extension));assert.ok(result.reference.includes('users%2Falice%2Fswaps'));
        assert.equal(new URL(result.reference).search,'');assert.equal(s.refs.length,0);
    });
}
test('unknown task field is resolved using received media, not URL extension',async()=>{
    const s=saving({mime:'video/webm'});assert.equal((await s.save('https://provider.invalid/image.jpg','alice','unknown')).mediaType,'video');
});
for(const options of [{mime:'text/html'},{mime:'application/octet-stream'},{mime:'video/mp4',empty:true},
                       {mime:'image/png'},{ok:false},{uploadError:true},{downloadError:true}]) {
    test(`invalid or failed video is never reported saved: ${JSON.stringify(options)}`,async()=>{
        const s=saving(options);await assert.rejects(s.save('https://provider.invalid/result.mp4','alice','video'));
        assert.equal(s.writes.length,0);assert.equal(s.refs.length,0);
    });
}
// Real 1x1 JPEG fixture; downloads and Firebase writes remain mocked.
const jpeg = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z', 'base64'));
for (const mime of ['image/jpeg', 'application/octet-stream', '']) {
    test(`JPEG binary fixture saves privately with image/jpeg: ${mime || 'missing MIME'}`, async () => {
        const s = saving({mime, bytes:jpeg});
        const result = await s.save('https://provider.invalid/result.JPG', 'alice', 'image');
        assert.equal(result.mediaType, 'image');
        assert.equal(s.writes.length, 1);
        assert.equal(s.writes[0].file.type, 'image/jpeg');
        assert.ok(s.writes[0].reference.fullPath.endsWith('.jpg'));
        assert.deepEqual(new Uint8Array(await s.writes[0].file.arrayBuffer()), jpeg);
        assert.equal(s.refs.length, 0);
    });
}
for (const bytes of ['<html>error</html>', '{"error":"failed"}', 'arbitrary bytes',
                     jpeg.slice(0, -2), new Uint8Array([0xff, 0xd8, 0xff])]) {
    test('generic MIME without complete JPEG markers is rejected before upload', async () => {
        const s = saving({mime:'application/octet-stream', bytes});
        await assert.rejects(s.save('https://provider.invalid/pretend.JPG', 'alice', 'image'));
        assert.equal(s.writes.length, 0);
    });
}
test('generic JPEG resolves unknown output but cannot replace an expected video', async () => {
    const s = saving({mime:'application/octet-stream',bytes:jpeg});
    assert.equal((await s.save('https://provider.invalid/result', 'alice', 'unknown')).mediaType, 'image');
    const video = saving({mime:'application/octet-stream',bytes:jpeg});
    await assert.rejects(video.save('https://provider.invalid/result', 'alice', 'video'));
    assert.equal(video.writes.length, 0);
});
for (const options of [{empty:true}, {ok:false}]) {
    test(`generic JPEG cannot bypass empty or HTTP error checks: ${JSON.stringify(options)}`, async () => {
        const s = saving({mime:'application/octet-stream',bytes:jpeg,...options});
        await assert.rejects(s.save('https://provider.invalid/result.JPG', 'alice', 'image'));
        assert.equal(s.writes.length, 0);
    });
}
for(const mime of ['video/mp4','application/octet-stream',''])for(const expected of ['video','unknown']) {
    test(`Face Swap MP4 saves and registers with validated video/mp4: ${mime || 'missing'} / ${expected}`,async()=>{
        const s=saving({mime,bytes:mp4});
        const saved=await s.save('https://provider.invalid/not-an-extension','alice',expected);
        assert.equal(saved.mediaType,'video');assert.equal(s.writes.length,1);
        assert.equal(s.writes[0].file.type,'video/mp4');
        assert.ok(s.writes[0].reference.fullPath.startsWith('users/alice/swaps/'));
        assert.ok(s.writes[0].reference.fullPath.endsWith('.mp4'));
        assert.deepEqual(new Uint8Array(await s.writes[0].file.arrayBuffer()),mp4);
        assert.equal(s.refs.length,0);
        const l=library();await l.createLibraryVideo('alice',saved.reference,'789','face-swap');
        assert.equal(l.records.length,1);assert.equal(l.records[0].data.videoUrl,saved.reference);
        assert.equal(l.records[0].data.taskId,'789');assert.equal(l.records[0].data.type,'face-swap');
        assert.equal(l.records[0].data.mediaType,'video');
    });
}
for(const mime of ['video/mp4','application/octet-stream',''])for(const bytes of ['<html>error</html>','{"error":true}','arbitrary bytes',mp4.slice(0,15)]) {
    test(`Face Swap invalid video content never uploads: ${mime || 'missing'} / ${String(bytes)}`,async()=>{
        const s=saving({mime,bytes});
        await assert.rejects(s.save('https://provider.invalid/pretend.mp4','alice','video'));
        assert.equal(s.writes.length,0);
    });
}
test('Face Swap rejects MP4-like bytes when browser media validation fails',async()=>{
    const s=saving({mime:'application/octet-stream',bytes:mp4,mediaError:true});
    await assert.rejects(s.save('https://provider.invalid/result.mp4','alice','video'));
    assert.equal(s.writes.length,0);
});
test('generic MP4 cannot replace an expected image',async()=>{
    const s=saving({mime:'application/octet-stream',bytes:mp4});
    await assert.rejects(s.save('https://provider.invalid/result','alice','image'));
    assert.equal(s.writes.length,0);
});
function library(){
    const records=[],module={exports:{}};let notify;let documents=[];const lookups=[];
    vm.runInNewContext(compile(read('services/library.ts')),{module,exports:module.exports,
        require(name){
            if(name==='firebase/firestore')return {
                collection:(_db,...parts)=>parts.join('/'),serverTimestamp:()=> 'timestamp',
                addDoc:async(path,data)=>{records.push({path,data});return {id:'actual-created-id'};},query:value=>value,orderBy:()=>{},
                where:(...args)=>{lookups.push(args);},limit:value=>{lookups.push(["limit",value]);},getDocs:async()=>({docs:documents}),
                onSnapshot:(_query,callback)=>{notify=callback;return()=>{};},
            };
            if(name==='../firebase/firestore')return {__esModule:true,default:{}};
            throw Error(name);
        },
    });
    return {...module.exports,records,lookups,setDocuments:values=>{documents=values;},notify:docs=>notify({docs:docs.map((data,index)=>({id:String(index),data:()=>data}))})};
}
test('Face Swap video records separate origin and media, preserving task identity and videoUrl',async()=>{
    const s=library();await s.createLibraryVideo('alice','saved-reference','123','face-swap');
    const {path,data}=s.records[0];assert.equal(path,'users/alice/swaps');
    assert.equal(data.type,'face-swap');assert.equal(data.mediaType,'video');assert.equal(data.videoUrl,'saved-reference');
    assert.equal(data.taskId,'123');assert.equal(data.imageUrl,undefined);assert.equal(s.isLibraryVideo(data),true);
});
test('other video generations keep their existing record shape',async()=>{
    const s=library();await s.createLibraryVideo('alice','video-reference','123');
    const data=s.records[0].data;assert.equal(data.type,'video-generation');assert.equal(data.mediaType,undefined);
    assert.equal(s.isLibraryVideo(data),true);
});
test('images and inconclusive legacy records retain existing classification',async()=>{
    const s=library();await s.createLibraryImage('alice','image-reference','face-swap');
    assert.equal(s.records[0].data.imageUrl,'image-reference');assert.equal(s.isLibraryVideo(s.records[0].data),false);
    let items;s.subscribeToLibrary('alice',value=>{items=value;});
    s.notify([{imageUrl:'legacy.mp4'},{type:'face-swap',imageUrl:'old.png'},
              {type:'face-swap',mediaType:'video',videoUrl:'new.mp4'},{type:'video-generation',videoUrl:'other.mp4'}]);
    assert.equal(items[0].type,'face-swap');assert.equal(s.isLibraryVideo(items[0]),false);
    assert.equal(s.isLibraryVideo(items[1]),false);assert.equal(s.isLibraryVideo(items[2]),true);assert.equal(s.isLibraryVideo(items[3]),true);
});
test('library uses existing private player, leaving unsupported Face Swap downloads explicitly disabled',()=>{
    const page=read('pages/Library/Library.tsx');assert.ok(page.includes('isLibraryVideo(item) ? ('));
    assert.ok(page.includes('<PrivateLibraryVideo'));assert.ok(page.includes('itemId={item.id}'));
    assert.ok(!page.includes('Download de vídeos Face Swap ainda indisponível'));
    assert.ok(page.includes('<PrivateLibraryImage'));assert.ok(!page.includes('src={item.videoUrl}'));
});

test('video registration returns the real Firestore document ID without changing fields',async()=>{
    const s=library();const id=await s.createLibraryVideo('alice','saved-video','789','face-swap');
    assert.equal(id,'actual-created-id');assert.equal(s.records[0].data.taskId,'789');
});
test('recovery lookup uses existing task ID, stays bounded and does not reinterpret legacy records',async()=>{
    const s=library();s.setDocuments([
        {id:'legacy',data:()=>({type:'face-swap',imageUrl:'legacy.mp4',taskId:'789'})},
        {id:'confirmed',data:()=>({type:'face-swap',mediaType:'video',videoUrl:'existing-reference',taskId:'789'})},
    ]);
    const found=await s.findFaceSwapVideo('alice','789');assert.equal(found.id,'confirmed');assert.equal(found.reference,'existing-reference');
    assert.deepEqual(s.lookups[0],['taskId','==','789']);assert.deepEqual(s.lookups[1],['limit',5]);
    assert.equal(s.records.length,0);
    s.setDocuments([{id:'legacy',data:()=>({type:'face-swap',imageUrl:'legacy.mp4'})}]);
    assert.equal(await s.findFaceSwapVideo('alice','789'),null);
});
