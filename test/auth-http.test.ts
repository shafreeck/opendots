import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as tcpServer, type Socket } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createHash, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { createApplication, type ApplicationOptions } from '../src/server.ts';
import { authDigest } from '../src/auth-config.ts';
import { ComputerApprovals } from '../src/computer-approvals.ts';
import { ComputerGateway } from '../src/computer-gateway.ts';

const credential = 'a'.repeat(64);
const syntheticConfig = () => ({ version: 1, credential: { kind: 'morphz_login_token_sha256', hashHex: authDigest(credential) }, sessionTtlSeconds: 3600, idleTtlSeconds: 60, maximumDevices: 8 });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { if (Date.now() >= deadline) assert.fail('Fixture condition did not settle'); await delay(5); } }
async function fixture(t: test.TestContext, computer = false, config: object = syntheticConfig(), extra: Partial<ApplicationOptions> = {}, beforeListen?: (app: ReturnType<typeof createApplication>) => void) {
  const root = mkdtempSync(join(tmpdir(), 'opendots-auth-http-test-')), authConfigPath = join(root, 'auth.json'), dbPath = join(root, 'app.sqlite');
  writeFileSync(authConfigPath, JSON.stringify(config), { mode: 0o600 });
  let now = Date.now(), runtimeCalls = 0;
  const sockets = new Set<Socket>(), received: string[] = [];
  const endpoint = () => tcpServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('data', data => received.push(data.toString())); socket.write('synthetic-rfb'); });
  const preview = computer ? endpoint() : undefined, control = computer ? endpoint() : undefined;
  if (preview && control) await Promise.all([new Promise<void>(r => preview.listen(0, '127.0.0.1', r)), new Promise<void>(r => control.listen(0, '127.0.0.1', r))]);
  const options: ApplicationOptions = { dbPath, authConfigPath, authNow: () => now, baseUrl: 'http://127.0.0.1:38886', autoStart: false, fetch: async () => { runtimeCalls++; throw Error('Isolated Runtime intentionally offline'); }, ...(preview && control ? { computer: { previewPort: (preview.address() as any).port, controlPort: (control.address() as any).port, previewReadOnlyEnforced: true } } : {}), ...extra };
  const app = createApplication(options);
  beforeListen?.(app);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); await app.ready;
  const port = (app.server.address() as any).port, origin = `http://127.0.0.1:${port}`;
  const login = async (label = 'Synthetic browser', value = credential) => {
    const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ credential: value, deviceLabel: label }) });
    assert.equal(response.status, 200); const json = await response.json(); const setCookie = response.headers.get('set-cookie')!;
    return { cookie: setCookie.split(';')[0], setCookie, session: json.session };
  };
  const post = (path: string, device: { cookie: string; session: { csrfToken: string } }, input: object = {}, csrf = device.session.csrfToken) => fetch(origin + path, { method: 'POST', headers: { origin, cookie: device.cookie, 'content-type': 'application/json', 'x-opendots-csrf': csrf }, body: JSON.stringify(input) });
  t.after(async () => { await app.close(); for (const socket of sockets) socket.destroy(); await Promise.all([preview && new Promise<void>(r => preview.close(() => r())), control && new Promise<void>(r => control.close(() => r()))]); rmSync(root, { recursive: true, force: true }); });
  return { app, root, authConfigPath, dbPath, options, port, origin, login, post, received, tick: (ms: number) => { now += ms; }, runtimeCalls: () => runtimeCalls };
}
async function wsRejected(connection: any, origin: string, cookie?: string) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(connection.url, connection.protocols, { origin, headers: cookie ? { cookie } : {} });
    ws.once('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!); });
    ws.once('open', () => { ws.terminate(); reject(Error('Unexpected accepted unauthenticated socket')); }); ws.on('error', () => {});
  });
}
async function wsOpen(connection: any, origin: string, cookie: string) {
  return new Promise<WebSocket>((resolve, reject) => { const ws = new WebSocket(connection.url, connection.protocols, { origin, headers: { cookie } }); ws.once('error', reject); ws.once('open', () => resolve(ws)); });
}

