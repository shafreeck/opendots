import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerGateway, ComputerGatewayError, type ComputerGatewayOptions } from '../src/computer-gateway.ts';
const delay = (ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(fn:()=>boolean) {for(let n=0;n<100;n++){if(fn())return;await delay(5);}assert.fail('Timed out waiting for fixture condition');}
async function fixture(t:test.TestContext, capture=false, extra:Partial<ComputerGatewayOptions>={}) {
 const root=mkdtempSync(join(tmpdir(),'opendots-gateway-'));const received={preview:[] as string[],control:[] as string[]};const sockets=new Set<any>();let now=Date.now();
 const endpoint=(kind:'preview'|'control')=>tcpServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('data',data=>received[kind].push(data.toString()));socket.write(`${kind}-fixture`);});
 const preview=endpoint('preview'),control=endpoint('control');await Promise.all([new Promise<void>(r=>preview.listen(0,'127.0.0.1',r)),new Promise<void>(r=>control.listen(0,'127.0.0.1',r))]);
 const server=httpServer((_req,res)=>{res.writeHead(404);res.end();});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const gateway=new ComputerGateway({dbPath:join(root,'computer.db'),previewPort:(preview.address() as any).port,controlPort:(control.address() as any).port,previewReadOnlyEnforced:true,now:()=>now,...(capture?{captureSettledObservation:async()=>({id:'trusted-fixture-observation',capturedAt:now})}:{}),...extra});gateway.attach(server);
 t.after(async()=>{await gateway.close();for(const socket of sockets)socket.destroy();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>preview.close(r)),new Promise(r=>control.close(r))]);rmSync(root,{recursive:true,force:true});});
 return {gateway,origin,received,tick:(ms:number)=>{now+=ms;}};
}
async function open(connection:any, origin:string) {return new Promise<WebSocket>((resolve,reject)=>{const ws=new WebSocket(connection.url,connection.protocols,{origin});ws.once('error',reject);ws.once('open',()=>resolve(ws));});}
async function rejected(connection:any,origin:string) {return new Promise<number>((resolve,reject)=>{const ws=new WebSocket(connection.url,connection.protocols,{origin});ws.once('unexpected-response',(_req,response)=>{response.resume();ws.terminate();resolve(response.statusCode!);});ws.once('open',()=>{ws.close();reject(Error('Expected rejected upgrade'));});ws.on('error',()=>{});});}

test('unconfigured gateway exposes no computer transport or fake AI return',async()=>{
 const gateway=new ComputerGateway({dbPath:':memory:'});assert.equal(gateway.snapshot().configured,false);assert.deepEqual(gateway.snapshot().capabilities,{preview:false,humanControl:false,aiControl:false});assert.throws(()=>gateway.preview('http://127.0.0.1:3000'),ComputerGatewayError);await gateway.close();
 assert.throws(()=>new ComputerGateway({dbPath:':memory:',previewPort:5900,controlPort:5900,previewReadOnlyEnforced:true}),/distinct/);
 assert.throws(()=>new ComputerGateway({dbPath:':memory:',previewPort:5900,controlPort:5901}),/read-only/);
});

test('preview and human control connect to separate fixed endpoints with protocol tickets, never URL tokens',async t=>{
 const {gateway:g,origin,received}=await fixture(t);const preview=g.preview(origin);assert.equal(new URL(preview.connection.url).search,'');assert.equal(preview.connection.viewOnly,true);
 const p=await open(preview.connection,origin);p.send(Buffer.from('preview-protocol-data'));await eventually(()=>received.preview.length>0);assert.deepEqual(received.control,[]);
 const human=await g.takeover(g.snapshot().state!.epoch,origin);const c=await open(human.connection,origin);c.send(Buffer.from('human-input'));await eventually(()=>received.control.join('').includes('human-input'));assert.equal(human.connection.viewOnly,false);
 p.close();c.close();await eventually(()=>g.snapshot().state!.owner==='paused');
});

