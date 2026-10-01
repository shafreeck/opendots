/** Product-facing origin policy only. This module does not create a listener,
 * terminate TLS, resolve DNS, trust proxy headers, or configure Morphz. */
export interface ApplicationOriginOptions {
  /** The actual port of the existing numeric-loopback listener, after binding. */
  localPort: number;
  ownerAuthEnabled: boolean;
  /** Explicit HTTPS browser origin behind an independently managed TLS proxy. */
  publicOrigin?: string;
}

export interface OriginRequest {
  readonly headers: Readonly<Record<string, unknown>>;
  /** Required: Node's parsed headers can discard duplicate Host fields. */
  readonly rawHeaders: readonly string[];
}

export type OriginRequestPurpose = 'read' | 'mutation' | 'websocket';

export interface ApplicationOrigin {
  readonly mode: 'loopback' | 'https-proxy';
  readonly origin: string;
  readonly host: string;
  readonly webSocketOrigin: string;
  readonly computerStreamUrl: string;
  readonly ownerAuthRequired: boolean;
  readonly matchesHost: (value: unknown) => boolean;
  /** A supplied Origin must always be exact; missing is allowed only explicitly. */
  readonly matchesOrigin: (value: unknown, required?: boolean) => boolean;
  readonly matchesWebSocketUrl: (value: unknown) => boolean;
  readonly matchesRequest: (request: OriginRequest, purpose: OriginRequestPurpose) => boolean;
}

export class ApplicationOriginError extends Error {
  readonly code: string;
  constructor(code = 'application_origin_invalid') {
    super(code); this.name = 'ApplicationOriginError'; this.code = code;
  }
}

/** Configuration normalization is deliberately narrow: one root slash and an
 * explicit default HTTPS port are accepted. Request headers are never normalized.
 * Lowercase ASCII DNS / canonical IP spelling is required; Unicode names must
 * be explicitly supplied in their ASCII form. No DNS resolution is performed. */
export function canonicalPublicOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length < 9 || value.length > 2048 || /[^\x21-\x7e]/.test(value)) throw new ApplicationOriginError();
  let url: URL;
  try { url = new URL(value); } catch { throw new ApplicationOriginError(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ApplicationOriginError();
  const bare = value.endsWith('/') ? value.slice(0, -1) : value;
  // Comparing the literal spelling also rejects empty ?/#, escaped hosts,
  // backslashes, uppercase, dot-segments, shorthand IPs and zero-padded ports.
  if (bare !== url.origin && !(url.port === '' && bare === `https://${url.hostname}:443`)) throw new ApplicationOriginError();
  if (url.port && (!/^[1-9][0-9]{0,4}$/.test(url.port) || Number(url.port) > 65535)) throw new ApplicationOriginError();
  if (!url.hostname.startsWith('[')) {
    if (url.hostname.length > 253 || !url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new ApplicationOriginError();
  }
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') throw new ApplicationOriginError();
  return url.origin;
}

const guardedHeaders = ['host', 'origin', 'sec-fetch-site'] as const;

/** Verify uniqueness and parsed/raw agreement before using Node's header map.
 * Forwarded and X-Forwarded-* deliberately provide no authority here. */
function singleOriginHeaders(request: OriginRequest): boolean {
  if (!request || !request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers) || !Array.isArray(request.rawHeaders) || request.rawHeaders.length % 2 !== 0) return false;
  const seen = new Map<string, string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i], value = request.rawHeaders[i + 1];
    if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value)) return false;
    const key = name.toLowerCase();
    if (!(guardedHeaders as readonly string[]).includes(key)) continue;
    if (seen.has(key)) return false;
    seen.set(key, value);
  }
  if (!seen.has('host')) return false;
  return guardedHeaders.every(key => seen.has(key)
    ? typeof request.headers[key] === 'string' && request.headers[key] === seen.get(key)
    : request.headers[key] === undefined);
}

export function createApplicationOrigin(options: ApplicationOriginOptions): ApplicationOrigin {
  if (!options || typeof options !== 'object' || !Number.isSafeInteger(options.localPort) || options.localPort < 1 || options.localPort > 65535 || typeof options.ownerAuthEnabled !== 'boolean') throw new ApplicationOriginError('application_origin_configuration_invalid');
  const remote = options.publicOrigin !== undefined;
  if (remote && !options.ownerAuthEnabled) throw new ApplicationOriginError('application_origin_owner_auth_required');
  const origin = remote ? canonicalPublicOrigin(options.publicOrigin) : new URL(`http://127.0.0.1:${options.localPort}`).origin;
  const url = new URL(origin);
  const webSocketOrigin = `${remote ? 'wss:' : 'ws:'}//${url.host}`;
  const computerStreamUrl = `${webSocketOrigin}/api/computer/stream`;
  const matchesHost = (value: unknown): boolean => typeof value === 'string' && value === url.host;
  const matchesOrigin = (value: unknown, required = true): boolean => value === undefined ? !required : typeof value === 'string' && value === origin;
  const matchesWebSocketUrl = (value: unknown): boolean => typeof value === 'string' && value === computerStreamUrl;
  const matchesRequest = (request: OriginRequest, purpose: OriginRequestPurpose): boolean => {
    if (!['read', 'mutation', 'websocket'].includes(purpose) || !singleOriginHeaders(request)) return false;
    if (!matchesHost(request.headers.host) || !matchesOrigin(request.headers.origin, purpose !== 'read')) return false;
    const fetchSite = request.headers['sec-fetch-site'];
    return fetchSite === undefined || fetchSite === 'same-origin' || (purpose === 'read' && fetchSite === 'none');
  };
  return Object.freeze({ mode: remote ? 'https-proxy' : 'loopback', origin, host: url.host, webSocketOrigin, computerStreamUrl, ownerAuthRequired: remote, matchesHost, matchesOrigin, matchesWebSocketUrl, matchesRequest });
}
