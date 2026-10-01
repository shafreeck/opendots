import { createHash } from 'node:crypto';
import { COMPUTER_TOOL, ComputerEdgeError, edgeId, edgeRecord, validateComputerBinding, validateComputerCommand, type ComputerEdgeBinding, type ComputerEdgeCommand, type ComputerEdgeFinish, type ComputerEdgeLease, type ComputerEdgeTransport } from './computer-edge-types.ts';

export function computerConnectionProof(nodeId: string, challengeId: string, nonce: string): Uint8Array {
  if (![nodeId, challengeId, nonce].every(edgeId)) throw new ComputerEdgeError('invalid_edge_challenge', 502);
  return Buffer.from(`morphz-edge-connect-v1\0${nodeId}\0${challengeId}\0${nonce}`);
}
/** Builder only. Calling this never pairs a device or generates/stores a key. */
export function computerPairingRequest(input: { code: string; nodeId: string; name: string; publicKeyHex: string }) {
  if (!edgeId(input.nodeId) || !input.code || input.code.length > 1024 || !input.name || input.name.length > 128 || !/^[a-f0-9]{64}$/.test(input.publicKeyHex)) throw new ComputerEdgeError('invalid_pairing_request', 400);
  return { code: input.code, node_id: input.nodeId, name: input.name, device_key_fingerprint: `sha256:${createHash('sha256').update(Buffer.from(input.publicKeyHex, 'hex')).digest('hex')}`, device_public_key: input.publicKeyHex, protocol_version: 1, platform: 'linux', capabilities: [COMPUTER_TOOL], metadata: { product: 'opendots', desktop_only: true } };
}
/** Operator-generated template only. Its local endpoint MUST return 503 without
 * dispatching input. The actual image-capable execution path is the Edge target.
 */
export function computerHostManifest(binding: ComputerEdgeBinding, deniedLoopbackEndpoint: string, operatorToken: string) {
  validateComputerBinding(binding);
  const url = new URL(deniedLoopbackEndpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || operatorToken.length < 32 || operatorToken.length > 1024 || !/^[\x21-\x7e]+$/.test(operatorToken)) throw new ComputerEdgeError('invalid_host_manifest', 400);
  return { protocol: 1, tools: [{ endpoint: url.href, token: operatorToken, context_ids: [binding.contextId], idempotent_requests: [{ '/action': 'status' }, { '/action': 'receipt' }], definition: {
    name: COMPUTER_TOOL,
    description: `Operate only the authorized headed desktop on target ${binding.targetId}. Select this target on the first physical action of a fresh execution Thread; an existing Thread cannot change targets. Start with status, then observe using the returned epoch. Observe returns the real screenshot plus a single-use observationId. Act must use that exact observed epoch and observationId. Human takeover invalidates old plans. No shell, scripts, arbitrary CDP, uploads or clipboard. Read receipt(jobId) after uncertainty; never repeat an uncertain action. Input dispatch is not proof of a website/business outcome.`,
    parameters: { type: 'object', additionalProperties: false, properties: { action: { enum: ['status', 'observe', 'act', 'receipt'] }, epoch: { type: 'integer', minimum: 0 }, observationId: { type: 'string' }, jobId: { type: 'string' }, operation: { type: 'object', description: 'move/click with x,y (click button left/middle/right); scroll with direction and pixels 1..1000; key with Enter,Tab,Escape,Backspace,Delete,ArrowUp,ArrowDown,ArrowLeft,ArrowRight,Home,End,PageUp,PageDown,Ctrl+L,Ctrl+A; type with text <=4096 characters, no control characters.' } }, required: ['action'] },
  } }] };
}
export interface ComputerEdgeClientOptions {
  baseUrl: string; binding: ComputerEdgeBinding; workerId: string;
  /** An explicit operator assertion for a fixed private HTTP service endpoint.
   * This does not change LocalOperatorAdapter policy or expose a browser setting. */
  allowPrivateHttp?: boolean;
  signConnectionProof: (bytes: Uint8Array) => Promise<string>;
  fetch?: typeof fetch; now?: () => number; claimWaitSeconds?: number;
}
/** Existing Morphz Edge v1 routes; credentials remain in memory/injected signer.
 * No redirects, fallback endpoint, auto-pairing, body/error logging or constructor I/O.
 */
