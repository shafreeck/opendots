import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthError, authDigest, readOwnerAuthConfig, validateOwnerAuthConfig, verifyOwnerCredential } from '../src/auth-config.ts';

const basic = () => ({ version: 1, credential: { kind: 'morphz_login_token_sha256', hashHex: authDigest('a'.repeat(64)) }, sessionTtlSeconds: 86400, idleTtlSeconds: 3600, maximumDevices: 16 });
test('fixed-cost native Node scrypt verifies an isolated synthetic password without creating credentials', async () => {
  const synthetic = 'Fixture-only passphrase 🙂 ', saltHex = 'ab'.repeat(32);
  const hashHex = scryptSync(synthetic, Buffer.from(saltHex, 'hex'), 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }).toString('hex');
  const config = validateOwnerAuthConfig({ ...basic(), credential: { kind: 'scrypt', saltHex, hashHex, N: 131072, r: 8, p: 1 } });
  assert.equal(await verifyOwnerCredential(config.credential, synthetic), true);
  assert.equal(await verifyOwnerCredential(config.credential, synthetic.trim()), false); // no silent normalization
  assert.equal(await verifyOwnerCredential(config.credential, '\ud800'), false);
  assert.equal(await verifyOwnerCredential(config.credential, 'a'.repeat(1025)), false);
  assert.equal(await verifyOwnerCredential(config.credential, {}), false);
});

test('native Morphz random-token format remains distinct from a password hash', async () => {
  const config = validateOwnerAuthConfig(basic());
  assert.equal(await verifyOwnerCredential(config.credential, 'a'.repeat(64)), true);
  for (const candidate of ['A'.repeat(64), 'ordinary password', '', 'b'.repeat(64)]) assert.equal(await verifyOwnerCredential(config.credential, candidate), false);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.credential));
  for (const value of [{ ...basic(), unknown: true }, { ...basic(), maximumDevices: 33 }, { ...basic(), idleTtlSeconds: 86401 }, { ...basic(), sessionTtlSeconds: 0 }, { ...basic(), credential: { kind: 'plaintext', value: 'secret' } }, { ...basic(), credential: { kind: 'scrypt', saltHex: 'a'.repeat(64), hashHex: 'b'.repeat(128), N: 16384, r: 8, p: 1 } }]) assert.throws(() => validateOwnerAuthConfig(value), AuthError);
});

test('explicit private config file is bounded, no-follow, owner-checked and never discovered from HOME', t => {
  const root = mkdtempSync(join(tmpdir(), 'opendots-auth-config-test-')), path = join(root, 'auth.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path, JSON.stringify(basic()), { mode: 0o600 }); assert.deepEqual(readOwnerAuthConfig(path), basic());
  chmodSync(path, 0o644); assert.throws(() => readOwnerAuthConfig(path), { code: 'authentication_configuration_file_invalid' });
  writeFileSync(path, '{secret fixture marker'); assert.throws(() => readOwnerAuthConfig(path), { code: 'authentication_configuration_file_invalid' });
  chmodSync(path, 0o600); assert.throws(() => readOwnerAuthConfig(path), { code: 'authentication_configuration_invalid' });
  writeFileSync(path, 'x'.repeat(16385)); assert.throws(() => readOwnerAuthConfig(path), { code: 'authentication_configuration_file_invalid' });
  const alias = join(root, 'alias'); symlinkSync(path, alias); assert.throws(() => readOwnerAuthConfig(alias), { code: 'authentication_configuration_file_invalid' });
  assert.throws(() => readOwnerAuthConfig('auth.json'), { code: 'authentication_configuration_path_invalid' });
  assert.throws(() => readOwnerAuthConfig(join(root, 'missing')), { code: 'authentication_configuration_unavailable' });
});
