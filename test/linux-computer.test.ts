import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { configuredLinuxComputer, browserLifetime } from '../src/linux-computer.ts';

test('browser lifecycle proof identifies the exact supervised process without inspecting arguments',async()=>{
 assert.throws(()=>browserLifetime(-1),/browser_pid_invalid/);
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 const current=browserLifetime(child.pid!);current();
 child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
 assert.throws(current,/desktop_browser_unavailable/);
});
test('explicit Linux launcher reads no key or desktop on construction and has no fake driver fallback',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opendots-linux-launch-'));const path=join(dir,'computer.json');
 const config={version:1,dedicatedNode:true,previewReadOnlyEnforced:true,credentialsPath:join(dir,'not-present.json'),nodeId:'node',targetId:'desktop',policyDigest:'policy',workerId:'worker',display:':99',xauthority:'/tmp/opendots-test.Xauthority',browserPid:process.pid,browserInstanceId:'browser-test-instance',previewPort:5901,controlPort:5902,reviewedX11vncSha256:'a'.repeat(64)};
 writeFileSync(path,JSON.stringify(config),{mode:0o600});
 try{
  const wired=configuredLinuxComputer(path,'http://127.0.0.1:3000');
  assert.equal(wired.computer.previewReadOnlyEnforced,true);assert.equal(wired.computer.previewPort,5901);
  assert.throws(()=>wired.computerHost.driver.display(),/desktop_not_ready/);
  await assert.rejects(wired.computerHost.prepare!({nodeId:'node',targetId:'desktop',policyDigest:'policy',principalId:'p',agentId:'a',contextId:'c',sessionId:'s'}));
  assert.throws(()=>wired.computerHost.driver.display(),/desktop_not_ready/);
  await wired.computer.closeHumanControl!();
  await assert.rejects(wired.computer.prepareHumanControl!(1),/desktop_closed/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
