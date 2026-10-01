import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationOriginError, canonicalPublicOrigin, createApplicationOrigin, type OriginRequest } from '../src/application-origin.ts';

const local = (port = 3210) => createApplicationOrigin({ localPort: port, ownerAuthEnabled: false });
const remote = (publicOrigin = 'https://dots.example') => createApplicationOrigin({ localPort: 3210, ownerAuthEnabled: true, publicOrigin });
function request(host: unknown, origin?: unknown, site?: unknown): OriginRequest {
  const headers: Record<string, unknown> = { host };
  const rawHeaders = ['Host', String(host)];
  if (origin !== undefined) { headers.origin = origin; rawHeaders.push('Origin', String(origin)); }
  if (site !== undefined) { headers['sec-fetch-site'] = site; rawHeaders.push('Sec-Fetch-Site', String(site)); }
  return { headers, rawHeaders };
}

test('default policy names only the numeric-loopback listener without enabling remote access', () => {
  const policy = local();
  assert.equal(policy.mode, 'loopback');
  assert.equal(policy.origin, 'http://127.0.0.1:3210');
  assert.equal(policy.host, '127.0.0.1:3210');
  assert.equal(policy.webSocketOrigin, 'ws://127.0.0.1:3210');
  assert.equal(policy.computerStreamUrl, 'ws://127.0.0.1:3210/api/computer/stream');
  assert.equal(policy.ownerAuthRequired, false);
  assert.ok(Object.isFrozen(policy));
  for (const host of ['localhost:3210', '127.1:3210', '0x7f000001:3210', '[::1]:3210', '127.0.0.1:3211', 'dots.example']) assert.equal(policy.matchesHost(host), false, host);
  assert.equal(policy.matchesRequest(request(policy.host), 'read'), true);
});

test('HTTPS is opt-in and owner authentication is mandatory, including loopback HTTPS', () => {
  for (const publicOrigin of ['https://dots.example', 'https://127.0.0.1:3210']) {
    assert.throws(() => createApplicationOrigin({ localPort: 3210, ownerAuthEnabled: false, publicOrigin }), { code: 'application_origin_owner_auth_required' });
    const policy = remote(publicOrigin);
    assert.equal(policy.mode, 'https-proxy'); assert.equal(policy.ownerAuthRequired, true);
    assert.equal(policy.matchesHost('127.0.0.1:3210'), publicOrigin === 'https://127.0.0.1:3210');
  }
  for (const localPort of [0, -1, 65536, 1.5, NaN, Infinity]) assert.throws(() => createApplicationOrigin({ localPort, ownerAuthEnabled: true }), ApplicationOriginError);
  assert.throws(() => createApplicationOrigin({ localPort: 3210, ownerAuthEnabled: 'true' as unknown as boolean }), ApplicationOriginError);
});

test('configuration permits only root slash and explicit default-port normalization', () => {
  for (const value of ['https://dots.example', 'https://dots.example/', 'https://dots.example:443', 'https://dots.example:443/']) assert.equal(canonicalPublicOrigin(value), 'https://dots.example');
  assert.equal(canonicalPublicOrigin('https://dots.example:8443/'), 'https://dots.example:8443');
  assert.equal(canonicalPublicOrigin('https://xn--bcher-kva.example'), 'https://xn--bcher-kva.example');
  assert.equal(canonicalPublicOrigin('https://192.168.1.20:8443'), 'https://192.168.1.20:8443');
  assert.equal(canonicalPublicOrigin('https://[2001:db8::1]:443/'), 'https://[2001:db8::1]');
  assert.equal(local(80).origin, 'http://127.0.0.1');
  assert.equal(local(80).host, '127.0.0.1');
  assert.equal(local(80).webSocketOrigin, 'ws://127.0.0.1');
  const policy = remote('https://dots.example:443/');
  assert.equal(policy.matchesHost('dots.example'), true);
  assert.equal(policy.matchesHost('dots.example:443'), false);
  assert.equal(policy.matchesOrigin('https://dots.example'), true);
  assert.equal(policy.matchesOrigin('https://dots.example:443'), false);
  assert.equal(policy.matchesOrigin('https://dots.example/'), false);
});

test('ambiguous, active, credential-bearing and path-bearing configuration is rejected', () => {
  const rejected: unknown[] = [undefined, null, {}, ['https://dots.example'], '', 'http://dots.example', 'http://127.0.0.1:3210', 'ws://dots.example', 'wss://dots.example', 'javascript:alert(1)', '//dots.example',
    ' https://dots.example', 'https://dots.example ', 'https://do\tts.example', 'https://dots.example\n', 'https://dots.example\0',
    'HTTPS://dots.example', 'https://DOTS.example', 'https://dots.example.', 'https://*.example', 'https://bad_host.example', 'https://-bad.example', 'https://bad-.example', 'https://a..example', `https://${'a'.repeat(64)}.example`,
    'https://user@dots.example', 'https://user:password@dots.example', 'https://@dots.example', 'https://dots.example/path', 'https://dots.example//', 'https://dots.example/.', 'https://dots.example/a/..', 'https://dots.example/%2e',
    'https://dots.example?', 'https://dots.example?x=1', 'https://dots.example#', 'https://dots.example#view', 'https://dots.example\\', 'https:////dots.example', 'https://dots.example%2e', 'https://%64ots.example', 'https://bücher.example',
    'https://dots.example:', 'https://dots.example:0', 'https://dots.example:0443', 'https://dots.example:08443', 'https://dots.example:65536', 'https://dots.example:+443',
    'https://127.1', 'https://0177.0.0.1', 'https://0x7f000001', 'https://2130706433', 'https://0.0.0.0', 'https://[::]', 'https://[2001:0db8::1]', 'https://[fe80::1%25en0]'];
  for (const value of rejected) assert.throws(() => canonicalPublicOrigin(value), ApplicationOriginError, String(value));
});

