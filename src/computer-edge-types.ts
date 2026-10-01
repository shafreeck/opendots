/** Product-owned, opt-in consumer of Morphz's existing Edge v1 protocol.
 * No registration, connection, credential generation or desktop input occurs on import.
 */
export const COMPUTER_TOOL = 'host_opendots_computer';
export interface ComputerEdgeBinding {
  nodeId: string; targetId: string; principalId: string; agentId: string;
  contextId: string; sessionId: string; policyDigest: string;
}
export interface ComputerExecutionScope {
  principal_id: string; agent_id: string; context_id: string;
  session_id: string; thread_id: string; objective_id?: string;
}
export interface ComputerEdgeRoute {
  route_id: string; target_id: string; target_revision: number;
  provider_node_id: string; backend_kind: 'edge_node'; endpoint_ref: null;
  policy_digest: string; execution_scope: ComputerExecutionScope;
}
export interface ComputerEdgeCommand {
  job_id: string; revision: number; target_id: string; provider_node_id: string;
  tool_name: string; arguments: string; route: ComputerEdgeRoute;
  status: 'claimed' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
  claimed_by: string; claim_token: string; lease_expires_at: string;
  side_effect_started_at?: string | null;
}
export type ComputerEdgeLease = Omit<ComputerEdgeCommand, 'arguments'> & { argumentsHash: string };
export interface ComputerEdgeFinish {
  status: 'succeeded' | 'failed' | 'cancelled'; output: string | null; error: string | null;
}
export interface ComputerEdgeTransport {
  heartbeatNode(signal?: AbortSignal): Promise<void>;
  claim(signal?: AbortSignal): Promise<ComputerEdgeCommand | null>;
  heartbeat(command: ComputerEdgeCommand, sideEffectStarted: boolean, signal?: AbortSignal): Promise<ComputerEdgeCommand>;
  finish(command: ComputerEdgeLease, result: ComputerEdgeFinish, signal?: AbortSignal): Promise<ComputerEdgeCommand>;
  close(): void;
}
export const COMPUTER_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Ctrl+L', 'Ctrl+A'] as const;
export type ComputerAction =
  | { type: 'click'; x: number; y: number; button: 'left' | 'middle' | 'right' }
  | { type: 'move'; x: number; y: number }
  | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; pixels: number }
  | { type: 'key'; key: typeof COMPUTER_KEYS[number] }
  | { type: 'type'; text: string };
export type ComputerToolRequest =
  | { action: 'status' }
  | { action: 'observe'; epoch: number }
  | { action: 'act'; epoch: number; observationId: string; operation: ComputerAction }
  | { action: 'receipt'; jobId: string };
export interface ComputerDisplay { id: string; width: number; height: number }
export interface ComputerCapture extends ComputerDisplay { png: Uint8Array; capturedAt: number }
/** Trusted driver only. IDs change on any display/browser replacement. Each NEW bounded
 * gesture (one character, click pair or scroll detent) MUST call assertCurrent
 * immediately before dispatch. Finish only the owned release/restoration of an
 * admitted gesture; revocation/abort rejects the next gesture. Never admit a whole
 * string as one gesture. Abort must settle within a bounded deadline.
 * Never implement this with a model-provided shell command, script, path or CDP method.
 */
