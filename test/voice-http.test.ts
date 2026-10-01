import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/server.ts';
import type { SpeechProvider } from '../src/voice-provider.ts';
import { maxSpeechSegmentBytes, wavFromPCM } from '../vendor/app-speech/audio.ts';

const marker = 'SYNTHETIC_RAW_AUDIO_SHOULD_NOT_PERSIST';
const pcm = Buffer.alloc(3200); pcm.write(marker); const wav = Buffer.from(wavFromPCM(pcm));
async function fixture(t: test.TestContext, enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-voice-http-')); let session: any; let principal = 'verified-principal'; let providerCalls = 0;
  const provider: SpeechProvider = { provider: { id: 'doubao', label: '豆包' }, configured: () => true, transcribe: async () => { providerCalls++; return 'synthetic-unsent-transcript'; }, synthesize: async () => { providerCalls++; return wav; } };
  const fetcher = (async (raw: any, init: any = {}) => {
    const url = new URL(raw); const path = url.pathname; const input = init.body ? JSON.parse(init.body) : null;
    if (path === '/api/session-io/capabilities') return Response.json({ enabled: true, io_versions: ['1'], encodings: ['json'], formats: [{ definition: { id: 'morphz.chat', version: '1', encodings: ['json'] } }] });
    if (path === '/api/agents' && init.method === 'GET') return Response.json({ agents: [] });
    if (path === '/api/agents' && init.method === 'POST') { session = { id: input.initial_session_id, agent_id: input.id, context_id: input.root_context_id, status: 'active' }; return Response.json({ initial_session: session }); }
    if (path.endsWith('/principal')) return Response.json({ principal_id: principal, session_id: session.id, context_id: session.context_id });
    if (path.endsWith('/io/events')) return Response.json({ subscription: {}, events: [{ io_version: '1', event_id: 'committed-reply', sequence: 1, type: 'output.committed', session_id: session.id, message: { format: { id: 'morphz.chat', version: '1' }, content: { encoding: 'json', value: { text: '已保存的助手回复' } } } }], cursor: 'fixture-final' });
    if (path.endsWith('/overview')) return Response.json({ context: { id: session.context_id, agent_id: session.agent_id }, objectives: [], sessions: [] });
    if (path.endsWith('/scheduler')) return Response.json({ context_id: session.context_id, objectives: [], detail_bounds: { limit: 2000, has_more_objectives: false } });
    if (path.endsWith('/approvals')) return Response.json({ approvals: [], truncated: false });
    if (path.startsWith('/api/sessions/')) return session ? Response.json(session) : new Response('', { status: 404 });
    throw Error('Unexpected synthetic Runtime call');
  }) as typeof fetch;
  const app = createApplication({ dbPath: join(dir, 'app.db'), baseUrl: 'http://127.0.0.1:3001', fetch: fetcher, autoStart: false, voice: { enabled, provider } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const state = await (await fetch(origin + '/api/state')).json();
  const headers = { 'x-opendots-csrf': state.csrfToken, 'content-type': 'audio/wav', 'x-opendots-voice-consent': 'transcribe' };
  return { app, dir, provider, origin, headers, calls: () => providerCalls, setPrincipal: (value: string) => { principal = value; } };
}

test('HTTP voice is disabled by default and capability reads never invoke provider', async t => {
  const f = await fixture(t, false);
  const caps = await (await fetch(f.origin + '/api/voice')).json(); assert.equal(caps.status, 'disabled'); assert.equal(caps.operations.transcribe, false); assert.equal(f.calls(), 0);
  assert.equal((await fetch(f.origin + '/api/voice/transcribe', { method: 'POST', headers: f.headers, body: wav })).status, 503);
  assert.equal(f.calls(), 0);
});

test('HTTP voice enforces CSRF, exact purpose, format, size, fixed Session and private ephemeral results', async t => {
  const f = await fixture(t);
  const post = (headers: Record<string, string>, body: Uint8Array = wav) => fetch(f.origin + '/api/voice/transcribe', { method: 'POST', headers, body: Buffer.from(body) });
  await fetch(f.origin + '/api/voice'); assert.equal(f.calls(), 0);
  assert.equal((await post({ ...f.headers, 'x-opendots-csrf': 'wrong' })).status, 403);
  assert.equal((await post({ ...f.headers, 'x-opendots-voice-consent': '' })).status, 400);
  assert.equal((await post({ ...f.headers, 'content-type': 'audio/webm' })).status, 415);
  assert.equal((await post(f.headers, new Uint8Array(maxSpeechSegmentBytes + 1))).status, 413);
  assert.equal((await post({ ...f.headers, origin: 'https://foreign.example' })).status, 403);
  assert.equal(f.calls(), 0);
  const recognized = await post(f.headers); assert.equal(recognized.status, 200); assert.equal(recognized.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await recognized.json(), { text: 'synthetic-unsent-transcript', reviewRequired: true, sentToChat: false }); assert.equal(f.calls(), 1);
  assert.equal(f.app.runtime!.store.commands().length, 0);
  await f.app.runtime!.refresh();
  const read = (input: object) => fetch(f.origin + '/api/voice/read-aloud', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opendots-csrf': f.headers['x-opendots-csrf'] }, body: JSON.stringify(input) });
  assert.equal((await read({ messageId: 'committed-reply', consent: false })).status, 400);
  assert.equal((await read({ messageId: 'committed-reply', consent: true, text: 'arbitrary' })).status, 400);
  assert.equal((await read({ messageId: 'unknown', consent: true })).status, 404);
  const spoken = await read({ messageId: 'committed-reply', consent: true }); assert.equal(spoken.status, 200); assert.equal(spoken.headers.get('content-type'), 'audio/wav'); assert.equal(spoken.headers.get('cache-control'), 'no-store'); assert.equal(spoken.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(Buffer.from(await spoken.arrayBuffer()), wav); assert.equal(f.calls(), 2);
  f.setPrincipal('changed-principal'); assert.equal((await read({ messageId: 'committed-reply', consent: true })).status, 503); assert.equal(f.calls(), 2);
  for (const file of readdirSync(f.dir)) { const bytes = readFileSync(join(f.dir, file)); assert.ok(!bytes.includes(Buffer.from(marker))); assert.ok(!bytes.includes(Buffer.from('synthetic-unsent-transcript'))); }
});

test('HTTP disconnect aborts active speech and server shutdown cancels pending provider work', { timeout: 10000 }, async t => {
  const f = await fixture(t); let began!: () => void; let aborted!: () => void;
  let started = new Promise<void>(resolve => { began = resolve; }); let cancelled = new Promise<void>(resolve => { aborted = resolve; });
  f.provider.transcribe = async (_principal, _wav, signal) => new Promise<string>((_resolve, reject) => { began(); signal.addEventListener('abort', () => { aborted(); reject(Error('synthetic cancellation')); }, { once: true }); });
  const controller = new AbortController(); const pending = fetch(f.origin + '/api/voice/transcribe', { method: 'POST', headers: f.headers, body: wav, signal: controller.signal }).catch(() => null);
  await started; controller.abort(); await cancelled; await pending;
  started = new Promise<void>(resolve => { began = resolve; }); cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const next = fetch(f.origin + '/api/voice/transcribe', { method: 'POST', headers: f.headers, body: wav });
  await started; const closing = f.app.close(); await cancelled;
  const result = await next; assert.equal(result.status, 499); await closing;
});