test('HTTP authentication exposes only login assets/status before authentication and keeps bearer out of JSON', async t => {
  const f = await fixture(t);
  const status = await (await fetch(f.origin + '/api/auth')).json(); assert.equal(status.enabled, true); assert.equal(status.authenticated, false); assert.equal(status.session, null);
  const root = await fetch(f.origin + '/', { redirect: 'manual' }); assert.equal(root.status, 303); assert.equal(root.headers.get('location'), '/login');
  for (const path of ['/login', '/login.js', '/styles.css']) assert.equal((await fetch(f.origin + path)).status, 200);
  for (const path of ['/api/state', '/app.js', '/voice-capture.js', '/voice-stream-capture.js', '/api/voice/stream', '/vendor/novnc/core/rfb.js', '/api/models', '/api/uploads', '/api/artifact-documents', '/api/artifact-commands/document-key-123', '/api/artifact-documents/doc-12345678-1234-1234-1234-123456789abc', '/api/artifact-documents/doc-12345678-1234-1234-1234-123456789abc/versions/ver-abcdef12-abcd-abcd-abcd-abcdef123456/content', '/api/artifacts', '/api/artifacts/' + 'a'.repeat(64) + '/content', '/api/computer', '/api/computer/approvals', '/api/computer/stream', '/api/voice', '/api/reminders', '/api/notifications', '/api/auth/devices']) assert.equal((await fetch(f.origin + path)).status, 401, path);
  const device = await f.login();
  assert.match(device.setCookie, /HttpOnly; SameSite=Strict/); assert.ok(!JSON.stringify(device.session).includes(device.cookie.split('=')[1]));
  const state = await (await fetch(f.origin + '/api/state', { headers: { cookie: device.cookie } })).json();
  assert.equal(state.csrfToken, device.session.csrfToken); assert.equal(state.authentication.session.ownerId, f.app.runtime!.store.binding()!.userId);
  assert.equal((await fetch(f.origin + '/', { headers: { cookie: device.cookie } })).status, 200); assert.equal(f.runtimeCalls(), 0);
});

test('HTTP login requires exact Origin, JSON bounds and protected mutations require this device CSRF', async t => {
  const f = await fixture(t), a = await f.login('A'), b = await f.login('B');
  for (const origin of [undefined, 'https://foreign.example']) {
    const response = await fetch(f.origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ credential, deviceLabel: 'Rejected' }) }); assert.equal(response.status, 403);
  }
  assert.equal((await fetch(f.origin + '/api/auth/login', { method: 'POST', headers: { origin: f.origin, 'content-type': 'text/plain' }, body: credential })).status, 415);
  assert.equal((await fetch(f.origin + '/api/auth/login', { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'secret'.repeat(1000), deviceLabel: 'Huge' }) })).status, 413);
  assert.equal((await f.post('/api/notifications/mode', a, { mode: 'off' }, b.session.csrfToken)).status, 403);
  assert.equal((await f.post('/api/notifications/mode', a, { mode: 'off' })).status, 200);
  assert.equal((await fetch(f.origin + '/api/auth/devices', { headers: { cookie: a.cookie, origin: 'https://foreign.example' } })).status, 403);
  const devices = await (await fetch(f.origin + '/api/auth/devices', { headers: { cookie: a.cookie } })).json(); assert.equal(devices.devices.length, 2); assert.equal(devices.devices.filter((d: any) => d.current).length, 1);
  const revoked = await f.post(`/api/auth/devices/${b.session.id}/revoke`, a); assert.equal(revoked.status, 200); assert.equal(revoked.headers.get('set-cookie'), null);
  assert.equal((await fetch(f.origin + '/api/state', { headers: { cookie: b.cookie } })).status, 401);
  assert.equal((await f.post('/api/auth/logout', a)).status, 200); assert.equal((await fetch(f.origin + '/api/state', { headers: { cookie: a.cookie } })).status, 401);
});

