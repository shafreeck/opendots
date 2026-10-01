import { createHash, createPrivateKey, createPublicKey, sign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, normalize, parse } from 'node:path';
import { edgeId, validateComputerBinding, type ComputerEdgeBinding } from './computer-edge-types.ts';

/** Operator-only setup data. This is not a browser/API request DTO. */
export interface ComputerConfig {
  readonly version: 1;
  /** Operator attestation: no standard broad-capability runner uses this node. */
  readonly dedicatedNode: true;
  readonly credentialsPath: string;
  readonly nodeId: string;
  readonly targetId: string;
  readonly policyDigest: string;
  readonly workerId: string;
  readonly display: string;
  readonly xauthority: string;
  readonly browserPid: number;
  readonly browserInstanceId: string;
  readonly previewPort: number;
  /** Reviewed server-side read-only + clipboard-disabled preview on this DISPLAY. */
  readonly previewReadOnlyEnforced: true;
  readonly controlPort: number;
  readonly reviewedX11vncSha256: string;
}
export type ComputerIdentity = Pick<ComputerEdgeBinding, 'principalId' | 'agentId' | 'contextId' | 'sessionId'>;
export interface LoadComputerConfigOptions {
  configPath: string;
  expectedConfig: ComputerConfig;
  /** The already configured BFF LocalOperatorAdapter origin, never browser input. */
  runtimeOrigin: string;
  /** Obtained from RuntimeService.verifiedIdentity(), not operator JSON. */
  identity: ComputerIdentity;
}
export interface LoadedComputerConfig {
  readonly config: ComputerConfig;
  readonly binding: Readonly<ComputerEdgeBinding>;
  readonly runtimeOrigin: string;
  readonly deviceKeyFingerprint: string;
  signConnectionProof(bytes: Uint8Array): Promise<string>;
  close(): void;
}
export class ComputerConfigError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ComputerConfigError'; this.code = code; }
}
const CONFIG_KEYS = ['version', 'dedicatedNode', 'credentialsPath', 'nodeId', 'targetId', 'policyDigest', 'workerId', 'display', 'xauthority', 'browserPid', 'browserInstanceId', 'previewPort', 'previewReadOnlyEnforced', 'controlPort', 'reviewedX11vncSha256'] as const;
const CREDENTIAL_KEYS = ['server_url', 'node_id', 'device_key_fingerprint', 'device_public_key', 'device_private_key_pkcs8'];
const MAX_FILE_BYTES = 16_384;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_V1_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PKCS8_V2_PREFIX = Buffer.from('3051020101300506032b657004220420', 'hex');
const PKCS8_LEGACY_PREFIX = Buffer.from('3053020101300506032b657004220420', 'hex');
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new ComputerConfigError(code); }
function record(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), code);
  const object = value as Record<string, unknown>;
  check(Object.keys(object).length === keys.length && Object.keys(object).every(key => keys.includes(key)), code);
  return object;
}
function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 1 && value.length <= 1024 && isAbsolute(value) && normalize(value) === value && !/[\u0000-\u001f\u007f]/.test(value) && !value.endsWith('/');
}
function sameFile(a: Stats, b: Stats) { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
/** Reject path indirection and untrusted writable ancestors. Root-owned sticky
 * temporary directories are allowed so a private mkdtemp directory is usable. */
function checkParents(path: string, uid: number) {
  let parent = dirname(path);
  for (;;) {
    const info = lstatSync(parent);
    check(info.isDirectory() && !info.isSymbolicLink() && [0, uid].includes(info.uid), 'computer_config_path_untrusted');
    check((info.mode & 0o022) === 0 || (info.uid === 0 && (info.mode & 0o1000) !== 0), 'computer_config_path_untrusted');
    if (parent === parse(parent).root) break;
    parent = dirname(parent);
  }
}
function verifyFile(info: Stats, uid: number, secret: boolean) {
  check(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= MAX_FILE_BYTES, 'computer_config_file_invalid');
  check(secret ? info.uid === uid : [0, uid].includes(info.uid), 'computer_config_owner_invalid');
  check((info.mode & 0o7000) === 0 && (secret ? (info.mode & 0o177) === 0 && (info.mode & 0o400) !== 0 : (info.mode & 0o133) === 0 && (info.mode & 0o444) !== 0), 'computer_config_mode_invalid');
}
/** No readFile fallback: check the actual open descriptor before any bytes. */
function readSelectedJson(path: string, secret: boolean): unknown {
  check(absolutePath(path), 'computer_config_path_invalid');
  check(process.platform === 'linux' && typeof process.geteuid === 'function' && constants.O_NOFOLLOW !== undefined, 'computer_config_platform_unsupported');
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const uid = process.geteuid();
    checkParents(path, uid);
    const before = lstatSync(path);
    verifyFile(before, uid, secret);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    verifyFile(opened, uid, secret);
    check(sameFile(before, opened), 'computer_config_file_changed');
    bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    for (;;) { const read = readSync(fd, bytes, length, bytes.length - length, null); if (read === 0) break; length += read; check(length <= MAX_FILE_BYTES, 'computer_config_file_invalid'); }
    check(sameFile(opened, fstatSync(fd)) && sameFile(opened, lstatSync(path)), 'computer_config_file_changed');
    checkParents(path, uid);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { throw new ComputerConfigError('computer_config_json_invalid'); }
  } catch (error) {
    if (error instanceof ComputerConfigError) throw error;
    // Native filesystem/JSON/crypto errors may contain paths or private bytes.
    throw new ComputerConfigError('computer_config_file_unavailable');
  } finally { bytes?.fill(0); if (fd !== undefined) { try { closeSync(fd); } catch { /* Never leak a native error. */ } } }
}
function validateConfig(value: unknown): ComputerConfig {
  const c = record(value, CONFIG_KEYS, 'computer_config_invalid');
  check(c.version === 1 && c.dedicatedNode === true, 'computer_config_dedicated_node_required');
  check([c.nodeId, c.targetId, c.policyDigest, c.workerId].every(edgeId) && c.targetId !== 'target-default', 'computer_config_binding_invalid');
  check(absolutePath(c.credentialsPath) && absolutePath(c.xauthority), 'computer_config_path_invalid');
  check(typeof c.display === 'string' && /^:[0-9]{1,4}(?:\.[0-9]{1,2})?$/.test(c.display), 'computer_config_display_invalid');
  // Match the driver’s trusted path grammar; this loader does not read Xauthority.
  check(/^\/[A-Za-z0-9_./-]{1,500}$/.test(c.xauthority), 'computer_config_path_invalid');
  check(Number.isSafeInteger(c.browserPid) && Number(c.browserPid) > 1 && Number(c.browserPid) <= 2_147_483_647 && typeof c.browserInstanceId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(c.browserInstanceId), 'computer_config_browser_invalid');
  check([c.previewPort, c.controlPort].every(port => Number.isSafeInteger(port) && Number(port) >= 1024 && Number(port) <= 65535) && c.previewPort !== c.controlPort, 'computer_config_ports_invalid');
  check(c.previewReadOnlyEnforced === true, 'computer_config_preview_attestation_required');
  check(typeof c.reviewedX11vncSha256 === 'string' && /^[a-f0-9]{64}$/.test(c.reviewedX11vncSha256), 'computer_config_build_invalid');
  // Rebuild in one stable order, excluding unknown fields and prototype state.
  return Object.freeze(Object.fromEntries(CONFIG_KEYS.map(key => [key, c[key]])) as unknown as ComputerConfig);
}
/** Stage one: reads only the explicit public config, never the credential file. */
export function readComputerConfig(configPath: string): ComputerConfig { return validateConfig(readSelectedJson(configPath, false)); }
function localOrigin(value: unknown): string {
  check(typeof value === 'string' && value.length <= 2048 && value.trim() === value, 'computer_config_runtime_origin_invalid');
  let url: URL;
  try { url = new URL(value); } catch { throw new ComputerConfigError('computer_config_runtime_origin_invalid'); }
  check(['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'computer_config_runtime_origin_invalid');
  return url.origin;
}
/** Morphz uses ring::Ed25519KeyPair::from_pkcs8 (v2, with public key).
 * Accept the current RFC 5958 tag and ring's documented legacy tag only.
 * Re-import the seed as v1 to independently derive, rather than trust, its key. */
function nativePrivateKey(hex: unknown, declaredPublic: unknown): KeyObject {
  check(typeof hex === 'string' && /^(?:[a-f0-9]{166}|[a-f0-9]{170})$/.test(hex) && typeof declaredPublic === 'string' && /^[a-f0-9]{64}$/.test(declaredPublic), 'computer_config_key_invalid');
  const der = Buffer.from(hex, 'hex');
  let seedOnly: Buffer | undefined;
  try {
    const legacy = der.length === 85;
    const prefix = legacy ? PKCS8_LEGACY_PREFIX : PKCS8_V2_PREFIX;
    const suffix = Buffer.from(legacy ? 'a123032100' : '812100', 'hex');
    check(der.subarray(0, 16).equals(prefix) && der.subarray(48, 48 + suffix.length).equals(suffix), 'computer_config_key_invalid');
    const embeddedPublic = der.subarray(48 + suffix.length);
    seedOnly = Buffer.concat([PKCS8_V1_PREFIX, der.subarray(16, 48)]);
    const key = createPrivateKey({ key: seedOnly, format: 'der', type: 'pkcs8' });
    check(key.asymmetricKeyType === 'ed25519', 'computer_config_key_invalid');
    const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
    check(spki.length === 44 && spki.subarray(0, 12).equals(SPKI_PREFIX), 'computer_config_key_invalid');
    const derivedPublic = spki.subarray(12);
    check(timingSafeEqual(derivedPublic, embeddedPublic) && timingSafeEqual(derivedPublic, Buffer.from(declaredPublic, 'hex')), 'computer_config_key_mismatch');
    return key;
  } catch (error) { if (error instanceof ComputerConfigError) throw error; throw new ComputerConfigError('computer_config_key_invalid'); }
  finally { der.fill(0); seedOnly?.fill(0); }
}
/** Stage two, after BFF identity verification. No registration, network or writes. */
export function loadComputerConfig(options: LoadComputerConfigOptions): LoadedComputerConfig {
  const expected = validateConfig(options.expectedConfig);
  const config = readComputerConfig(options.configPath);
  check(JSON.stringify(config) === JSON.stringify(expected), 'computer_config_snapshot_changed');
  const identity = record(options.identity, ['principalId', 'agentId', 'contextId', 'sessionId'], 'computer_config_identity_invalid');
  const binding: ComputerEdgeBinding = { nodeId: config.nodeId, targetId: config.targetId, policyDigest: config.policyDigest, principalId: String(identity.principalId), agentId: String(identity.agentId), contextId: String(identity.contextId), sessionId: String(identity.sessionId) };
  check(Object.values(identity).every(edgeId), 'computer_config_identity_invalid');
  try { validateComputerBinding(binding); } catch { throw new ComputerConfigError('computer_config_identity_invalid'); }
  const runtimeOrigin = localOrigin(options.runtimeOrigin);
  const credentials = record(readSelectedJson(config.credentialsPath, true), CREDENTIAL_KEYS, 'computer_config_credentials_invalid');
  check(credentials.node_id === config.nodeId, 'computer_config_node_mismatch');
  check(localOrigin(credentials.server_url) === runtimeOrigin, 'computer_config_runtime_origin_mismatch');
  let privateKey: KeyObject | undefined = nativePrivateKey(credentials.device_private_key_pkcs8, credentials.device_public_key);
  // Drop the JS reference promptly. JS string/KeyObject erasure is not guaranteed.
  credentials.device_private_key_pkcs8 = undefined;
  const deviceKeyFingerprint = `sha256:${createHash('sha256').update(Buffer.from(credentials.device_public_key as string, 'hex')).digest('hex')}`;
  check(credentials.device_key_fingerprint === deviceKeyFingerprint, 'computer_config_fingerprint_mismatch');
  return Object.freeze({
    config, binding: Object.freeze(binding), runtimeOrigin, deviceKeyFingerprint,
    async signConnectionProof(bytes: Uint8Array): Promise<string> {
      check(privateKey !== undefined, 'computer_config_signer_closed');
      check(bytes instanceof Uint8Array && bytes.byteLength <= 1600, 'computer_config_proof_invalid');
      const proof = Buffer.from(bytes), parts = proof.toString('utf8').split('\0');
      check(parts.length === 4 && parts[0] === 'morphz-edge-connect-v1' && parts[1] === binding.nodeId && edgeId(parts[2]) && edgeId(parts[3]) && proof.equals(Buffer.from(parts.join('\0'))), 'computer_config_proof_invalid');
      try { return sign(null, proof, privateKey).toString('hex'); }
      catch { throw new ComputerConfigError('computer_config_signer_failed'); }
    },
    close() { privateKey = undefined; },
  });
}
