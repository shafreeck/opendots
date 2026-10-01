import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { ConnectorError, checkConnector } from './connector-types.ts';

export const HOST_CONNECTOR_PATH = '/api/host-tools/connectors/call';
export const HOST_CALENDAR_PATH = '/api/host-tools/calendar/call';
export interface NativeHostRoute {
  readonly path: typeof HOST_CONNECTOR_PATH | typeof HOST_CALENDAR_PATH;
  readonly token: string;
  readonly handle: (authorization: string, body: unknown, signal: AbortSignal) => Promise<unknown>;
}
export interface NativeHostListenerOptions { port: number; routes: readonly NativeHostRoute[] }

// Do not reflect arbitrary exception messages, codes, or status values to callers.
const PUBLIC_ERRORS: Readonly<Record<string, number>> = Object.freeze({
  connector_host_closed: 503,
  connector_callback_origin_denied: 403,
  connector_callback_route_denied: 404,
  connector_browser_callback_denied: 403,
  connector_callback_unauthorized: 401,
  connector_callback_json_required: 415,
  connector_callback_body_limit: 413,
  connector_callback_json_invalid: 400,
  connector_callback_interrupted: 503,
  connector_callback_unavailable: 503,
  connector_invalid_request: 400,
  connector_json_limit: 413,
  connector_parameters_invalid: 400,
  connector_permission_denied: 403,
  connector_scope_denied: 403,
  connector_job_mismatch: 403,
  connector_thread_mismatch: 403,
  connector_route_mismatch: 403,
  connector_arguments_mismatch: 403,
  connector_execution_inactive: 409,
  connector_receipt_conflict: 409,
  connector_unavailable: 404,
  connector_operation_unavailable: 404,
  connector_configuration_changed: 403,
  connector_saved_binding_required: 403,
  connector_request_aborted: 503,
  connector_authority_unavailable: 503,
  connector_transport_unavailable: 503,
  connector_response_limit: 502,
  calendar_proposal_limit: 409,
  calendar_proposal_call_conflict: 409,
  calendar_proposal_not_found: 404,
  calendar_proposal_scope_denied: 403,
});

/** The two private native callbacks share only HTTP transport. Callers verify
 * configuration and identity before starting; each domain handler must still
 * verify its complete native invocation proof. Construction opens no socket. */
export class NativeHostListener {
  private readonly port: number;
  private readonly routes = new Map<string, Readonly<NativeHostRoute>>();
  private readonly lifetime = new AbortController();
  private readonly handlers = new Set<Promise<unknown>>();
  private readonly sockets = new Set<Socket>();
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private accepting = false;
  private readonly server = createServer((request, response) => {
    // Keep these listeners after an early response/body-reader cleanup: peer
    // resets can arrive later and must never become uncaught stream errors.
    request.on('error', () => undefined);
    response.on('error', () => undefined);
    this.track(Promise.resolve().then(() => this.respond(request, response)));
  });

  constructor(options: NativeHostListenerOptions) {
    checkConnector(Number.isInteger(options.port) && options.port >= 1024 && options.port <= 65_535, 'connector_configuration_invalid');
    checkConnector(Array.isArray(options.routes) && options.routes.length >= 1 && options.routes.length <= 2, 'connector_registry_invalid');
    this.port = options.port;
    const tokens = new Set<string>();
    for (const route of options.routes) {
      checkConnector(route && [HOST_CONNECTOR_PATH, HOST_CALENDAR_PATH].includes(route.path) && !this.routes.has(route.path) && typeof route.handle === 'function', 'connector_registry_invalid');
      checkConnector(typeof route.token === 'string' && /^[\x21-\x7e]{32,1024}$/.test(route.token), 'connector_token_invalid');
      checkConnector(!tokens.has(route.token), 'connector_separate_callback_token_required');
      tokens.add(route.token);
      this.routes.set(route.path, Object.freeze({ ...route }));
    }
    this.server.requestTimeout = 5_000;
    this.server.headersTimeout = 5_000;
    this.server.keepAliveTimeout = 1_000;
    this.server.maxRequestsPerSocket = 20;
    this.server.on('connection', socket => {
      socket.on('error', () => undefined);
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      if (this.lifetime.signal.aborted) socket.destroy();
    });
    this.server.on('clientError', (_error, socket) => socket.destroy());
    this.server.on('error', () => { this.accepting = false; });
  }

  snapshot(): { listening: boolean; closed: boolean } {
    return { listening: this.accepting && this.server.listening, closed: this.lifetime.signal.aborted };
  }

