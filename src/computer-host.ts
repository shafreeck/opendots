import { ComputerEdgeExecutor } from './computer-edge-executor.ts';
import { ComputerApprovals } from './computer-approvals.ts';
import type { ComputerEdgeBinding, ComputerEdgeDriver, ComputerEdgeTransport } from './computer-edge-types.ts';
import type { ComputerGateway } from './computer-gateway.ts';
import type { RuntimeService } from './runtime-service.ts';

export interface ComputerHostOptions {
  nodeId: string; targetId: string; policyDigest: string; workerId: string;
  driver: ComputerEdgeDriver;
  /** Existing paired node only. No implicit registration/key creation. */
  transport: (binding: ComputerEdgeBinding) => ComputerEdgeTransport;
  prepare?: (binding:ComputerEdgeBinding) => Promise<void>;
}
export interface ComputerHostStatus { status:'disabled'|'connecting'|'ready'|'unavailable'|'closed'; message:string; verification:'configuration_and_transport_only' }
/** Existing fixed assistant identity + exact-action approval + native Edge loop.
 * This host is opt-in. Constructing the ordinary chat app never provisions a device.
 */
export class ComputerHost {
  private options:ComputerHostOptions;
  private runtime:RuntimeService;
  private gateway:ComputerGateway;
  private executor?:ComputerEdgeExecutor;
  private transport?:ComputerEdgeTransport;
  approvals?:ComputerApprovals;
  private loop?:Promise<void>;
  private closed=false;
  private status:ComputerHostStatus={status:'connecting',message:'Verifying the configured desktop and existing paired node',verification:'configuration_and_transport_only'};
  constructor(runtime:RuntimeService,gateway:ComputerGateway,options:ComputerHostOptions){this.runtime=runtime;this.gateway=gateway;this.options=options;}
  snapshot(){return {...this.status};}
  start(){if(this.loop)return;this.loop=this.run();}
  private async run(){
    try{
      await this.runtime.verifiedIdentity();
      if(this.closed)return;
      const saved=this.runtime.store.binding()!;
      const binding:ComputerEdgeBinding={nodeId:this.options.nodeId,targetId:this.options.targetId,policyDigest:this.options.policyDigest,principalId:saved.principalId!,agentId:saved.agentId,contextId:saved.contextId,sessionId:saved.sessionId};
      await this.options.prepare?.(binding);
      if(this.closed)return;
      this.transport=this.options.transport(binding);
      this.approvals=new ComputerApprovals({db:this.runtime.store.db,binding,revalidate:async()=>{await this.runtime.verifiedIdentity();},state:()=>{
        const state=this.gateway.snapshot().state;if(!state)throw Error('Computer unavailable');return state;
      },observation:(id,thread,epoch)=>{if(!this.executor)throw Error('Computer unavailable');return this.executor.approvalObservation(id,thread,epoch);}});
      this.executor=new ComputerEdgeExecutor({db:this.runtime.store.db,binding,workerId:this.options.workerId,transport:this.transport,driver:this.options.driver,
        arbiter:{state:()=>{const state=this.gateway.snapshot().state;if(!state)throw Error('Computer unavailable');return state;},performAi:(epoch,action)=>this.gateway.performAi(epoch,action),renewAi:epoch=>{this.gateway.renewAi(epoch);},pause:(uncertain,epoch)=>{this.gateway.pauseTrusted(uncertain,epoch);}},
        authorize:(scope,request,identity)=>this.approvals!.authorize(scope,request,identity)});
      while(!this.closed){
        const epoch=this.gateway.snapshot().state?.epoch;
        try{
          if(this.gateway.snapshot().state?.owner==='ai')await this.executor.maintainLease(epoch!);else await this.transport.heartbeatNode();
          if(this.closed)break;
          this.status={...this.status,status:'ready',message:'Existing Edge node connected; each physical action requires an exact one-time user approval'};
          const result=await this.executor.runOnce();
          if(!result&&!this.closed)await new Promise(resolve=>setTimeout(resolve,100));
        }catch{
          if(this.closed)break;
          if(epoch!==undefined)this.gateway.pauseTrusted(false,epoch);
          this.status={...this.status,status:'unavailable',message:'Desktop transport is unconfirmed; control is paused and no physical action is replayed'};
          await new Promise(resolve=>setTimeout(resolve,1000));
        }
      }
    }catch{
      if(!this.closed)this.status={...this.status,status:'unavailable',message:'Desktop initialization failed; verify the explicit device configuration. Chat history is retained'};
    }
  }
  async close(){if(this.closed)return;this.closed=true;this.status={...this.status,status:'closed',message:'Desktop worker stopped'};this.approvals?.close();this.transport?.close();await this.executor?.close();await this.loop;}
}
