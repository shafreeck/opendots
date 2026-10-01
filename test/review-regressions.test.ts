import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createApplication } from '../src/server.ts';
import { RuntimeStore } from '../src/runtime-store.ts';

function directory(t:test.TestContext) {const path=mkdtempSync(join(tmpdir(),'opendots-review-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}

test('revision fence preserves newer Objective and resolved approval against a stale read',t=>{
 const store=new RuntimeStore(join(directory(t),'state.db'));
 store.setView('objective','one',{id:'one',status:'completed',revision:4});store.setView('objective','one',{id:'one',status:'active',revision:3});assert.equal(store.objectives()[0].status,'completed');
 store.setView('approval','permission',{id:'permission',revision:5,status:'denied'});store.replaceApprovals([{id:'permission',revision:4,status:'pending_human'}]);assert.deepEqual(store.views('approval'),[]);store.close();
});

test('noVNC static mount only exposes allowlisted JS inside the installed package',async t=>{
 const app=createApplication({dbPath:join(directory(t),'app.db'),autoStart:false});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const port=(app.server.address() as {port:number}).port;
 const get=(path:string)=>new Promise<{status:number;body:string}>((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode!,body:text}));});req.on('error',reject);req.end();});
 assert.equal((await get('/vendor/novnc/core/rfb.js')).status,200);assert.equal((await get('/vendor/novnc/vendor/pako/lib/zlib/inflate.js')).status,200);
 for(const path of ['/vendor/novnc/package.json','/vendor/novnc/core/../../../../src/server.ts','/vendor/novnc/core/%2e%2e/%2e%2e/src/server.ts','/vendor/novnc/core/../../../opendots/public/app.js','/vendor/novnc/core/rfb.js?token=anything'])assert.notEqual((await get(path)).status,200,path);
});

test('secret-entry errors are redacted and request bodies never enter durable command storage',async t=>{
 const dir=directory(t),dbPath=join(dir,'app.db');const secret='SYNTHETIC_SECRET_MUST_NOT_PERSIST';let session:any;let posted=false;
 const fetcher=(async(raw:any,init:any={})=>{
  const url=new URL(raw),path=url.pathname,input=init.body?JSON.parse(init.body):null;
  if(path==='/api/session-io/capabilities')return Response.json({enabled:true,io_versions:['1'],encodings:['json'],formats:[{definition:{id:'morphz.chat',version:'1',encodings:['json']}}]});
  if(path==='/api/agents'&&init.method==='GET')return Response.json({agents:[]});
  if(path==='/api/agents'&&init.method==='POST'){session={id:input.initial_session_id,agent_id:input.id,context_id:input.root_context_id,status:'active'};return Response.json({initial_session:session});}
  if(path.endsWith('/principal'))return Response.json({session_id:session.id,context_id:session.context_id,principal_id:'local-runtime'});
  if(path.startsWith('/api/sessions/'))return session?Response.json(session):Response.json({error:{}},{status:404});
  if(path==='/api/runtime/providers/setup'){posted=true;assert.equal(input.managed_secret.value,secret);return Response.json({error:{code:'bad_configuration',message:secret}},{status:400});}
  throw Error(`Unexpected fixture route: ${path}`);
 }) as typeof fetch;
 const app=createApplication({dbPath,baseUrl:'http://127.0.0.1:54321',fetch:fetcher,autoStart:false});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const port=(app.server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`;
 const state=await(await fetch(origin+'/api/state')).json();const body={requestId:'a5b3c163-2c4d-4162-912e-b1c65912a9ac',label:'Fixture',protocol:'openai-chat',baseUrl:'https://example.com/v1',apiKey:secret,model:'fixture'};
 const unauthorized=await fetch(origin+'/api/models/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(unauthorized.status,403);assert.equal(posted,false);
 const response=await fetch(origin+'/api/models/connect',{method:'POST',headers:{'content-type':'application/json','x-opendots-csrf':state.csrfToken},body:JSON.stringify(body)});assert.equal(response.status,409);assert.equal(posted,true);assert.ok(!(await response.text()).includes(secret));
 assert.deepEqual(app.runtime!.store.commands(),[]);assert.ok(!JSON.stringify(app.runtime!.snapshot()).includes(secret));
 for(const path of [dbPath,dbPath+'-wal']){try{assert.ok(!readFileSync(path).includes(Buffer.from(secret)));}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error;}}
});