export class ComputerEdgeClient implements ComputerEdgeTransport {
  private options: ComputerEdgeClientOptions;
  private base: string;
  private fetcher: typeof fetch;
  private now: () => number;
  private lifetime = new AbortController();
  private connection?: { token: string; expiresAt: number };
  private connecting?: Promise<void>;
  constructor(options: ComputerEdgeClientOptions) {
    validateComputerBinding(options.binding);
    if (!edgeId(options.workerId)) throw new ComputerEdgeError('invalid_worker_id', 400);
    const url = new URL(options.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '') || (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && options.allowPrivateHttp !== true)) throw new ComputerEdgeError('invalid_edge_endpoint', 400);
    this.options = options; this.base = url.origin; this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now;
  }
  private async request(path: string, body: unknown, token?: string, signal?: AbortSignal, timeout = 10_000): Promise<unknown> {
    if (this.lifetime.signal.aborted) throw new ComputerEdgeError('edge_client_closed', 503);
    const combined = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    let response: Response;
    try {
      response = await this.fetcher(this.base + path, { method: 'POST', redirect: 'error', signal: combined, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      if (!response.ok) { await response.body?.cancel(); if ([401, 403].includes(response.status)) this.connection = undefined; throw new ComputerEdgeError(`edge_http_${response.status}`, response.status); }
      if (response.status === 204) return null;
      if (!response.body || Number(response.headers.get('content-length') ?? 0) > 2 * 1024 * 1024) throw new ComputerEdgeError('edge_response_too_large', 502);
      const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 2 * 1024 * 1024) throw new ComputerEdgeError('edge_response_too_large', 502); chunks.push(next.value); } }
      finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) { if (error instanceof ComputerEdgeError) throw error; throw new ComputerEdgeError(combined.aborted ? 'edge_request_aborted' : 'edge_transport_unconfirmed', 503); }
  }
  private nodePath() { return `/api/edge/nodes/${encodeURIComponent(this.options.binding.nodeId)}`; }
  private async token(signal?: AbortSignal) {
    if (this.connection && this.connection.expiresAt > this.now() + 30_000) return this.connection.token;
    if (!this.connecting) {
      this.connecting = (async () => {
        const c = edgeRecord(await this.request(`${this.nodePath()}/challenge`, {}, undefined, signal));
        if (typeof c.expires_at !== 'string' || Date.parse(c.expires_at) <= this.now() || !edgeId(c.challenge_id) || !edgeId(c.nonce)) throw new ComputerEdgeError('invalid_edge_challenge', 502);
        let signature: string;
        const signingSignal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort!: () => void;
        try {
          if (signingSignal.aborted) throw new Error('closed');
          signature = await Promise.race([
            this.options.signConnectionProof(computerConnectionProof(this.options.binding.nodeId, c.challenge_id, c.nonce)),
            new Promise<never>((_, reject) => { onAbort = () => reject(new Error('closed')); signingSignal.addEventListener('abort', onAbort, { once: true }); timer = setTimeout(() => reject(new Error('timeout')), 10_000); }),
          ]);
        } catch { throw new ComputerEdgeError('edge_signer_unavailable', 503); }
        finally { if (timer) clearTimeout(timer); if (onAbort) signingSignal.removeEventListener('abort', onAbort); }
        if (!/^[a-f0-9]{128}$/i.test(signature)) throw new ComputerEdgeError('invalid_edge_signature', 400);
        const result = edgeRecord(await this.request(`${this.nodePath()}/connect`, { challenge_id: c.challenge_id, nonce: c.nonce, signature }, undefined, signal));
        if (typeof result.token !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(result.token) || typeof result.expires_at !== 'string' || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= this.now()) throw new ComputerEdgeError('invalid_edge_connection', 502);
        this.connection = { token: result.token, expiresAt: Date.parse(result.expires_at) };
      })().finally(() => { this.connecting = undefined; });
    }
    await this.connecting;
    if (!this.connection) throw new ComputerEdgeError('edge_connection_unavailable', 503);
    return this.connection.token;
  }
  async heartbeatNode(signal?: AbortSignal) {
    const b = this.options.binding;
    const result = edgeRecord(await this.request(`${this.nodePath()}/heartbeat`, { platform: 'linux', capabilities: [COMPUTER_TOOL], metadata: { product: 'opendots', desktop_only: true }, targets: [{ id: b.targetId, owner_principal_id: b.principalId, provider_node_id: b.nodeId, kind: 'edge_node', name: 'OpenDots headed desktop', status: 'online', platform: 'linux', workspace_root: null, capabilities: [COMPUTER_TOOL], metadata: { product: 'opendots', desktop_only: true }, policy_digest: b.policyDigest, last_seen_at: null }] }, await this.token(signal), signal));
    if (result.id !== b.nodeId || result.owner_principal_id !== b.principalId || result.status !== 'online') throw new ComputerEdgeError('edge_node_scope_mismatch', 403);
  }
  async claim(signal?: AbortSignal) {
    const wait = Math.max(0, Math.min(25, Math.floor(this.options.claimWaitSeconds ?? 20)));
    const value = await this.request(`${this.nodePath()}/jobs/claim?wait_seconds=${wait}`, { worker_id: this.options.workerId, lease_seconds: 30 }, await this.token(signal), signal, (wait + 10) * 1000);
    if (value === null) return null;
    const command = validateComputerCommand(edgeRecord(value).job, this.options.binding, this.options.workerId);
    if (!['claimed', 'cancel_requested'].includes(command.status) || Date.parse(command.lease_expires_at) <= this.now()) throw new ComputerEdgeError('invalid_edge_claim', 409);
    return command;
  }
  async heartbeat(command: ComputerEdgeCommand, sideEffectStarted: boolean, signal?: AbortSignal) {
    validateComputerCommand(command, this.options.binding, this.options.workerId);
    const result = validateComputerCommand(await this.request(`${this.nodePath()}/jobs/${encodeURIComponent(command.job_id)}/heartbeat`, { expected_revision: command.revision, claim_token: command.claim_token, lease_seconds: 30, side_effect_started: sideEffectStarted, progress: 'computer operation pending' }, await this.token(signal), signal), this.options.binding, this.options.workerId);
    if (result.job_id !== command.job_id || result.claim_token !== command.claim_token || result.arguments !== command.arguments || JSON.stringify(result.route) !== JSON.stringify(command.route) || result.revision < command.revision) throw new ComputerEdgeError('edge_heartbeat_identity_mismatch', 403);
    return result;
  }
  async finish(command: ComputerEdgeLease, result: ComputerEdgeFinish, signal?: AbortSignal) {
    validateComputerCommand({ ...command, arguments: '' }, this.options.binding, this.options.workerId);
    if (!/^[a-f0-9]{64}$/.test(command.argumentsHash)) throw new ComputerEdgeError('invalid_edge_receipt', 400);
    if (Buffer.byteLength(JSON.stringify(result)) > 1_600_000) throw new ComputerEdgeError('edge_result_too_large', 413);
    const response = validateComputerCommand(await this.request(`${this.nodePath()}/jobs/${encodeURIComponent(command.job_id)}/finish`, { expected_revision: command.revision, claim_token: command.claim_token, ...result }, await this.token(signal), signal), this.options.binding, this.options.workerId);
    if (response.job_id !== command.job_id || response.status !== result.status || response.claim_token !== command.claim_token || createHash('sha256').update(response.arguments).digest('hex') !== command.argumentsHash || JSON.stringify(response.route) !== JSON.stringify(command.route)) throw new ComputerEdgeError('edge_finish_identity_mismatch', 403);
    return response;
  }
  close() { this.connection = undefined; this.lifetime.abort(); }
}
