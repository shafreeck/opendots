import test from 'node:test';import assert from 'node:assert/strict';import {MemoryView,MemoryViewError} from '../src/memory-view.ts';
const page={root_frame_id:'memory/user',mind_version:7,nodes:[{kind:'frame',id:'memory/user',revision:2,lifecycle:'active',body:'(fact "User supplied memory")',sources:['event-source']}],truncated:false};
test('memory view projects actual Frame results and sources without inventing edit/forget support',async()=>{
 const v=new MemoryView({searchRecall:async()=>({context_id:'own',matches:[{document_kind:'frame',document_id:'memory/user',revision:2,preview:'fact'},{document_kind:'event',document_id:'event-source'}],next_cursor:'opaque'}),recallFrame:async()=>page},'own','session');
 const list=await v.search('fact');assert.equal(list.frames.length,1);assert.equal(list.nextCursor,'opaque');assert.equal(list.capabilities.forget,false);assert.deepEqual((await v.read('memory/user')).sources,['event-source']);
});
test('memory view rejects foreign Context and wrong Frame identity',async()=>{
 const v=new MemoryView({searchRecall:async()=>({context_id:'foreign',matches:[]}),recallFrame:async()=>({...page,root_frame_id:'other'})},'own','session');
 await assert.rejects(v.search('fact'),MemoryViewError);await assert.rejects(v.read('memory/user'),MemoryViewError);
});
