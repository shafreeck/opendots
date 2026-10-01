import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RuntimeService} from '../src/runtime-service.ts';
import {ConfiguredHostTools} from '../src/host-tools-service.ts';
import {validateHostToolsConfig} from '../src/host-tools-config.ts';
import {AUTHORED_DOCUMENT_TOOL} from '../src/authored-documents.ts';
import type {AuthoredDocumentHost} from '../src/authored-document-host.ts';
import type {NativeHostEnvelope} from '../src/native-host-authority.ts';

const binding={principalId:'principal',agentId:'agent',contextId:'context',sessionId:'session'};
const token='d'.repeat(64),runtimeOrigin='http://127.0.0.1:9999';

test('synchronous factory guard catches policy or owner binding changes after an async authorization gap',async t=>{
  for(const mutation of ['configuration','disabled','binding'] as const)for(const action of ['create','append','replay'] as const)await t.test(`${mutation} ${action}`,async()=>{
    const dir=mkdtempSync(join(tmpdir(),'opendots-authored-factory-'));
    const runtime=new RuntimeService({dbPath:join(dir,'product.db'),baseUrl:runtimeOrigin,autoStart:false,fetch:async()=>{throw Error('No native mutations or bootstrap allowed in this fixture');}});
    const saved={...runtime.store.binding()!,...binding,userId:'owner',verified:true};
    const saveBinding=(value:typeof saved)=>runtime.store.db.prepare('UPDATE runtime_binding SET value_json=? WHERE singleton=1').run(JSON.stringify(value));saveBinding(saved);
    const raw={version:2,ownerId:'owner',runtimeOrigin,binding,callbackPort:45000,tools:{authoredDocuments:{callbackToken:token,allowAuthoring:true}}},configPath=join(dir,'host-tools.json');writeFileSync(configPath,JSON.stringify(raw),{mode:0o600});
    const jobs=new Map<string,any>(),activations=new Map<string,any>();let offline=false,reads=0,identityCalls=0,blockAt=Infinity,entered!:()=>void,release!:()=>void;
    const began=new Promise<void>(r=>entered=r),gap=new Promise<void>(r=>release=r);
    // The final identity read is the asynchronous gap after local host policy.
    runtime.verifiedIdentity=async()=>{if(++identityCalls===blockAt){entered();await gap;}if(offline)throw Error('offline');return saved;};
    const runtimeFetch:typeof fetch=async(url,init)=>{
      reads++;assert.equal(init?.method,'GET');if(offline)throw Error('offline');const p=new URL(String(url)).pathname;
      if(p.startsWith('/api/execution-jobs/'))return Response.json(jobs.get(p.split('/').at(-1)!));
      if(p.includes('/threads/'))return Response.json({snapshot:{thread:{id:'thread',agent_id:'agent',context_id:'context',session_id:'session',initiating_principal_id:'principal',target_id:'target-default',root_turn_id:'root',generation:1,lifecycle:'open',control_state:'active'},activations:[...activations.values()].map(activation=>({activation,jobs:[...jobs.values()].filter(job=>job.activation_id===activation.id).map(job=>({job}))}))}});
      if(p.endsWith('/principal'))return Response.json({session_id:'session',context_id:'context',principal_id:'principal'});
      return Response.json({id:'session',agent_id:'agent',context_id:'context'});
    };
    let host!:AuthoredDocumentHost;
    const service=new ConfiguredHostTools({configPath,config:validateHostToolsConfig(raw),runtimeOrigin,runtimeFetch,store:runtime.store,ownerAuthenticationConfigured:true,authoredFactory:(authority,authorize,guard)=>host=runtime.createAuthoredDocumentHost(authority,authorize,guard)});
    const envelope=(id:string,args:object={action:'create',name:'Saved report',format:'text',content:'Exact original bytes\n'}):NativeHostEnvelope=>{
      const invocation={job_id:'job-'+id,tool_call_id:id,principal_id:'principal',agent_id:'agent',context_id:'context',session_id:'session',thread_id:'thread',target_id:'target-default'};
      activations.set(id,{id,generation:1,root_turn_id:'root',agent_id:'agent',context_id:'context',session_id:'session',initiating_principal_id:'principal',status:'running'});
      jobs.set(invocation.job_id,{id:invocation.job_id,...invocation,activation_id:id,initiating_principal_id:'principal',tool_name:AUTHORED_DOCUMENT_TOOL,status:'running',cancel_requested_at:null,request:{...args,_morphz_execution_route:{target_id:'target-default',backend_kind:'in_process_local'}}});
      return{protocol:1,tool:AUTHORED_DOCUMENT_TOOL,invocation,arguments:args};
    };
    const call=(e:NativeHostEnvelope)=>host.handle(e,new AbortController().signal) as Promise<any>;
    try{
      const original=envelope('original'),first=await call(original);identityCalls=0;blockAt=2;
      const pending=call(action==='replay'?original:action==='append'?envelope('blocked',{action:'append',documentId:first.document.id,expectedRevision:1,parentVersionId:first.version.id,content:'Rejected bytes'}):envelope('blocked'));
      const denied=assert.rejects(pending,mutation==='binding'?{code:'connector_saved_binding_required'}:mutation==='configuration'?{code:'connector_configuration_changed'}:{code:'host_tools_configuration_invalid'});
      await began;
      if(mutation==='binding')saveBinding({...saved,userId:'different-owner'});
      else writeFileSync(configPath,JSON.stringify({...raw,tools:{authoredDocuments:{callbackToken:mutation==='configuration'?'e'.repeat(64):token,allowAuthoring:mutation!=='disabled'}}}));
      release();await denied;
      for(const table of ['authored_documents','authored_document_versions','authored_document_content','authored_document_receipts'])assert.equal(runtime.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,1);
      // Native admission policy must not leak onto authenticated browser reads.
      if(mutation==='binding')saveBinding(saved);offline=true;const priorReads=reads;let ownerChecks=0;
      const history=runtime.withRequestAuthorization(()=>{ownerChecks++;},()=>runtime.authoredDocumentHistory(first.document.id));
      assert.equal(history.versions.length,1);assert.equal(runtime.withRequestAuthorization(()=>{ownerChecks++;},()=>runtime.downloadAuthoredVersion(first.document.id,first.version.id)).bytes.toString(),'Exact original bytes\n');
      assert.equal(runtime.withRequestAuthorization(()=>{ownerChecks++;},()=>runtime.listAuthoredDocuments()).documents.length,1);assert.ok(ownerChecks>=3);assert.equal(reads,priorReads);
    }finally{release();await service.close();await runtime.close();rmSync(dir,{recursive:true,force:true});}
  });
});
