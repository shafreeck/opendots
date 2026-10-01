import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { ComputerControl, ControlConflict, type ComputerState, type ControlLease } from './computer-control.ts';
import { canonicalPublicOrigin, createApplicationOrigin } from './application-origin.ts';

export class ComputerGatewayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface ComputerGatewayOptions {
  dbPath: string;
  previewPort?: number;
  controlPort?: number;
  /** An operator configuration assertion, not something RFB can detect.
   * Deploy two x11vnc endpoints on the SAME display; preview must use -viewonly
   * and disable clipboard input. Never point both ports at a control endpoint.
   */
  previewReadOnlyEnforced?: boolean;
  /** Trusted backend integration only: settle remote input, capture THIS same
   * live desktop after the fence, return its observation identity/time.
   * A browser-supplied image, timestamp or ID is never accepted.
   */
  captureSettledObservation?: (sessionId: string, context: { acknowledgeUncertainty: boolean }) => Promise<{ id: string; capturedAt: number }>;
  prepareHumanControl?: (epoch: number) => Promise<{ id: string; uncertainty?: boolean }>;
  abandonHumanControl?: (handle: { id: string }) => Promise<void>;
  closeHumanControl?: () => Promise<void>;
  /** Product browser authentication only; never a model-supplied identity. */
  authentication?: { authenticate(cookie: string | undefined): { id: string } | null; isCurrentSession(id: string): boolean };
  /** Explicit BFF browser origin only; upstream VNC stays numeric loopback. */
  publicOrigin?: string;
  now?: () => number;
}
interface Ticket { origin: string; owner: 'preview' | 'human'; epoch: number; expiresAt: number; authSessionId?: string }
interface Connection {
  ws: WebSocket; socket: Socket; owner: Ticket['owner']; epoch: number; authSessionId?: string;
  queued: Buffer[]; queuedBytes: number; pumping?: Promise<void>; closed: boolean;
}
const SESSION = 'opendots-computer';
const BUFFER_LIMIT = 262144;
const validPort = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
const dataBuffer = (data: RawData): Buffer => Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);

/** Loopback single-user RFB bridge. No CDP, browser debugger, shell or arbitrary
 * upstream URL is exposed. Human and AI dispatch share the same epoch arbiter.
 * A preview endpoint is a distinct, server-enforced read-only VNC server.
 */
