import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalPublicOrigin } from './application-origin.ts';
import { AuthError, authCheck, authConfigFingerprint, authDigest, validateOwnerAuthConfig, verifyOwnerCredential, type OwnerAuthConfig } from './auth-config.ts';

export interface AuthSession { id: string; ownerId: string; deviceLabel: string; createdAt: number; lastSeenAt: number; expiresAt: number; absoluteExpiresAt: number; csrfToken: string }
export interface AuthDevice { id: string; deviceLabel: string; createdAt: number; lastSeenAt: number; expiresAt: number; absoluteExpiresAt: number; current: boolean }
export interface OwnerAuthOptions { db: DatabaseSync; ownerId: string; origin: string; config: OwnerAuthConfig; now?: () => number }
interface SessionRow { id: string; token_hash: string; config_hash: string; generation: number; device_label: string; created_at: number; last_seen_at: number; expires_at: number }
interface StateRow { owner_id: string; origin: string; config_hash: string; generation: number }
export const AUTH_LIMITS = Object.freeze({ attemptsPerRemote: 5, attemptsGlobal: 20, attemptWindowMs: 300_000, maximumRemoteBuckets: 256, maximumConcurrentVerifications: 1, maximumCookieBytes: 8192, maximumPasswordBytes: 1024 });

/** Must be called even when auth config is absent. Never silently downgrade an
 * existing authenticated database to the development loopback-only mode. */
