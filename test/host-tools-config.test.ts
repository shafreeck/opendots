import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, chownSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConnectorConfig } from '../src/connector-config.ts';
import { readHostToolsConfig, validateHostToolsConfig } from '../src/host-tools-config.ts';
import { ConnectorError } from '../src/connector-types.ts';

const common = () => ({ ownerId: 'owner', runtimeOrigin: 'http://127.0.0.1:1234', binding: { principalId: 'principal', agentId: 'agent', contextId: 'context', sessionId: 'session' }, callbackPort: 4321 });
const github = () => ({ callbackToken: 'g'.repeat(64), allowPublicGithubReads: true, repositories: ['morphz-ai/morphz'] });
const calendar = () => ({ callbackToken: 'c'.repeat(64), allowProposals: true });
const v1 = () => ({ version: 1, ...common(), ...github() });
const v2 = () => ({ version: 2, ...common(), tools: { githubPublic: github(), calendarProposals: calendar() } });
const privateFile = (run: (root: string, path: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), 'opendots-host-tools-config-'));
  try { run(root, join(root, 'explicit.json')); }
  finally { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); }
};

test('v1 remains byte-compatible with its loader and normalizes without rewriting the private input', () => privateFile((_root, file) => {
  const bytes = Buffer.from(`\n${JSON.stringify(v1(), null, 2)}\n`);
  writeFileSync(file, bytes, { mode: 0o400 });
  const before = lstatSync(file);
  assert.deepEqual(readConnectorConfig(file), v1());
  assert.deepEqual(readHostToolsConfig(file), { sourceVersion: 1, ...common(), tools: { githubPublic: github() } });
  assert.deepEqual(readFileSync(file), bytes);
  const after = lstatSync(file);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ctimeMs, before.ctimeMs);
  assert.equal(after.ino, before.ino);
}));

test('v2 supports either independent tool and both tools with deeply frozen normalized config', () => {
  for (const tools of [{ githubPublic: github() }, { calendarProposals: calendar() }, v2().tools]) {
    const input = { version: 2, ...common(), tools };
    const value = validateHostToolsConfig(input);
    assert.deepEqual(value, { sourceVersion: 2, ...common(), tools });
    assert.equal(Object.hasOwn(value, 'version'), false);
    assert.ok(Object.isFrozen(value));
    assert.ok(Object.isFrozen(value.binding));
    assert.ok(Object.isFrozen(value.tools));
    if (value.tools.githubPublic) {
      assert.ok(Object.isFrozen(value.tools.githubPublic));
      assert.ok(Object.isFrozen(value.tools.githubPublic.repositories));
    }
    if (value.tools.calendarProposals) assert.ok(Object.isFrozen(value.tools.calendarProposals));
    input.binding.agentId = 'changed';
    assert.equal(value.binding.agentId, 'agent');
    privateFile((_root, file) => {
      writeFileSync(file, JSON.stringify({ version: 2, ...common(), tools }), { mode: 0o600 });
      assert.deepEqual(readHostToolsConfig(file), value);
    });
  }
});

test('v2 denies extra fields, missing fields, unknown tools, disabled grants and duplicate tokens', () => {
  const invalid: unknown[] = [
    null, [], 'config', { ...v2(), version: 3 }, { ...v2(), sourceVersion: 2 },
    { ...v2(), callbackToken: 'x'.repeat(64) }, { ...v2(), allowProposals: true },
    { ...v2(), tools: {} }, { ...v2(), tools: [] }, { ...v2(), tools: { shell: {} } },
    { ...v2(), tools: { ...v2().tools, mail: {} } },
    { ...v2(), tools: { githubPublic: undefined } }, { ...v2(), tools: { calendarProposals: null } },
    { ...v2(), tools: { calendarProposals: { callbackToken: calendar().callbackToken } } },
    { ...v2(), tools: { calendarProposals: { ...calendar(), allowProposals: false } } },
    { ...v2(), tools: { calendarProposals: { ...calendar(), allowCreate: true } } },
    { ...v2(), tools: { calendarProposals: { ...calendar(), accountId: 'unscoped' } } },
    { ...v2(), tools: { githubPublic: { ...github(), allowPublicGithubReads: false } } },
    { ...v2(), tools: { githubPublic: { ...github(), authHeaders: {} } } },
    { ...v2(), tools: { githubPublic: github(), calendarProposals: { ...calendar(), callbackToken: github().callbackToken } } },
    { ...v2(), binding: { ...common().binding, userId: 'extra' } },
    { ...v2(), binding: { principalId: 'principal', agentId: 'agent', contextId: 'context' } },
    { ...v2(), binding: { ...common().binding, sessionId: '' } },
    { ...v2(), ownerId: 'space separated' },
  ];
  const missing = v2() as Record<string, unknown>; delete missing.callbackPort; invalid.push(missing);
  for (const value of invalid) assert.throws(() => validateHostToolsConfig(value), ConnectorError);
});

