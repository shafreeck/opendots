/** Server-owned connector contracts. Importing this module opens no connection. */
export const CONNECTOR_TOOL = 'host_opendots_connectors';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ConnectorBinding { principalId: string; agentId: string; contextId: string; sessionId: string }
export interface ConnectorInvocation {
  job_id: string; tool_call_id: string; session_id: string; context_id: string;
  principal_id: string; agent_id: string; thread_id: string; target_id: string;
}
export type ConnectorRequest =
  | { action: 'list' }
  | { action: 'describe'; connector: string }
  | { action: 'status'; connector: string }
  | { action: 'call'; connector: string; operation: string; parameters: Record<string, Json> };
export interface ConnectorEnvelope { protocol: 1; tool: typeof CONNECTOR_TOOL; invocation: ConnectorInvocation; arguments: ConnectorRequest }
export interface ConnectorOperation { id: string; description: string; inputSchema: Record<string, Json>; effect: 'public_read' }
export interface ConnectorAdapter {
  readonly id: string;
  readonly label: string;
  readonly operations: readonly ConnectorOperation[];
  /** This metadata must be safe for both user and model. It must not probe or log in. */
  status(): Record<string, Json>;
  validate(operation: string, parameters: unknown): Record<string, Json>;
  /** Trusted server implementation, never a model-supplied URL, executable, or credentials. */
  call(operation: string, parameters: Record<string, Json>, signal: AbortSignal): Promise<Json>;
}
export class ConnectorError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status = 400) { super(code); this.name = 'ConnectorError'; this.code = code; this.status = status; }
}
export function checkConnector(ok: unknown, code = 'connector_invalid_request', status = 400): asserts ok {
  if (!ok) throw new ConnectorError(code, status);
}
export function connectorRecord(value: unknown): Record<string, unknown> {
  checkConnector(value !== null && typeof value === 'object' && !Array.isArray(value));
  checkConnector([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  return value as Record<string, unknown>;
}
export function connectorKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  checkConnector(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
export function connectorId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,512}$/.test(value); }
export function connectorBinding(value: ConnectorBinding) {
  const b = connectorRecord(value); connectorKeys(b, ['principalId', 'agentId', 'contextId', 'sessionId']);
  checkConnector(Object.values(b).every(connectorId), 'connector_invalid_binding');
  return Object.freeze({ ...value });
}
/** Canonical bounded JSON also rejects non-JSON values and prototype ambiguity. */
export function connectorJson(value: unknown, maximum = 65_536): string {
  function visit(v: unknown, depth: number): Json {
    checkConnector(depth <= 20, 'connector_json_limit', 413);
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') { checkConnector(Number.isFinite(v)); return v; }
    if (Array.isArray(v)) { checkConnector(v.length <= 2_000, 'connector_json_limit', 413); return v.map(x => visit(x, depth + 1)); }
    const o = connectorRecord(v); const entries = Object.entries(o);
    checkConnector(entries.length <= 2_000, 'connector_json_limit', 413);
    return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => {
      checkConnector(!['__proto__', 'constructor', 'prototype'].includes(k)); return [k, visit(x, depth + 1)];
    }));
  }
  const encoded = JSON.stringify(visit(value, 0));
  checkConnector(Buffer.byteLength(encoded) <= maximum, 'connector_json_limit', 413); return encoded;
}
export function parseConnectorEnvelope(value: unknown): ConnectorEnvelope {
  connectorJson(value); const e = connectorRecord(value); connectorKeys(e, ['protocol', 'tool', 'invocation', 'arguments']);
  checkConnector(e.protocol === 1 && e.tool === CONNECTOR_TOOL);
  const i = connectorRecord(e.invocation); connectorKeys(i, ['job_id','tool_call_id','session_id','context_id','principal_id','agent_id','thread_id','target_id']);
  checkConnector(Object.values(i).every(connectorId));
  const a = connectorRecord(e.arguments);
  if (a.action === 'list') connectorKeys(a, ['action']);
  else if (a.action === 'describe' || a.action === 'status') { connectorKeys(a, ['action','connector']); checkConnector(connectorId(a.connector)); }
  else { connectorKeys(a, ['action','connector','operation','parameters']); checkConnector(a.action === 'call' && connectorId(a.connector) && connectorId(a.operation)); connectorRecord(a.parameters); }
  return JSON.parse(connectorJson(e)) as ConnectorEnvelope;
}
/** Fixed-origin clients use this only with preconstructed trusted URLs and headers. */
export async function connectorGet(fetcher: typeof fetch, url: string, headers: HeadersInit, signal: AbortSignal, maximum = 2_097_152): Promise<unknown> {
  try {
    checkConnector(!signal.aborted, 'connector_request_aborted', 503);
    const response = await fetcher(url, { method: 'GET', headers, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    if (!response.ok) { await response.body?.cancel(); throw new ConnectorError(`connector_http_${response.status}`, response.status); }
    const length = response.headers.get('content-length');
    if (!response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))) {
      await response.body?.cancel(); throw new ConnectorError('connector_response_limit', 502);
    }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { checkConnector(!signal.aborted, 'connector_request_aborted', 503); const part = await reader.read(); if (part.done) break; size += part.value.byteLength; checkConnector(size <= maximum, 'connector_response_limit', 502); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError(signal.aborted ? 'connector_request_aborted' : 'connector_transport_unavailable', 503);
  }
}