export interface ComputerEdgeDriver {
  display(): ComputerDisplay;
  capture(context: { signal: AbortSignal; assertCurrent: () => void }): Promise<ComputerCapture>;
  act(action: ComputerAction, context: { signal: AbortSignal; assertCurrent: () => void }): Promise<void>;
}
export interface ComputerArbiterState { owner: 'human' | 'ai' | 'paused' | 'transition'; epoch: number; leaseUntil: number }
export interface ComputerEdgeArbiter {
  state(): ComputerArbiterState;
  performAi<T>(epoch: number, action: () => Promise<T>): Promise<T>;
  /** Renew only an already valid AI lease of this exact epoch. */
  renewAi(epoch: number): void | Promise<void>;
  /** Record uncertainty even after an epoch change; revoke only expectedEpoch when supplied. */
  pause(uncertainty?: boolean, expectedEpoch?: number): void | Promise<void>;
}
export class ComputerEdgeError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}
export function edgeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputerEdgeError('invalid_edge_response', 502);
  return value as Record<string, unknown>;
}
export function edgeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,512}$/.test(value);
}
export function validateComputerBinding(binding: ComputerEdgeBinding) {
  const keys = ['nodeId', 'targetId', 'principalId', 'agentId', 'contextId', 'sessionId', 'policyDigest'];
  if (Object.keys(binding).length !== keys.length || keys.some(key => !edgeId((binding as unknown as Record<string, unknown>)[key])) || binding.targetId === 'target-default') throw new ComputerEdgeError('invalid_computer_binding', 400);
}
/** The native command, never model arguments, provides execution identity. */
export function validateComputerCommand(value: unknown, binding: ComputerEdgeBinding, workerId: string): ComputerEdgeCommand {
  const c = edgeRecord(value), r = edgeRecord(c.route), s = edgeRecord(r.execution_scope);
  if (!edgeId(c.job_id) || !Number.isSafeInteger(c.revision) || Number(c.revision) < 1 || c.target_id !== binding.targetId || c.provider_node_id !== binding.nodeId || c.tool_name !== COMPUTER_TOOL || typeof c.arguments !== 'string' || c.arguments.length > 16_384 || c.claimed_by !== workerId || typeof c.claim_token !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(c.claim_token) || typeof c.lease_expires_at !== 'string' || !Number.isFinite(Date.parse(c.lease_expires_at)) || !['claimed', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'lost'].includes(String(c.status))) throw new ComputerEdgeError('computer_command_scope_mismatch', 403);
  if (!edgeId(r.route_id) || !Number.isSafeInteger(r.target_revision) || Number(r.target_revision) < 1 || r.target_id !== binding.targetId || r.provider_node_id !== binding.nodeId || r.backend_kind !== 'edge_node' || r.endpoint_ref !== null || r.policy_digest !== binding.policyDigest || s.principal_id !== binding.principalId || s.agent_id !== binding.agentId || s.context_id !== binding.contextId || s.session_id !== binding.sessionId || !edgeId(s.thread_id) || (s.objective_id !== undefined && !edgeId(s.objective_id))) throw new ComputerEdgeError('computer_command_scope_mismatch', 403);
  return value as ComputerEdgeCommand;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new ComputerEdgeError('invalid_computer_request', 400);
}
export function parseComputerRequest(raw: string): ComputerToolRequest {
  let a: Record<string, unknown>;
  try { a = edgeRecord(JSON.parse(raw)); } catch { throw new ComputerEdgeError('invalid_computer_request', 400); }
  if (a.action === 'status') { exactKeys(a, ['action']); return { action: 'status' }; }
  if (a.action === 'receipt') { exactKeys(a, ['action', 'jobId']); if (!edgeId(a.jobId)) throw new ComputerEdgeError('invalid_computer_request', 400); return { action: 'receipt', jobId: a.jobId }; }
  if (!Number.isSafeInteger(a.epoch) || Number(a.epoch) < 0) throw new ComputerEdgeError('invalid_computer_request', 400);
  if (a.action === 'observe') { exactKeys(a, ['action', 'epoch']); return { action: 'observe', epoch: Number(a.epoch) }; }
  if (a.action !== 'act' || typeof a.observationId !== 'string' || !/^[a-f0-9-]{36}$/.test(a.observationId)) throw new ComputerEdgeError('invalid_computer_request', 400);
  exactKeys(a, ['action', 'epoch', 'observationId', 'operation']);
  const op = edgeRecord(a.operation);
  switch (op.type) {
    case 'move': case 'click':
      exactKeys(op, op.type === 'click' ? ['type', 'x', 'y', 'button'] : ['type', 'x', 'y']);
      if (![op.x, op.y].every(n => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) < 16_384) || (op.type === 'click' && !['left', 'middle', 'right'].includes(String(op.button)))) throw new ComputerEdgeError('invalid_computer_request', 400);
      break;
    case 'scroll':
      exactKeys(op, ['type', 'direction', 'pixels']);
      if (!['up', 'down', 'left', 'right'].includes(String(op.direction)) || !Number.isSafeInteger(op.pixels) || Number(op.pixels) < 1 || Number(op.pixels) > 1000) throw new ComputerEdgeError('invalid_computer_request', 400);
      break;
    case 'key': exactKeys(op, ['type', 'key']); if (!(COMPUTER_KEYS as readonly unknown[]).includes(op.key)) throw new ComputerEdgeError('invalid_computer_request', 400); break;
    case 'type': exactKeys(op, ['type', 'text']); if (typeof op.text !== 'string' || op.text.length < 1 || op.text.length > 4096 || /[\u0000-\u001f\u007f]/.test(op.text)) throw new ComputerEdgeError('invalid_computer_request', 400); break;
    default: throw new ComputerEdgeError('invalid_computer_request', 400);
  }
  return a as unknown as ComputerToolRequest;
}
