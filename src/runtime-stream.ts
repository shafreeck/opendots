/** Typed Session IO transient presentation only. Never persisted or treated as a result. */
export interface DraftMessage {
  id: string; output_id: string; root_turn_id: string; thread_id?: string; text: string;
  role: 'assistant'; draft: true; delta_seq: number; created_at: number;
}
export class DraftProjection {
  private drafts = new Map<string, DraftMessage>();
  private terminalRoots = new Set<string>();
  constructor(privateSessionId: string) { this.sessionId = privateSessionId; }
  private readonly sessionId: string;
  clear() { this.drafts.clear(); this.terminalRoots.clear(); }
  consume(event: Record<string, unknown>) {
    if (event.session_id && event.session_id !== this.sessionId) return;
    const id = typeof event.output_id === 'string' ? event.output_id : '';
    const root = typeof event.root_turn_id === 'string' ? event.root_turn_id : '';
    const original = event.event as { topic?: string; payload?: { terminal_kind?: unknown } } | undefined;
    if (event.type === 'output.committed' || (event.type === 'run.state' && (['chat/reply', 'chat/no_reply', 'chat/cancelled', 'session/io_state'].includes(original?.topic ?? '') || original?.payload?.terminal_kind !== undefined))) {
      if (root) {
        this.terminalRoots.add(root);
        if (this.terminalRoots.size > 4096) this.terminalRoots.delete(this.terminalRoots.values().next().value!);
        for (const [key, value] of this.drafts) if (value.root_turn_id === root) this.drafts.delete(key);
      }
      return;
    }
    if (event.type === 'stream.reset') { if (id) this.drafts.delete(id); else this.drafts.clear(); return; }
    if (event.type === 'output.aborted') { this.drafts.delete(id); return; }
    if (!id || !root || this.terminalRoots.has(root) || !Number.isSafeInteger(event.delta_seq) || Number(event.delta_seq) < 0 || typeof event.text !== 'string') return;
    if (event.type === 'output.started') {
      const previous = this.drafts.get(id);
      if (previous && previous.delta_seq > Number(event.delta_seq)) return;
      if (Buffer.byteLength(event.text) > 262144) { this.drafts.delete(id); return; }
      if (!previous && this.drafts.size >= 64) this.drafts.delete(this.drafts.keys().next().value!);
      this.drafts.set(id, { id: `draft:${id}`, output_id: id, root_turn_id: root, thread_id: typeof event.thread_id === 'string' ? event.thread_id : undefined, text: event.text, role: 'assistant', draft: true, delta_seq: Number(event.delta_seq), created_at: previous?.created_at ?? Date.now() });
    } else if (event.type === 'output.delta' && event.operation === 'text.append') {
      const previous = this.drafts.get(id);
      if (!previous) return; // A missing prefix requires a fresh snapshot, never guessed concatenation.
      if (Number(event.delta_seq) <= previous.delta_seq) return;
      if (Number(event.delta_seq) !== previous.delta_seq + 1 || Buffer.byteLength(previous.text) + Buffer.byteLength(event.text) > 262144) { this.drafts.delete(id); return; }
      this.drafts.set(id, { ...previous, text: previous.text + event.text, delta_seq: Number(event.delta_seq) });
    }
  }
  snapshot() { return [...this.drafts.values()].map(value => ({ ...value })); }
}

/** Streaming parser supports split UTF-8, CRLF, comments and multiline data.
 * Bounds memory; malformed payloads terminate observation, never replay a command.
 */
export async function readSse(stream: ReadableStream<Uint8Array>, receive: (event: Record<string, unknown>) => void, signal: AbortSignal) {
  const reader = stream.getReader(); const decoder = new TextDecoder(); let buffer = '';
  const abort = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener('abort', abort, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1_048_576) throw new Error('Runtime stream frame exceeds limit');
      // Normalization preserves a CR split across chunks until its LF arrives.
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        const event = JSON.parse(data); if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw new Error('Invalid Runtime stream event');
        receive(event);
      }
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