test('exact Host/Origin policy rejects unknown origins and hostile header representations', () => {
  const policy = remote();
  for (const host of [undefined, null, ['dots.example'], 'dots.example,evil.example', 'dots.example:443', 'dots.example.evil', 'evil@dots.example', 'DOTS.example', 'dots.example.', ' dots.example', 'dots.example\r\nHost: evil.example']) assert.equal(policy.matchesRequest(request(host, policy.origin), 'read'), false, String(host));
  for (const origin of [null, ['https://dots.example'], '', 'null', 'http://dots.example', 'https://evil.example', 'https://dots.example.evil', 'https://dots.example https://evil.example', 'https://dots.example,https://evil.example', 'https://dots.example/', 'https://dots.example:443']) assert.equal(policy.matchesRequest(request(policy.host, origin), 'read'), false, String(origin));
  assert.equal(policy.matchesOrigin(undefined), false);
  assert.equal(policy.matchesOrigin(undefined, false), true);
  assert.equal(policy.matchesRequest(request(policy.host), 'read'), true);
  // @ts-expect-error Deliberately exercise a JavaScript caller omitting purpose.
  assert.equal(policy.matchesRequest(request(policy.host)), false);
  // @ts-expect-error Deliberately exercise an unknown runtime purpose.
  assert.equal(policy.matchesRequest(request(policy.host, policy.origin), 'unknown'), false);
  assert.equal(policy.matchesRequest(request(policy.host), 'mutation'), false);
  assert.equal(policy.matchesRequest(request(policy.host), 'websocket'), false);
  for (const purpose of ['read', 'mutation', 'websocket'] as const) assert.equal(policy.matchesRequest(request(policy.host, policy.origin, 'same-origin'), purpose), true);
  assert.equal(policy.matchesRequest(request(policy.host, policy.origin, 'none'), 'read'), true);
  assert.equal(policy.matchesRequest(request(policy.host, policy.origin, 'none'), 'mutation'), false);
  assert.equal(policy.matchesRequest(request(policy.host, policy.origin, 'none'), 'websocket'), false);
  for (const site of ['', 'cross-site', 'same-site', 'same-origin, cross-site', ['same-origin']]) assert.equal(policy.matchesRequest(request(policy.host, policy.origin, site), 'read'), false);
});

test('raw headers defeat discarded duplicates and parsed/raw disagreements', () => {
  const policy = remote();
  for (const duplicate of [['Host', 'dots.example'], ['hOsT', 'evil.example'], ['Origin', policy.origin], ['ORIGIN', 'https://evil.example'], ['Sec-Fetch-Site', 'same-origin']]) {
    const good = request(policy.host, policy.origin, 'same-origin');
    assert.equal(policy.matchesRequest({ ...good, rawHeaders: [...good.rawHeaders, ...duplicate] }, 'read'), false);
  }
  const good = request(policy.host, policy.origin);
  for (const rawHeaders of [[], ['Host'], ['Host', policy.host, 'Origin', 'https://evil.example'], ['Host', policy.host], [' Host', policy.host, 'Origin', policy.origin], ['Host', policy.host, 'Origin', policy.origin, 'X-Test', 'x\r\ny']]) assert.equal(policy.matchesRequest({ ...good, rawHeaders }, 'read'), false);
  assert.equal(policy.matchesRequest({ headers: { host: policy.host }, rawHeaders: ['Host', policy.host, 'Origin', policy.origin] }, 'read'), false);
  assert.equal(policy.matchesRequest({ headers: { host: policy.host }, rawHeaders: undefined } as unknown as OriginRequest, 'read'), false);
  assert.equal(policy.matchesRequest(null as unknown as OriginRequest, 'read'), false);
});

test('forwarding headers cannot create or override application-origin authority', () => {
  const policy = remote();
  const forwarded = ['Forwarded', 'proto=https;host=dots.example', 'X-Forwarded-Host', 'dots.example', 'X-Forwarded-Proto', 'https'];
  for (const input of [request('127.0.0.1:3210', policy.origin), request(policy.host, 'http://127.0.0.1:3210')]) assert.equal(policy.matchesRequest({ ...input, rawHeaders: [...input.rawHeaders, ...forwarded] }, 'read'), false);
  const good = request(policy.host, policy.origin);
  assert.equal(policy.matchesRequest({ ...good, headers: { ...good.headers, forwarded: 'host=evil.example', 'x-forwarded-host': 'evil.example' }, rawHeaders: [...good.rawHeaders, 'Forwarded', 'host=evil.example', 'X-Forwarded-Host', 'evil.example'] }, 'read'), true);
});

test('WebSocket endpoints follow configured scheme and exact stream route only', () => {
  for (const policy of [local(), remote(), remote('https://dots.example:8443')]) {
    assert.equal(policy.matchesWebSocketUrl(policy.computerStreamUrl), true);
    for (const value of [undefined, policy.webSocketOrigin, policy.computerStreamUrl + '?ticket=secret', policy.computerStreamUrl + '#', policy.computerStreamUrl + '/', policy.computerStreamUrl.replace('/api/', '/%61pi/'), policy.computerStreamUrl.replace('//', '//user@'), 'wss://evil.example/api/computer/stream', policy.computerStreamUrl.replace(/^wss:/, 'ws:').replace(/^ws:/, policy.mode === 'loopback' ? 'wss:' : 'ws:')]) assert.equal(policy.matchesWebSocketUrl(value), false, String(value));
  }
  assert.equal(remote().computerStreamUrl, 'wss://dots.example/api/computer/stream');
});