test('computer tickets are bound to the cookie session; revoke-all immediately closes active streams', async t => {
  const f = await fixture(t, true), a = await f.login('A'), b = await f.login('B');
  const preview = await (await f.post('/api/computer/preview', a)).json();
  assert.equal(await wsRejected(preview.connection, f.origin), 401); assert.equal(await wsRejected(preview.connection, f.origin, b.cookie), 401);
  assert.equal(await wsRejected(preview.connection, 'https://foreign.example', a.cookie), 403);
  const p = await wsOpen(preview.connection, f.origin, a.cookie);
  const state = await (await fetch(f.origin + '/api/computer', { headers: { cookie: a.cookie } })).json();
  const takeover = await (await f.post('/api/computer/takeover', a, { expectedEpoch: state.state.epoch })).json();
  const human = await wsOpen(takeover.connection, f.origin, a.cookie); human.send(Buffer.from('before-revoke')); await eventually(() => f.received.includes('before-revoke'));
  const queued = await (await f.post('/api/computer/preview', b)).json();
  const revoked = await f.post('/api/auth/revoke-all', b); assert.equal(revoked.status, 200); assert.match(revoked.headers.get('set-cookie')!, /Max-Age=0/);
  await eventually(() => p.readyState === WebSocket.CLOSED && human.readyState === WebSocket.CLOSED);
  assert.equal(f.app.computer.snapshot().state?.owner, 'paused'); assert.equal(await wsRejected(queued.connection, f.origin, b.cookie), 403);
  assert.equal((await fetch(f.origin + '/api/state', { headers: { cookie: a.cookie } })).status, 401);
});

test('session expiry stops preview output and human input independently of a still-valid lease', async t => {
  const f = await fixture(t, true), a = await f.login();
  const ticket = await (await f.post('/api/computer/takeover', a, { expectedEpoch: f.app.computer.snapshot().state!.epoch })).json();
  const ws = await wsOpen(ticket.connection, f.origin, a.cookie);
  // Auth clock changes only; the computer arbiter clock/lease has not expired.
  f.tick(61_000); ws.send(Buffer.from('expired-device-input'));
  await eventually(() => ws.readyState === WebSocket.CLOSED); assert.ok(!f.received.includes('expired-device-input'));
  assert.equal((await fetch(f.origin + '/api/state', { headers: { cookie: a.cookie } })).status, 401);
});

test('revocation during a private byte download prevents the response body from leaking', async t => {
  const f = await fixture(t), a = await f.login('A'), b = await f.login('B');
  let release!: () => void, entered!: () => void; const waiting = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  t.mock.method(f.app.runtime!, 'downloadArtifact', async () => { entered(); await gate; return { artifact: { name: 'private.txt' }, bytes: Buffer.from('PRIVATE-FIXTURE-BYTES') }; });
  const download = fetch(f.origin + '/api/artifacts/' + 'a'.repeat(64) + '/content', { headers: { cookie: a.cookie } });
  await waiting; await f.post(`/api/auth/devices/${a.session.id}/revoke`, b); release();
  const response = await download; assert.equal(response.status, 401); assert.ok(!(await response.text()).includes('PRIVATE-FIXTURE-BYTES'));
});

test('revocation while a mutation body is arriving refuses dispatch after the await', async t => {
  const f = await fixture(t), a = await f.login('A'), b = await f.login('B');
  let entered!: () => void; const waiting = new Promise<void>(r => { entered = r; });
  const listener = (req: any) => { if (req.url === '/api/notifications/mode') entered(); }; f.app.server.on('request', listener);
  let request!: ReturnType<typeof httpRequest>;
  const response = new Promise<number>((resolve, reject) => {
    request = httpRequest(f.origin + '/api/notifications/mode', { method: 'POST', headers: { origin: f.origin, cookie: a.cookie, 'content-type': 'application/json', 'x-opendots-csrf': a.session.csrfToken } }, res => { res.resume(); resolve(res.statusCode!); }); request.on('error', reject); request.write('{"mode":');
  });
  await waiting; await f.post(`/api/auth/devices/${a.session.id}/revoke`, b); request.end('"off"}');
  assert.equal(await response, 401); f.app.server.off('request', listener);
});