test('websocket upgrades reject foreign origin, token replay, query credentials and expired tickets',async t=>{
 const {gateway:g,origin,tick}=await fixture(t);const foreign=g.preview(origin);assert.equal(await rejected(foreign.connection,'https://evil.example'),403);
 const p=await open(foreign.connection,origin);assert.equal(await rejected(foreign.connection,origin),403);p.close();
 const query=g.preview(origin);assert.equal(await rejected({...query.connection,url:query.connection.url+'?token=forbidden'},origin),404);
 const expired=g.preview(origin);tick(16_000);assert.equal(await rejected(expired.connection,origin),403);
});

test('unauthenticated legacy localhost tickets keep their own exact Origin',async t=>{
 const f=await fixture(t),alias=f.origin.replace('127.0.0.1','localhost'),ticket=f.gateway.preview(alias);
 assert.equal(ticket.connection.url,alias.replace('http:','ws:')+'/api/computer/stream');
 const ws=await new Promise<WebSocket>((resolve,reject)=>{const ws=new WebSocket(f.origin.replace('http:','ws:')+'/api/computer/stream',ticket.connection.protocols,{origin:alias,headers:{host:new URL(alias).host}});ws.once('error',reject);ws.once('open',()=>resolve(ws));});ws.close();
});

test('takeover revokes previous sockets/tickets; disconnect pauses without returning AI authority',async t=>{
 const {gateway:g,origin,received}=await fixture(t);const first=await g.takeover(0,origin);const ws=await open(first.connection,origin);ws.send(Buffer.from('before-fence'));await eventually(()=>received.control.length>0);
 const second=await g.takeover(first.state.epoch,origin);await eventually(()=>ws.readyState===WebSocket.CLOSED);assert.ok(second.state.epoch>first.state.epoch);assert.equal(g.snapshot().state!.owner,'human');
 await assert.rejects(g.takeover(first.state.epoch,origin),/changed/);assert.equal(await rejected(first.connection,origin),403);
 const current=await open(second.connection,origin);current.close();await eventually(()=>g.snapshot().state!.owner==='paused');assert.equal(g.snapshot().capabilities.aiControl,false);
});

test('lease expiration gates writes immediately even before periodic cleanup',async t=>{
 const {gateway:g,origin,received,tick}=await fixture(t);const human=await g.takeover(0,origin);const ws=await open(human.connection,origin);tick(31_000);ws.send(Buffer.from('must-not-pass'));await eventually(()=>ws.readyState===WebSocket.CLOSED);assert.ok(!received.control.join('').includes('must-not-pass'));assert.throws(()=>g.renew(human.state.epoch));
});

test('return to AI is disabled without trusted capture; injected fresh observation remains backend-only',async t=>{
 const {gateway:g,origin}=await fixture(t);const human=await g.takeover(0,origin);await assert.rejects(g.returnToAi(human.state.epoch),/trusted fresh/);assert.equal(g.snapshot().state!.owner,'human');
 const enabled=await fixture(t,true);const takeover=await enabled.gateway.takeover(0,enabled.origin);const ai=await enabled.gateway.returnToAi(takeover.state.epoch);assert.equal(ai.state.owner,'ai');assert.equal(ai.state.observationId,'trusted-fixture-observation');assert.equal(await enabled.gateway.performAi(ai.state.epoch,async()=>42),42);
 const next=await enabled.gateway.takeover(ai.state.epoch,enabled.origin);await assert.rejects(enabled.gateway.performAi(ai.state.epoch,async()=>{throw Error('must not run');}),/revoked/);assert.equal(next.state.owner,'human');
});

test('uncertain physical effect requires explicit return acknowledgment and remains visible', async t => {
 const {gateway:g,origin}=await fixture(t,true);
 const ai=await g.returnToAi(0);
 await assert.rejects(g.performAi(ai.state.epoch,async()=>{throw Error('external receipt lost');}));
 const human=await g.takeover(g.snapshot().state!.epoch,origin);
 await assert.rejects(g.returnToAi(human.state.epoch),/unconfirmed outcome/);
 assert.equal(g.snapshot().state!.owner,'human');assert.equal(g.snapshot().state!.epoch,human.state.epoch);
 const returned=await g.returnToAi(human.state.epoch,true);
 assert.equal(returned.state.owner,'ai');assert.equal(returned.state.uncertainty,true);
});

