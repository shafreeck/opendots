import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect, createServer as tcpServer, type Socket } from 'node:net';
import { WebSocket } from 'ws';
import { authDigest } from '../src/auth-config.ts';
import { canonicalPublicOrigin } from '../src/application-origin.ts';
import { createApplication, type ApplicationOptions } from '../src/server.ts';
import { ComputerGateway } from '../src/computer-gateway.ts';

// All sockets are real local HTTP/WS fixtures. Canonical headers simulate the
// trusted proxy-to-BFF hop; these tests do not provide or attest browser TLS.
const credential = 'd'.repeat(64);
const syntheticConfig = { version: 1, credential: { kind: 'morphz_login_token_sha256', hashHex: authDigest(credential) }, sessionTtlSeconds: 3600, idleTtlSeconds: 60, maximumDevices: 8 };
type Device = { cookie: string; setCookie: string; session: { id: string; csrfToken: string; ownerId: string } };
type Reply = { status: number; headers: IncomingHttpHeaders; text: string; json: any };
type RequestInput = { method?: string; headers?: Record<string, string | undefined>; rawHeaders?: string[]; body?: object };
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() >= deadline) assert.fail('Local transport did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(t: test.TestContext, publicOrigin = 'https://dots.example:443/', computerEnabled = false) {
  const root = mkdtempSync(join(tmpdir(), 'opendots-remote-test-')), dbPath = join(root, 'app.sqlite'), authConfigPath = join(root, 'auth.json');
  writeFileSync(authConfigPath, JSON.stringify(syntheticConfig), { mode: 0o600 });
  const origin = canonicalPublicOrigin(publicOrigin), host = new URL(origin).host;
  const sockets = new Set<Socket>(), received: string[] = [];
  const endpoint = () => tcpServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('data', bytes => received.push(bytes.toString())); socket.write('synthetic-rfb'); });
  const preview = computerEnabled ? endpoint() : undefined, control = computerEnabled ? endpoint() : undefined;
  if (preview && control) await Promise.all([new Promise<void>(r => preview.listen(0, '127.0.0.1', r)), new Promise<void>(r => control.listen(0, '127.0.0.1', r))]);
  let now = Date.now(), runtimeCalls = 0;
  const options: ApplicationOptions = { dbPath, authConfigPath, publicOrigin, baseUrl: 'http://127.0.0.1:39997', autoStart: false, authNow: () => now, fetch: async () => { runtimeCalls++; throw Error('Fixture Runtime offline'); }, ...(preview && control ? { computer: { previewPort: (preview.address() as any).port, controlPort: (control.address() as any).port, previewReadOnlyEnforced: true } } : {}) };
  const app = createApplication(options);
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r)); await app.ready;
  const address = app.server.address(); assert.ok(address && typeof address !== 'string'); assert.equal(address.address, '127.0.0.1');
  const port = address.port;
  const invoke = (path: string, input: RequestInput = {}) => new Promise<Reply>((resolve, reject) => {
    const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
    const headers = input.rawHeaders ?? Object.fromEntries(Object.entries({ host, connection: 'close', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }), ...input.headers }).filter(([, value]) => value !== undefined));
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: input.method ?? 'GET', headers }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', data => { text += data; }); response.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: response.statusCode!, headers: response.headers, text, json }); });
    }); req.on('error', reject); req.end(payload);
  });
  const login = async (deviceLabel = 'Synthetic phone'): Promise<Device> => {
    const response = await invoke('/api/auth/login', { method: 'POST', headers: { origin }, body: { credential, deviceLabel } });
    assert.equal(response.status, 200); const setCookie = response.headers['set-cookie']![0];
    return { cookie: setCookie.split(';')[0], setCookie, session: response.json.session };
  };
  const post = (path: string, device: Device, body: object = {}, headers: Record<string, string | undefined> = {}) => invoke(path, { method: 'POST', headers: { origin, cookie: device.cookie, 'x-opendots-csrf': device.session.csrfToken, ...headers }, body });
  t.after(async () => { await app.close(); for (const socket of sockets) socket.destroy(); await Promise.all([preview && new Promise<void>(r => preview.close(() => r())), control && new Promise<void>(r => control.close(() => r()))]); rmSync(root, { recursive: true, force: true }); });
  return { app, options, root, port, origin, host, invoke, login, post, received, tick: (milliseconds: number) => { now += milliseconds; }, runtimeCalls: () => runtimeCalls };
}
async function openSocket(f: { port: number; origin: string; host: string }, connection: any, cookie?: string, extra: Record<string, string> = {}) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/computer/stream`, connection.protocols, { origin: f.origin, headers: { host: f.host, ...(cookie ? { cookie } : {}), ...extra } });
    ws.once('error', reject); ws.once('open', () => resolve(ws));
  });
}
async function rejectedSocket(f: { port: number; origin: string; host: string }, connection: any, cookie?: string, extra: { origin?: string; host?: string; noOrigin?: boolean } = {}) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/computer/stream`, connection.protocols, { ...(extra.noOrigin ? {} : { origin: extra.origin ?? f.origin }), headers: { host: extra.host ?? f.host, ...(cookie ? { cookie } : {}) } });
    ws.once('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!); });
    ws.once('open', () => { ws.terminate(); reject(Error('Unexpected accepted fixture socket')); }); ws.on('error', () => {});
  });
}
async function rawUpgrade(port: number, headers: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }); let text = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(Error('Raw fixture upgrade timed out')); });
    socket.on('error', reject); socket.on('connect', () => socket.write(['GET /api/computer/stream HTTP/1.1', ...headers, '', ''].join('\r\n')));
    socket.on('data', bytes => { text += bytes.toString(); const match = text.match(/^HTTP\/1\.1 (\d{3}) /); if (match) { socket.destroy(); resolve(Number(match[1])); } });
  });
}