export class ComputerGateway {
  private options: ComputerGatewayOptions;
  private control?: ComputerControl;
  private tickets = new Map<string, Ticket>();
  private connections = new Set<Connection>();
  private pumps = new Set<Promise<void>>();
  private aiActions = new Set<Promise<unknown>>();
  private wss: WebSocketServer;
  private timer?: ReturnType<typeof setInterval>;
  private server?: Server;
  private closed = false;
  private now: () => number;
  readonly configured: boolean;
  constructor(options: ComputerGatewayOptions) {
    const publicOrigin = options.publicOrigin === undefined ? undefined : canonicalPublicOrigin(options.publicOrigin);
    if (publicOrigin && !options.authentication) throw new ComputerGatewayError(503, 'HTTPS computer transport requires owner authentication');
    this.options = { ...options, publicOrigin }; this.now = options.now ?? Date.now;
    if(Boolean(options.prepareHumanControl)!==Boolean(options.abandonHumanControl))throw new ComputerGatewayError(503, 'Owned human control startup and cleanup must be configured together');
    const requested = options.previewPort !== undefined || options.controlPort !== undefined;
    if (requested && (!validPort(options.previewPort) || !validPort(options.controlPort) || options.previewPort === options.controlPort || options.previewReadOnlyEnforced !== true)) throw new ComputerGatewayError(503, 'Computer preview requires distinct loopback VNC ports and an operator-configured read-only preview endpoint');
    this.configured = requested;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: BUFFER_LIMIT, perMessageDeflate: false, handleProtocols: protocols => protocols.has('binary') ? 'binary' : false });
    if (this.configured) {
      this.control = new ComputerControl(options.dbPath, this.now);
      try { this.control.state(SESSION); } catch { this.control.createSession(SESSION); }
      this.timer = setInterval(() => this.expire(), 250); this.timer.unref();
    }
  }
  attach(server: Server) {
    if (this.server) throw new ComputerGatewayError(409, 'Computer gateway is already attached');
    this.server = server; server.on('upgrade', this.upgrade);
  }
  snapshot() {
    const state = this.control?.state(SESSION) ?? null;
    return {
      configured: this.configured, state,
      capabilities: { preview: this.configured, humanControl: this.configured, aiControl: this.configured && Boolean(this.options.captureSettledObservation) },
      message: !this.configured ? 'Computer is not configured. Start the isolated same-display preview/control services before enabling access.' : !this.options.captureSettledObservation ? 'Same-session VNC access configured. Return to AI is disabled until trusted input settlement and fresh desktop observation are integrated.' : 'Same-session desktop control is lease-gated. Previously dispatched external effects are not undone by takeover.',
    };
  }
  private requireControl() {
    if (!this.control || this.closed) throw new ComputerGatewayError(503, 'Computer access is not configured');
    return this.control;
  }
  private expectEpoch(epoch: number) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new ComputerGatewayError(400, 'A nonnegative expectedEpoch is required');
    const state = this.requireControl().state(SESSION);
    if (state.epoch !== epoch) throw new ComputerGatewayError(409, 'Computer control changed. Refresh before trying again.');
    return state;
  }
  private sessionCurrent(id: string | undefined) {
    if (!this.options.authentication) return id === undefined;
    try { return Boolean(id && this.options.authentication.isCurrentSession(id)); } catch { return false; }
  }
  private requireSession(id: string | undefined) { if (!this.sessionCurrent(id)) throw new ComputerGatewayError(401, 'Authentication required'); }
  /** Explicit logout/revocation hook. IDs originate from the auth service only. */
  revokeSessions(id: string | null) {
    for (const [value, ticket] of this.tickets) if (ticket.authSessionId && (id === null || ticket.authSessionId === id)) {
      this.tickets.delete(value);
      if (ticket.owner === 'human' && this.humanLeaseValid(ticket.epoch)) this.control!.pause(SESSION);
    }
    for (const connection of this.connections) if (connection.authSessionId && (id === null || connection.authSessionId === id)) this.disconnect(connection);
  }
  private mint(origin: string, owner: Ticket['owner'], epoch: number, authSessionId?: string) {
    this.requireSession(authSessionId);
    const policy = this.originPolicy();
    const legacyOrigin = !this.options.authentication && this.options.publicOrigin === undefined ? policy.origin.replace('127.0.0.1', 'localhost') : undefined;
    if (!policy.matchesOrigin(origin) && origin !== legacyOrigin) throw new ComputerGatewayError(403, 'Computer tickets require the configured application origin');
    const value = randomBytes(32).toString('base64url'); const expiresAt = this.now() + 15_000;
    if (this.tickets.size >= 100) throw new ComputerGatewayError(429, 'Too many pending computer connections');
    this.tickets.set(value, { origin, owner, epoch, expiresAt, authSessionId });
    return { url: origin === legacyOrigin ? policy.computerStreamUrl.replace('127.0.0.1', 'localhost') : policy.computerStreamUrl, protocols: ['binary', `opendots-ticket.${value}`], expiresAt, viewOnly: owner === 'preview' };
  }
  private originPolicy() {
    const address = this.server?.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new ComputerGatewayError(503, 'Computer transport requires the numeric-loopback application listener');
    return createApplicationOrigin({ localPort: address.port, ownerAuthEnabled: Boolean(this.options.authentication), publicOrigin: this.options.publicOrigin });
  }
  preview(origin: string, authSessionId?: string) { const state = this.requireControl().state(SESSION); return { state, connection: this.mint(origin, 'preview', state.epoch, authSessionId) }; }
  async takeover(expectedEpoch: number, origin: string, authSessionId?: string) {
    this.requireSession(authSessionId);
    this.expectEpoch(expectedEpoch);
    const transition = this.requireControl().takeover(SESSION); this.invalidateHumanConnections();
    const state = await transition;
    let handle: { id: string; uncertainty?: boolean } | undefined;
    try {
      handle = await this.options.prepareHumanControl?.(state.epoch);
      if (!this.humanLeaseValid(state.epoch)) throw new ComputerGatewayError(409, 'Human control changed during desktop startup');
      if(handle?.uncertainty===true)this.requireControl().noteUncertainty(SESSION);
      return { state: this.requireControl().state(SESSION), connection: this.mint(origin, 'human', state.epoch, authSessionId) };
    } catch {
      if (handle) { try { await this.options.abandonHumanControl!(handle); } catch { this.requireControl().pause(SESSION, true, state.epoch); } }
      this.requireControl().pause(SESSION, false, state.epoch);
      throw new ComputerGatewayError(409, 'Human control startup was not confirmed; no new input connection was granted');
    }
  }
  renew(epoch: number) {
    this.expectEpoch(epoch);
    return { state: this.requireControl().renew({ sessionId: SESSION, owner: 'human', epoch }) };
  }
  pause(expectedEpoch: number) {
    this.expectEpoch(expectedEpoch); const state = this.requireControl().pause(SESSION); this.invalidateHumanConnections(); return { state };
  }
  /** Internal executor recovery/disconnection only; never grants authority. */
  pauseTrusted(uncertain = false, expectedEpoch?: number) {
    const state = this.requireControl().pause(SESSION, uncertain, expectedEpoch);
    if (state.owner === 'paused') this.invalidateHumanConnections(); return { state };
  }
  async returnToAi(expectedEpoch: number, acknowledgeUncertainty = false, assertAuthorized: () => void = () => {}) {
    assertAuthorized();
    this.expectEpoch(expectedEpoch);
    if (this.requireControl().state(SESSION).uncertainty && acknowledgeUncertainty !== true) throw new ComputerGatewayError(409, 'A previous computer action has an unconfirmed outcome. Review the desktop and explicitly acknowledge that returning control cannot undo external effects.');
    if (!this.options.captureSettledObservation) throw new ComputerGatewayError(503, 'Return to AI requires a trusted fresh desktop observation and input-settlement integration. Control remains with you.');
    // Revocation is synchronous before the transfer waits for the current action.
    const transfer = this.requireControl().returnToAi(SESSION, async () => {
      // This callback may run synchronously before returnToAi() returns its Promise.
      // Close the transport and discard its queue BEFORE asking for the fresh observation.
      this.invalidateHumanConnections();
      await Promise.allSettled([...this.pumps]);
      // An in-flight action may have become uncertain while the transfer waited.
      if (this.requireControl().state(SESSION).uncertainty && acknowledgeUncertainty !== true) throw new ComputerGatewayError(409, 'A computer action became unconfirmed while transferring control. Review it before explicitly returning to AI.');
      try { const observation = await this.options.captureSettledObservation!(SESSION, { acknowledgeUncertainty }); assertAuthorized(); return observation; }
      catch (error) { this.requireControl().pause(SESSION, true, expectedEpoch + 1); throw error; }
    }, assertAuthorized);
    this.invalidateHumanConnections(); return { state: await transfer };
  }
  /** Trusted executor liveness only. Never grants ownership or refreshes an expired epoch. */
  renewAi(epoch: number) {
    if (!this.options.captureSettledObservation) throw new ComputerGatewayError(503, 'AI computer execution is not configured');
    this.expectEpoch(epoch);
    return { state: this.requireControl().renew({ sessionId: SESSION, owner: 'ai', epoch }) };
  }
  /** Internal executor entry only. No HTTP route accepts arbitrary actions. */
  async performAi<T>(epoch: number, action: () => Promise<T>): Promise<T> {
    if (!this.options.captureSettledObservation) throw new ComputerGatewayError(503, 'AI computer execution is not configured');
    const operation = this.requireControl().perform({ sessionId: SESSION, owner: 'ai', epoch }, action);
    this.aiActions.add(operation); try { return await operation; } finally { this.aiActions.delete(operation); }
  }
  private invalidateHumanConnections() {
    for (const [value, ticket] of this.tickets) if (ticket.owner === 'human') this.tickets.delete(value);
    for (const connection of this.connections) if (connection.owner === 'human') this.disconnect(connection);
  }
  private expire() {
    if (this.closed) return;
    for (const [value, ticket] of this.tickets) if (ticket.expiresAt <= this.now() || !this.sessionCurrent(ticket.authSessionId)) {
      this.tickets.delete(value);
      if (!this.sessionCurrent(ticket.authSessionId) && ticket.owner === 'human' && this.humanLeaseValid(ticket.epoch)) this.control!.pause(SESSION);
    }
    const state = this.control!.state(SESSION);
    if (['human', 'ai'].includes(state.owner) && state.leaseUntil <= this.now()) { this.control!.pause(SESSION); this.invalidateHumanConnections(); }
    for (const connection of this.connections) if (!this.sessionCurrent(connection.authSessionId) || (connection.owner === 'human' && !this.humanLeaseValid(connection.epoch))) this.disconnect(connection);
  }
  private humanLeaseValid(epoch: number) {
    const state = this.control?.state(SESSION);
    return Boolean(state?.owner === 'human' && state.epoch === epoch && state.leaseUntil > this.now());
  }
  private upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (!this.configured || this.closed || request.url !== '/api/computer/stream') return reject(404);
    let policy; try { policy = this.originPolicy(); } catch { return reject(403); }
    let origin = policy.origin;
    if (!policy.matchesRequest(request, 'websocket')) {
      // Historical unauthenticated localhost alias only, never HTTPS/auth mode.
      const legacyHost = policy.host.replace('127.0.0.1', 'localhost');
      if (this.options.authentication || this.options.publicOrigin !== undefined || request.headers.host !== legacyHost || request.headers.origin !== `http://${legacyHost}`) return reject(403);
      // Check the original alias headers directly; never rewrite browser Origin.
      const names = request.rawHeaders.filter((_value, index) => index % 2 === 0).map(name => name.toLowerCase());
      if (['host', 'origin', 'sec-fetch-site'].some(name => names.filter(value => value === name).length > 1)) return reject(403);
      const fetchSite = request.headers['sec-fetch-site'];
      if (fetchSite !== undefined && fetchSite !== 'same-origin') return reject(403);
      origin = `http://${legacyHost}`;
    }
    const protocols = request.headers['sec-websocket-protocol']?.split(',').map(value => value.trim()) ?? [];
    if (protocols.length !== 2 || !protocols.includes('binary')) return reject(403);
    const encoded = protocols.find(value => /^opendots-ticket\.[A-Za-z0-9_-]{43}$/.test(value));
    const token = encoded?.slice('opendots-ticket.'.length); const ticket = token ? this.tickets.get(token) : undefined;
    if (!ticket || ticket.origin !== origin || ticket.expiresAt <= this.now()) return reject(403);
    if (this.options.authentication) {
      let session; try { session = this.options.authentication.authenticate(request.headers.cookie); } catch { return reject(401); }
      if (!session || session.id !== ticket.authSessionId || !this.sessionCurrent(session.id)) return reject(401);
    }
    this.tickets.delete(token!); // One use, including an interrupted upgrade.
    if (ticket.owner === 'human' && !this.humanLeaseValid(ticket.epoch)) return reject(409);
    if (this.connections.size >= 8) return reject(429);
    this.wss.handleUpgrade(request, socket, head, ws => this.open(ws, ticket));
  };
  private open(ws: WebSocket, ticket: Ticket) {
    if (!this.sessionCurrent(ticket.authSessionId)) { ws.terminate(); return; }
    const socket = connect({ host: '127.0.0.1', port: ticket.owner === 'preview' ? this.options.previewPort! : this.options.controlPort! });
    const connection: Connection = { ws, socket, owner: ticket.owner, epoch: ticket.epoch, authSessionId: ticket.authSessionId, queued: [], queuedBytes: 0, closed: false };
    this.connections.add(connection);
    socket.setNoDelay(true); socket.setTimeout(120_000); // Fail-closed on a dead endpoint, no implicit owner change.
    socket.on('timeout', () => this.disconnect(connection));
    socket.on('data', data => {
      if (connection.closed || ws.readyState !== WebSocket.OPEN) return;
      if (!this.sessionCurrent(connection.authSessionId)) return this.disconnect(connection);
      if (ws.bufferedAmount + data.byteLength > 4 * 1024 * 1024) return this.disconnect(connection);
      ws.send(data, { binary: true }, error => { if (error) this.disconnect(connection); });
    });
    socket.on('error', () => this.disconnect(connection)); socket.on('close', () => this.disconnect(connection));
    ws.on('message', (data, isBinary) => {
      if (connection.closed || !isBinary) return this.disconnect(connection);
      if (!this.sessionCurrent(connection.authSessionId)) return this.disconnect(connection);
      const bytes = dataBuffer(data);
      if (connection.queuedBytes + bytes.length > BUFFER_LIMIT) return this.disconnect(connection);
      if (ticket.owner === 'human' && !this.humanLeaseValid(ticket.epoch)) return this.disconnect(connection);
      connection.queued.push(bytes); connection.queuedBytes += bytes.length;
      this.pump(connection);
    });
    ws.on('error', () => this.disconnect(connection)); ws.on('close', () => this.disconnect(connection));
  }
  private pump(connection: Connection) {
    if (connection.pumping || connection.closed) return;
    const operation = (async () => {
      while (!connection.closed && connection.queued.length) {
        const bytes = connection.queued.shift()!; connection.queuedBytes -= bytes.length;
        const write = () => new Promise<void>((resolve, reject) => {
          if (connection.closed || connection.socket.destroyed || !this.sessionCurrent(connection.authSessionId)) return reject(new ControlConflict('Computer connection closed before dispatch'));
          // Control.perform validates the epoch immediately before invoking this callback.
          connection.socket.write(bytes, error => error ? reject(error) : resolve());
        });
        if (connection.owner === 'human') await this.requireControl().perform({ sessionId: SESSION, owner: 'human', epoch: connection.epoch }, write);
        else await write(); // Read-only enforcement belongs to the isolated preview VNC server.
      }
    })().catch(() => this.disconnect(connection)).finally(() => { connection.pumping = undefined; this.pumps.delete(operation); });
    connection.pumping = operation; this.pumps.add(operation);
  }
  private disconnect(connection: Connection) {
    if (connection.closed) return;
    connection.closed = true; connection.queued = []; connection.queuedBytes = 0;
    connection.socket.destroy(); connection.ws.terminate(); this.connections.delete(connection);
    // Closing an obsolete socket must not revoke a newer tab's granted lease.
    if (connection.owner === 'human' && this.humanLeaseValid(connection.epoch)) {
      this.control!.pause(SESSION);
      for (const [value, ticket] of this.tickets) if (ticket.owner === 'human') this.tickets.delete(value);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; if (this.timer) clearInterval(this.timer); this.server?.off('upgrade', this.upgrade);
    const pending = [...this.pumps];
    if (this.control) this.control.pause(SESSION);
    for (const connection of this.connections) this.disconnect(connection);
    this.tickets.clear(); await Promise.allSettled([...pending, ...this.aiActions]);
    try { await this.options.closeHumanControl?.(); } catch { this.control?.pause(SESSION, true); }
    await new Promise<void>(resolve => this.wss.close(() => resolve())); this.control?.close();
  }
}
