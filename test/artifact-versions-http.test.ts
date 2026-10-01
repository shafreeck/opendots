import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/server.ts';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
async function fixture(t:any){
 const dir=mkdtempSync(join(tmpdir(),'opendots-version-http-'));let session:any;let offline=false;let hold:ReturnType<typeof deferred>|undefined;let arrived:ReturnType<typeof deferred>|undefined;let resourceReads=0;
 const bytes=[Buffer.from('version one'),Buffer.from('version two')];
 const resources=bytes.map((b,i)=>({resource_id:`io-resource:version_${i}`,source_event_id:`event-${i}`,name:`report-${i}.txt`,media_type:'text/plain',size_bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}));
 const fetcher=(async(raw:any,init:any={})=>{if(offline)throw new Error('fixture unavailable');const path=new URL(raw).pathname;const body=init.body?JSON.parse(init.body):null;
  if(path==='/api/session-io/capabilities')return Response.json({enabled:true,io_versions:['1'],encodings:['json'],formats:[{definition:{id:'morphz.chat',version:'1',encodings:['json']}}]});
  if(path==='/api/agents'&&init.method==='GET')return Response.json({agents:[]});
  if(path==='/api/agents'&&init.method==='POST'){session={id:body.initial_session_id,agent_id:body.id,context_id:body.root_context_id,status:'active'};return Response.json({initial_session:session});}
  if(path.endsWith('/principal'))return Response.json({principal_id:'principal-version',session_id:session.id,context_id:session.context_id});
  if(path.includes('/io/resources/')){resourceReads++;arrived?.resolve();if(hold)await hold.promise;const id=decodeURIComponent(path.split('/').at(-1)!);return new Response(bytes[resources.findIndex(r=>r.resource_id===id)]);}
  if(path.endsWith('/io/events'))return Response.json({subscription:{},events:resources.map((resource,i)=>({io_version:'1',type:'output.committed',event_id:resource.source_event_id,sequence:i+1,session_id:session.id,timestamp:'2026-09-30T00:00:00Z',resources:[resource]})),cursor:'version-cursor'});
  if(path.endsWith('/overview'))return Response.json({context:{id:session.context_id,agent_id:session.agent_id},objectives:[],sessions:[]});
  if(path.endsWith('/scheduler'))return Response.json({context_id:session.context_id,objectives:[],detail_bounds:{limit:2000,has_more_objectives:false}});
  if(path.endsWith('/approvals'))return Response.json({approvals:[],truncated:false});
  if(path.startsWith('/api/sessions/'))return session?Response.json(session):Response.json({error:{}},{status:404});
  throw Error('Unexpected fixture route');
 })as typeof fetch;
 let app=createApplication({dbPath:join(dir,'product.sqlite'),baseUrl:'http://127.0.0.1:3001',fetch:fetcher,autoStart:false});
 const listen=async()=>{await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));return`http://127.0.0.1:${(app.server.address()as{port:number}).port}`;};let origin=await listen();
 t.after(async()=>{hold?.resolve();await app.close();rmSync(dir,{recursive:true,force:true});});
 const catalogue=await(await fetch(origin+'/api/artifacts')).json();
 return{get app(){return app;},get origin(){return origin;},catalogue,bytes,reads:()=>resourceReads,setOffline:(value:boolean)=>offline=value,
  pauseResource:()=>{hold=deferred();arrived=deferred();return{arrived:arrived.promise,release:()=>hold!.resolve()};},
  post:async(path:string,input:any,csrf=true)=>{const state=await(await fetch(origin+'/api/state')).json();return fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...(csrf?{'x-opendots-csrf':state.csrfToken}:{})},body:JSON.stringify(input)});},
  restart:async()=>{await app.close();app=createApplication({dbPath:join(dir,'product.sqlite'),baseUrl:'http://127.0.0.1:3001',fetch:fetcher,autoStart:false});origin=await listen();}};
}

test('document HTTP admission, lineage, exact receipt replay and inert version download survive restart',async t=>{
 const f=await fixture(t);const create={title:'Reviewed report',artifactId:f.catalogue.artifacts[0].id,note:'first',idempotencyKey:'document-create-one'};
 assert.equal((await f.post('/api/artifact-documents',create,false)).status,403);
 assert.equal((await f.post('/api/artifact-documents',{...create,sessionId:'foreign'})).status,400);
 const response=await f.post('/api/artifact-documents',create);assert.equal(response.status,200);const first=await response.json();assert.equal(f.reads(),1);
 const append={artifactId:f.catalogue.artifacts[1].id,note:'revised',expectedRevision:1,parentVersionId:first.version.id,idempotencyKey:'document-append-two'};
 const second=await(await f.post(`/api/artifact-documents/${first.documentAtAdmission.id}/versions`,append)).json();assert.equal(second.version.revision,2);assert.equal(second.version.parentVersionId,first.version.id);
 assert.equal((await f.post(`/api/artifact-documents/${first.documentAtAdmission.id}/versions`,{...append,idempotencyKey:'stale-new-request'})).status,409);
 const content=await fetch(f.origin+first.version.downloadPath);assert.equal(content.status,200);assert.equal(content.headers.get('content-type'),'application/octet-stream');assert.match(content.headers.get('content-disposition')!,/^attachment;/);assert.deepEqual(Buffer.from(await content.arrayBuffer()),f.bytes[0]);
 await f.restart();f.setOffline(true);const reads=f.reads();
 const retry=await(await f.post('/api/artifact-documents',create)).json();assert.deepEqual(retry,first);assert.equal(f.reads(),reads);
 const receipt=await(await fetch(f.origin+'/api/artifact-commands/document-append-two')).json();assert.deepEqual(receipt.receipt,second);
 const history=await(await fetch(f.origin+`/api/artifact-documents/${first.documentAtAdmission.id}`)).json();assert.equal(history.document.revision,2);assert.deepEqual(history.versions.map((v:any)=>v.id),[first.version.id,second.version.id]);
 const page=await(await f.post(`/api/artifact-documents/${first.documentAtAdmission.id}/versions/page`,{limit:1})).json();assert.equal(page.nextCursor,first.version.id);
 assert.ok((await fetch(f.origin+first.version.downloadPath)).status>=500);
 assert.ok((await f.post('/api/artifact-documents',{...create,idempotencyKey:'new-offline-request'})).status>=500);
 assert.equal((await(await fetch(f.origin+'/api/artifact-documents')).json()).documents.length,1);
});

test('revoked product authority during native verification cannot admit a local document',async t=>{
 const f=await fixture(t),barrier=f.pauseResource();let authorized=true;
 const pending=f.app.runtime!.withRequestAuthorization(()=>{if(!authorized)throw Error('fixture authority revoked');},()=>f.app.runtime!.createArtifactDocument({title:'No admission',artifactId:f.catalogue.artifacts[0].id,idempotencyKey:'revoked-document'}));
 await barrier.arrived;authorized=false;barrier.release();await assert.rejects(pending,/revoked/);
 assert.equal(f.app.runtime!.listArtifactDocuments().documents.length,0);
 assert.equal(f.app.runtime!.artifactCommandReceipt('revoked-document').receipt,null);
});
