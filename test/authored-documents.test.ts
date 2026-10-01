import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthoredDocuments, AUTHORED_DOCUMENT_TOOL, authoredDocumentLimits, validateAuthoredDocumentRequest } from '../src/authored-documents.ts';
import { AuthoredDocumentHost, authoredDocumentRegistration, parseAuthoredDocumentEnvelope } from '../src/authored-document-host.ts';
import { NativeHostAuthority, type NativeHostEnvelope } from '../src/native-host-authority.ts';

const binding={principalId:'principal',agentId:'agent',contextId:'context',sessionId:'session'};
const signal=()=>new AbortController().signal;
function fixture(path=':memory:'){
  const db=new DatabaseSync(path);let allowed=true,reads=0,offline=false;let guard:(()=>void)=()=>{if(!allowed)throw Error('denied');};
  const documents=new AuthoredDocuments({db,binding:{...binding,ownerId:'owner',verified:true},assertAuthorized:()=>guard(),now:()=>1234});
  const jobs=new Map<string,any>(),activations=new Map<string,any>();
  const thread:any={id:'thread',...{agent_id:'agent',context_id:'context',session_id:'session',initiating_principal_id:'principal'},target_id:'target-default',root_turn_id:'root-turn',generation:2,lifecycle:'open',control_state:'active',supervision:{supervisor_kind:'objective',supervisor_id:'objective',generation:3}};
  const objective:any={id:'objective',agent_id:'agent',context_id:'context',coordinator_session_id:'session',initiating_principal_id:'principal',generation:3,status:'active'};
  const fetcher:typeof fetch=async(url,init)=>{
    reads++;assert.equal(init?.method,'GET');if(offline)throw Error('offline');const u=new URL(String(url)),p=u.pathname;
    if(p.startsWith('/api/execution-jobs/'))return Response.json(jobs.get(p.split('/').at(-1)!));
    if(p.includes('/threads/'))return Response.json({snapshot:{thread,activations:[...activations.values()].map(a=>({activation:a,jobs:[...jobs.values()].filter(j=>j.activation_id===a.id).map(job=>({job}))}))}});
    if(p.endsWith('/scheduler')){assert.equal(u.search,'?include_terminal=true&limit=2000');return Response.json({context_id:'context',objectives:[{objective}]});}
    if(p.endsWith('/principal'))return Response.json({session_id:'session',context_id:'context',principal_id:'principal'});
    return Response.json({id:'session',agent_id:'agent',context_id:'context'});
  };
  const authority=new NativeHostAuthority({baseUrl:'http://127.0.0.1:9999',binding,toolName:AUTHORED_DOCUMENT_TOOL,fetch:fetcher});
  let authorize:()=>Promise<void>=async()=>{if(!allowed)throw Error('denied');};
  const host=new AuthoredDocumentHost({documents,authority,authorize:()=>authorize()});
  const envelope=(args:any,id='call-1'):NativeHostEnvelope=>{
    const invocation={job_id:'job-'+id,tool_call_id:id,principal_id:'principal',agent_id:'agent',context_id:'context',session_id:'session',thread_id:'thread',target_id:'target-default'};
    const activation={id:'activation-'+id,generation:2,root_turn_id:'root-turn',agent_id:'agent',context_id:'context',session_id:'session',initiating_principal_id:'principal',status:'running'};
    activations.set(activation.id,activation);jobs.set(invocation.job_id,{id:invocation.job_id,...invocation,activation_id:activation.id,initiating_principal_id:'principal',tool_name:AUTHORED_DOCUMENT_TOOL,status:'running',cancel_requested_at:null,request:{...args,_morphz_execution_route:{target_id:'target-default',backend_kind:'in_process_local'}}});
    return{protocol:1,tool:AUTHORED_DOCUMENT_TOOL,invocation,arguments:args};
  };
  const create=(id='call-1',content='# Hello, 世界\n',format='markdown')=>envelope({action:'create',name:'Report',format,content},id);
  const call=(e:NativeHostEnvelope)=>host.handle(e,signal()) as Promise<any>;
  return{db,documents,host,authority,thread,objective,activations,jobs,envelope,create,call,reads:()=>reads,offline:()=>offline=true,revoke:()=>allowed=false,setGuard:(fn:()=>void)=>guard=fn,setAuthorize:(fn:()=>Promise<void>)=>authorize=fn,close:async()=>{await host.close();documents.close();db.close();}};
}

