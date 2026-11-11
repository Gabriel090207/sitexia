// Real saving/upload and library functions, offline provider/Storage/Firestore.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const read=path=>readFileSync(new URL(`../src/${path}`,import.meta.url),'utf8');
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
function saving({mime='video/mp4',ok=true,uploadError=false,downloadError=false,empty=false}={}){
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
            throw Error(name);
        },
    });
    const module={exports:{}};
    vm.runInNewContext(compile(read('pages/FaceSwap/saveFaceSwapResult.ts')),{module,exports:module.exports,File,
        fetch:async url=>{downloads.push(url);if(downloadError)throw Error('network');return {ok,blob:async()=>new Blob(empty?[]:['provider-bytes'],{type:mime})};},
        require(name){if(name==='../../services/storage')return storage.exports;throw Error(name);},
    });
    return {save:module.exports.saveFaceSwapResult,writes,downloads,refs};
}
for(const [mime,kind,extension]of [['image/png','image','png'],['image/jpeg','image','jpg'],['image/webp','image','webp'],
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