  start(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.reject(new ConnectorError('connector_host_closed', 503));
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.server.off('error', error); this.server.off('listening', listening); };
      const error = () => { cleanup(); reject(new ConnectorError('connector_callback_unavailable', 503)); };
      const listening = () => {
        cleanup();
        if (this.lifetime.signal.aborted) reject(new ConnectorError('connector_host_closed', 503));
        else { this.accepting = true; resolve(); }
      };
      this.server.once('error', error);
      this.server.once('listening', listening);
      try { this.server.listen(this.port, '127.0.0.1'); } catch { error(); }
    });
    return this.starting;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.handlers.add(operation);
    void operation.then(() => this.handlers.delete(operation), () => this.handlers.delete(operation));
    return operation;
  }

  private authenticate(request: IncomingMessage): { route: Readonly<NativeHostRoute>; authorization: string } {
    checkConnector(request.socket.remoteAddress === '127.0.0.1' && request.headers.host === `127.0.0.1:${this.port}`, 'connector_callback_origin_denied', 403);
    const route = request.url === undefined ? undefined : this.routes.get(request.url);
    checkConnector(request.method === 'POST' && route, 'connector_callback_route_denied', 404);
    checkConnector(['origin', 'cookie', 'sec-fetch-site', 'x-opendots-csrf'].every(name => !Object.hasOwn(request.headers, name)), 'connector_browser_callback_denied', 403);
    // Node may discard duplicate singleton headers; refuse that ambiguity.
    const count = (name: string) => request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === name).length;
    checkConnector(count('host') === 1, 'connector_callback_origin_denied', 403);
    const authorization = request.headers.authorization;
    const expected = Buffer.from(`Bearer ${route.token}`);
    const actual = Buffer.from(authorization ?? '');
    checkConnector(count('authorization') === 1 && typeof authorization === 'string' && actual.length === expected.length && timingSafeEqual(actual, expected), 'connector_callback_unauthorized', 401);
    checkConnector(count('content-type') === 1 && request.headers['content-type']?.split(';')[0]?.trim() === 'application/json', 'connector_callback_json_required', 415);
    return { route, authorization };
  }

  private readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0, settled = false;
      const timer = setTimeout(() => finish(new ConnectorError('connector_callback_interrupted', 503)), 5_000);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        request.off('data', data); request.off('end', end);
        request.off('error', error); request.off('aborted', error);
        signal.removeEventListener('abort', abort);
      };
      const finish = (failure?: ConnectorError, value?: unknown) => {
        if (settled) return;
        settled = true; cleanup();
        if (failure) reject(failure); else resolve(value);
      };
      const error = () => finish(new ConnectorError('connector_callback_interrupted', 503));
      const abort = () => finish(new ConnectorError('connector_callback_interrupted', 503));
      const data = (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65_536) finish(new ConnectorError('connector_callback_body_limit', 413));
        else chunks.push(chunk);
      };
      const end = () => {
        try { finish(undefined, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))); }
        catch { finish(new ConnectorError('connector_callback_json_invalid')); }
      };
      request.on('data', data); request.once('end', end);
      request.once('error', error); request.once('aborted', error);
      signal.addEventListener('abort', abort, { once: true });
      const length = request.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 65_536)) finish(new ConnectorError('connector_callback_body_limit', 413));
      else if (signal.aborted) abort();
    });
  }

  private async bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort!: () => void;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        abort = () => reject(new ConnectorError('connector_callback_interrupted', 503));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally { signal.removeEventListener('abort', abort); }
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    const disconnected = new AbortController(), deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 15_000); timer.unref();
    const onDisconnect = () => { if (!response.writableEnded) disconnected.abort(); };
    request.once('aborted', onDisconnect); response.once('close', onDisconnect);
    const signal = AbortSignal.any([this.lifetime.signal, disconnected.signal, deadline.signal]);
    try {
      checkConnector(this.accepting && !signal.aborted, 'connector_host_closed', 503);
      const { route, authorization } = this.authenticate(request);
      const body = await this.readBody(request, signal);
      checkConnector(!signal.aborted, 'connector_callback_interrupted', 503);
      // Track the actual domain promise as well as the response. A deadline may
      // end HTTP first, but close must still await the admitted handler's cleanup.
      const operation = this.track(Promise.resolve().then(() => {
        checkConnector(!signal.aborted, 'connector_callback_interrupted', 503);
        return route.handle(authorization, body, signal);
      }));
      const result = await this.bounded(operation, signal);
      checkConnector(!signal.aborted, 'connector_callback_interrupted', 503);
      const encoded = JSON.stringify(result);
      checkConnector(typeof encoded === 'string', 'connector_callback_unavailable', 503);
      if (!response.destroyed) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(encoded); }
    } catch (error) {
      // Never keep an early-rejected or partial body alive for another request.
      request.resume();
      if (!response.destroyed && !response.headersSent) {
        const code = error instanceof ConnectorError && Object.hasOwn(PUBLIC_ERRORS, error.code) ? error.code : 'connector_callback_unavailable';
        response.writeHead(PUBLIC_ERRORS[code]!, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ error: code, code }));
      }
    } finally {
      clearTimeout(timer); request.off('aborted', onDisconnect); response.off('close', onDisconnect);
    }
  }

  /** Stops admission synchronously, aborts and drains admitted handlers, then
   * closes transport. Domain hosts and their database remain caller-owned. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    // Assign before abort dispatch, which can synchronously re-enter close.
    let finish!: () => void, fail!: (reason: unknown) => void;
    this.closing = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    this.lifetime.abort();
    const stop = () => new Promise<void>(resolve => {
      this.server.close(() => resolve());
      this.server.closeIdleConnections();
    });
    let stopped = this.server.listening ? stop() : undefined;
    void (async () => {
      await this.starting?.catch(() => undefined);
      if (!stopped && this.server.listening) stopped = stop();
      while (this.handlers.size) await Promise.allSettled([...this.handlers]);
      this.server.closeAllConnections();
      for (const socket of this.sockets) socket.destroy();
      await stopped;
    })().then(finish, fail);
    return this.closing;
  }
}
