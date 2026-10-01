import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readComputerConfig, loadComputerConfig, type LoadedComputerConfig } from './computer-config.ts';
import { ComputerEdgeClient } from './computer-edge-client.ts';
import { LinuxDesktopDriver, LinuxDesktopError } from './linux-desktop.ts';
import { HumanVncLifecycle, SpawnHumanVncExecutor, type HumanVncHandle } from './linux-desktop-vnc.ts';
import type { ComputerGatewayOptions } from './computer-gateway.ts';
import type { ComputerHostOptions } from './computer-host.ts';
import type { ComputerEdgeDriver } from './computer-edge-types.ts';

/** Process start time, not merely a recyclable PID. Only an operator's explicit
 * browser PID is read; no process inventory or command-line/secret discovery. */
export function browserLifetime(pid:number) {
  if(!Number.isSafeInteger(pid)||pid<2||pid>0x7fffffff)throw new LinuxDesktopError('browser_pid_invalid');
  const read=()=>{try{const stat=readFileSync(`/proc/${pid}/stat`,'utf8');const end=stat.lastIndexOf(')');const fields=stat.slice(end+2).trim().split(/\s+/);if(end<0||!/^\d+$/.test(fields[19]??'')||['Z','X'].includes(fields[0]))throw Error();return fields[19];}catch{throw new LinuxDesktopError('desktop_browser_unavailable');}};
  const birth=read();return ()=>{if(read()!==birth)throw new LinuxDesktopError('desktop_browser_replaced');};
}

/** Explicit Linux-only launcher wiring. No device pairing, key generation, daemon
 * restart, host-network change or default full-access configuration occurs here.
 * The existing same-display PREVIEW must already be server-enforced read-only.
 */
export function configuredLinuxComputer(configPath:string,runtimeOrigin:string):{
  computer:Omit<ComputerGatewayOptions,'dbPath'>;computerHost:ComputerHostOptions;
} {
  if(process.platform!=='linux')throw new LinuxDesktopError('linux_desktop_required');
  const config=readComputerConfig(configPath);
  let loaded:LoadedComputerConfig|undefined,driver:LinuxDesktopDriver|undefined,lifecycle:HumanVncLifecycle|undefined;
  let serverHandle:HumanVncHandle|undefined,logicalLease:string|undefined,closed=false;
  let queue:Promise<unknown>=Promise.resolve();
  const nativeVnc=new SpawnHumanVncExecutor();
  const serial=<T>(operation:()=>Promise<T>)=>{const result=queue.then(operation);queue=result.catch(()=>{});return result;};
  const ready=()=>{if(closed||!driver||!lifecycle)throw new LinuxDesktopError('desktop_not_ready');return {driver,lifecycle};};
  let preparing:Promise<void>|undefined;
  const ensureDesktop=async()=>{
    if(closed)throw new LinuxDesktopError('desktop_closed');
    if(!driver||!lifecycle){
      preparing??=(async()=>{
        await nativeVnc.verify({version:'0.9.16',sha256:config.reviewedX11vncSha256});
        const assertBrowserCurrent=browserLifetime(config.browserPid);
        const connected=await LinuxDesktopDriver.connect({display:config.display,xauthority:config.xauthority,browserInstanceId:config.browserInstanceId,assertBrowserCurrent});
        if(closed)throw new LinuxDesktopError('desktop_closed');
        driver=connected;
        lifecycle=new HumanVncLifecycle({driver,display:config.display,previewDisplay:config.display,xauthority:config.xauthority,controlPort:config.controlPort,reviewedBuild:{version:'0.9.16',sha256:config.reviewedX11vncSha256},executor:nativeVnc});
      })().finally(()=>{preparing=undefined;});
      await preparing;
    }
    return ready();
  };
  const proxy:ComputerEdgeDriver={display:()=>ready().driver.display(),capture:context=>ready().driver.capture(context),act:(action,context)=>ready().driver.act(action,context)};
  return {
    computer:{previewPort:config.previewPort,controlPort:config.controlPort,previewReadOnlyEnforced:config.previewReadOnlyEnforced,
      prepareHumanControl:async()=>serial(async()=>{
        const current=await ensureDesktop();
        if(current.lifecycle.state().status!=='running')serverHandle=await current.lifecycle.start({repair:current.lifecycle.state().status==='paused'});
        if(!serverHandle)throw new LinuxDesktopError('human_vnc_handle_unavailable');
        logicalLease=randomUUID();return {id:logicalLease,uncertainty:current.lifecycle.state().uncertainty};
      }),
      abandonHumanControl:handle=>serial(async()=>{
        if(logicalLease!==handle.id)return;logicalLease=undefined;
        const current=ready();
        if(!serverHandle)return;
        try{await current.lifecycle.stopAndFence(serverHandle);}catch(error){await current.lifecycle.close();throw error;}finally{serverHandle=undefined;}
      }),
      captureSettledObservation:(_session,context)=>serial(async()=>{
        const current=ready();logicalLease=undefined;
        let capture;
        if(serverHandle&&current.lifecycle.state().status==='running'){
          capture=(await current.lifecycle.stopAndFence(serverHandle,{acknowledgeUncertainty:context.acknowledgeUncertainty})).capture;
          serverHandle=undefined;
        }else{
          // Never infer an orphaned/unmanaged VNC input server has drained.
          if(current.lifecycle.state().status!=='stopped'||!await nativeVnc.portUnused(config.controlPort))throw new LinuxDesktopError('human_vnc_fence_unavailable');
          capture=context.acknowledgeUncertainty?await current.driver.acknowledgeRepair(true):await current.driver.inspectAndCaptureUnheld();
        }
        return {id:capture.observationId,capturedAt:capture.capturedAt};
      }),
      closeHumanControl:()=>serial(async()=>{closed=true;logicalLease=undefined;try{await lifecycle?.close();}finally{loaded?.close();loaded=undefined;serverHandle=undefined;}}),
    },
    computerHost:{nodeId:config.nodeId,targetId:config.targetId,policyDigest:config.policyDigest,workerId:config.workerId,driver:proxy,
      prepare:async binding=>{
        if(closed)throw new LinuxDesktopError('desktop_closed');
        loaded=loadComputerConfig({configPath,expectedConfig:config,runtimeOrigin,identity:{principalId:binding.principalId,agentId:binding.agentId,contextId:binding.contextId,sessionId:binding.sessionId}});
        if(JSON.stringify(loaded.binding)!==JSON.stringify({...loaded.binding,...binding}))throw new LinuxDesktopError('desktop_binding_changed');
        await ensureDesktop();
        if(closed){loaded.close();throw new LinuxDesktopError('desktop_closed');}
      },
      transport:binding=>{
        const identity=loaded;if(!identity||closed)throw new LinuxDesktopError('desktop_not_ready');
        return new ComputerEdgeClient({baseUrl:identity.runtimeOrigin,binding,workerId:config.workerId,signConnectionProof:proof=>identity.signConnectionProof(proof)});
      },
    },
  };
}