test('v2 enforces exact loopback origins, port bounds, and ASCII graphic token bounds for each tool', () => {
  for (const runtimeOrigin of ['https://remote.example', 'http://127.0.0.2', 'http://127.0.0.1/', 'http://localhost/path', 'http://localhost?x=1', 'http://localhost#x', 'http://user@localhost', 'http://LOCALHOST', 'http://2130706433', 'http://localhost:80', 'file:///tmp/runtime', 1]) {
    assert.throws(() => validateHostToolsConfig({ ...v2(), runtimeOrigin }), ConnectorError);
  }
  for (const runtimeOrigin of ['http://127.0.0.1:1234', 'http://localhost', 'https://[::1]:4321']) {
    assert.equal(validateHostToolsConfig({ ...v2(), runtimeOrigin }).runtimeOrigin, runtimeOrigin);
  }
  for (const callbackPort of [1023, 65536, 4321.5, '4321', NaN, Infinity]) assert.throws(() => validateHostToolsConfig({ ...v2(), callbackPort }), ConnectorError);
  for (const callbackPort of [1024, 65535]) assert.equal(validateHostToolsConfig({ ...v2(), callbackPort }).callbackPort, callbackPort);
  for (const callbackToken of ['', 'x'.repeat(31), 'x'.repeat(1025), 'x'.repeat(31) + ' ', 'x'.repeat(31) + '\n', 'x'.repeat(31) + '\u007f', 'x'.repeat(31) + 'é', 123]) {
    assert.throws(() => validateHostToolsConfig({ ...v2(), tools: { githubPublic: { ...github(), callbackToken } } }), ConnectorError);
    assert.throws(() => validateHostToolsConfig({ ...v2(), tools: { calendarProposals: { ...calendar(), callbackToken } } }), ConnectorError);
  }
  for (const callbackToken of ['!'.repeat(32), '~'.repeat(1024)]) assert.equal(validateHostToolsConfig({ ...v2(), tools: { calendarProposals: { ...calendar(), callbackToken } } }).tools.calendarProposals?.callbackToken, callbackToken);
});

test('v2 preserves the sorted unique lowercase bounded public repository allowlist', () => {
  for (const repositories of [[], ['Other/Repo'], ['x/y', 'x/y'], ['z/y', 'a/b'], ['*/*'], ['https://github.com/x/y'], ['x/..'], ['x/.'], ['../repo'], ['x/y/z'], 'x/y', Array.from({ length: 51 }, (_, i) => `x/repo${i}`)]) {
    assert.throws(() => validateHostToolsConfig({ ...v2(), tools: { githubPublic: { ...github(), repositories } } }), ConnectorError);
  }
  const repositories = ['a/b', 'morphz-ai/morphz', 'z/repo'];
  const value = validateHostToolsConfig({ ...v2(), tools: { githubPublic: { ...github(), repositories } } });
  repositories.push('z/mutated');
  assert.deepEqual(value.tools.githubPublic?.repositories, ['a/b', 'morphz-ai/morphz', 'z/repo']);
});

test('v1 semantic validation still rejects extras, ungranted reads and invalid repository scopes', () => {
  for (const value of [{ ...v1(), tools: {} }, { ...v1(), allowPublicGithubReads: false }, { ...v1(), repositories: ['X/y'] }, { ...v1(), callbackToken: 'short' }]) {
    assert.throws(() => validateHostToolsConfig(value), ConnectorError);
  }
});

test('the private reader rejects symlinks, hardlinks, directories, non-private modes and unsafe parents', () => privateFile((root, file) => {
  writeFileSync(file, JSON.stringify(v2()), { mode: 0o600 });
  const link = join(root, 'link.json'); symlinkSync(file, link);
  assert.throws(() => readHostToolsConfig(link), ConnectorError);
  const hard = join(root, 'hard.json'); linkSync(file, hard);
  assert.throws(() => readHostToolsConfig(file), ConnectorError); rmSync(hard);
  const dir = join(root, 'directory.json'); mkdirSync(dir, { mode: 0o700 });
  assert.throws(() => readHostToolsConfig(dir), ConnectorError);
  const parentLink = join(root, 'parent-link'); symlinkSync(root, parentLink);
  assert.throws(() => readHostToolsConfig(join(parentLink, 'explicit.json')), ConnectorError);
  for (const mode of [0o000, 0o200, 0o401, 0o440, 0o644, 0o660, 0o700, 0o1600, 0o2600, 0o4600]) {
    chmodSync(file, mode); assert.throws(() => readHostToolsConfig(file), ConnectorError);
  }
  chmodSync(file, 0o600);
  chmodSync(root, 0o770); assert.throws(() => readHostToolsConfig(file), ConnectorError);
  chmodSync(root, 0o700);
}));

test('the private reader enforces current UID ownership', { skip: process.geteuid?.() !== 0 }, () => privateFile((_root, file) => {
  writeFileSync(file, JSON.stringify(v2()), { mode: 0o600 });
  chownSync(file, 1, 1);
  assert.throws(() => readHostToolsConfig(file), ConnectorError);
}));

test('reader accepts the byte limit and rejects oversized, empty, invalid UTF-8 and malformed files with fixed errors', () => privateFile((root, file) => {
  const json = JSON.stringify(v2());
  writeFileSync(file, json.padEnd(16_384, ' '), { mode: 0o600 });
  assert.equal(readHostToolsConfig(file).sourceVersion, 2);
  const secret = 'SYNTHETIC_SECRET_MUST_NOT_APPEAR';
  for (const bytes of [Buffer.alloc(0), Buffer.from(json.padEnd(16_385, ' ')), Buffer.from([0xff, 0xfe]), Buffer.from(secret)]) {
    writeFileSync(file, bytes);
    assert.throws(() => readHostToolsConfig(file), error => error instanceof ConnectorError && /^[a-z_]+$/.test(error.message) && !error.message.includes(secret) && !error.message.includes(root));
  }
  for (const path of ['relative.json', `${root}/../escape.json`, `${root}//explicit.json`, `${root}/bad\nname.json`, `${root}/${'x'.repeat(1024)}`]) {
    assert.throws(() => readHostToolsConfig(path), error => error instanceof ConnectorError && error.code === 'host_tools_configuration_path_invalid');
  }
  assert.throws(() => readHostToolsConfig(join(root, 'missing.json')), error => error instanceof ConnectorError && error.message === 'host_tools_configuration_unavailable' && error.status === 503);
}));
