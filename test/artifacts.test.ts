import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifacts, ArtifactError } from '../src/artifacts.ts';
import { LocalOperatorAdapter, MorphzError, type IoEvent } from '../src/morphz-adapter.ts';
import { createApplication } from '../src/server.ts';
const bytes=Buffer.from('Actual immutable resource bytes.');
const digest=createHash('sha256').update(bytes).digest('hex');
const resourceId='io-resource:fixture_opaque-id';
const metadata={resource_id:resourceId,source_event_id:'event-1',name:'report.txt',media_type:'text/plain',size_bytes:bytes.length,sha256:digest};
const event=(extra:Record<string,unknown>={}):IoEvent=>({io_version:'1',type:'output.committed',event_id:'event-1',sequence:1,session_id:'session-1',timestamp:'2026-09-30T00:00:00Z',resources:[metadata],...extra});

test('catalog projects only registered input/output resources with stable opaque product IDs',async()=>{
 const calls:unknown[]=[];const adapter={readResource:async(...args:unknown[])=>{calls.push(args);return bytes;}};
 const output=new Artifacts(adapter,'session-1',()=>[event()]);const view=output.list()[0];assert.equal(view.origin,'output');assert.equal(view.name,'report.txt');assert.equal(view.sourceEventId,'event-1');assert.match(view.id,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(view).includes(resourceId));
 const restored=new Artifacts(adapter,'session-1',()=>[event()]);assert.equal(restored.list()[0].id,view.id);assert.deepEqual((await restored.download(view.id)).bytes,bytes);assert.equal(calls.length,1);assert.deepEqual(calls[0],['session-1',resourceId,32*1024*1024]);
 const input=new Artifacts(adapter,'session-1',()=>[event({type:'input.accepted',resources:undefined,binding:{resources:[metadata]}})]);assert.equal(input.list()[0].origin,'input');
 const rawWrite=new Artifacts(adapter,'session-1',()=>[event({resources:[],message:{content:{value:{text:'Created /workspace/report.txt'}}}})]);assert.deepEqual(rawWrite.list(),[]);
});

test('foreign Session/event provenance, fabricated keys and path/URL inputs fail closed before byte fetch',async()=>{
 let calls=0;const adapter={readResource:async()=>{calls++;return bytes;}};
 const known=new Artifacts(adapter,'session-1',()=>[event()]);for(const value of ['../../secret','https://evil.example/file',resourceId,'0'.repeat(64)])await assert.rejects(known.download(value),error=>error instanceof ArtifactError&&error.status===404);assert.equal(calls,0);
 assert.throws(()=>new Artifacts(adapter,'session-2',()=>[event()]).list(),/Session/);
 assert.throws(()=>new Artifacts(adapter,'session-1',()=>[event({resources:[{...metadata,source_event_id:'foreign-event'}]})]).list(),/provenance/);
 assert.throws(()=>new Artifacts(adapter,'session-1',()=>[event({resources:[{...metadata,resource_id:'file:///secret'}]})]).list(),/provenance/);
});

test('resource bytes must match declared size and SHA-256; oversize resources never dispatch',async()=>{
 const mismatch=new Artifacts({readResource:async()=>Buffer.from('wrong')},'session-1',()=>[event()]);await assert.rejects(mismatch.download(mismatch.list()[0].id),/integrity/);
 const tooLarge=new Artifacts({readResource:async()=>{throw Error('must not fetch');}},'session-1',()=>[event()],1);assert.equal(tooLarge.list()[0].downloadable,false);await assert.rejects(tooLarge.download(tooLarge.list()[0].id),error=>error instanceof ArtifactError&&error.status===413);
 const hostile=new Artifacts({readResource:async()=>bytes},'session-1',()=>[event({resources:[{...metadata,name:'C:\\private\\report\r\n.txt',storage_path:'/secret',token:'never-project'}]})]);assert.equal(hostile.list()[0].name,'report.txt');assert.ok(!JSON.stringify(hostile.list()).includes('private'));assert.ok(!JSON.stringify(hostile.list()).includes('never-project'));
});

test('binary Runtime reader bounds streamed bytes, preserves scope and does not echo errors',async()=>{
 let captured:any;const adapter=new LocalOperatorAdapter({baseUrl:'http://127.0.0.1:3001',operatorToken:'fixture-token',fetch:(async(url,init)=>{captured={url:String(url),headers:new Headers(init?.headers),redirect:init?.redirect};return new Response(bytes);}) as typeof fetch});
 assert.deepEqual(await adapter.readResource('session/1',resourceId,100),bytes);assert.match(captured.url,/session%2F1\/io\/resources\/io-resource%3Afixture_opaque-id/);assert.equal(captured.headers.get('authorization'),'Bearer fixture-token');assert.equal(captured.redirect,'error');
 await assert.rejects(adapter.readResource('session/1',resourceId,2),error=>error instanceof MorphzError&&error.status===413);
 const denied=new LocalOperatorAdapter({baseUrl:'http://127.0.0.1:3001',fetch:(async()=>new Response('SECRET upstream body',{status:403})) as typeof fetch});await assert.rejects(denied.readResource('s',resourceId,100),error=>error instanceof MorphzError&&error.status===403&&!error.message.includes('SECRET'));
});

test('HTTP attachment delivery is scoped, inert, integrity-verified and private',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'opendots-resource-http-'));let session:any;let resourceReads=0;
 const fetcher=(async(raw:any,init:any={})=>{const path=new URL(raw).pathname;const body=init.body?JSON.parse(init.body):null;
  if(path==='/api/session-io/capabilities')return Response.json({enabled:true,io_versions:['1'],encodings:['json'],formats:[{definition:{id:'morphz.chat',version:'1',encodings:['json']}}]});
  if(path==='/api/agents'&&init.method==='GET')return Response.json({agents:[]});
  if(path==='/api/agents'&&init.method==='POST'){session={id:body.initial_session_id,agent_id:body.id,context_id:body.root_context_id,status:'active'};return Response.json({initial_session:session});}
  if(path.endsWith('/principal'))return Response.json({principal_id:'runtime-principal',session_id:session.id,context_id:session.context_id});
  if(path.includes('/io/resources/')){resourceReads++;return new Response(bytes,{headers:{'content-type':'text/html','content-disposition':'inline'}});}
  if(path.endsWith('/io/events'))return Response.json({subscription:{},events:[event({session_id:session.id,resources:[{...metadata,name:'unsafe.html',media_type:'text/html'}]})],cursor:'opaque-resource'});
  if(path.endsWith('/overview'))return Response.json({context:{id:session.context_id,agent_id:session.agent_id},objectives:[],sessions:[]});
  if(path.endsWith('/scheduler'))return Response.json({context_id:session.context_id,objectives:[],detail_bounds:{limit:2000,has_more_objectives:false}});
  if(path.endsWith('/approvals'))return Response.json({approvals:[],truncated:false});
  if(path.startsWith('/api/sessions/'))return session?Response.json(session):Response.json({error:{}},{status:404});
  throw Error('Unexpected fixture path');
 }) as typeof fetch;
 const app=createApplication({dbPath:join(dir,'app.db'),baseUrl:'http://127.0.0.1:3001',fetch:fetcher,autoStart:false});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const listed=await(await fetch(origin+'/api/artifacts')).json();assert.equal(listed.artifacts.length,1);const response=await fetch(origin+listed.artifacts[0].downloadPath);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.match(response.headers.get('content-disposition')!,/^attachment;/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.equal(resourceReads,1);
 assert.equal((await fetch(origin+'/api/artifacts/'+'0'.repeat(64)+'/content')).status,404);assert.equal(resourceReads,1);
});
