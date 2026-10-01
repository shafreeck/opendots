import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthError, authDigest, validateOwnerAuthConfig } from '../src/auth-config.ts';
import { AUTH_LIMITS, OwnerAuth, assertAuthenticationMode } from '../src/auth-sessions.ts';

const token = 'a'.repeat(64), ownerId = 'user-auth-fixture', origin = 'http://127.0.0.1:38887';
const configuration = () => validateOwnerAuthConfig({ version: 1, credential: { kind: 'morphz_login_token_sha256', hashHex: authDigest(token) }, sessionTtlSeconds: 3600, idleTtlSeconds: 600, maximumDevices: 8 });
const cookie = (value: { setCookie: string }) => value.setCookie.split(';')[0];
const code = (expected: string) => (error: unknown) => error instanceof AuthError && error.code === expected && error.message === expected;
function fixture(t: test.TestContext, options: { persistent?: boolean; origin?: string; maximumDevices?: number } = {}) {
  const root = options.persistent ? mkdtempSync(join(tmpdir(), 'opendots-auth-session-test-')) : null;
  const db = new DatabaseSync(root ? join(root, 'fixture.sqlite') : ':memory:');
  const config = configuration(); let now = 1_000_000;
  const auth = new OwnerAuth({ db, ownerId, origin: options.origin ?? origin, config: { ...config, maximumDevices: options.maximumDevices ?? config.maximumDevices }, now: () => now });
  t.after(async () => { await auth.close(); db.close(); if (root) rmSync(root, { recursive: true, force: true }); });
  return { db, auth, config, root, time: () => now, advance: (ms: number) => { now += ms; }, login: (label = 'Fixture browser', remoteAddress = '127.0.0.1') => auth.login({ credential: token, deviceLabel: label }, { origin: options.origin ?? origin, remoteAddress }) };
}

test('random HttpOnly/Strict sessions carry distinct CSRF and only bearer hashes persist', async t => {
  const f = fixture(t), a = await f.login('Device A'), b = await f.login('Device B');
  assert.match(a.setCookie, /; Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600$/);
  assert.notEqual(cookie(a), cookie(b)); assert.notEqual(a.session.csrfToken, b.session.csrfToken);
  assert.equal(f.auth.authenticate(cookie(a))?.id, a.session.id);
  const encoded = JSON.stringify(f.db.prepare('SELECT * FROM auth_device_sessions').all());
  assert.ok(!encoded.includes(cookie(a).split('=')[1])); assert.ok(!encoded.includes(token)); assert.ok(!encoded.includes(a.session.csrfToken));
  assert.deepEqual(f.auth.listDevices(cookie(a)).devices.map(d => [d.deviceLabel, d.current]).sort(), [['Device A', true], ['Device B', false]]);
  assert.equal(f.auth.requireMutation(cookie(a), a.session.csrfToken, origin).ownerId, ownerId);
  assert.throws(() => f.auth.requireMutation(cookie(a), b.session.csrfToken, origin), code('authentication_request_rejected'));
  assert.throws(() => f.auth.requireMutation(cookie(a), a.session.csrfToken, 'http://127.0.0.1:1'), code('authentication_request_rejected'));
});

test('malformed/duplicate cookies and unknown tokens cannot authenticate or fall back', async t => {
  const f = fixture(t), a = await f.login(), c = cookie(a);
  for (const value of [undefined, '', `${c}; ${c}`, c + '0', `${f.auth.cookieName}=invalid; ${c}`, `${f.auth.cookieName}=${'f'.repeat(64)}`, 'morphz_legacy=' + token, 'x'.repeat(AUTH_LIMITS.maximumCookieBytes + 1)]) assert.equal(f.auth.authenticate(value), null);
  assert.throws(() => f.auth.requireMutation(undefined, a.session.csrfToken, origin), code('authentication_required'));
});

