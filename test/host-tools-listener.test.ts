import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeHostListener, HOST_CALENDAR_PATH, HOST_CONNECTOR_PATH, type NativeHostRoute } from '../src/host-tools-listener.ts';
import { ConnectorError } from '../src/connector-types.ts';

const CONNECTOR_TOKEN = 'connector-synthetic-test-token-only'.repeat(2);
const CALENDAR_TOKEN = 'calendar-synthetic-test-token-only'.repeat(2);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
interface Reply { status: number; body: string; headers: IncomingHttpHeaders }
async function fixture(t: test.TestContext, handle?: NativeHostRoute['handle']) {
  const calls: Array<{ path: string; authorization: string; body: unknown; signal: AbortSignal }> = [];
  const port = await unusedPort();
  const requests = new Set<ClientRequest>();
  const routes: NativeHostRoute[] = [
    { path: HOST_CONNECTOR_PATH, token: CONNECTOR_TOKEN, handle: async (authorization, body, signal) => { calls.push({ path: HOST_CONNECTOR_PATH, authorization, body, signal }); return handle ? handle(authorization, body, signal) : { route: 'connectors', body }; } },
    { path: HOST_CALENDAR_PATH, token: CALENDAR_TOKEN, handle: async (authorization, body, signal) => { calls.push({ path: HOST_CALENDAR_PATH, authorization, body, signal }); return handle ? handle(authorization, body, signal) : { route: 'calendar', body }; } },
  ];
  const listener = new NativeHostListener({ port, routes });
  t.after(async () => { for (const request of requests) request.destroy(); await listener.close(); });
  function open(options: { path?: string; token?: string; headers?: Record<string, string>; method?: string; localAddress?: string } = {}) {
    let request!: ClientRequest;
    const response = new Promise<Reply>((resolve, reject) => {
      request = httpRequest({ host: '127.0.0.1', port, localAddress: options.localAddress, path: options.path ?? HOST_CONNECTOR_PATH, method: options.method ?? 'POST', agent: false,
        headers: { authorization: `Bearer ${options.token ?? CONNECTOR_TOKEN}`, 'content-type': 'application/json', ...options.headers } }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => resolve({ status: incoming.statusCode!, body: Buffer.concat(chunks).toString(), headers: incoming.headers }));
      });
      request.on('error', reject);
      requests.add(request); request.once('close', () => requests.delete(request));
    });
    return { request, response };
  }
  async function post(options: Parameters<typeof open>[0] = {}, body: string | Buffer = '{"synthetic":true}') {
    const call = open(options); call.request.end(body); return call.response;
  }
  return { port, listener, routes, calls, open, post };
}

test('construction has no listening side effect; start and close are idempotent and never reopen', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.listener.snapshot(), { listening: false, closed: false });
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(f.port, '127.0.0.1', resolve));
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const first = f.listener.start(); assert.equal(first, f.listener.start()); await first;
  assert.deepEqual(f.listener.snapshot(), { listening: true, closed: false });
  const close = f.listener.close(); assert.equal(close, f.listener.close());
  assert.deepEqual(f.listener.snapshot(), { listening: false, closed: true });
  await close;
  await assert.rejects(f.listener.start(), { code: 'connector_host_closed' });
});

test('the fixed routes have isolated bearers and pass the original authorization and JSON to their handler', async t => {
  const f = await fixture(t); await f.listener.start();
  assert.equal((await f.post({ token: CALENDAR_TOKEN })).status, 401);
  assert.equal((await f.post({ path: HOST_CALENDAR_PATH, token: CONNECTOR_TOKEN })).status, 401);
  assert.equal(f.calls.length, 0);
  const connector = await f.post(); assert.equal(connector.status, 200);
  assert.deepEqual(JSON.parse(connector.body), { route: 'connectors', body: { synthetic: true } });
  const calendar = await f.post({ path: HOST_CALENDAR_PATH, token: CALENDAR_TOKEN }); assert.equal(calendar.status, 200);
  assert.deepEqual(JSON.parse(calendar.body), { route: 'calendar', body: { synthetic: true } });
  assert.equal(f.calls[0]!.authorization, `Bearer ${CONNECTOR_TOKEN}`);
  assert.equal(f.calls[1]!.authorization, `Bearer ${CALENDAR_TOKEN}`);
  assert.equal(connector.headers['cache-control'], 'no-store');
  assert.equal(connector.headers['x-content-type-options'], 'nosniff');
});

