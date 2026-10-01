import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateHostToolsConfig } from '../src/host-tools-config.ts';
import { ConfiguredHostTools } from '../src/host-tools-service.ts';
import { AuthoredDocumentHost } from '../src/authored-document-host.ts';
import { AuthoredDocuments, AUTHORED_DOCUMENT_TOOL } from '../src/authored-documents.ts';
const binding={principalId:'principal',agentId:'agent',contextId:'context',sessionId:'session'};
const token='d'.repeat(64),base={version:2,ownerId:'owner',runtimeOrigin:'http://127.0.0.1:9999',binding,callbackPort:45000,tools:{authoredDocuments:{callbackToken:token,allowAuthoring:true}}};
test('authored config is explicit, owner-authenticated and distinct-token scoped',()=>{const config=validateHostToolsConfig(base);assert.equal(config.tools.authoredDocuments!.allowAuthoring,true);for(const tools of [{authoredDocuments:{callbackToken:token,allowAuthoring:false}},{authoredDocuments:{callbackToken:token,allowAuthoring:true,path:'/tmp/import'}},{...base.tools,calendarProposals:{callbackToken:token,allowProposals:true}}])assert.throws(()=>validateHostToolsConfig({...base,tools}));});
test('configured document host recovers failed startup with bounded retry and close fences resurrection',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'opendots-authored-host-'));const db=new DatabaseSync(':memory:');let service:ConfiguredHostTools|undefined;
  const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
  const config=validateHostToolsConfig({...base,callbackPort:port}),configPath=join(dir,'host-tools.json');writeFileSync(configPath,JSON.stringify({...base,callbackPort:port}),{mode:0o600});
  let online=false,reads=0;const runtimeFetch:typeof fetch=async(url)=>{reads++;if(!online)throw Error('offline');const path=new URL(String(url)).pathname;if(path.endsWith('/principal'))return Response.json({principal_id:binding.principalId,context_id:binding.contextId,session_id:binding.sessionId});if(path==='/api/execution-targets')return Response.json({targets:[{id:'target-default',revision:1,kind:'in_process_local',status:'online',capabilities:[AUTHORED_DOCUMENT_TOOL]}]});return Response.json({id:binding.sessionId,agent_id:binding.agentId,context_id:binding.contextId});};
  const documents=new AuthoredDocuments({db,binding:{...binding,ownerId:'owner',verified:true},assertAuthorized:()=>{}});
  const options={configPath,config,runtimeOrigin:base.runtimeOrigin,runtimeFetch,store:{db,binding:()=>({...binding,userId:'owner',runtimeOrigin:base.runtimeOrigin,verified:true})},ownerAuthenticationConfigured:true,authoredFactory:(authority:any,authorize:()=>Promise<void>)=>new AuthoredDocumentHost({documents,authority,authorize})};
  try{
    assert.throws(()=>new ConfiguredHostTools({...options,ownerAuthenticationConfigured:false}),{code:'authored_owner_authentication_required'});
    service=new ConfiguredHostTools(options);assert.equal(service.authoringSnapshot().callbackListening,false);await assert.rejects(service.start(),{code:'connector_startup_unavailable'});assert.equal(service.authoringSnapshot().status,'unavailable');assert.ok(service.authoringSnapshot().nextRetryAt!==null);
    online=true;const deadline=Date.now()+3000;while(service.authoringSnapshot().status!=='ready'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));assert.equal(service.authoringSnapshot().status,'ready');assert.equal(service.authoringSnapshot().callbackListening,true);assert.equal(service.authoringSnapshot().nextRetryAt,null);await service.nativeCatalogue();assert.equal(service.authoringSnapshot().nativeRegistration,'advertised');
    await service.close();const prior=reads;assert.equal(service.authoringSnapshot().status,'closed');assert.equal(service.authoringSnapshot().nextRetryAt,null);await assert.rejects(service.start(),{code:'connector_host_closed'});await new Promise(r=>setTimeout(r,300));assert.equal(reads,prior);
  }finally{await service?.close();documents.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
