import { WebSocket } from 'ws';
import { ApplicationStreamProjection } from './runtime-observer.ts';
import type { NativeSchedule } from './reminders.ts';
import type { ObjectiveInputDestination } from './objective-input.ts';
import type { AttachmentStageDeclaration, NativeAttachmentStage } from './attachment-upload.ts';
import { readSse } from './runtime-stream.ts';
/** Server-only transport contract pinned by morphz-source.lock.json.
 * Gateway and local operator authority are deliberately separate adapters.
 * No token, upstream URL, arbitrary Principal or Context reaches the renderer.
 */
export interface TransportOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export interface MorphzOptions extends TransportOptions {
  principalId: string; // A trusted host identity, never browser input.
  serviceToken?: string; // Gateway credential, never operator credentials.
}
export interface IoEvent {
  io_version: '1'; type: string; event_id: string; sequence: number;
  session_id?: string; timestamp?: string;
  message?: { format: { id: string; version: string }; content: { encoding: string; value?: unknown; text?: string } };
  [key: string]: unknown;
}
export interface IoEventPage { subscription: Record<string, unknown>; events: IoEvent[]; cursor: string }
export interface IoReceipt {
  io_version: '1'; status: 'accepted'; accepted: true; message_id: string; event_id: string;
  session_id: string; cursor: string; binding: unknown;
}
export interface IoCapabilities {
  enabled: boolean; io_versions: string[]; encodings: string[];
  formats: Array<{ definition: { id: string; version: string; encodings: string[] }; [key: string]: unknown }>;
  [key: string]: unknown;
}
export interface RuntimeSession { id: string; agent_id: string; context_id: string; status: string; [key: string]: unknown }
export interface RuntimeObjective {
  id: string; agent_id: string; context_id: string; coordinator_session_id: string; delivery_session_id: string;
  stated_objective: string; status: string; revision: number; generation: number;
  status_reason?: string | null; wait_condition?: unknown; created_at?: string; updated_at?: string;
  [key: string]: unknown;
}
export interface RuntimeApproval {
  id: string; revision: number; status: string; action?: unknown; requested?: unknown; justification?: string;
  thread_id?: string; target_id?: string; objective_id?: string | null; requested_scope?: string; available_scopes?: string[];
  [key: string]: unknown;
}
export interface ContextOverview {
  context: { id: string; agent_id: string; [key: string]: unknown };
  objectives: RuntimeObjective[]; sessions: Array<Record<string, unknown>>; generated_at?: string;
  [key: string]: unknown;
}
export class MorphzError extends Error {
  readonly status: number; readonly code?: string;
  constructor(status: number, code?: string) {
    super(`Morphz request failed (HTTP ${status})`); this.name = 'MorphzError'; this.status = status; this.code = code;
  }
}
function origin(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Morphz base URL must be an HTTP(S) origin without credentials, path, query, or fragment');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote Morphz connections require HTTPS');
  return url;
}
const pathId = (id: string) => encodeURIComponent(id);

