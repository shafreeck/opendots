import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ComputerHost } from '../src/computer-host.ts';
import { ComputerGateway } from '../src/computer-gateway.ts';
import type { RuntimeService } from '../src/runtime-service.ts';
import type { ComputerEdgeTransport, ComputerEdgeBinding } from '../src/computer-edge-types.ts';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3sAAAAASUVORK5CYII=','base64');
async function eventually(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Fixture condition not reached');}
test('opt-in computer host derives exact Runtime identity and never grants AI ownership on reconnect',async()=>{
 const db=new DatabaseSync(':memory:');let checks=0,heartbeats=0,claims=0,stopped=false,received:ComputerEdgeBinding|undefined;
 const runtime={verifiedIdentity:async()=>{checks++;},store:{db,binding:()=>({principalId:'p',agentId:'a',contextId:'c',sessionId:'s'})}} as unknown as RuntimeService;
 const gateway=new ComputerGateway({dbPath:':memory:',previewPort:55001,controlPort:55002,previewReadOnlyEnforced:true,captureSettledObservation:async()=>({id:'synthetic-capture',capturedAt:Date.now()})});
 const transport:ComputerEdgeTransport={heartbeatNode:async()=>{heartbeats++;},claim:async()=>{claims++;return null;},heartbeat:async c=>c,finish:async()=>{throw Error('No synthetic job');},close:()=>{stopped=true;}};
 const host=new ComputerHost(runtime,gateway,{nodeId:'n',targetId:'desktop',policyDigest:'policy',workerId:'worker',driver:{display:()=>({id:'display',width:1,height:1}),capture:async()=>({id:'display',width:1,height:1,png,capturedAt:Date.now()}),act:async()=>assert.fail('No physical job authorized')},transport:b=>{received=b;return transport;}});
 try{assert.equal(heartbeats,0);host.start();await eventually(()=>host.snapshot().status==='ready');assert.deepEqual(received,{nodeId:'n',targetId:'desktop',policyDigest:'policy',principalId:'p',agentId:'a',contextId:'c',sessionId:'s'});assert.ok(checks>0);assert.ok(heartbeats>0);assert.equal(gateway.snapshot().state!.owner,'paused');assert.equal(host.approvals!.pendingCount(),0);assert.ok(claims<10,'Empty claims must not busy-spin');}
 finally{await host.close();await gateway.close();db.close();}
 assert.equal(stopped,true);assert.equal(host.snapshot().status,'closed');
});
test('native identity or driver preparation failure leaves chat store open and computer unavailable',async()=>{
 const db=new DatabaseSync(':memory:');let prepared=false;
 const runtime={verifiedIdentity:async()=>{throw Error('private authority diagnostic');},store:{db,binding:()=>undefined}} as unknown as RuntimeService;
 const gateway=new ComputerGateway({dbPath:':memory:'});
 const host=new ComputerHost(runtime,gateway,{nodeId:'n',targetId:'desktop',policyDigest:'policy',workerId:'worker',prepare:async()=>{prepared=true;},driver:{display:()=>{throw Error();},capture:async()=>{throw Error();},act:async()=>{throw Error();}},transport:()=>{throw Error('must not connect');}});
 host.start();await eventually(()=>host.snapshot().status==='unavailable');assert.equal(prepared,false);assert.ok(!host.snapshot().message.includes('private authority'));assert.equal(db.prepare('SELECT 1 AS n').get()!.n,1);await host.close();await gateway.close();db.close();
});

test('shutdown during desktop preparation cannot create a late connection or permission store',async()=>{
 const db=new DatabaseSync(':memory:');let entered=false,release!:()=>void,connections=0;
 const runtime={verifiedIdentity:async()=>{},store:{db,binding:()=>({principalId:'p',agentId:'a',contextId:'c',sessionId:'s'})}} as unknown as RuntimeService;
 const gateway=new ComputerGateway({dbPath:':memory:'});
 const host=new ComputerHost(runtime,gateway,{nodeId:'n',targetId:'desktop',policyDigest:'policy',workerId:'worker',prepare:()=>{entered=true;return new Promise<void>(r=>{release=r;});},driver:{display:()=>({id:'display',width:1,height:1}),capture:async()=>{throw Error();},act:async()=>{throw Error();}},transport:()=>{connections++;throw Error('must not connect');}});
 host.start();await eventually(()=>entered);const closed=host.close();release();await closed;
 assert.equal(connections,0);assert.equal(host.approvals,undefined);assert.equal(host.snapshot().status,'closed');await gateway.close();db.close();
});
test('shutdown aborts a pending native claim without dispatching input or replaying work',async()=>{
 const db=new DatabaseSync(':memory:');let claimed=false,transportClosed=false;
 const runtime={verifiedIdentity:async()=>{},store:{db,binding:()=>({principalId:'p',agentId:'a',contextId:'c',sessionId:'s'})}} as unknown as RuntimeService;
 const gateway=new ComputerGateway({dbPath:':memory:',previewPort:55003,controlPort:55004,previewReadOnlyEnforced:true,captureSettledObservation:async()=>({id:'capture',capturedAt:Date.now()})});
 const host=new ComputerHost(runtime,gateway,{nodeId:'n',targetId:'desktop',policyDigest:'policy',workerId:'worker',driver:{display:()=>({id:'display',width:1,height:1}),capture:async()=>{throw Error();},act:async()=>assert.fail('No action may execute')},transport:()=>({heartbeatNode:async()=>{},claim:signal=>{claimed=true;return new Promise((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(Error('fixture aborted')),{once:true});});},heartbeat:async c=>c,finish:async()=>{throw Error();},close:()=>{transportClosed=true;}})});
 host.start();await eventually(()=>claimed);await host.close();assert.equal(transportClosed,true);assert.equal(gateway.snapshot().state!.owner,'paused');assert.equal(host.snapshot().status,'closed');await gateway.close();db.close();
});
