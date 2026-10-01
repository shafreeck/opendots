import { ConnectorError, checkConnector, connectorBinding, connectorGet, connectorId, connectorJson, connectorRecord, type ConnectorBinding, type ConnectorInvocation } from './connector-types.ts';

export interface NativeHostAuthorityOptions {
  toolName: 'host_opendots_connectors' | 'host_opendots_calendar' | 'host_opendots_documents';
  baseUrl: string; binding: ConnectorBinding; operatorToken?: string; fetch?: typeof fetch; timeoutMs?: number;
}
/** Operator-only local client: Thread detail is not a gateway-Principal endpoint.
 * Fixed GETs only. No provider/SecretStore endpoints, raw responses, or mutations. */
export interface NativeHostEnvelope { protocol:1; tool:string; invocation:ConnectorInvocation; arguments:object }
export interface NativeDocumentProvenance {
  sessionId:string; principalId:string; agentId:string; contextId:string;
  jobId:string; callId:string; threadId:string; activationId:string; rootTurnId:string;
  threadGeneration:number; objectiveId:string|null; objectiveGeneration:number|null;
}
export class NativeHostAuthority {
  private toolName: NativeHostAuthorityOptions['toolName'];
  readonly binding: Readonly<ConnectorBinding>;
  private base: string; private headers: Headers; private fetcher: typeof fetch; private timeout: number;
  constructor(options: NativeHostAuthorityOptions) {
    checkConnector(['host_opendots_connectors','host_opendots_calendar','host_opendots_documents'].includes(options.toolName),'host_tool_not_allowed'); this.toolName=options.toolName;
    this.binding = connectorBinding(options.binding);
    let url: URL; try { url = new URL(options.baseUrl); } catch { throw new ConnectorError('connector_runtime_origin_invalid'); }
    checkConnector(['http:','https:'].includes(url.protocol) && ['127.0.0.1','localhost','[::1]'].includes(url.hostname) && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash, 'connector_runtime_origin_invalid');
    this.base = url.origin; this.fetcher = options.fetch ?? fetch; this.timeout = options.timeoutMs ?? 5_000;
    checkConnector(Number.isInteger(this.timeout) && this.timeout >= 10 && this.timeout <= 10_000, 'connector_timeout_invalid');
    this.headers = new Headers({ accept: 'application/json' });
    if (options.operatorToken !== undefined) { checkConnector(/^[\x21-\x7e]{1,4096}$/.test(options.operatorToken), 'connector_token_invalid'); this.headers.set('authorization', `Bearer ${options.operatorToken}`); }
  }
  private get(path: string, signal?: AbortSignal) { return connectorGet(this.fetcher, this.base + path, this.headers, AbortSignal.any([AbortSignal.timeout(this.timeout), ...(signal ? [signal] : [])])); }
  async verifyBinding(signal?: AbortSignal): Promise<void> {
    const b = this.binding;
    const [session, principal] = await Promise.all([this.get(`/api/sessions/${encodeURIComponent(b.sessionId)}`, signal), this.get(`/api/sessions/${encodeURIComponent(b.sessionId)}/principal`, signal)]);
    this.checkBinding(session, principal);
  }
  private checkBinding(session: unknown, principal: unknown) {
    const b = this.binding, s = connectorRecord(session), p = connectorRecord(principal);
    checkConnector(s.id === b.sessionId && s.agent_id === b.agentId && s.context_id === b.contextId && p.session_id === b.sessionId && p.context_id === b.contextId && p.principal_id === b.principalId, 'connector_scope_denied', 403);
  }
  async catalogue(signal?: AbortSignal) {
    const value = connectorRecord(await this.get('/api/execution-targets', signal));
    checkConnector(Array.isArray(value.targets) && value.targets.length <= 2_000, 'connector_native_catalogue_invalid', 502);
    const targets = value.targets.map(raw => {
      const t = connectorRecord(raw);
      checkConnector(connectorId(t.id) && Number.isSafeInteger(t.revision) && Number(t.revision) >= 0 && typeof t.kind === 'string' && ['in_process_local','edge_node','managed_ssh','managed_cloud_worker'].includes(t.kind) && ['online','offline','disabled'].includes(String(t.status)), 'connector_native_catalogue_invalid', 502);
      checkConnector(Array.isArray(t.capabilities) && t.capabilities.length <= 256 && t.capabilities.every(connectorId), 'connector_native_catalogue_invalid', 502);
      return { id: t.id, revision: t.revision as number, kind: t.kind, status: t.status as string, capabilities: [...new Set(t.capabilities as string[])].sort() };
    });
    return { source: 'morphz_execution_targets' as const, evidence: 'declared_capabilities_only' as const, connectionVerified: false as const, schemasAvailable: false as const, targets };
  }
  /** Live callback provenance is checked again before dispatch and every receipt replay.
   * Product user policy remains a separate mandatory host authorization callback. */
  async verifyInvocation(envelope: NativeHostEnvelope, replay: boolean, signal?: AbortSignal): Promise<void> {
    await this.verifyEvidence(envelope,replay,signal);
  }
  private async verifyEvidence(envelope:NativeHostEnvelope,replay:boolean,signal?:AbortSignal) {
    const i = envelope.invocation, b = this.binding;
    checkConnector(i.principal_id === b.principalId && i.agent_id === b.agentId && i.context_id === b.contextId && i.session_id === b.sessionId && i.target_id === 'target-default', 'connector_scope_denied', 403);
    const [rawJob, rawThread, rawSession, rawPrincipal] = await Promise.all([
      this.get(`/api/execution-jobs/${encodeURIComponent(i.job_id)}`, signal),
      this.get(`/api/contexts/${encodeURIComponent(b.contextId)}/threads/${encodeURIComponent(i.thread_id)}`, signal),
      this.get(`/api/sessions/${encodeURIComponent(b.sessionId)}`, signal),
      this.get(`/api/sessions/${encodeURIComponent(b.sessionId)}/principal`, signal),
    ]);
    const j = connectorRecord(rawJob), snapshot = connectorRecord(connectorRecord(rawThread).snapshot), t = connectorRecord(snapshot.thread);
    this.checkBinding(rawSession, rawPrincipal);
    checkConnector(j.id === i.job_id && j.tool_name === this.toolName && envelope.tool === this.toolName && j.tool_call_id === i.tool_call_id && j.thread_id === i.thread_id && j.target_id === i.target_id && j.initiating_principal_id === i.principal_id && j.agent_id === i.agent_id && j.context_id === i.context_id && j.session_id === i.session_id, 'connector_job_mismatch', 403);
    checkConnector(t.id === i.thread_id && t.agent_id === i.agent_id && t.context_id === i.context_id && t.session_id === i.session_id && t.initiating_principal_id === i.principal_id && t.target_id === i.target_id, 'connector_thread_mismatch', 403);
    const request = { ...connectorRecord(j.request) };
    const route = connectorRecord(request._morphz_execution_route);
    checkConnector(route.target_id === i.target_id && route.backend_kind === 'in_process_local', 'connector_route_mismatch', 403);
    // Source-pinned Runtime-only additions; never broadly discard arbitrary _morphz* fields.
    for (const key of ['_morphz_execution_route','_morphz_action_group_id','_morphz_wake_thread','_morphz_capability_lease_objective_id']) delete request[key];
    checkConnector(connectorJson(request) === connectorJson(envelope.arguments), 'connector_arguments_mismatch', 403);
    if (!replay) checkConnector(j.status === 'running' && j.cancel_requested_at == null && t.lifecycle === 'open' && t.control_state === 'active', 'connector_execution_inactive', 409);
    return {j,t,snapshot};
  }
  /** Exact Job -> Activation -> Thread proof, sourced only from fixed native GETs.
   * Missing Objective supervision is represented as null, never inferred from a
   * latest task, model argument, neighboring activation, or product document. */
  async verifyDocumentInvocation(envelope:NativeHostEnvelope,replay:boolean,signal?:AbortSignal):Promise<NativeDocumentProvenance> {
    checkConnector(this.toolName==='host_opendots_documents','host_tool_not_allowed');
    const {j,t,snapshot}=await this.verifyEvidence(envelope,replay,signal),i=envelope.invocation;
    const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=1;
    checkConnector(connectorId(j.activation_id)&&connectorId(t.root_turn_id)&&positive(t.generation)&&Array.isArray(snapshot.activations)&&snapshot.activations.length<=2000,'connector_provenance_invalid',502);
    const candidates=snapshot.activations.map(connectorRecord).filter(s=>connectorRecord(s.activation).id===j.activation_id);
    checkConnector(candidates.length===1,'connector_activation_mismatch',403);
    const candidate=candidates[0]!,a=connectorRecord(candidate.activation);
    checkConnector(a.root_turn_id===t.root_turn_id&&a.session_id===i.session_id&&a.agent_id===i.agent_id&&a.context_id===i.context_id&&a.initiating_principal_id===i.principal_id&&positive(a.generation)&&Number(a.generation)<=Number(t.generation),'connector_activation_mismatch',403);
    checkConnector(Array.isArray(candidate.jobs)&&candidate.jobs.length<=2000,'connector_provenance_invalid',502);
    const jobs=candidate.jobs.map(connectorRecord).map(s=>connectorRecord(s.job)).filter(job=>job.id===j.id);
    checkConnector(jobs.length===1&&['id','activation_id','thread_id','agent_id','context_id','session_id','initiating_principal_id','target_id','tool_call_id','tool_name'].every(k=>jobs[0]![k]===j[k])&&connectorJson(jobs[0]!.request)===connectorJson(j.request),'connector_job_mismatch',403);
    if(!replay)checkConnector(a.generation===t.generation&&a.status==='running','connector_execution_inactive',409);
    let objectiveId:string|null=null,objectiveGeneration:number|null=null;
    if(t.supervision!==undefined&&t.supervision!==null){
      const supervision=connectorRecord(t.supervision);
      if(supervision.supervisor_kind==='objective'){
        checkConnector(connectorId(supervision.supervisor_id)&&positive(supervision.generation),'connector_provenance_invalid',502);
        const scheduler=connectorRecord(await this.get(`/api/contexts/${encodeURIComponent(i.context_id)}/scheduler?include_terminal=true&limit=2000`,signal));
        checkConnector(scheduler.context_id===i.context_id&&Array.isArray(scheduler.objectives)&&scheduler.objectives.length<=2000,'connector_provenance_invalid',502);
        const objectives=scheduler.objectives.map(connectorRecord).map(s=>connectorRecord(s.objective)).filter(o=>o.id===supervision.supervisor_id);
        checkConnector(objectives.length===1,'connector_objective_mismatch',403);const objective=objectives[0]!;
        checkConnector(objective.id===supervision.supervisor_id&&objective.agent_id===i.agent_id&&objective.context_id===i.context_id&&objective.coordinator_session_id===i.session_id&&objective.initiating_principal_id===i.principal_id&&positive(objective.generation)&&Number(objective.generation)>=Number(supervision.generation),'connector_objective_mismatch',403);
        if(!replay)checkConnector(objective.generation===supervision.generation&&objective.status==='active','connector_execution_inactive',409);
        objectiveId=supervision.supervisor_id;objectiveGeneration=Number(supervision.generation);
      }
    }
    checkConnector(!signal?.aborted,'connector_request_aborted',503);
    return {sessionId:i.session_id,principalId:i.principal_id,agentId:i.agent_id,contextId:i.context_id,jobId:i.job_id,callId:i.tool_call_id,threadId:i.thread_id,activationId:j.activation_id,rootTurnId:t.root_turn_id,threadGeneration:Number(a.generation),objectiveId,objectiveGeneration};
  }
}
