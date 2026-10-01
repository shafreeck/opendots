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

test('native access rejection and changed host policy do not become automatic retry or listener admission',async t=>{
  for(const mode of ['native401','native403','policyRevokedBeforeRetry','bindingRevokedBeforeRetry','missingPolicyBeforeRetry'] as const)await t.test(mode,async()=>{
    const dir=mkdtempSync(join(tmpdir(),'opendots-authored-denied-')),db=new DatabaseSync(':memory:');
    const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
    const raw={...base,callbackPort:port},config=validateHostToolsConfig(raw),configPath=join(dir,'host-tools.json');writeFileSync(configPath,JSON.stringify(raw),{mode:0o600});
    let reads=0,online=false,saved={...binding,userId:'owner',runtimeOrigin:base.runtimeOrigin,verified:true};
    const runtimeFetch:typeof fetch=async url=>{
      reads++;if(mode==='native401'||mode==='native403')return new Response(null,{status:mode==='native401'?401:403});
      if(!online)return new Response(null,{status:503});
      return String(url).endsWith('/principal')?Response.json({principal_id:binding.principalId,context_id:binding.contextId,session_id:binding.sessionId}):Response.json({id:binding.sessionId,agent_id:binding.agentId,context_id:binding.contextId});
    };
    const documents=new AuthoredDocuments({db,binding:{...binding,ownerId:'owner',verified:true},assertAuthorized:()=>{}});
    const service=new ConfiguredHostTools({configPath,config,runtimeOrigin:base.runtimeOrigin,runtimeFetch,store:{db,binding:()=>saved},ownerAuthenticationConfigured:true,authoredFactory:(authority,authorize)=>new AuthoredDocumentHost({documents,authority,authorize})});
    try{
      await assert.rejects(service.start(),{code:'connector_startup_unavailable'});const rejectedReads=reads;
      if(mode==='native401'||mode==='native403')assert.equal(service.authoringSnapshot().nextRetryAt,null);
      else{
        assert.notEqual(service.authoringSnapshot().nextRetryAt,null);online=true;
        if(mode==='policyRevokedBeforeRetry')writeFileSync(configPath,JSON.stringify({...raw,tools:{authoredDocuments:{callbackToken:token,allowAuthoring:false}}}));
        if(mode==='bindingRevokedBeforeRetry')saved={...saved,userId:'other-owner'};
        if(mode==='missingPolicyBeforeRetry')rmSync(configPath);
      }
      await new Promise(r=>setTimeout(r,600));
      assert.equal(reads,rejectedReads);assert.equal(service.authoringSnapshot().status,'unavailable');assert.equal(service.authoringSnapshot().callbackListening,false);assert.equal(service.authoringSnapshot().nextRetryAt,null);
      // Restoring a denied setup cannot silently restart this already-rejected host.
      writeFileSync(configPath,JSON.stringify(raw),{mode:0o600});saved={...saved,userId:'owner'};online=true;
      await assert.rejects(service.start(),{code:'connector_startup_unavailable'});assert.equal(reads,rejectedReads);
    }finally{await service.close();documents.close();db.close();rmSync(dir,{recursive:true,force:true});}
  });
});

test('an explicit native 503 remains recoverable without reopening or changing a binding',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'opendots-authored-transient-')),db=new DatabaseSync(':memory:');
  const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
  const raw={...base,callbackPort:port},configPath=join(dir,'host-tools.json');writeFileSync(configPath,JSON.stringify(raw),{mode:0o600});
  let online=false,reads=0;const runtimeFetch:typeof fetch=async url=>{reads++;if(!online)return new Response(null,{status:503});return String(url).endsWith('/principal')?Response.json({principal_id:binding.principalId,context_id:binding.contextId,session_id:binding.sessionId}):Response.json({id:binding.sessionId,agent_id:binding.agentId,context_id:binding.contextId});};
  const documents=new AuthoredDocuments({db,binding:{...binding,ownerId:'owner',verified:true},assertAuthorized:()=>{}}),saved={...binding,userId:'owner',runtimeOrigin:base.runtimeOrigin,verified:true};
  const service=new ConfiguredHostTools({configPath,config:validateHostToolsConfig(raw),runtimeOrigin:base.runtimeOrigin,runtimeFetch,store:{db,binding:()=>saved},ownerAuthenticationConfigured:true,authoredFactory:(authority,authorize)=>new AuthoredDocumentHost({documents,authority,authorize})});
  try{await assert.rejects(service.start());assert.notEqual(service.authoringSnapshot().nextRetryAt,null);online=true;const deadline=Date.now()+3000;while(service.authoringSnapshot().status!=='ready'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));assert.equal(service.authoringSnapshot().status,'ready');assert.equal(service.authoringSnapshot().callbackListening,true);const admittedReads=reads;await service.start();assert.equal(reads,admittedReads);assert.equal(service.authoringSnapshot().nextRetryAt,null);}finally{await service.close();documents.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('identity and policy changes during async startup verification block listener admission',async t=>{
  for(const failure of ['identity','changed','missing'] as const)await t.test(failure,async()=>{
    const dir=mkdtempSync(join(tmpdir(),'opendots-authored-denial-')),db=new DatabaseSync(':memory:');
    const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
    const raw={...base,callbackPort:port},config=validateHostToolsConfig(raw),configPath=join(dir,'host-tools.json');writeFileSync(configPath,JSON.stringify(raw),{mode:0o600});
    let reads=0;
    const runtimeFetch:typeof fetch=async url=>{
      reads++;await Promise.resolve();
      if(failure==='changed')writeFileSync(configPath,JSON.stringify({...raw,tools:{authoredDocuments:{callbackToken:'x'.repeat(64),allowAuthoring:true}}}));
      if(failure==='missing')rmSync(configPath,{force:true});
      return new URL(String(url)).pathname.endsWith('/principal')?Response.json({principal_id:failure==='identity'?'other':binding.principalId,context_id:binding.contextId,session_id:binding.sessionId}):Response.json({id:binding.sessionId,agent_id:binding.agentId,context_id:binding.contextId});
    };
    const documents=new AuthoredDocuments({db,binding:{...binding,ownerId:'owner',verified:true},assertAuthorized:()=>{}});
    const service=new ConfiguredHostTools({configPath,config,runtimeOrigin:base.runtimeOrigin,runtimeFetch,store:{db,binding:()=>({...binding,userId:'owner',runtimeOrigin:base.runtimeOrigin,verified:true})},ownerAuthenticationConfigured:true,authoredFactory:(authority,authorize)=>new AuthoredDocumentHost({documents,authority,authorize})});
    try{
      await assert.rejects(service.start(),{code:'connector_startup_unavailable'});
      const deniedReads=reads;assert.equal(deniedReads,2);assert.equal(service.authoringSnapshot().status,'unavailable');assert.equal(service.authoringSnapshot().callbackListening,false);assert.equal(service.authoringSnapshot().nextRetryAt,null);
      // Restoring the file does not turn a denied lifetime into new authority.
      writeFileSync(configPath,JSON.stringify(raw));await new Promise(r=>setTimeout(r,350));
      await assert.rejects(service.start(),{code:'connector_startup_unavailable'});assert.equal(reads,deniedReads);assert.equal(service.authoringSnapshot().callbackListening,false);
    }finally{await service.close();documents.close();db.close();rmSync(dir,{recursive:true,force:true});}
  });
});
