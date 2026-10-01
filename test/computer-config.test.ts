import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import fs, { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { ComputerConfigError, loadComputerConfig, readComputerConfig } from '../src/computer-config.ts';
import { computerConnectionProof } from '../src/computer-edge-client.ts';

const identity = { principalId: 'principal-fixture', agentId: 'agent-fixture', contextId: 'context-fixture', sessionId: 'session-fixture' };
const runtimeOrigin = 'http://127.0.0.1:38999';
function fixture(t: test.TestContext, legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'opendots-computer-config-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'desktop.json'), credentialsPath = join(root, 'credentials.json');
  // Temporary, never paired synthetic key only. Match native ring v2 encoding.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const nativeKey = Buffer.concat([Buffer.from(legacy ? '3053020101300506032b657004220420' : '3051020101300506032b657004220420', 'hex'), seed, Buffer.from(legacy ? 'a123032100' : '812100', 'hex'), pub]).toString('hex');
  const credentials = { server_url: runtimeOrigin + '/', node_id: 'desktop-node', device_key_fingerprint: `sha256:${createHash('sha256').update(pub).digest('hex')}`, device_public_key: pub.toString('hex'), device_private_key_pkcs8: nativeKey };
  const config = { version: 1, dedicatedNode: true, credentialsPath, nodeId: credentials.node_id, targetId: 'desktop-target', policyDigest: 'reviewed-desktop-policy', workerId: 'desktop-worker', display: ':99', xauthority: join(root, 'not-read-Xauthority'), browserPid: 1234, browserInstanceId: 'synthetic-browser-instance', previewPort: 5901, previewReadOnlyEnforced: true, controlPort: 5902, reviewedX11vncSha256: 'a'.repeat(64) };
  const saveConfig = () => writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const saveCredentials = () => writeFileSync(credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
  saveConfig(); saveCredentials();
  const load = () => loadComputerConfig({ configPath, expectedConfig: readComputerConfig(configPath), runtimeOrigin, identity });
  return { root, configPath, credentialsPath, config, credentials, publicKey, nativeKey, saveConfig, saveCredentials, load };
}
function code(expected: string) { return (error: unknown) => error instanceof ComputerConfigError && error.code === expected && error.message === expected; }

for (const legacy of [false, true]) test(`loads native ${legacy ? 'legacy-tag' : 'standard-tag'} Ed25519 v2 key and signs only the bound connection proof`, async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network is not permitted in a config-loader fixture'); });
  const f = fixture(t, legacy), before = readFileSync(f.credentialsPath);
  const loaded = f.load(), proof = computerConnectionProof(f.config.nodeId, 'challenge', 'nonce');
  assert.equal(loaded.runtimeOrigin, runtimeOrigin);
  assert.deepEqual(loaded.binding, { nodeId: f.config.nodeId, targetId: f.config.targetId, policyDigest: f.config.policyDigest, ...identity });
  assert.ok(Object.isFrozen(loaded) && Object.isFrozen(loaded.config) && Object.isFrozen(loaded.binding));
  assert.equal(verify(null, proof, f.publicKey, Buffer.from(await loaded.signConnectionProof(proof), 'hex')), true);
  await assert.rejects(loaded.signConnectionProof(computerConnectionProof('other-node', 'challenge', 'nonce')), code('computer_config_proof_invalid'));
  await assert.rejects(loaded.signConnectionProof(Buffer.from('arbitrary message')), code('computer_config_proof_invalid'));
  await assert.rejects(loaded.signConnectionProof(Buffer.alloc(1601)), code('computer_config_proof_invalid'));
  assert.equal(JSON.stringify(loaded).includes(f.nativeKey), false); assert.equal(inspect(loaded).includes(f.nativeKey), false);
  assert.deepEqual(readFileSync(f.credentialsPath), before);
  assert.equal(network.mock.callCount(), 0);
  loaded.close(); loaded.close();
  await assert.rejects(loaded.signConnectionProof(proof), code('computer_config_signer_closed'));
});

test('public stage does not read credential or Xauthority files and never falls back to ambient config', t => {
  const f = fixture(t);
  rmSync(f.credentialsPath);
  const config = readComputerConfig(f.configPath);
  assert.equal(config.credentialsPath, f.credentialsPath);
  assert.throws(f.load, code('computer_config_file_unavailable'));
  assert.throws(() => readComputerConfig('desktop.json'), code('computer_config_path_invalid'));
  assert.throws(() => readComputerConfig('~/desktop.json'), code('computer_config_path_invalid'));
});

test('rejects changed public snapshot before attempting any credential read', t => {
  const f = fixture(t), expectedConfig = readComputerConfig(f.configPath);
  f.config.targetId = 'changed-target'; f.saveConfig(); rmSync(f.credentialsPath);
  assert.throws(() => loadComputerConfig({ configPath: f.configPath, expectedConfig, runtimeOrigin, identity }), code('computer_config_snapshot_changed'));
});

test('loopback origin and native server identity must exactly match the configured BFF', t => {
  const f = fixture(t), expectedConfig = readComputerConfig(f.configPath);
  for (const origin of ['https://remote.example', 'http://127.0.0.1:38999/path', 'http://user:password@127.0.0.1:38999', runtimeOrigin + '?token=secret', runtimeOrigin + '#fragment']) {
    assert.throws(() => loadComputerConfig({ configPath: f.configPath, expectedConfig, runtimeOrigin: origin, identity }), code('computer_config_runtime_origin_invalid'));
  }
  for (const origin of ['http://localhost:38999', 'http://127.0.0.1:39000', 'https://127.0.0.1:38999']) {
    f.credentials.server_url = origin; f.saveCredentials(); assert.throws(f.load, code('computer_config_runtime_origin_mismatch'));
  }
  f.credentials.server_url = 'https://remote.example'; f.saveCredentials(); assert.throws(f.load, code('computer_config_runtime_origin_invalid'));
});

test('native node, derived public key, embedded public key and fingerprint are all verified', t => {
  const f = fixture(t);
  f.credentials.node_id = 'other'; f.saveCredentials(); assert.throws(f.load, code('computer_config_node_mismatch'));
  f.credentials.node_id = f.config.nodeId;
  const original = { ...f.credentials };
  for (const replacement of [
    { device_public_key: 'aa'.repeat(32) },
    { device_private_key_pkcs8: original.device_private_key_pkcs8.slice(0, -64) + 'aa'.repeat(32) },
  ]) {
    Object.assign(f.credentials, original, replacement); f.saveCredentials(); assert.throws(f.load, code('computer_config_key_mismatch'));
  }
  Object.assign(f.credentials, original, { device_key_fingerprint: 'sha256:' + '0'.repeat(64) }); f.saveCredentials(); assert.throws(f.load, code('computer_config_fingerprint_mismatch'));
});

test('rejects malformed, truncated, v1-only and other algorithm key encodings without echoing bytes', t => {
  const f = fixture(t);
  for (const key of ['private marker not DER', f.nativeKey.slice(2), f.nativeKey + '00', f.nativeKey.replace('2b6570', '2b6571'), '302e020100300506032b657004220420' + '00'.repeat(32)]) {
    f.credentials.device_private_key_pkcs8 = key; f.saveCredentials();
    let failure: unknown; try { f.load(); } catch (error) { failure = error; }
    assert.ok(code('computer_config_key_invalid')(failure)); assert.equal(inspect(failure).includes(key), false);
  }
});

test('credential mode is checked before invalid JSON can be read and public modes cannot be writable by others', t => {
  const f = fixture(t);
  writeFileSync(f.credentialsPath, '{PRIVATE MARKER'); chmodSync(f.credentialsPath, 0o644);
  assert.throws(f.load, code('computer_config_mode_invalid'));
  chmodSync(f.credentialsPath, 0o600); f.saveCredentials();
  for (const mode of [0o640, 0o660, 0o700, 0o4600]) { chmodSync(f.credentialsPath, mode); assert.throws(f.load, code('computer_config_mode_invalid')); }
  chmodSync(f.credentialsPath, 0o400); f.load().close();
  chmodSync(f.configPath, 0o644); f.load().close();
  chmodSync(f.configPath, 0o664); assert.throws(() => readComputerConfig(f.configPath), code('computer_config_mode_invalid'));
});

test('descriptor owner metadata is checked before reading private bytes', t => {
  const f = fixture(t), original = fs.fstatSync;
  const read = t.mock.method(fs, 'readSync');
  const stat = t.mock.method(fs, 'fstatSync', (fd: number) => { const value = original(fd); return Object.assign(value, { uid: value.uid + 1 }); });
  syncBuiltinESMExports();
  try { assert.throws(() => readComputerConfig(f.configPath), code('computer_config_owner_invalid')); assert.equal(read.mock.callCount(), 0); }
  finally { read.mock.restore(); stat.mock.restore(); syncBuiltinESMExports(); }
});

test('rejects symlink and hardlink files and symlink/writable parent directories', t => {
  const f = fixture(t), old = f.credentialsPath + '.real';
  writeFileSync(old, readFileSync(f.credentialsPath), { mode: 0o600 }); rmSync(f.credentialsPath); symlinkSync(old, f.credentialsPath);
  assert.throws(f.load, code('computer_config_file_invalid'));
  rmSync(f.credentialsPath); linkSync(old, f.credentialsPath); assert.throws(f.load, code('computer_config_file_invalid'));
  rmSync(f.credentialsPath); rmSync(old); f.saveCredentials();
  const alias = join(f.root, 'alias'); symlinkSync(f.root, alias);
  assert.throws(() => readComputerConfig(join(alias, 'desktop.json')), code('computer_config_path_untrusted'));
  const unsafe = join(f.root, 'unsafe'); mkdirSync(unsafe, { mode: 0o777 }); chmodSync(unsafe, 0o777);
  const path = join(unsafe, 'config.json'); writeFileSync(path, JSON.stringify(f.config), { mode: 0o600 });
  assert.throws(() => readComputerConfig(path), code('computer_config_path_untrusted'));
});

test('bounded JSON, strict config schema and trusted identity prevent accidental broader configuration', t => {
  const f = fixture(t), original = { ...f.config };
  for (const replacement of [
    { dedicatedNode: false }, { previewReadOnlyEnforced: false }, { targetId: 'target-default' }, { display: 'remote:0' }, { browserPid: 1 }, { browserInstanceId: 'short' },
    { controlPort: f.config.previewPort }, { previewPort: 80 }, { xauthority: '/tmp/../secret' }, { reviewedX11vncSha256: 'unknown' }, { credentialsPath: './credentials.json' }, { command: 'extra shell argument' },
  ]) {
    writeFileSync(f.configPath, JSON.stringify({ ...original, ...replacement })); assert.throws(() => readComputerConfig(f.configPath), ComputerConfigError);
  }
  f.saveConfig(); const expectedConfig = readComputerConfig(f.configPath);
  for (const badIdentity of [{ ...identity, principalId: '' }, { ...identity, sessionId: {} }, { ...identity, unexpected: 'extra' }]) {
    assert.throws(() => loadComputerConfig({ configPath: f.configPath, expectedConfig, runtimeOrigin, identity: badIdentity as any }), code('computer_config_identity_invalid'));
  }
  writeFileSync(f.credentialsPath, 'x'.repeat(16_385)); assert.throws(f.load, code('computer_config_file_invalid'));
  writeFileSync(f.credentialsPath, '{PRIVATE MARKER'); assert.throws(f.load, code('computer_config_json_invalid'));
  rmSync(f.configPath); assert.throws(() => readComputerConfig(f.configPath), code('computer_config_file_unavailable'));
});