test('real exact UTF8 bytes, SHA256, immutable metadata and server native provenance are committed together',async()=>{const f=fixture();try{const text='# Hello, 世界\n',e=f.create('call-1',text),r=await f.call(e);assert.equal(r.document.source,'opendots_authored');assert.equal(r.version.name,'Report.md');assert.equal(r.version.sizeBytes,Buffer.byteLength(text));assert.equal(r.version.sha256,createHash('sha256').update(text).digest('hex'));assert.deepEqual(r.version.provenance,{...binding,jobId:'job-call-1',callId:'call-1',threadId:'thread',activationId:'activation-call-1',rootTurnId:'root-turn',threadGeneration:2,objectiveId:'objective',objectiveGeneration:3});const saved=f.documents.downloadVersion(r.document.id,r.version.id);assert.equal(saved.bytes.toString(),text);assert.equal(r.version.downloadPath,`/api/authored-documents/${r.document.id}/versions/${r.version.id}/content`);assert.equal(f.db.prepare('SELECT count(*) AS n FROM authored_document_receipts').get()!.n,1);}finally{await f.close();}});

test('text, Markdown and CSV preserve literal inert bytes and fixed extensions including existing extension',async()=>{const f=fixture();try{for(const [format,ext,media]of [['text','txt','text/plain'],['markdown','md','text/markdown'],['csv','csv','text/csv']]){const content='<script>alert(1)</script>\n=HYPERLINK("literal")\n',e=f.envelope({action:'create',name:'Report.'+ext,format,content},format!);const r=await f.call(e);assert.equal(r.version.name,'Report.'+ext);assert.equal(r.version.mediaType,media);assert.equal(f.documents.downloadVersion(r.document.id,r.version.id).bytes.toString(),content);}}finally{await f.close();}});

test('append CAS and old Call replay retain original head even after a later immutable version',async()=>{const f=fixture();try{const original=f.create(),first=await f.call(original);const append=f.envelope({action:'append',documentId:first.document.id,expectedRevision:1,parentVersionId:first.version.id,content:'New'},'append');const second=await f.call(append);assert.equal(second.document.revision,2);assert.equal(second.version.parentVersionId,first.version.id);f.jobs.get(original.invocation.job_id).status='succeeded';f.activations.get('activation-call-1').status='succeeded';assert.deepEqual(await f.call(original),first);assert.equal(f.documents.downloadVersion(first.document.id,first.version.id).bytes.toString(),'# Hello, 世界\n');await assert.rejects(f.call(f.envelope(append.arguments,'append-race')),{code:'authored_document_head_conflict'});assert.equal(f.db.prepare('SELECT count(*) AS n FROM authored_document_receipts').get()!.n,2);}finally{await f.close();}});

test('same native Job/Call changed arguments conflict before any writes or native proof lookup',async()=>{const f=fixture();try{const e=f.create(),r=await f.call(e),before=f.reads();await assert.rejects(f.call({...e,arguments:{...e.arguments,content:'Changed'}}),{code:'authored_document_call_conflict'});assert.equal(f.reads(),before);assert.equal(f.documents.history(r.document.id).versions.length,1);}finally{await f.close();}});