test('auth configuration is guarded before Runtime/desktop workers and cannot downgrade on restart', async t => {
  const f = await fixture(t), a = await f.login(); const owner = f.app.runtime!.store.binding()!.userId;
  await f.app.close();
  let runtimeCalls = 0;
  assert.throws(() => createApplication({ dbPath: f.dbPath, baseUrl: f.options.baseUrl, fetch: async () => { runtimeCalls++; throw Error('must not start'); } }), { code: 'authentication_configuration_required' });
  assert.equal(runtimeCalls, 0);
  const resumed = createApplication(f.options); await new Promise<void>(r => resumed.server.listen(f.port, '127.0.0.1', r)); await resumed.ready;
  assert.equal(resumed.runtime!.store.binding()!.userId, owner);
  assert.equal((await fetch(f.origin + '/api/state', { headers: { cookie: a.cookie } })).status, 200); await resumed.close();
  const wrongOrigin = createApplication(f.options); await new Promise<void>(r => wrongOrigin.server.listen(0, '127.0.0.1', r));
  await assert.rejects(wrongOrigin.ready, { code: 'authentication_owner_binding_mismatch' }); await wrongOrigin.close();
  assert.throws(() => createApplication({ dbPath: join(f.root, 'no-owner.sqlite'), authConfigPath: f.authConfigPath, autoStart: true }), { code: 'authentication_saved_owner_required' });
  assert.throws(() => createApplication({ ...f.options, authConfigPath: join(f.root, 'missing.json'), autoStart: true, fetch: async () => { runtimeCalls++; throw Error(); } }), { code: 'authentication_configuration_unavailable' }); assert.equal(runtimeCalls, 0);
});

test('shutdown waits for a pending native password verification and never issues its cookie', async t => {
  const password = 'isolated-fixture-password', saltHex = 'bc'.repeat(32);
  const hashHex = scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }).toString('hex');
  const f = await fixture(t, false, { ...syntheticConfig(), credential: { kind: 'scrypt', saltHex, hashHex, N: 131072, r: 8, p: 1 } });
  const login = fetch(f.origin + '/api/auth/login', { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ credential: password, deviceLabel: 'Pending shutdown' }) });
  await eventually(() => Boolean(f.app.store.db.prepare("SELECT 1 FROM auth_attempt_windows WHERE bucket='global'").get()));
  const closed = f.app.close(); const response = await login; assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null); await closed;
  const db = new DatabaseSync(f.dbPath); assert.equal((db.prepare('SELECT COUNT(*) AS count FROM auth_device_sessions').get() as any).count, 0); db.close();
});

test('revoked device cannot grant a pending exact-action approval after native revalidation awaits', async t => {
  const f = await fixture(t, false, syntheticConfig(), { computerHost: { nodeId: 'node', targetId: 'desktop', policyDigest: 'digest', workerId: 'worker', driver: {} as any, transport: () => { throw Error('No live transport in fixture'); } } }, app => { t.mock.method(app.computerHost!, 'start', () => {}); });
  const a = await f.login('A'), b = await f.login('B'); let held = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), waiting = new Promise<void>(r => { entered = r; });
  const binding = { nodeId: 'node', targetId: 'desktop', principalId: 'principal', agentId: 'agent', contextId: 'context', sessionId: 'session', policyDigest: 'digest' };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA5kAAAAASUVORK5CYII=', 'base64'), hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
  const observationId = '11111111-1111-4111-8111-111111111111';
  const approvals = new ComputerApprovals({ db: f.app.store.db, binding, revalidate: async () => { if (held) { entered(); await gate; } }, state: () => ({ owner: 'ai', epoch: 7, leaseUntil: Date.now() + 60_000 }), observation: () => ({ observationId, epoch: 7, display: { id: 'display', width: 1, height: 1 }, capturedAt: Date.now(), sha256: hash(png), png }) });
  f.app.computerHost!.approvals = approvals;
  const operation = { type: 'click' as const, x: 0, y: 0, button: 'left' as const };
  let granted = false;
  const permit = approvals.authorize({ principal_id: 'principal', agent_id: 'agent', context_id: 'context', session_id: 'session', thread_id: 'thread' }, { action: 'act', epoch: 7, observationId, operation }, { jobId: 'auth-approval-fixture', actionDigest: hash(JSON.stringify(operation)), signal: new AbortController().signal, expiresAt: Date.now() + 45_000 }).then(value => { granted = Boolean(value); }, () => {});
  await new Promise(r => setImmediate(r)); const pending = (await approvals.list()).approvals[0]; held = true;
  const decision = f.post(`/api/computer/approvals/${pending.id}/decision`, a, { decision: 'allow_once', expectedRevision: pending.revision });
  await waiting; await f.post(`/api/auth/devices/${a.session.id}/revoke`, b); release();
  assert.equal((await decision).status, 401); assert.equal(granted, false);
  assert.equal((f.app.store.db.prepare('SELECT status FROM computer_action_approvals WHERE id=?').get(pending.id) as any).status, 'pending');
  approvals.close(); await permit; assert.equal(granted, false);
});