test('canonical HTTPS login emits Secure host-only cookies and preserves native Runtime identity', async t => {
  const f = await fixture(t), device = await f.login();
  assert.equal((await f.invoke('/')).status, 303);
  assert.equal((await f.invoke('/api/state')).status, 401);
  assert.match(device.setCookie, /^__Host-opendots_owner_[a-f0-9]{16}=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600; Secure$/);
  assert.ok(!device.setCookie.includes('Domain='));
  const state = await f.invoke('/api/state', { headers: { cookie: device.cookie } });
  assert.equal(state.status, 200); assert.equal(state.json.csrfToken, device.session.csrfToken);
  assert.match(String(state.headers['content-security-policy']), /connect-src 'self' wss:\/\/dots\.example;/);
  assert.equal(state.json.authentication.session.id, device.session.id);
  assert.equal(f.app.runtime!.adapter!.baseUrl, 'http://127.0.0.1:39997');
  assert.equal(f.app.runtime!.store.binding()!.runtimeOrigin, 'http://127.0.0.1:39997');
  assert.equal(f.runtimeCalls(), 0);
  assert.equal((f.app.store.db.prepare('SELECT origin FROM auth_owner_state').get() as any).origin, f.origin);
  assert.ok(!JSON.stringify(state.json).includes(device.cookie.split('=')[1]));
});

test('HTTPS HTTP rejects local aliases, ambiguous headers, noncanonical origin and forwarding-header spoofing', async t => {
  const f = await fixture(t), device = await f.login();
  for (const host of [`127.0.0.1:${f.port}`, `localhost:${f.port}`, 'dots.example:443', 'DOTS.example', 'dots.example.evil']) assert.equal((await f.invoke('/api/auth', { headers: { host, forwarded: 'proto=https;host=dots.example', 'x-forwarded-host': f.host, 'x-forwarded-proto': 'https' } })).status, 403, host);
  for (const origin of ['http://dots.example', `http://127.0.0.1:${f.port}`, 'https://dots.example:443', 'https://dots.example/', 'null', 'https://evil.example']) assert.equal((await f.post('/api/notifications/mode', device, { mode: 'off' }, { origin })).status, 403, origin);
  for (const extra of [['Host', f.host], ['hOsT', 'evil.example'], ['Origin', f.origin], ['Sec-Fetch-Site', 'same-origin']]) {
    const response = await f.invoke('/api/state', { rawHeaders: ['Host', f.host, 'Origin', f.origin, 'Sec-Fetch-Site', 'same-origin', 'Cookie', device.cookie, 'Connection', 'close', ...extra] });
    assert.equal(response.status, 403, extra.join(':'));
  }
  assert.equal((await f.invoke('https://evil.example/api/state', { headers: { cookie: device.cookie } })).status, 400);
  assert.equal((await f.invoke('//evil.example/api/state', { headers: { cookie: device.cookie } })).status, 400);
  assert.equal((await f.invoke('/api/state', { headers: { cookie: device.cookie, forwarded: 'host=evil.example', 'x-forwarded-host': 'evil.example' } })).status, 200);
});