test('current-device and other-device revoke signal promptly and never expose token/hash', async t => {
  const f = fixture(t), a = await f.login('A'), b = await f.login('B'), invalidated: (string | null)[] = [];
  const off = f.auth.onInvalidate(id => invalidated.push(id));
  assert.deepEqual(f.auth.revokeDevice(cookie(a), a.session.csrfToken, origin, b.session.id), { revoked: true, current: false });
  assert.equal(f.auth.authenticate(cookie(b)), null); assert.equal(f.auth.isCurrentSession(b.session.id), false); assert.equal(f.auth.isCurrentSession(a.session.id), true);
  assert.deepEqual(invalidated, [b.session.id]);
  const out = f.auth.logout(cookie(a), a.session.csrfToken, origin);
  assert.equal(out.current, true); assert.match(out.setCookie!, /Max-Age=0/); assert.equal(f.auth.authenticate(cookie(a)), null);
  assert.deepEqual(invalidated, [b.session.id, a.session.id]); off();
});

test('revoke-all invalidates every device and prevents an already pending login from committing', async t => {
  const f = fixture(t), a = await f.login('A'), events: (string | null)[] = [];
  f.auth.onInvalidate(id => events.push(id));
  const pending = f.login('Pending');
  const result = f.auth.revokeAll(cookie(a), a.session.csrfToken, origin);
  await assert.rejects(pending, code('authentication_failed'));
  assert.equal(result.revoked, 1); assert.deepEqual(events, [null]); assert.equal(f.auth.authenticate(cookie(a)), null);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM auth_device_sessions').get() as any).count, 0);
});

test('credential/config changes invalidate sessions and pending authentication', async t => {
  const f = fixture(t), a = await f.login(), events: (string | null)[] = [];
  f.auth.onInvalidate(id => events.push(id));
  const pending = f.login('Pending');
  f.auth.replaceConfiguration({ ...f.config, credential: { kind: 'morphz_login_token_sha256', hashHex: authDigest('b'.repeat(64)) } });
  await assert.rejects(pending, code('authentication_failed')); assert.equal(f.auth.authenticate(cookie(a)), null); assert.deepEqual(events, [null]);
  await assert.rejects(f.login(), code('authentication_failed'));
  const accepted = await f.auth.login({ credential: 'b'.repeat(64), deviceLabel: 'New credential' }, { origin, remoteAddress: '127.0.0.2' });
  assert.equal(f.auth.authenticate(cookie(accepted))?.id, accepted.session.id);
});

test('sessions survive restart, while missing config or changing owner/origin cannot downgrade or retarget', async t => {
  const f = fixture(t, { persistent: true }), a = await f.login(); await f.auth.close();
  assert.throws(() => assertAuthenticationMode(f.db, false), code('authentication_configuration_required')); assertAuthenticationMode(f.db, true);
  assert.throws(() => new OwnerAuth({ db: f.db, config: f.config, origin, ownerId: 'different-user' }), code('authentication_owner_binding_mismatch'));
  assert.throws(() => new OwnerAuth({ db: f.db, config: f.config, origin: 'http://localhost:38887', ownerId }), code('authentication_owner_binding_mismatch'));
  const next = new OwnerAuth({ db: f.db, config: f.config, origin, ownerId, now: f.time });
  assert.equal(next.authenticate(cookie(a))?.id, a.session.id); await next.close();
  const changed = new OwnerAuth({ db: f.db, config: { ...f.config, idleTtlSeconds: 300 }, origin, ownerId, now: f.time });
  assert.equal(changed.authenticate(cookie(a)), null); await changed.close();
});

test('idle timeout and fixed absolute expiry remain authoritative', async t => {
  const f = fixture(t), a = await f.login(); f.advance(599_999);
  assert.equal(f.auth.authenticate(cookie(a))?.id, a.session.id); // legitimate activity refreshes idle only
  f.advance(600_000); assert.equal(f.auth.authenticate(cookie(a)), null);
  const b = await f.login('B');
  for (let i = 0; i < 7; i++) { f.advance(500_000); assert.equal(f.auth.authenticate(cookie(b))?.id, b.session.id); }
  f.advance(100_000); assert.equal(f.auth.authenticate(cookie(b)), null); assert.equal(f.auth.isCurrentSession(b.session.id), false);
});