test('trusted AI renewal cannot grant ownership, revive expiry or cross a takeover epoch', async t => {
 const {gateway:g,origin,tick}=await fixture(t,true);
 assert.throws(()=>g.renewAi(0));
 const ai=await g.returnToAi(0);tick(10000);
 const renewed=g.renewAi(ai.state.epoch);assert.equal(renewed.state.epoch,ai.state.epoch);
 const human=await g.takeover(ai.state.epoch,origin);assert.throws(()=>g.renewAi(ai.state.epoch));assert.throws(()=>g.renewAi(human.state.epoch));
 const next=await g.returnToAi(human.state.epoch);tick(31000);assert.throws(()=>g.renewAi(next.state.epoch));
});

test('return rechecks uncertainty raised while waiting for an in-flight action', async t => {
 const {gateway:g}=await fixture(t,true); const ai=await g.returnToAi(0);
 let rejectAction!:(error:Error)=>void;
 const action=g.performAi(ai.state.epoch,()=>new Promise<void>((_resolve,reject)=>{rejectAction=reject;}));
 const rejectedAction=assert.rejects(action,/late effect failure/);
 const transfer=g.returnToAi(ai.state.epoch);
 rejectAction(new Error('late effect failure'));
 await rejectedAction;await assert.rejects(transfer,/became unconfirmed/);
 assert.equal(g.snapshot().state!.owner,'paused');assert.equal(g.snapshot().state!.uncertainty,true);
});

test('trusted crash recovery can persist uncertainty without inventing a physical action', async t => {
 const {gateway:g}=await fixture(t,true); const before=g.snapshot().state!;
 const paused=g.pauseTrusted(true);
 assert.equal(paused.state.owner,'paused');assert.equal(paused.state.uncertainty,true);assert.ok(paused.state.epoch>before.epoch);
 assert.equal(g.pauseTrusted(false).state.uncertainty,true);
 await assert.rejects(g.returnToAi(g.snapshot().state!.epoch),/unconfirmed outcome/);
});

test('late worker uncertainty does not revoke a newer human epoch', async t => {
 const {gateway:g,origin}=await fixture(t,true); const ai=await g.returnToAi(0);
 const human=await g.takeover(ai.state.epoch,origin);
 const late=g.pauseTrusted(true,ai.state.epoch);
 assert.equal(late.state.owner,'human');assert.equal(late.state.epoch,human.state.epoch);assert.equal(late.state.uncertainty,true);
 const disconnected=g.pauseTrusted(false,ai.state.epoch);assert.equal(disconnected.state.owner,'human');
});

test('late human server startup cannot mint a stale ticket or tear down a newer lease', async t => {
 let ready!:(handle:{id:string})=>void;const abandoned:string[]=[];let starts=0;
 const {gateway:g,origin}=await fixture(t,true,{prepareHumanControl:async()=>{starts++;if(starts===1)return new Promise(r=>{ready=r;});return {id:'new-server'};},abandonHumanControl:async h=>{abandoned.push(h.id);}});
 const first=g.takeover(0,origin);await eventually(()=>Boolean(ready));
 const second=await g.takeover(g.snapshot().state!.epoch,origin);
 ready({id:'old-server'});await assert.rejects(first,/not confirmed/);
 assert.deepEqual(abandoned,['old-server']);assert.equal(g.snapshot().state!.owner,'human');assert.equal(g.snapshot().state!.epoch,second.state.epoch);
});
test('failed native handoff fence preserves uncertainty and does not grant AI', async t => {
 const {gateway:g,origin}=await fixture(t,false,{captureSettledObservation:async()=>{throw Error('fixed fixture fence failure');}});
 const human=await g.takeover(0,origin);await assert.rejects(g.returnToAi(human.state.epoch));
 assert.equal(g.snapshot().state!.owner,'paused');assert.equal(g.snapshot().state!.uncertainty,true);
});

test('owned human server reports discovered held-input repair without revoking takeover',async t=>{
 const {gateway:g,origin}=await fixture(t,true,{prepareHumanControl:async()=>({id:'owned-human',uncertainty:true}),abandonHumanControl:async()=>{}});
 const human=await g.takeover(0,origin);assert.equal(human.state.owner,'human');assert.equal(human.state.uncertainty,true);
 await assert.rejects(g.returnToAi(human.state.epoch),/unconfirmed outcome/);
 assert.equal(g.snapshot().state!.owner,'human');
});