test('HTTPS mutations require canonical Origin and device-specific CSRF with no legacy fallback', async t => {
  const f = await fixture(t), a = await f.login('A'), b = await f.login('B');
  assert.equal((await f.invoke('/api/auth/login', { method: 'POST', body: { credential, deviceLabel: 'No Origin' } })).status, 403);
  assert.equal((await f.post('/api/notifications/mode', a, { mode: 'off' }, { origin: undefined })).status, 403);
  assert.equal((await f.post('/api/notifications/mode', a, { mode: 'off' }, { 'x-opendots-csrf': b.session.csrfToken })).status, 403);
  assert.equal((await f.post('/api/notifications/mode', a, { mode: 'off' }, { 'sec-fetch-site': 'none' })).status, 403);
  assert.equal((await f.post('/api/notifications/mode', a, { mode: 'off' }, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await f.post('/api/notifications/mode', a, { mode: 'off' })).status, 200);
  const loggedOut = await f.post('/api/auth/logout', a);
  assert.equal(loggedOut.status, 200); assert.match(loggedOut.headers['set-cookie']![0], /^__Host-.*; Max-Age=0; Secure$/);
  assert.equal((await f.invoke('/api/state', { headers: { cookie: a.cookie } })).status, 401);
  assert.equal((await f.invoke('/api/state', { headers: { cookie: b.cookie } })).status, 200);
});

test('WSS tickets retain canonical origin, cookie binding, epochs and logout stream revocation', async t => {
  const f = await fixture(t, 'https://dots.example:8443/', true), a = await f.login('A'), b = await f.login('B');
  const preview = await f.post('/api/computer/preview', a); assert.equal(preview.status, 200);
  assert.equal(preview.json.connection.url, 'wss://dots.example:8443/api/computer/stream');
  assert.equal(preview.json.connection.viewOnly, true); assert.equal(new URL(preview.json.connection.url).search, '');
  for (const extra of [{ noOrigin: true }, { origin: `http://127.0.0.1:${f.port}` }, { host: `127.0.0.1:${f.port}` }, { host: `localhost:${f.port}` }, { origin: 'https://evil.example' }]) assert.equal(await rejectedSocket(f, preview.json.connection, a.cookie, extra), 403);
  assert.equal(await rejectedSocket(f, preview.json.connection), 401);
  assert.equal(await rejectedSocket(f, preview.json.connection, b.cookie), 401);
  const p = await openSocket(f, preview.json.connection, a.cookie);
  assert.equal(await rejectedSocket(f, preview.json.connection, a.cookie), 403);
  const human = await f.post('/api/computer/takeover', a, { expectedEpoch: f.app.computer.snapshot().state!.epoch });
  assert.equal(human.status, 200); assert.equal(human.json.connection.url, 'wss://dots.example:8443/api/computer/stream');
  const h = await openSocket(f, human.json.connection, a.cookie); h.send(Buffer.from('before-logout'));
  await eventually(() => f.received.includes('before-logout'));
  const queued = await f.post('/api/computer/preview', a);
  assert.equal((await f.post('/api/auth/logout', a)).status, 200);
  await eventually(() => p.readyState === WebSocket.CLOSED && h.readyState === WebSocket.CLOSED);
  assert.equal(f.app.computer.snapshot().state!.owner, 'paused');
  assert.equal(await rejectedSocket(f, queued.json.connection, a.cookie), 403);
  assert.equal((await f.post('/api/computer/renew', b, { epoch: human.json.state.epoch })).status, 409);
});

test('HTTPS upgrade rejects duplicate headers; expiry and revoke-all still close current streams', async t => {
  const f = await fixture(t, 'https://dots.example', true), a = await f.login();
  const ticket = (await f.post('/api/computer/preview', a)).json.connection;
  const base = [`Host: ${f.host}`, `Origin: ${f.origin}`, `Cookie: ${a.cookie}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Protocol: ${ticket.protocols.join(', ')}`];
  for (const duplicate of [`Host: ${f.host}`, `Origin: ${f.origin}`]) assert.equal(await rawUpgrade(f.port, [...base, duplicate]), 403);
  const socket = await openSocket(f, ticket, a.cookie); f.tick(61_000);
  await eventually(() => socket.readyState === WebSocket.CLOSED);
  const b = await f.login('After expiry'), next = (await f.post('/api/computer/preview', b)).json.connection;
  const current = await openSocket(f, next, b.cookie);
  assert.equal((await f.post('/api/auth/revoke-all', b)).status, 200);
  await eventually(() => current.readyState === WebSocket.CLOSED);
});

test('public origin preflight refuses missing owner auth and invalid URLs before storage or Runtime calls', t => {
  const root = mkdtempSync(join(tmpdir(), 'opendots-origin-preflight-')), dbPath = join(root, 'absent', 'app.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true })); let calls = 0;
  for (const publicOrigin of ['https://dots.example', 'http://dots.example', 'https://dots.example/path', '']) {
    assert.throws(() => createApplication({ dbPath, publicOrigin, baseUrl: 'http://127.0.0.1:39997', fetch: async () => { calls++; throw Error(); } }));
    assert.equal(existsSync(dbPath), false);
  }
  assert.equal(calls, 0);
  assert.throws(() => new ComputerGateway({ dbPath: ':memory:', publicOrigin: 'https://dots.example' }), /owner authentication/);
});

test('origin-bound DB remains fail-closed across local/HTTPS and HTTPS-origin changes without migration', async t => {
  const f = await fixture(t), device = await f.login(); await f.app.close();
  for (const publicOrigin of [undefined, 'https://other.example']) {
    const changed = createApplication({ ...f.options, publicOrigin });
    await new Promise<void>(r => changed.server.listen(0, '127.0.0.1', r));
    await assert.rejects(changed.ready, { code: 'authentication_owner_binding_mismatch' }); await changed.close();
  }
  const restored = createApplication(f.options);
  await new Promise<void>(r => restored.server.listen(f.port, '127.0.0.1', r)); await restored.ready;
  assert.equal((await f.invoke('/api/state', { headers: { cookie: device.cookie } })).status, 200);
  assert.equal((restored.store.db.prepare('SELECT origin FROM auth_owner_state').get() as any).origin, f.origin);
  await restored.close();
  assert.throws(() => createApplication({ ...f.options, authConfigPath: undefined }), { code: 'application_origin_owner_auth_required' });
});

test('a saved previously unauthenticated owner can first bind HTTPS; an existing local auth binding cannot', async t => {
  const root = mkdtempSync(join(tmpdir(), 'opendots-origin-first-bind-')), dbPath = join(root, 'app.sqlite'), authConfigPath = join(root, 'auth.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(authConfigPath, JSON.stringify(syntheticConfig), { mode: 0o600 });
  const base = { dbPath, baseUrl: 'http://127.0.0.1:39997', autoStart: false };
  const local = createApplication(base); await new Promise<void>(r => local.server.listen(0, '127.0.0.1', r)); await local.ready;
  const owner = local.runtime!.store.binding()!.userId; await local.close();
  const https = createApplication({ ...base, authConfigPath, publicOrigin: 'https://dots.example' });
  await new Promise<void>(r => https.server.listen(0, '127.0.0.1', r)); await https.ready;
  assert.equal(https.runtime!.store.binding()!.userId, owner); await https.close();
  const localDbPath = join(root, 'local-auth.sqlite'), authenticated = createApplication({ ...base, dbPath: localDbPath, authConfigPath });
  await new Promise<void>(r => authenticated.server.listen(0, '127.0.0.1', r)); await authenticated.ready; await authenticated.close();
  const moved = createApplication({ ...base, dbPath: localDbPath, authConfigPath, publicOrigin: 'https://dots.example' });
  await new Promise<void>(r => moved.server.listen(0, '127.0.0.1', r));
  await assert.rejects(moved.ready, { code: 'authentication_owner_binding_mismatch' }); await moved.close();
});

test('HTTPS mode cannot bind an external listener or retarget the native Morphz operator origin', async t => {
  const f = await fixture(t); await f.app.close();
  assert.throws(() => createApplication({ ...f.options, dbPath: join(f.root, 'remote-runtime.sqlite'), baseUrl: 'https://dots.example' }), /loopback Morphz origin/);
  // Simulate the listener metadata violation without opening a public socket.
  const invalid = createApplication({ ...f.options, dbPath: join(f.root, 'invalid-listener.sqlite') });
  const realAddress = invalid.server.address.bind(invalid.server);
  t.mock.method(invalid.server, 'address', () => { const address = realAddress(); return address && typeof address !== 'string' ? { ...address, address: '0.0.0.0' } : address; });
  await new Promise<void>(r => invalid.server.listen(0, '127.0.0.1', r));
  await assert.rejects(invalid.ready, { code: 'authentication_loopback_listener_required' }); await invalid.close();
});

test('unauthenticated local development preserves localhost and its existing CSRF-only POST contract', async t => {
  const root = mkdtempSync(join(tmpdir(), 'opendots-origin-legacy-'));
  const app = createApplication({ dbPath: join(root, 'demo.sqlite'), mode: 'demo', startWorker: false });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r)); await app.ready;
  const port = (app.server.address() as any).port;
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const invoke = (path: string, method = 'GET', body?: object, csrf?: string) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { host: `localhost:${port}`, 'content-type': 'application/json', ...(csrf ? { 'x-opendots-csrf': csrf } : {}) } }, response => { let value = ''; response.on('data', data => { value += data; }); response.on('end', () => resolve({ status: response.statusCode!, json: JSON.parse(value) })); });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const state = await invoke('/api/state'); assert.equal(state.status, 200); assert.equal(state.json.authentication.enabled, false);
  const input = { text: 'Legacy local fixture', idempotencyKey: 'legacy-local-fixture' };
  assert.equal((await invoke('/api/chat', 'POST', input)).status, 403);
  assert.equal((await invoke('/api/chat', 'POST', input, state.json.csrfToken)).status, 200);
});
