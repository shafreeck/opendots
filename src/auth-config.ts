import { createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';

export type OwnerCredential = Readonly<{ kind: 'scrypt'; saltHex: string; hashHex: string; N: 131072; r: 8; p: 1 }> | Readonly<{ kind: 'morphz_login_token_sha256'; hashHex: string }>;
export interface OwnerAuthConfig {
  readonly version: 1;
  readonly credential: OwnerCredential;
  readonly sessionTtlSeconds: number;
  readonly idleTtlSeconds: number;
  readonly maximumDevices: number;
}
export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code = 'authentication_failed', status = 401) { super(code); this.name = 'AuthError'; this.code = code; this.status = status; }
}
export function authCheck(value: unknown, code: string, status = 400): asserts value { if (!value) throw new AuthError(code, status); }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  authCheck(value && typeof value === 'object' && !Array.isArray(value), 'authentication_configuration_invalid');
  const object = value as Record<string, unknown>;
  authCheck(Object.keys(object).length === keys.length && Object.keys(object).every(key => keys.includes(key)), 'authentication_configuration_invalid');
  return object;
}
export function validateOwnerAuthConfig(value: unknown): OwnerAuthConfig {
  const c = exact(value, ['version', 'credential', 'sessionTtlSeconds', 'idleTtlSeconds', 'maximumDevices']);
  const kind = c.credential && typeof c.credential === 'object' ? (c.credential as { kind?: unknown }).kind : undefined;
  authCheck(kind === 'scrypt' || kind === 'morphz_login_token_sha256', 'authentication_configuration_invalid');
  const credential = exact(c.credential, kind === 'scrypt' ? ['kind', 'saltHex', 'hashHex', 'N', 'r', 'p'] : ['kind', 'hashHex']);
  authCheck(typeof credential.hashHex === 'string' && (kind === 'scrypt' ? /^[a-f0-9]{128}$/ : /^[a-f0-9]{64}$/).test(credential.hashHex), 'authentication_configuration_invalid');
  if (kind === 'scrypt') authCheck(typeof credential.saltHex === 'string' && /^[a-f0-9]{64}$/.test(credential.saltHex) && credential.N === 131072 && credential.r === 8 && credential.p === 1, 'authentication_configuration_invalid');
  authCheck(c.version === 1 && Number.isSafeInteger(c.sessionTtlSeconds) && Number(c.sessionTtlSeconds) >= 300 && Number(c.sessionTtlSeconds) <= 2_592_000 && Number.isSafeInteger(c.idleTtlSeconds) && Number(c.idleTtlSeconds) >= 60 && Number(c.idleTtlSeconds) <= Math.min(Number(c.sessionTtlSeconds), 86_400) && Number.isSafeInteger(c.maximumDevices) && Number(c.maximumDevices) >= 1 && Number(c.maximumDevices) <= 32, 'authentication_configuration_invalid');
  const normalized: OwnerCredential = kind === 'scrypt'
    ? { kind, saltHex: credential.saltHex as string, hashHex: credential.hashHex, N: 131072, r: 8, p: 1 }
    : { kind, hashHex: credential.hashHex };
  return Object.freeze({ version: 1, credential: Object.freeze(normalized), sessionTtlSeconds: Number(c.sessionTtlSeconds), idleTtlSeconds: Number(c.idleTtlSeconds), maximumDevices: Number(c.maximumDevices) });
}
/** Explicit private operator file only. No HOME/env fallback, writes or setup. */
export function readOwnerAuthConfig(path: string): OwnerAuthConfig {
  authCheck(typeof path === 'string' && path.length <= 1024 && isAbsolute(path) && normalize(path) === path && !/[\x00-\x1f\x7f]/.test(path), 'authentication_configuration_path_invalid');
  authCheck(process.platform === 'linux' && typeof process.geteuid === 'function', 'authentication_configuration_platform_unsupported');
  let fd: number | undefined; const buffer = Buffer.alloc(16_385);
  try {
    const uid = process.geteuid();
    for (let parent = dirname(path);;) {
      const info = lstatSync(parent);
      authCheck(info.isDirectory() && [0, uid].includes(info.uid) && ((info.mode & 0o022) === 0 || (info.uid === 0 && (info.mode & 0o1000) !== 0)), 'authentication_configuration_path_untrusted');
      if (parent === dirname(parent)) break; parent = dirname(parent);
    }
    const before = lstatSync(path);
    const safe = (info: typeof before) => authCheck(info.isFile() && info.nlink === 1 && info.uid === uid && info.size > 0 && info.size <= 16_384 && (info.mode & 0o7177) === 0 && (info.mode & 0o400) !== 0, 'authentication_configuration_file_invalid');
    safe(before);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd); safe(opened);
    const unchanged = (a: typeof before, b: typeof before) => a.ino === b.ino && a.dev === b.dev && a.mode === b.mode && a.uid === b.uid && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    authCheck(unchanged(before, opened), 'authentication_configuration_changed');
    let length = 0;
    for (;;) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (count === 0) break; length += count; authCheck(length <= 16_384, 'authentication_configuration_file_invalid'); }
    authCheck(unchanged(opened, fstatSync(fd)) && unchanged(opened, lstatSync(path)), 'authentication_configuration_changed');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); } catch { throw new AuthError('authentication_configuration_invalid', 400); }
    return validateOwnerAuthConfig(parsed);
  } catch (error) { if (error instanceof AuthError) throw error; throw new AuthError('authentication_configuration_unavailable', 503); }
  finally { buffer.fill(0); if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}
export const authDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export function authConfigFingerprint(config: OwnerAuthConfig) { return authDigest(JSON.stringify(validateOwnerAuthConfig(config))); }
/** Verification only. No password/hash generation or identity provisioning API. */
export async function verifyOwnerCredential(credential: OwnerCredential, candidate: unknown): Promise<boolean> {
  if (typeof candidate !== 'string' || candidate.length < 1 || Buffer.byteLength(candidate) > 1024 || /[\ud800-\udfff]/u.test(candidate)) return false;
  if (credential.kind === 'morphz_login_token_sha256') return /^[a-f0-9]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(authDigest(candidate), 'hex'), Buffer.from(credential.hashHex, 'hex'));
  const bytes = Buffer.from(candidate, 'utf8');
  try {
    const derived = await new Promise<Buffer>((resolve, reject) => scrypt(bytes, Buffer.from(credential.saltHex, 'hex'), 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, result) => error ? reject(new AuthError('authentication_unavailable', 503)) : resolve(result)));
    try { return timingSafeEqual(derived, Buffer.from(credential.hashHex, 'hex')); } finally { derived.fill(0); }
  } catch { throw new AuthError('authentication_unavailable', 503); }
  finally { bytes.fill(0); }
}