test('abuse guard persists across restart and bounds global work across different remote addresses', async t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) await assert.rejects(f.auth.login({ credential: 'wrong', deviceLabel: 'Fixture' }, { origin, remoteAddress: '127.0.0.1' }), code('authentication_failed'));
  await assert.rejects(f.login(), code('authentication_try_later')); await f.auth.close();
  const next = new OwnerAuth({ db: f.db, config: f.config, ownerId, origin, now: f.time });
  await assert.rejects(next.login({ credential: token, deviceLabel: 'Restart' }, { origin, remoteAddress: '127.0.0.1' }), code('authentication_try_later'));
  for (let i = 2; i <= 14; i++) await assert.rejects(next.login({ credential: 'wrong', deviceLabel: 'Fixture' }, { origin, remoteAddress: `127.0.0.${i}` }), code('authentication_failed'));
  await assert.rejects(next.login({ credential: token, deviceLabel: 'Global blocked' }, { origin, remoteAddress: '127.0.0.99' }), code('authentication_try_later'));
  f.advance(AUTH_LIMITS.attemptWindowMs);
  const fresh = await next.login({ credential: token, deviceLabel: 'Window reset' }, { origin, remoteAddress: '127.0.0.1' }); assert.ok(fresh.session.id);
  assert.ok((f.db.prepare('SELECT COUNT(*) AS count FROM auth_attempt_windows').get() as any).count <= AUTH_LIMITS.maximumRemoteBuckets + 1); await next.close();
});

test('one verification in flight, cancelled login, capacity and service close fail without issuing a session', async t => {
  const f = fixture(t, { maximumDevices: 1 });
  const pending = f.login(); await assert.rejects(f.login('Concurrent'), code('authentication_try_later')); const a = await pending;
  await assert.rejects(f.login('Capacity'), code('authentication_device_limit'));
  const signal = new AbortController(); signal.abort();
  await assert.rejects(f.auth.login({ credential: token, deviceLabel: 'Cancelled' }, { origin, remoteAddress: '127.0.0.2', signal: signal.signal }), code('authentication_failed'));
  const closePending = f.login('Closing', '127.0.0.3'), closed = f.auth.close();
  assert.equal(f.auth.close(), closed);
  await assert.rejects(closePending, code('authentication_unavailable')); await closed;
  assert.equal(f.auth.authenticate(cookie(a)), null); assert.equal(f.auth.isCurrentSession(a.session.id), false);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM auth_device_sessions').get() as any).count, 1); // close does not own/delete the caller's DB
});

test('strict login origin, request shape and configured loopback HTTPS cookie policy', async t => {
  const f = fixture(t, { origin: 'https://127.0.0.1:38887' }), a = await f.login();
  assert.ok(a.setCookie.startsWith('__Host-')); assert.ok(a.setCookie.endsWith('; Secure')); assert.ok(!a.setCookie.includes('Domain='));
  for (const bad of [undefined, 'null', 'https://evil.example']) await assert.rejects(f.auth.login({ credential: token, deviceLabel: 'Fixture' }, { origin: bad }), code('authentication_request_rejected'));
  for (const label of ['', '<script>', 'x'.repeat(81), ' trimmed ', 'line\nbreak']) await assert.rejects(f.auth.login({ credential: token, deviceLabel: label }, { origin: 'https://127.0.0.1:38887', remoteAddress: '127.0.0.2' }), code('authentication_failed'));
  assert.throws(() => new OwnerAuth({ db: f.db, config: f.config, ownerId, origin: 'https://remote.example' }), code('authentication_owner_binding_mismatch'));
});