test('browser headers, including empty headers, are rejected before reading a partial body', async t => {
  const f = await fixture(t); await f.listener.start();
  for (const header of ['origin', 'cookie', 'sec-fetch-site', 'x-opendots-csrf']) {
    for (const value of ['browser', '']) {
      const { request, response } = f.open({ headers: { [header]: value, 'content-length': '60000' } });
      request.flushHeaders(); request.write('{');
      const reply = await response;
      assert.equal(reply.status, 403, header);
      assert.deepEqual(JSON.parse(reply.body), { error: 'connector_browser_callback_denied', code: 'connector_browser_callback_denied' });
      request.destroy();
    }
  }
  assert.equal(f.calls.length, 0);
});

test('only exact POST paths, numeric Host, and JSON content type are accepted', async t => {
  const f = await fixture(t); await f.listener.start();
  for (const path of [HOST_CONNECTOR_PATH + '?x=1', HOST_CONNECTOR_PATH + '?', HOST_CALENDAR_PATH + '/', '/api/host-tools/other/call', '/']) assert.equal((await f.post({ path })).status, 404);
  for (const method of ['GET', 'PUT', 'OPTIONS']) assert.equal((await f.post({ method }, '')).status, 404);
  for (const host of [`localhost:${f.port}`, `127.0.0.1:${f.port + 1}`, '127.0.0.1']) assert.equal((await f.post({ headers: { host } })).status, 403);
  assert.equal((await f.post({ localAddress: '127.0.0.2' })).status, 403);
  assert.equal((await f.post({ headers: { authorization: 'Bearer incorrect' } })).status, 401);
  assert.equal((await f.post({ headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(f.calls.length, 0);
});

test('JSON reader enforces 64 KiB for declared and streaming bodies and rejects malformed UTF-8', async t => {
  const f = await fixture(t); await f.listener.start();
  const maximum = JSON.stringify('x'.repeat(65_534));
  assert.equal(Buffer.byteLength(maximum), 65_536);
  assert.equal((await f.post({}, maximum)).status, 200);
  assert.equal((await f.post({}, JSON.stringify('x'.repeat(65_535)))).status, 413);
  assert.equal((await f.post({}, '{')).status, 400);
  assert.equal((await f.post({}, Buffer.from([0x22, 0xc3, 0x28, 0x22]))).status, 400);
  const declared = f.open({ headers: { 'content-length': '65537' } }); declared.request.flushHeaders();
  assert.equal((await declared.response).status, 413); declared.request.destroy();
  const streaming = f.open({ headers: { 'transfer-encoding': 'chunked' } });
  streaming.request.write('"' + 'x'.repeat(40_000)); streaming.request.end('x'.repeat(30_000) + '"');
  assert.equal((await streaming.response).status, 413);
  assert.equal(f.calls.length, 1);
});

test('unknown errors cannot leak secrets and known codes have fixed statuses', async t => {
  const f = await fixture(t, async (_authorization, body) => {
    if (body === 'raw') throw new Error('SYNTHETIC_SECRET');
    if (body === 'code') throw new ConnectorError('SYNTHETIC_SECRET', 418);
    if (body === 'prototype') throw new ConnectorError('constructor', 200);
    if (body === 'calendar') throw new ConnectorError('calendar_proposal_limit', 200);
    throw new ConnectorError('connector_permission_denied', 200);
  });
  await f.listener.start();
  for (const body of ['raw', 'code', 'prototype']) {
    const reply = await f.post({}, JSON.stringify(body)); assert.equal(reply.status, 503);
    assert.deepEqual(JSON.parse(reply.body), { error: 'connector_callback_unavailable', code: 'connector_callback_unavailable' });
  }
  assert.equal((await f.post({}, '"permission"')).status, 403);
  assert.equal((await f.post({}, '"calendar"')).status, 409);
});

test('shutdown aborts immediately and drains handlers even if their cleanup outlives the HTTP response', async t => {
  const began = deferred(), aborted = deferred(), finish = deferred();
  t.after(() => finish.resolve());
  let complete = false, nestedClose: Promise<void> | undefined;
  const f = await fixture(t, async (_authorization, _body, signal) => {
    signal.addEventListener('abort', () => { aborted.resolve(); nestedClose = f.listener.close(); }, { once: true });
    began.resolve(); await finish.promise; complete = true; return { done: true };
  });
  await f.listener.start(); const reply = f.post(); await began.promise;
  let closed = false; const closing = f.listener.close(); void closing.then(() => { closed = true; });
  assert.equal(closing, f.listener.close()); assert.equal(closing, nestedClose);
  await aborted.promise;
  assert.deepEqual(f.listener.snapshot(), { listening: false, closed: true });
  assert.equal((await reply).status, 503);
  assert.equal(closed, false); assert.equal(complete, false);
  finish.resolve(); await closing; assert.equal(complete, true);
  assert.equal(f.calls.length, 1);
});

test('close during a partially supplied body completes without dispatch or an uncaught late stream error', async t => {
  const f = await fixture(t); await f.listener.start();
  const partial = f.open({ headers: { 'content-length': '60000' } });
  // Install rejection handling immediately: shutdown may reset this incomplete peer.
  const outcome = partial.response.catch(() => null);
  partial.request.flushHeaders(); partial.request.write('{');
  await delay(20);
  await f.listener.close(); partial.request.destroy(new Error('synthetic late peer reset'));
  const reply = await outcome;
  if (reply) assert.equal(reply.status, 503);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.listener.snapshot(), { listening: false, closed: true });
});

test('closing immediately during startup leaves no listener and does not hang', async t => {
  const f = await fixture(t);
  const startup = f.listener.start(); const outcome = startup.catch(error => error);
  await f.listener.close(); const result: unknown = await outcome;
  assert.ok(result === undefined || result instanceof ConnectorError);
  assert.deepEqual(f.listener.snapshot(), { listening: false, closed: true });
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(f.port, '127.0.0.1', resolve));
  await new Promise<void>(resolve => probe.close(() => resolve()));
});

test('a port conflict fails closed without touching the existing service', async t => {
  const f = await fixture(t); const existing = createServer((_request, response) => response.end('existing'));
  await new Promise<void>(resolve => existing.listen(f.port, '127.0.0.1', resolve));
  t.after(async () => { existing.closeAllConnections(); await new Promise<void>(resolve => existing.close(() => resolve())); });
  await assert.rejects(f.listener.start(), { code: 'connector_callback_unavailable' });
  assert.deepEqual(f.listener.snapshot(), { listening: false, closed: false });
  assert.equal((await f.post()).body, 'existing'); assert.equal(f.calls.length, 0);
  await f.listener.close(); assert.equal((await f.post()).body, 'existing');
});

test('constructor refuses additional routes, duplicate paths or tokens, and invalid ports', async () => {
  const route: NativeHostRoute = { path: HOST_CONNECTOR_PATH, token: CONNECTOR_TOKEN, handle: async () => ({}) };
  for (const routes of [[], [route, route], [route, { ...route, path: HOST_CALENDAR_PATH }], [{ ...route, path: '/proxy' }], [{ ...route, token: '' }]]) {
    assert.throws(() => new NativeHostListener({ port: 12345, routes: routes as NativeHostRoute[] }), ConnectorError);
  }
  for (const port of [0, -1, 1023, 65536, 1234.5, NaN]) assert.throws(() => new NativeHostListener({ port, routes: [route] }), ConnectorError);
});

test('duplicate singleton authorization and Host headers are rejected without dispatch', async t => {
  const f = await fixture(t); await f.listener.start();
  async function raw(extra: string) {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(f.port, '127.0.0.1'); const chunks: Buffer[] = [];
      socket.on('error', reject); socket.on('data', chunk => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
      socket.once('connect', () => socket.end(`POST ${HOST_CONNECTOR_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nAuthorization: Bearer ${CONNECTOR_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n${extra}\r\n{}`));
    });
  }
  assert.match(await raw(`Host: 127.0.0.1:${f.port}\r\n`), /^HTTP\/1.1 403/);
  assert.match(await raw(`Authorization: Bearer ${CONNECTOR_TOKEN}\r\n`), /^HTTP\/1.1 401/);
  assert.equal(f.calls.length, 0);
});

test('the five-second body deadline terminates a stalled request without invoking its domain', { timeout: 8_000 }, async t => {
  const f = await fixture(t); await f.listener.start();
  const partial = f.open({ headers: { 'content-length': '60000' } });
  const started = Date.now(); partial.request.flushHeaders(); partial.request.write('{');
  const reply = await partial.response;
  assert.equal(reply.status, 503); assert.ok(Date.now() - started >= 4_900);
  assert.equal(f.calls.length, 0);
});

test('the fifteen-second total deadline aborts and bounds an uncooperative domain response while close still drains it', { timeout: 18_000 }, async t => {
  const finish = deferred(), began = deferred(), aborted = deferred();
  t.after(() => finish.resolve());
  const f = await fixture(t, async (_authorization, _body, signal) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    began.resolve(); await finish.promise; return { late: true };
  });
  await f.listener.start(); const started = Date.now(); const response = f.post(); await began.promise;
  const reply = await response; await aborted.promise;
  assert.equal(reply.status, 503); assert.ok(Date.now() - started >= 14_900);
  let closed = false; const closing = f.listener.close(); void closing.then(() => { closed = true; });
  await delay(10); assert.equal(closed, false);
  finish.resolve(); await closing;
});
