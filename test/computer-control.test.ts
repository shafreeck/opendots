import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ComputerControl,ControlConflict } from '../src/computer-control.ts';
function setup(t:any){const dir=mkdtempSync(join(tmpdir(),'opendots-control-'));let now=100;const path=join(dir,'state.db');const control=new ComputerControl(path,()=>now);t.after(()=>{control.close();rmSync(dir,{recursive:true,force:true});});return {control,path,tick:(v:number)=>{now=v;}};}
test('computer starts paused and AI return requires fresh observation',async t=>{
 const {control:c}=setup(t);const s=c.createSession('desk');assert.equal(s.owner,'paused');
 await assert.rejects(c.returnToAi('desk',async()=>({id:'stale',capturedAt:99})),ControlConflict);
 const ai=await c.returnToAi('desk',async()=>({id:'fresh',capturedAt:100}));assert.equal(ai.owner,'ai');assert.equal(ai.observationId,'fresh');
 assert.equal(await c.perform({sessionId:'desk',owner:'ai',epoch:ai.epoch},async()=>42),42);
});
test('takeover revokes queued AI authority before waiting for current action',async t=>{
 const {control:c}=setup(t);c.createSession('desk');const ai=await c.returnToAi('desk',async()=>({id:'fresh',capturedAt:100}));
 const lease={sessionId:'desk',owner:'ai' as const,epoch:ai.epoch};let finish!:()=>void;
 const running=c.perform(lease,()=>new Promise<void>(resolve=>{finish=resolve;}));
 let granted=false;const transfer=c.takeover('desk').then(s=>{granted=true;return s;});
 assert.equal(c.state('desk').owner,'transition');assert.equal(granted,false);
 await assert.rejects(c.perform(lease,async()=>{throw Error('must not run');}),ControlConflict);
 finish();await running;const human=await transfer;assert.equal(human.owner,'human');assert.ok(human.epoch>ai.epoch);
});
test('disconnect during transfer pauses and never auto resumes',async t=>{
 const {control:c}=setup(t);c.createSession('desk');let captured!:()=>void;
 const transfer=c.returnToAi('desk',()=>new Promise(resolve=>{captured=()=>resolve({id:'snap',capturedAt:100});}));
 c.pause('desk');captured();await assert.rejects(transfer,ControlConflict);assert.equal(c.state('desk').owner,'paused');
});
test('expired control lease blocks all physical actions',async t=>{
 const {control:c,tick}=setup(t);c.createSession('desk');const human=await c.takeover('desk');tick(40_000);
 await assert.rejects(c.perform({sessionId:'desk',owner:'human',epoch:human.epoch},async()=>1),ControlConflict);
 assert.throws(()=>c.renew({sessionId:'desk',owner:'human',epoch:human.epoch}),ControlConflict);
});
test('uncertain action is visible after takeover, not reported undone',async t=>{
 const {control:c}=setup(t);c.createSession('desk');const ai=await c.returnToAi('desk',async()=>({id:'snap',capturedAt:100}));
 await assert.rejects(c.perform({sessionId:'desk',owner:'ai',epoch:ai.epoch},async()=>{throw Error('reply lost');}));
 const s=await c.takeover('desk');assert.equal(s.uncertainty,true);assert.ok(c.audit('desk').some((x:any)=>x.event==='action.uncertain'));
});
test('reopening storage revokes previous owner and raises epoch',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opendots-reopen-'));const path=join(dir,'control.db');
 const a=new ComputerControl(path);a.createSession('desk');const old=await a.takeover('desk');a.close();
 const b=new ComputerControl(path);try{const current=b.state('desk');assert.equal(current.owner,'paused');assert.ok(current.epoch>old.epoch);}finally{b.close();rmSync(dir,{recursive:true,force:true});}
});
