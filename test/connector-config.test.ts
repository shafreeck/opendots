import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConnectorConfig, validateConnectorConfig } from '../src/connector-config.ts';
import { ConnectorError } from '../src/connector-types.ts';
const config = () => ({ version: 1, ownerId: 'owner', runtimeOrigin: 'http://127.0.0.1:1234', binding: { principalId: 'principal', agentId: 'agent', contextId: 'context', sessionId: 'session' }, callbackPort: 4321, callbackToken: 't'.repeat(64), allowPublicGithubReads: true, repositories: ['morphz-ai/morphz'] });
test('connector config reads only the explicit private file and preserves fixed binding/policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'opendots-connector-config-')); const file = join(root, 'existing.json');
  try { writeFileSync(file, JSON.stringify(config()), { mode: 0o600 }); const value = readConnectorConfig(file); assert.deepEqual(value, config()); assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.binding)); assert.ok(Object.isFrozen(value.repositories)); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test('connector config rejects absent explicit consent, dynamic scope, arbitrary endpoints and extras', () => {
  for (const value of [{ ...config(), allowPublicGithubReads: false }, { ...config(), runtimeOrigin: 'https://remote.example' }, { ...config(), callbackPort: 0 }, { ...config(), callbackToken: 'short' }, { ...config(), repositories: ['Other/Repo'] }, { ...config(), repositories: ['x/y','x/y'] }, { ...config(), repositories: ['z/y','a/b'] }, { ...config(), authHeaders: {} }, { ...config(), binding: { ...config().binding, userId: 'injected' } }]) assert.throws(() => validateConnectorConfig(value), ConnectorError);
});
test('connector private config rejects symlinks, hardlinks, public modes and malformed bytes without leakage', () => {
  const root = mkdtempSync(join(tmpdir(), 'opendots-connector-config-')); const file = join(root, 'existing.json');
  try {
    writeFileSync(file, JSON.stringify(config()), { mode: 0o600 }); symlinkSync(file, join(root, 'link.json')); assert.throws(() => readConnectorConfig(join(root, 'link.json')), ConnectorError);
    linkSync(file, join(root, 'hard.json')); assert.throws(() => readConnectorConfig(file), ConnectorError); rmSync(join(root, 'hard.json'));
    chmodSync(file, 0o644); assert.throws(() => readConnectorConfig(file), ConnectorError); chmodSync(file, 0o600);
    writeFileSync(file, 'SECRET_BAD_JSON'); assert.throws(() => readConnectorConfig(file), e => e instanceof ConnectorError && !e.message.includes('SECRET'));
    assert.throws(() => readConnectorConfig(join(root, 'missing.json')), e => e instanceof ConnectorError && !e.message.includes(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