class SessionAdapter {
  protected readonly options: TransportOptions;
  protected readonly headers: Headers;
  private readonly fetcher: typeof globalThis.fetch;
  readonly baseUrl: string;
  private capabilities?: IoCapabilities;
  constructor(options: TransportOptions, headers: Headers) {
    this.baseUrl = origin(options.baseUrl).origin; this.options = { ...options }; this.headers = headers;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  protected async call<T>(path: string, input?: object, method = input ? 'POST' : 'GET'): Promise<T> {
    const headers = new Headers(this.headers); headers.set('accept', 'application/json');
    if (input) headers.set('content-type', 'application/json');
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method, headers, body: input ? JSON.stringify(input) : undefined, redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: { code?: unknown } };
      const code = typeof result.error?.code === 'string' && /^[a-z0-9_]{1,100}$/.test(result.error.code) ? result.error.code : undefined;
      throw new MorphzError(response.status, code);
    }
    return response.json() as Promise<T>;
  }
  async getCapabilities(): Promise<IoCapabilities> {
    const capabilities = await this.call<IoCapabilities>('/api/session-io/capabilities');
    if (capabilities.enabled !== true || !capabilities.io_versions?.includes('1') || !capabilities.encodings?.includes('json') || !capabilities.formats?.some(format => format.definition?.id === 'morphz.chat' && format.definition.version === '1' && format.definition.encodings.includes('json'))) throw new Error('Morphz does not advertise the required Session IO v1 chat contract');
    this.capabilities = capabilities; return capabilities;
  }
  getSession(sessionId: string) { return this.call<RuntimeSession>(`/api/sessions/${pathId(sessionId)}`); }
  getPrincipal(sessionId: string) { return this.call<{ principal_id: string; session_id: string; context_id: string }>(`/api/sessions/${pathId(sessionId)}/principal`); }
  createSession(input: { id: string; agent_id?: string; title?: string; parent_session_id?: string; mount?: { type: 'existing_context'; context_id: string } | { type: 'new_blank_context'; context_id?: string; context_title?: string } }) {
    return this.call<RuntimeSession>('/api/sessions', input);
  }
  /** Exact identity and envelope are stable across retries. Receipt is only admission. */
  async sendMessage(sessionId: string, text: string, clientMessageId: string, dispatchMode: 'parallel' | 'interrupt' | 'follow_up' = 'parallel', attachments?: Array<{ stage_id: string }>): Promise<IoReceipt> {
    if (!this.capabilities) await this.getCapabilities();
    return this.call<IoReceipt>(`/api/sessions/${pathId(sessionId)}/io/messages`, {
      io_version: '1', client_message_id: clientMessageId,
      message: { format: { id: 'morphz.chat', version: '1' }, content: { encoding: 'json', value: { text, ...(attachments?.length ? { attachments } : {}) } } },
      activation: { dispatch_mode: dispatchMode },
    });
  }
  async sendObjectiveInput(sessionId: string, text: string, clientMessageId: string, destination: ObjectiveInputDestination): Promise<IoReceipt> {
    const capabilities = this.capabilities ?? await this.getCapabilities();
    if (capabilities.directed_input !== true) throw new MorphzError(409, 'directed_input_unavailable');
    if (!destination || Object.keys(destination).some(key => !['kind','objective_id','generation','reply_to_request_id'].includes(key)) || destination.kind !== 'objective' || !/^[A-Za-z0-9_-]{1,200}$/.test(destination.objective_id) || !Number.isSafeInteger(destination.generation) || destination.generation < 1 || (destination.reply_to_request_id !== undefined && (typeof destination.reply_to_request_id !== 'string' || !destination.reply_to_request_id || destination.reply_to_request_id.length > 512))) throw new Error('Invalid exact Objective input destination');
    return this.call<IoReceipt>(`/api/sessions/${pathId(sessionId)}/io/messages`, {
      io_version: '1', client_message_id: clientMessageId,
      message: { format: { id: 'morphz.chat', version: '1' }, content: { encoding: 'json', value: { text } } },
      activation: { mode: 'evaluate', dispatch_mode: 'parallel', input_destination: destination },
    });
  }
  async listEvents(sessionId: string, after?: string): Promise<IoEventPage> {
    if (!this.capabilities) await this.getCapabilities();
    const query = new URLSearchParams({ io_version: '1', receive_formats: JSON.stringify([{ id: 'morphz.chat', version: '1', encoding: 'json' }]), receive_unknown: 'reject' });
    if (after !== undefined) query.set('after', after);
    return this.call<IoEventPage>(`/api/sessions/${pathId(sessionId)}/io/events?${query}`);
  }
  async readResource(sessionId: string, resourceId: string, maximumBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('A resource byte limit is required');
    const headers = new Headers(this.headers); headers.set('accept', 'application/octet-stream');
    const response = await this.fetcher(`${this.baseUrl}/api/sessions/${pathId(sessionId)}/io/resources/${pathId(resourceId)}`, { headers, redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new MorphzError(response.status); }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) { await response.body?.cancel(); throw new MorphzError(413, 'resource_limit_exceeded'); }
    if (!response.body) throw new MorphzError(502, 'resource_body_missing');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > maximumBytes) throw new MorphzError(413, 'resource_limit_exceeded'); chunks.push(value); }
      return Buffer.concat(chunks, size);
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  createAttachmentStage(sessionId: string, input: AttachmentStageDeclaration) {
    return this.call<NativeAttachmentStage>(`/api/sessions/${pathId(sessionId)}/attachment-stages`, input);
  }
  getAttachmentStage(sessionId: string, stageId: string) {
    return this.call<NativeAttachmentStage>(`/api/sessions/${pathId(sessionId)}/attachment-stages/${pathId(stageId)}`);
  }
  async uploadAttachmentStage(sessionId: string, stageId: string, offset: number, bytes: Uint8Array): Promise<NativeAttachmentStage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || bytes.byteLength > 256 * 1024) throw new Error('Invalid attachment upload chunk');
    const headers = new Headers(this.headers); headers.set('content-type', 'application/octet-stream'); headers.set('x-morphz-upload-offset', String(offset));
    const response = await this.fetcher(`${this.baseUrl}/api/sessions/${pathId(sessionId)}/attachment-stages/${pathId(stageId)}/content`, { method: 'PUT', headers, body: Buffer.from(bytes), redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new MorphzError(response.status); }
    return response.json() as Promise<NativeAttachmentStage>;
  }
  async cancelAttachmentStage(sessionId: string, stageId: string): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/api/sessions/${pathId(sessionId)}/attachment-stages/${pathId(stageId)}`, { method: 'DELETE', headers: this.headers, redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000) });
    await response.body?.cancel(); if (!response.ok) throw new MorphzError(response.status);
  }
  async observe(sessionId: string, after: string | undefined, signal: AbortSignal, receive: (event: Record<string, unknown>) => void) {
    if (!this.capabilities) await this.getCapabilities();
    const headers = new Headers(this.headers); headers.set('accept', 'text/event-stream');
    const query = new URLSearchParams({ io_version: '1', receive_formats: JSON.stringify([{ id: 'morphz.chat', version: '1', encoding: 'json' }]), receive_unknown: 'reject' });
    if (after !== undefined) query.set('after', after);
    const response = await this.fetcher(`${this.baseUrl}/api/sessions/${pathId(sessionId)}/io/stream?${query}`, { headers, redirect: 'error', signal });
    if (!response.ok) throw new MorphzError(response.status);
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Runtime did not return a Session IO stream');
    await readSse(response.body, receive, signal);
  }
  createObjective(input: { id: string; coordinator_session_id: string; delivery_session_id: string; stated_objective: string; token_budget?: number }) {
    return this.call<{ objective: RuntimeObjective; harness_binding: unknown }>('/api/objectives', input);
  }
  controlObjective(id: string, action: 'pause' | 'resume' | 'cancel', expectedRevision: number) {
    return this.call<{ objective?: RuntimeObjective; terminal_status?: string; objective_id?: string }>(
      `/api/objectives/${pathId(id)}${action === 'cancel' ? '' : `/${action}`}`,
      { expected_revision: expectedRevision, reason: `Explicit opendots user request: ${action}` }, action === 'cancel' ? 'DELETE' : 'POST');
  }
  listApprovals(sessionId: string) { return this.call<{ approvals: RuntimeApproval[]; truncated: boolean }>(`/api/sessions/${pathId(sessionId)}/approvals`); }
  getApproval(sessionId: string, id: string) { return this.call<RuntimeApproval>(`/api/sessions/${pathId(sessionId)}/approvals/${pathId(id)}`); }
  decideApproval(sessionId: string, approvalId: string, command: { expected_revision: number; decision: 'allow_once' | 'deny' }) {
    return this.call<RuntimeApproval>(`/api/sessions/${pathId(sessionId)}/approvals/${pathId(approvalId)}`, command);
  }
  getTurnThread(sessionId: string, rootTurnId: string) { return this.call<Record<string, unknown>>(`/api/sessions/${pathId(sessionId)}/turns/${pathId(rootTurnId)}/thread`); }
  createSchedule(sessionId: string, input: { id: string; intent: string; not_before: string; interval_seconds?: number; dependency_thread_ids: string[] }) { return this.call<NativeSchedule>(`/api/sessions/${pathId(sessionId)}/schedules`, input); }
  getSchedule(sessionId: string, id: string) { return this.call<NativeSchedule>(`/api/sessions/${pathId(sessionId)}/schedules/${pathId(id)}`); }
  controlSchedule(sessionId: string, id: string, input: { action: 'pause' | 'resume' | 'cancel'; expected_revision: number }) { return this.call<NativeSchedule>(`/api/sessions/${pathId(sessionId)}/schedules/${pathId(id)}`, input); }
  cancelTurn(sessionId: string, rootTurnId: string, expectedRevision: number) { return this.call<Record<string, unknown>>(`/api/sessions/${pathId(sessionId)}/turns/${pathId(rootTurnId)}/thread`, { expected_revision: expectedRevision }); }
}

/** Principal-scoped gateway adapter. Intentionally has no operator read API. */
export class MorphzAdapter extends SessionAdapter {
  constructor(options: MorphzOptions) {
    if (!/^[\x21-\x7e]{1,200}$/.test(options.principalId)) throw new Error('A server-verified principal is required');
    const headers = new Headers({ 'x-morphz-principal': options.principalId });
    if (options.serviceToken) headers.set('authorization', `Bearer ${options.serviceToken}`);
    super(options, headers);
  }
}

/** Explicit single-user, loopback-only authority. Do not use for a gateway or tenant.
 * Runtime resolves the actual administrative default Principal. No Principal assertion
 * is sent. The product service additionally limits reads to its persisted own binding.
 */
export class LocalOperatorAdapter extends SessionAdapter {
  constructor(options: TransportOptions & { operatorToken?: string }) {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(origin(options.baseUrl).hostname)) throw new Error('Local operator mode requires a loopback Morphz origin');
    const headers = new Headers();
    if (options.operatorToken) headers.set('authorization', `Bearer ${options.operatorToken}`);
    super(options, headers);
  }
  /** Upstream application-compatible, fixed-Session, read-only observation.
   * No query credentials or arbitrary operator subscription are exposed.
   */
  async observeApplication(sessionId: string, signal: AbortSignal, receive: (event: Record<string, unknown>) => void) {
    await this.getSession(sessionId); // Validate the actual default Principal's Session binding first.
    signal.throwIfAborted();
    const url = new URL('/ws', this.baseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('session_id', sessionId);
    const projection = new ApplicationStreamProjection(sessionId);
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(url, { headers: Object.fromEntries(this.headers.entries()), handshakeTimeout: this.options.timeoutMs ?? 15_000, maxPayload: 4 * 1024 * 1024, followRedirects: false });
      const abort = () => socket.terminate(); signal.addEventListener('abort', abort, { once: true });
      socket.on('message', data => {
        try { const event = projection.accept(JSON.parse(data.toString())); if (event) receive(event); }
        catch { socket.terminate(); }
      });
      socket.on('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); });
      socket.on('error', () => socket.terminate());
      socket.once('close', () => { signal.removeEventListener('abort', abort); resolve(); });
    });
  }
  createAgentBundle(input: { id: string; root_context_id: string; initial_session_id: string; title: string; root_context_title: string; initial_session_title: string }) {
    return this.call<{ agent: { id: string; root_context_id: string }; root_context: { id: string }; initial_session: RuntimeSession }>('/api/agents', input);
  }
  searchRecall(contextId: string, query: string, cursor?: string) { const params = new URLSearchParams({query,limit:'50'}); if (cursor) params.set('cursor',cursor); return this.call<unknown>(`/api/contexts/${pathId(contextId)}/recall/search?${params}`); }
  recallFrame(contextId: string, frameId: string) { return this.call<unknown>(`/api/contexts/${pathId(contextId)}/frames/${pathId(frameId)}/recall?depth=0&include_bodies=true&include_events=false&max_nodes=32`); }
  setupProvider(body: unknown) { return this.call<unknown>('/api/runtime/providers/setup', body as object, 'PUT'); }
  getProviders() { return this.call<unknown>('/api/runtime/providers'); }
  getInference() { return this.call<unknown>('/api/runtime/inference'); }
  updateInference(input: { model: string; reasoning_effort?: string }) { return this.call<unknown>('/api/runtime/inference', input, 'PUT'); }
  getAgentProviderBindings(agentId: string) { return this.call<unknown>(`/api/agents/${pathId(agentId)}/provider-accounts`); }
  bindAgentProviderAccount(agentId: string, accountId: string) { return this.call<unknown>(`/api/agents/${pathId(agentId)}/provider-accounts/${pathId(accountId)}`, {}, 'PUT'); }
  listAgents() { return this.call<{ agents: Array<{ id: string; root_context_id: string }> }>('/api/agents'); }
  getContextScheduler(contextId: string) {
    return this.call<{ context_id: string; objectives: Array<{ objective: RuntimeObjective }>; detail_bounds: { limit: number; has_more_objectives: boolean }; generated_at: string }>(`/api/contexts/${pathId(contextId)}/scheduler?include_terminal=true&limit=2000`);
  }
  getContextOverview(contextId: string, sessionId: string) {
    return this.call<ContextOverview>(`/api/contexts/${pathId(contextId)}/overview?${new URLSearchParams({ session_id: sessionId })}`);
  }
}