test('receipt INSERT failure atomically rolls back bytes, immutable version and head',async()=>{const f=fixture();try{const first=await f.call(f.create());f.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON authored_document_receipts BEGIN SELECT RAISE(FAIL,'fixture failure'); END;");await assert.rejects(f.call(f.envelope({action:'append',documentId:first.document.id,expectedRevision:1,parentVersionId:first.version.id,content:'Lost'},'failed')));assert.equal(f.documents.get(first.document.id).document.revision,1);for(const table of ['authored_documents','authored_document_versions','authored_document_content','authored_document_receipts'])assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,1);}finally{await f.close();}});

test('strict formats, unknown fields, malformed Unicode, controls, paths and encoded request bounds fail closed',()=>{const base={action:'create',name:'Name',format:'text',content:'hello'};for(const input of [{...base,format:'html'},{...base,ownerId:'forged'},{...base,name:'../path'},{...base,content:'\ud800'},{...base,content:'\0'},{...base,content:'a'.repeat(authoredDocumentLimits.contentBytes+1)},{...base,content:'\t'.repeat(40000)}])assert.throws(()=>validateAuthoredDocumentRequest(input));assert.equal(validateAuthoredDocumentRequest({...base,content:'😀\t\r\n'}).action,'create');});

test('scope, envelope identity and native Tool/Job/Thread/Activation proof cannot be forged',async()=>{const f=fixture();try{const e=f.create();for(const key of ['principal_id','session_id','context_id','agent_id','thread_id','job_id','tool_call_id','target_id'])await assert.rejects(f.call({...e,invocation:{...e.invocation,[key]:'forged'}}));f.jobs.get(e.invocation.job_id).tool_name='host_opendots_calendar';await assert.rejects(f.call(e),{code:'connector_job_mismatch'});f.jobs.get(e.invocation.job_id).tool_name=AUTHORED_DOCUMENT_TOOL;f.activations.get('activation-call-1').root_turn_id='other-root';await assert.rejects(f.call(e),{code:'connector_activation_mismatch'});assert.equal(f.documents.list().documents.length,0);}finally{await f.close();}});

test('native Objective ownership and generation are verified against supported exact scheduler row',async()=>{const f=fixture();try{const e=f.create();f.objective.generation=4;await assert.rejects(f.call(e),{code:'connector_execution_inactive'});f.objective.generation=3;f.objective.coordinator_session_id='foreign';await assert.rejects(f.call(e),{code:'connector_objective_mismatch'});assert.equal(f.documents.list().documents.length,0);}finally{await f.close();}});

test('replay requires fresh native authority and immutable activation/root proof',async()=>{const f=fixture();try{const e=f.create();await f.call(e);const reads=f.reads();await f.call(e);assert.ok(f.reads()>reads);f.jobs.get(e.invocation.job_id).activation_id='replacement';f.activations.set('replacement',{...f.activations.get('activation-call-1'),id:'replacement'});await assert.rejects(f.call(e),{code:'authored_document_provenance_changed'});f.offline();await assert.rejects(f.call(e));assert.equal(f.documents.list().documents.length,1);}finally{await f.close();}});

test('missing Objective supervision stays null and task links require exact creator Job AND Thread',async()=>{const f=fixture();try{delete f.thread.supervision;const first=await f.call(f.create());assert.equal(first.version.provenance.objectiveId,null);assert.equal(first.version.provenance.objectiveGeneration,null);const result=f.documents.forTask({objectiveId:'some-task',jobIds:['job-call-1'],threadIds:['thread']});assert.equal(result.items[0]!.version.id,first.version.id);assert.deepEqual(f.documents.forTask({objectiveId:'some-task',jobIds:['job-call-1'],threadIds:['wrong']}).items,[]);assert.deepEqual(f.documents.forTask({objectiveId:'some-task',jobIds:['wrong'],threadIds:['thread']}).items,[]);}finally{await f.close();}});

test('synchronous admission rechecks authorization and rejects asynchronous guards',async()=>{const f=fixture();try{f.setAuthorize(async()=>{});f.revoke();await assert.rejects(f.call(f.create()));f.setGuard((async()=>{}) as ()=>void);await assert.rejects(f.call(f.create()),{code:'authored_document_guard_must_be_synchronous'});assert.equal(f.db.prepare('SELECT count(*) AS n FROM authored_documents').get()!.n,0);}finally{await f.close();}});

test('revocation during asynchronous native proof is checked before product mutation',async()=>{const f=fixture();try{let n=0;f.setAuthorize(async()=>{if(++n===2)f.revoke();});await assert.rejects(f.call(f.create()));assert.equal(f.db.prepare('SELECT count(*) AS n FROM authored_documents').get()!.n,0);}finally{await f.close();}});

test('shutdown aborts a pending authorization and late completion cannot write',async()=>{const f=fixture();try{let entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>entered=r);f.setAuthorize(()=>{entered();return new Promise<void>(r=>release=r);});const call=f.call(f.create());await began;const caught=assert.rejects(call,{code:'connector_host_closed'});await f.host.close();await caught;release();await new Promise(r=>setImmediate(r));assert.equal(f.db.prepare('SELECT count(*) AS n FROM authored_documents').get()!.n,0);}finally{await f.close();}});

test('concurrent append calls linearize a single exact head winner',async()=>{const f=fixture();try{const first=await f.call(f.create()),args={action:'append',documentId:first.document.id,expectedRevision:1,parentVersionId:first.version.id,content:'next'};const results=await Promise.allSettled([f.call(f.envelope(args,'a')),f.call(f.envelope(args,'b'))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.documents.history(first.document.id).versions.length,2);assert.equal(f.db.prepare('SELECT count(*) AS n FROM authored_document_receipts').get()!.n,2);}finally{await f.close();}});

test('new status Calls observe new versions while old get receipts remain historical',async()=>{const f=fixture();try{const first=await f.call(f.create()),get=f.envelope({action:'get',documentId:first.document.id},'get'),old=await f.call(get);await f.call(f.envelope({action:'append',documentId:first.document.id,expectedRevision:1,parentVersionId:first.version.id,content:'next'},'append'));assert.deepEqual(await f.call(get),old);assert.equal((await f.call(f.envelope({action:'status',documentId:first.document.id},'status'))).document.revision,2);}finally{await f.close();}});

test('history pagination and retrieval remain owner scoped and corruption fails integrity',async()=>{const f=fixture();try{const first=await f.call(f.create());await f.call(f.envelope({action:'append',documentId:first.document.id,expectedRevision:1,parentVersionId:first.version.id,content:'next'},'append'));const page=f.documents.history(first.document.id,{limit:1});assert.equal(page.nextCursor,first.version.id);assert.equal(f.documents.history(first.document.id,{afterId:page.nextCursor!}).versions[0]!.revision,2);const foreign=new AuthoredDocuments({db:f.db,binding:{...binding,ownerId:'other',verified:true},assertAuthorized:()=>{}});assert.equal(foreign.list().documents.length,0);assert.throws(()=>foreign.downloadVersion(first.document.id,first.version.id),{code:'authored_document_not_found'});f.db.prepare('UPDATE authored_document_content SET bytes=? WHERE version_id=?').run(Buffer.from('corrupt'),first.version.id);assert.throws(()=>f.documents.downloadVersion(first.document.id,first.version.id),{code:'authored_document_integrity_failed'});}finally{await f.close();}});

test('file-backed restart retains exact bytes and original Call receipts without native availability',async()=>{const dir=mkdtempSync(join(tmpdir(),'opendots-authored-')),path=join(dir,'product.db');let f=fixture(path);try{const e=f.create(),first=await f.call(e);await f.close();f=fixture(path);f.offline();assert.equal(f.documents.downloadVersion(first.document.id,first.version.id).bytes.toString(),'# Hello, 世界\n');assert.deepEqual(f.documents.receipt(e),first);await assert.rejects(f.call(e));}finally{await f.close();rmSync(dir,{recursive:true,force:true});}});

test('manifest is inert fixed-loopback data and envelope rejects model task/path/proof arguments',()=>{const entry=authoredDocumentRegistration({contextId:'context',endpoint:'http://127.0.0.1:4000/api/host-tools/documents/call',token:'x'.repeat(64)});assert.equal(entry.definition.name,AUTHORED_DOCUMENT_TOOL);assert.deepEqual(entry.idempotent_requests,[]);assert.throws(()=>authoredDocumentRegistration({contextId:'context',endpoint:'https://example.com/api/host-tools/documents/call',token:'x'.repeat(64)}));assert.throws(()=>parseAuthoredDocumentEnvelope({protocol:1,tool:AUTHORED_DOCUMENT_TOOL,invocation:{},arguments:{action:'create',path:'/tmp/file'}}));});

test('local byte quota rolls back an attempted version while original Call receipt remains replayable',async()=>{const f=fixture();try{
  const content='x'.repeat(authoredDocumentLimits.contentBytes),original=f.create('quota-0',content,'text'),first=await f.call(original);let current=first,admitted=1;
  // Exercise the synchronous persistence boundary in isolation after one native
  // proof; this avoids building artificially huge native Thread snapshots.
  for(let n=1;n<300;n++){
    const e=f.envelope({action:'append',documentId:first.document.id,expectedRevision:current.document.revision,parentVersionId:current.version.id,content},`quota-${n}`);
    const proof={...first.version.provenance,jobId:e.invocation.job_id,callId:e.invocation.tool_call_id,activationId:'activation-'+e.invocation.tool_call_id};
    try{current=f.documents.execute(e,proof) as any;admitted++;}
    catch(error){assert.equal((error as any).code,'authored_document_storage_limit');break;}
  }
  assert.equal(admitted,Math.floor(authoredDocumentLimits.totalBytes/authoredDocumentLimits.contentBytes));
  assert.equal(f.documents.get(first.document.id).document.revision,admitted);
  assert.deepEqual(f.documents.receipt(original),first);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM authored_document_versions').get()!.n,admitted);
  assert.equal(f.documents.downloadVersion(first.document.id,first.version.id).bytes.toString(),content);
}finally{await f.close();}});

test('receipt count and UTF8-byte quotas atomically reject new calls without pruning replays or changing heads',async()=>{const f=fixture();try{
  const e=f.create(),first=await f.call(e);
  const fill=f.db.prepare('INSERT INTO authored_document_receipts VALUES(?,?,?,?,?,?,?)');
  f.db.exec('BEGIN');for(let n=1;n<authoredDocumentLimits.receipts;n++)fill.run('quota-'+n,'owner','session','envelope','provenance','{}',1234);f.db.exec('COMMIT');
  await assert.rejects(f.call(f.create('blocked-create')),{code:'authored_document_receipt_limit'});
  assert.equal(f.documents.list().documents.length,1);assert.deepEqual(await f.call(e),first);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM authored_document_content').get()!.n,1);
  f.db.prepare("DELETE FROM authored_document_receipts WHERE id LIKE 'quota-%'").run();
  const bytes=Number(f.db.prepare('SELECT sum(length(CAST(result_json AS BLOB))) AS n FROM authored_document_receipts').get()!.n);
  const remaining=authoredDocumentLimits.receiptTotalBytes-bytes;
  fill.run('quota-bytes','owner','session','envelope','provenance','"'+'x'.repeat(remaining-2)+'"',1234);
  const append=f.envelope({action:'append',documentId:first.document.id,expectedRevision:1,parentVersionId:first.version.id,content:'must roll back'},'blocked-append');
  await assert.rejects(f.call(append),{code:'authored_document_receipt_limit'});
  assert.equal(f.documents.get(first.document.id).document.revision,1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM authored_document_versions').get()!.n,1);
  assert.deepEqual(await f.call(e),first);
  await assert.rejects(f.call(f.envelope({action:'get',documentId:first.document.id},'blocked-get')),{code:'authored_document_receipt_limit'});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM authored_document_receipts').get()!.n,2);
}finally{await f.close();}});