test('revocation during model/account catalogue reads prevents the native write, without global auth state', async t => {
  let session: any, writes = 0, entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  let chatEntered!: () => void, releaseChat!: () => void, chatWrites = 0;
  const chatWaiting = new Promise<void>(r => { chatEntered = r; }), chatGate = new Promise<void>(r => { releaseChat = r; });
  const nativeFetch: typeof fetch = async (raw, init = {}) => {
    const path = new URL(String(raw)).pathname, method = init.method ?? 'GET';
    if (path === '/api/session-io/capabilities') return Response.json({ enabled: true, io_versions: ['1'], encodings: ['json'], formats: [{ definition: { id: 'morphz.chat', version: '1', encodings: ['json'] } }] });
    if (path === '/api/agents' && method === 'GET') return Response.json({ agents: [] });
    if (path === '/api/agents' && method === 'POST') { const input = JSON.parse(String(init.body)); session = { id: input.initial_session_id, agent_id: input.id, context_id: input.root_context_id, status: 'active' }; return Response.json({ initial_session: session }); }
    if (path.endsWith('/principal')) return Response.json({ principal_id: 'principal', session_id: session.id, context_id: session.context_id });
    if (path.endsWith('/io/messages')) { chatWrites++; chatEntered(); await chatGate; return Response.json({ session_id: session.id, status: 'accepted', accepted: true, event_id: 'fixture-durable-event' }); }
    if (path.startsWith('/api/sessions/')) return session ? Response.json(session) : new Response('', { status: 404 });
    if (path === '/api/runtime/providers') { entered(); await gate; return Response.json({ auth_accounts: { 'fixture-account': { config: { label: 'Fixture', provider: 'fixture' }, effective_enabled: true } }, model_routes: {} }); }
    if (path === '/api/runtime/inference') return Response.json({ model: 'fixture', model_options: [{ id: 'fixture' }] });
    if (path.endsWith('/provider-accounts')) return Response.json({ bindings: [], revision: 0 });
    if (path.endsWith('/provider-accounts/fixture-account') && method === 'PUT') { writes++; return Response.json({}); }
    throw Error('Unexpected isolated native fixture route');
  };
  const f = await fixture(t, false, syntheticConfig(), { fetch: nativeFetch }), a = await f.login('A'), b = await f.login('B');
  const mutation = f.post('/api/models/account', a, { accountId: 'fixture-account' });
  await waiting;
  assert.equal((await fetch(f.origin + '/api/state', { headers: { cookie: b.cookie } })).status, 200);
  await f.post(`/api/auth/devices/${a.session.id}/revoke`, b); release();
  assert.equal((await mutation).status, 401); assert.equal(writes, 0);
  assert.equal((await f.post('/api/models/account', b, { accountId: 'fixture-account' })).status, 200); assert.equal(writes, 1);
  // An already durably admitted command is different from a later settings write.
  const c = await f.login('C'), message = { text: 'Fixture accepted background input', idempotencyKey: 'auth-admitted-command' };
  const chat = f.post('/api/chat', b, message); await chatWaiting;
  assert.ok(f.app.runtime!.store.commandByKey(message.idempotencyKey));
  await f.post(`/api/auth/devices/${b.session.id}/revoke`, c); releaseChat();
  assert.equal((await chat).status, 401); assert.equal(f.app.runtime!.store.commandByKey(message.idempotencyKey)!.status, 'accepted');
  assert.equal((await f.post('/api/chat', c, message)).status, 202); assert.equal(chatWrites, 1);
});

test('return-to-AI rechecks synchronous authorization at the final grant transaction', async () => {
  let current = true, revokedAt = '';
  const gateway = new ComputerGateway({ dbPath: ':memory:', previewPort: 5901, controlPort: 5902, previewReadOnlyEnforced: true, captureSettledObservation: async () => {
    queueMicrotask(() => queueMicrotask(() => { current = false; revokedAt = gateway.snapshot().state!.owner; gateway.revokeSessions('device-fixture'); }));
    return { id: 'synthetic-fresh-observation', capturedAt: Date.now() };
  } });
  try {
    await assert.rejects(gateway.returnToAi(0, false, () => { if (!current) throw Error('owner revoked'); }), /owner revoked/);
    assert.equal(revokedAt, 'transition'); assert.equal(gateway.snapshot().state?.owner, 'paused');
  } finally { await gateway.close(); }
});
