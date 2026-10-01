import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftProjection, readSse } from '../src/runtime-stream.ts';
const draft = (type:string,delta_seq:number,text:string,extra:Record<string,unknown>={})=>({type,output_id:'output-a',root_turn_id:'root-a',session_id:'session-a',thread_id:'thread-a',delta_seq,text,...extra});

test('typed draft snapshots replace prefixes, duplicate deltas do not append, gaps fail closed',()=>{
 const p=new DraftProjection('session-a');p.consume(draft('output.started',2,'hello'));p.consume(draft('output.delta',3,' world',{operation:'text.append'}));p.consume(draft('output.delta',3,' world',{operation:'text.append'}));assert.equal(p.snapshot()[0].text,'hello world');
 const time=p.snapshot()[0].created_at;p.consume(draft('output.started',4,'hello world!'));assert.equal(p.snapshot()[0].text,'hello world!');assert.equal(p.snapshot()[0].created_at,time);
 p.consume(draft('output.delta',6,'gap',{operation:'text.append'}));assert.equal(p.snapshot().length,0);
 p.consume(draft('output.delta',7,'no prefix',{operation:'text.append'}));assert.equal(p.snapshot().length,0);
 p.consume(draft('output.started',7,'authoritative snapshot'));assert.equal(p.snapshot()[0].text,'authoritative snapshot');assert.equal(p.snapshot()[0].draft,true);
});

test('terminal roots fence late drafts from all model attempts, reconnect discards ephemeral state',()=>{
 const p=new DraftProjection('session-a');p.consume(draft('output.started',0,''));p.consume(draft('output.started',0,'second',{output_id:'output-b'}));assert.equal(p.snapshot().length,2);
 p.consume({type:'output.committed',session_id:'session-a',root_turn_id:'root-a'});assert.deepEqual(p.snapshot(),[]);
 p.consume(draft('output.delta',1,'late',{operation:'text.append'}));p.consume(draft('output.started',2,'late',{output_id:'output-c'}));assert.deepEqual(p.snapshot(),[]);
 p.clear();p.consume(draft('output.started',3,'snapshot'));p.consume({type:'stream.reset',output_id:'output-a'});assert.deepEqual(p.snapshot(),[]);
 p.consume(draft('output.started',3,'snapshot'));p.consume({type:'output.aborted',output_id:'output-a'});assert.deepEqual(p.snapshot(),[]);
});

test('draft projection enforces session, UTF-8 bytes and bounded count',()=>{
 const p=new DraftProjection('session-a');p.consume(draft('output.started',0,'foreign',{session_id:'another'}));assert.deepEqual(p.snapshot(),[]);
 p.consume(draft('output.started',0,'中'.repeat(90_000)));assert.deepEqual(p.snapshot(),[]);
 for(let n=0;n<100;n++)p.consume(draft('output.started',0,'x',{output_id:`out-${n}`,root_turn_id:`root-${n}`}));assert.equal(p.snapshot().length,64);
});

test('SSE parser handles chunk-split UTF-8, CRLF, comments and multiple frames',async()=>{
 const bytes=new TextEncoder().encode(': keepalive\r\n\r\nevent: output.started\r\ndata: {"type":"output.started","text":"中文"}\r\n\r\ndata: {"type":"stream.reset",\ndata: "reason":"gap"}\n\n');
 const stream=new ReadableStream<Uint8Array>({start(controller){for(let n=0;n<bytes.length;n++)controller.enqueue(bytes.slice(n,n+1));controller.close();}});const events:unknown[]=[];await readSse(stream,e=>events.push(e),new AbortController().signal);assert.deepEqual(events,[{type:'output.started',text:'中文'},{type:'stream.reset',reason:'gap'}]);
});

test('SSE parser terminates on malformed event and abort cancels reader',async()=>{
 let cancelled=false;const controller=new AbortController();const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('data: {"type":"stream.opened"}\n\n'));},cancel(){cancelled=true;}});
 await readSse(stream,()=>controller.abort(),controller.signal);assert.equal(cancelled,true);
 const invalid=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('data: []\n\n'));c.close();}});await assert.rejects(readSse(invalid,()=>{},new AbortController().signal),/Invalid Runtime/);
});

import { ApplicationStreamProjection } from '../src/runtime-observer.ts';
test('pinned application observer projects only public text and refuses reconnect suffixes',()=>{
 const p=new ApplicationStreamProjection('session-a');let id=0;
 const raw=(kind:string,text:string,extra:Record<string,unknown>={})=>({id:`event-${++id}`,topic:'runtime/model_stream',payload:{session_id:'session-a',attempt_id:'physical-attempt',root_turn_id:'root-a',thread_id:'thread-a',stream:{kind,text},...extra}});
 assert.equal(p.accept(raw('text_delta','missing-prefix')),undefined);
 assert.equal(p.accept(raw('reasoning_summary_delta','PRIVATE_REASONING')),undefined);
 assert.equal(p.accept(raw('provider_continuation','PRIVATE_CONTINUATION')),undefined);
 assert.equal(p.accept(raw('started',''))!.type,'output.started');
 const input=raw('text_delta','Visible text');const output=p.accept(input)!;assert.equal(output.type,'output.delta');assert.equal(output.text,'Visible text');assert.equal(output.delta_seq,1);assert.equal(p.accept(input),undefined);
 assert.equal(p.accept(raw('text_delta','foreign',{session_id:'session-other'})),undefined);
 assert.equal(p.accept({id:'snapshot',topic:'runtime/model_request_snapshot',payload:{session_id:'session-a',text:'PRIVATE_PROMPT'}}),undefined);
 assert.equal(p.accept(raw('failed','PRIVATE_PROVIDER_ERROR'))!.type,'output.aborted');
 assert.equal(p.accept(raw('text_delta','after-abort')),undefined);
});
