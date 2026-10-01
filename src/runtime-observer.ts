/** Read-only compatibility projection for the pinned upstream application WebSocket.
 * See docs/RUNTIME_COMPATIBILITY.md. Never forwards model requests, reasoning,
 * provider continuation, tool arguments, credentials or arbitrary Runtime payloads.
 */
export class ApplicationStreamProjection {
  private sessionId: string;
  private attempts = new Map<string, { root: string; sequence: number }>();
  private seen = new Set<string>();
  constructor(sessionId: string) { this.sessionId = sessionId; }
  accept(raw: unknown): Record<string, unknown> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const event = raw as Record<string, unknown>; const p = event.payload as Record<string, unknown> | undefined;
    if (!p || p.session_id !== this.sessionId || typeof event.topic !== 'string') return;
    if (event.topic === 'runtime/model_attempt_snapshot') return { type: 'stream.opened', transport: 'application_ws', session_id: this.sessionId };
    if (typeof event.id !== 'string' || this.seen.has(event.id)) return;
    this.seen.add(event.id); if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    const root = typeof p.root_turn_id === 'string' ? p.root_turn_id : '';
    if (['chat/reply', 'chat/no_reply', 'chat/cancelled', 'chat/runtime_error', 'session/io_state'].includes(event.topic) && root) {
      for (const [id, attempt] of this.attempts) if (attempt.root === root) this.attempts.delete(id);
      return { type: 'run.state', session_id: this.sessionId, root_turn_id: root, event: { topic: event.topic, payload: { terminal_kind: 'observed' } } };
    }
    if (event.topic !== 'runtime/model_stream' || !root || typeof p.attempt_id !== 'string') return;
    const stream = p.stream as Record<string, unknown> | undefined;
    if (!stream || !['started', 'text_delta', 'failed', 'incomplete'].includes(String(stream.kind))) return;
    const id = p.attempt_id;
    if (stream.kind === 'started') {
      if (this.attempts.size >= 64 && !this.attempts.has(id)) this.attempts.delete(this.attempts.keys().next().value!);
      this.attempts.set(id, { root, sequence: 0 });
    }
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.root !== root) return; // A reconnect suffix is never a complete draft.
    const base = { output_id: `application:${id}`, session_id: this.sessionId, root_turn_id: root, thread_id: typeof p.thread_id === 'string' ? p.thread_id : undefined };
    if (stream.kind === 'started') return { ...base, type: 'output.started', delta_seq: 0, text: '' };
    if (stream.kind === 'text_delta') {
      if (typeof stream.text !== 'string') return;
      return { ...base, type: 'output.delta', operation: 'text.append', delta_seq: ++attempt.sequence, text: stream.text };
    }
    this.attempts.delete(id); return { ...base, type: 'output.aborted' };
  }
}