export function assertAuthenticationMode(db: DatabaseSync, configured: boolean): void {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_owner_state'").get();
  if (!configured && table && db.prepare('SELECT 1 FROM auth_owner_state LIMIT 1').get()) throw new AuthError('authentication_configuration_required', 503);
}
function originOf(value: string) {
  let url: URL; try { url = new URL(value); } catch { throw new AuthError('authentication_origin_invalid', 400); }
  if (url.protocol === 'https:') {
    try { return canonicalPublicOrigin(value); } catch { throw new AuthError('authentication_origin_invalid', 400); }
  }
  authCheck(['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && value.trim() === value, 'authentication_origin_invalid');
  return url.origin;
}
function equalHex(a: unknown, b: string): boolean { return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }

/** Single owner / multiple revocable browser sessions. Adapted from the pinned
 * Morphz application's IdentityCenter security contract, not its workspace model.
 * All sessions retain the BFF's existing saved owner; they grant no new Runtime
 * Principal, Agent, Context, gateway or operator authority.
 */
export class OwnerAuth {
  readonly cookieName: string;
  readonly origin: string;
  private readonly db: DatabaseSync;
  private readonly ownerId: string;
  private readonly now: () => number;
  private config: OwnerAuthConfig;
  private configHash: string;
  private closed = false;
  private closing?: Promise<void>;
  private active?: Promise<void>;
  private invalidators = new Set<(sessionId: string | null) => void>();
  constructor(options: OwnerAuthOptions) {
    this.db = options.db; this.ownerId = options.ownerId; this.now = options.now ?? Date.now;
    authCheck(typeof this.ownerId === 'string' && /^[A-Za-z0-9_.:-]{1,512}$/.test(this.ownerId), 'authentication_owner_invalid');
    this.origin = originOf(options.origin); this.config = validateOwnerAuthConfig(options.config); this.configHash = authConfigFingerprint(this.config);
    this.cookieName = `${this.origin.startsWith('https:') ? '__Host-' : ''}opendots_owner_${authDigest(this.ownerId + '\0' + this.origin).slice(0, 16)}`;
    this.db.exec(`CREATE TABLE IF NOT EXISTS auth_owner_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_id TEXT NOT NULL,origin TEXT NOT NULL,config_hash TEXT NOT NULL,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_device_sessions(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,config_hash TEXT NOT NULL,generation INTEGER NOT NULL,device_label TEXT NOT NULL,created_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_attempt_windows(bucket TEXT PRIMARY KEY,started_at INTEGER NOT NULL,count INTEGER NOT NULL);`);
    this.transaction(() => {
      const state = this.state();
      if (state) {
        authCheck(state.owner_id === this.ownerId && state.origin === this.origin, 'authentication_owner_binding_mismatch', 403);
        if (state.config_hash !== this.configHash) {
          this.db.prepare('DELETE FROM auth_device_sessions').run();
          this.db.prepare('UPDATE auth_owner_state SET config_hash=?,generation=generation+1 WHERE singleton=1').run(this.configHash);
        }
      } else this.db.prepare('INSERT INTO auth_owner_state VALUES(1,?,?,?,1)').run(this.ownerId, this.origin, this.configHash);
      this.purge();
    });
  }
  private state() {
    try { return this.db.prepare('SELECT * FROM auth_owner_state WHERE singleton=1').get() as StateRow | undefined; }
    catch { throw new AuthError('authentication_unavailable', 503); }
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} if (error instanceof AuthError) throw error; throw new AuthError('authentication_unavailable', 503); }
  }
  private currentState(): StateRow {
    authCheck(!this.closed, 'authentication_unavailable', 503);
    const state = this.state();
    authCheck(!this.closed && state && state.owner_id === this.ownerId && state.origin === this.origin && state.config_hash === this.configHash, 'authentication_unavailable', 503);
    return state;
  }
  private requireOrigin(origin: unknown) { authCheck(origin === this.origin, 'authentication_request_rejected', 403); }
  private expiry(row: SessionRow) { return Math.min(row.expires_at, row.last_seen_at + this.config.idleTtlSeconds * 1000); }
  private purge() {
    const now = this.now();
    this.db.prepare('DELETE FROM auth_device_sessions WHERE expires_at<=? OR last_seen_at<=?').run(now, now - this.config.idleTtlSeconds * 1000);
    this.db.prepare('DELETE FROM auth_attempt_windows WHERE started_at<=?').run(now - AUTH_LIMITS.attemptWindowMs);
  }
  private attempt(remoteAddress: string | undefined) {
    const candidate = typeof remoteAddress === 'string' && remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
    const address = typeof candidate === 'string' && isIP(candidate) ? candidate : 'unknown';
    const bucket = authDigest('remote\0' + address), now = this.now();
    // Counters are committed even when rejecting. A process restart is not a reset.
    const allowed = this.transaction(() => {
      this.purge();
      const increment = (key: string, maximum: number) => {
        const row = this.db.prepare('SELECT count FROM auth_attempt_windows WHERE bucket=?').get(key) as { count: number } | undefined;
        if (!row) this.db.prepare('INSERT INTO auth_attempt_windows VALUES(?,?,1)').run(key, now);
        else this.db.prepare('UPDATE auth_attempt_windows SET count=? WHERE bucket=?').run(Math.min(row.count + 1, maximum + 1), key);
        return !row || row.count < maximum;
      };
      if (!increment('global', AUTH_LIMITS.attemptsGlobal)) return false;
      const exists = this.db.prepare('SELECT 1 FROM auth_attempt_windows WHERE bucket=?').get(bucket);
      const count = Number((this.db.prepare('SELECT COUNT(*) AS count FROM auth_attempt_windows').get() as { count: number }).count);
      if (!exists && count >= AUTH_LIMITS.maximumRemoteBuckets + 1) return false;
      return increment(bucket, AUTH_LIMITS.attemptsPerRemote);
    });
    authCheck(allowed, 'authentication_try_later', 429);
  }
  private cookie(secret: string, maximumAge: number) { return `${this.cookieName}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maximumAge}${this.origin.startsWith('https:') ? '; Secure' : ''}`; }
  clearCookie() { return this.cookie('', 0); }
  private secret(cookie: string | undefined): string | null {
    if (typeof cookie !== 'string' || Buffer.byteLength(cookie) > AUTH_LIMITS.maximumCookieBytes) return null;
    const values = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(this.cookieName + '='));
    if (values.length !== 1) return null;
    const secret = values[0].slice(this.cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(secret) ? secret : null;
  }
  private csrf(secret: string, row: SessionRow) { return createHmac('sha256', Buffer.from(secret, 'hex')).update(`opendots-csrf-v1\0${this.ownerId}\0${row.id}`).digest('hex'); }
  private projection(secret: string, row: SessionRow): AuthSession {
    return Object.freeze({ id: row.id, ownerId: this.ownerId, deviceLabel: row.device_label, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: this.expiry(row), absoluteExpiresAt: row.expires_at, csrfToken: this.csrf(secret, row) });
  }
  async login(input: { credential: unknown; deviceLabel: unknown }, context: { origin: unknown; remoteAddress?: string; signal?: AbortSignal }): Promise<{ setCookie: string; session: AuthSession }> {
    this.requireOrigin(context.origin); const state = this.currentState(); this.attempt(context.remoteAddress);
    authCheck(!this.active, 'authentication_try_later', 429);
    authCheck(input && typeof input === 'object' && Object.keys(input).length === 2 && typeof input.deviceLabel === 'string' && input.deviceLabel.length >= 1 && input.deviceLabel.length <= 80 && input.deviceLabel.trim() === input.deviceLabel && !/[\x00-\x1f\x7f<>]/.test(input.deviceLabel), 'authentication_failed', 401);
    const label = input.deviceLabel;
    authCheck(!context.signal?.aborted, 'authentication_failed', 401);
    let release!: () => void; this.active = new Promise<void>(resolve => { release = resolve; });
    try {
      const verified = await verifyOwnerCredential(this.config.credential, input.credential);
      const current = this.currentState();
      authCheck(verified && current.generation === state.generation && current.config_hash === state.config_hash && !context.signal?.aborted, 'authentication_failed', 401);
      return this.transaction(() => {
        this.purge();
        const count = (this.db.prepare('SELECT COUNT(*) AS count FROM auth_device_sessions').get() as { count: number }).count;
        authCheck(count < this.config.maximumDevices, 'authentication_device_limit', 409);
        const secret = randomBytes(32).toString('hex'), now = this.now();
        const row: SessionRow = { id: randomUUID(), token_hash: authDigest(secret), config_hash: this.configHash, generation: current.generation, device_label: label, created_at: now, last_seen_at: now, expires_at: now + this.config.sessionTtlSeconds * 1000 };
        this.db.prepare('INSERT INTO auth_device_sessions VALUES(?,?,?,?,?,?,?,?)').run(row.id, row.token_hash, row.config_hash, row.generation, row.device_label, row.created_at, row.last_seen_at, row.expires_at);
        return { setCookie: this.cookie(secret, this.config.sessionTtlSeconds), session: this.projection(secret, row) };
      });
    } finally { this.active = undefined; release(); }
  }
  authenticate(cookie: string | undefined): AuthSession | null {
    if (this.closed) return null;
    const state = this.currentState(), secret = this.secret(cookie); if (!secret) return null;
    const row = this.db.prepare('SELECT * FROM auth_device_sessions WHERE token_hash=?').get(authDigest(secret)) as SessionRow | undefined;
    if (!row || row.config_hash !== state.config_hash || row.generation !== state.generation || this.expiry(row) <= this.now()) return null;
    // Bounded write rate; expiry remains authoritative between touches.
    if (this.now() - row.last_seen_at >= 30_000) { row.last_seen_at = this.now(); this.db.prepare('UPDATE auth_device_sessions SET last_seen_at=? WHERE id=?').run(row.last_seen_at, row.id); }
    return this.projection(secret, row);
  }
  private required(cookie: string | undefined) { const session = this.authenticate(cookie); authCheck(session, 'authentication_required', 401); return session; }
  requireMutation(cookie: string | undefined, csrf: unknown, origin: unknown): AuthSession {
    this.requireOrigin(origin); const session = this.required(cookie); authCheck(equalHex(csrf, session.csrfToken), 'authentication_request_rejected', 403); return session;
  }
  /** Internal transport/long-operation fence. It never grants from an opaque ID. */
  isCurrentSession(id: string): boolean {
    if (this.closed) return false;
    const state = this.currentState();
    const row = this.db.prepare('SELECT * FROM auth_device_sessions WHERE id=?').get(id) as SessionRow | undefined;
    return Boolean(row && row.config_hash === state.config_hash && row.generation === state.generation && this.expiry(row) > this.now());
  }
  /** Close authenticated streams on explicit revocation; also check expiry on a
   * bounded timer/every packet with isCurrentSession. Listener errors stay private. */
  onInvalidate(listener: (sessionId: string | null) => void) { this.invalidators.add(listener); return () => { this.invalidators.delete(listener); }; }
  private invalidate(id: string | null) { for (const listener of this.invalidators) { try { listener(id); } catch {} } }
  listDevices(cookie: string | undefined): { devices: AuthDevice[] } {
    const session = this.required(cookie); this.purge();
    return { devices: (this.db.prepare('SELECT * FROM auth_device_sessions ORDER BY created_at,id').all() as unknown as SessionRow[]).map(row => ({ id: row.id, deviceLabel: row.device_label, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: this.expiry(row), absoluteExpiresAt: row.expires_at, current: row.id === session.id })) };
  }
  revokeDevice(cookie: string | undefined, csrf: unknown, origin: unknown, id: string): { revoked: boolean; current: boolean; setCookie?: string } {
    const session = this.requireMutation(cookie, csrf, origin);
    authCheck(typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id), 'authentication_request_rejected', 400);
    const result = this.db.prepare('DELETE FROM auth_device_sessions WHERE id=?').run(id);
    if (result.changes) this.invalidate(id);
    return { revoked: Boolean(result.changes), current: id === session.id, ...(id === session.id ? { setCookie: this.clearCookie() } : {}) };
  }
  logout(cookie: string | undefined, csrf: unknown, origin: unknown) { const session = this.requireMutation(cookie, csrf, origin); return this.revokeDevice(cookie, csrf, origin, session.id); }
  revokeAll(cookie: string | undefined, csrf: unknown, origin: unknown): { revoked: number; setCookie: string } {
    this.requireMutation(cookie, csrf, origin);
    const count = this.transaction(() => { const result = this.db.prepare('DELETE FROM auth_device_sessions').run(); this.db.prepare('UPDATE auth_owner_state SET generation=generation+1 WHERE singleton=1').run(); return Number(result.changes); });
    this.invalidate(null); return { revoked: count, setCookie: this.clearCookie() };
  }
  replaceConfiguration(value: OwnerAuthConfig) {
    this.currentState(); const config = validateOwnerAuthConfig(value), fingerprint = authConfigFingerprint(config);
    if (fingerprint === this.configHash) return;
    this.transaction(() => { this.db.prepare('DELETE FROM auth_device_sessions').run(); this.db.prepare('UPDATE auth_owner_state SET config_hash=?,generation=generation+1 WHERE singleton=1').run(fingerprint); });
    this.config = config; this.configHash = fingerprint; this.invalidate(null);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve(this.active).then(() => { this.invalidators.clear(); });
    this.invalidate(null);
    return this.closing;
  }
}
