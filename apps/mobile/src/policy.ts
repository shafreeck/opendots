import { URL } from 'react-native-url-polyfill/js/URL.js';
/** Client-owned URL policy, independent of the server and WebView callbacks.
 * Android does not run onShouldStartLoadWithRequest for the initial source. */
export class MobilePolicyError extends Error {
  readonly code: 'invalid_endpoint' | 'phone_loopback';
  constructor(code: 'invalid_endpoint' | 'phone_loopback' = 'invalid_endpoint') { super(code); this.code = code; }
}
export function validateEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length < 9 || value.length > 2048 || /[^\x21-\x7e]/.test(value)) throw new MobilePolicyError();
  let url: URL; try { url = new URL(value); } catch { throw new MobilePolicyError(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new MobilePolicyError();
  const bare = value.endsWith('/') ? value.slice(0, -1) : value;
  if (bare !== url.origin && !(url.port === '' && bare === `https://${url.hostname}:443`)) throw new MobilePolicyError();
  if (url.port && (!/^[1-9][0-9]{0,4}$/.test(url.port) || Number(url.port) > 65535)) throw new MobilePolicyError();
  const host = url.hostname;
  if (!host.startsWith('[') && (host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) throw new MobilePolicyError();
  if (host === 'localhost' || host.endsWith('.localhost') || /^(?:127|0)\./.test(host) || ['[::]', '[::1]'].includes(host) || host.startsWith('[::ffff:')) throw new MobilePolicyError('phone_loopback');
  return url.origin;
}
const fragments = new Set(['', '#chat', '#tasks', '#files', '#memory', '#computer', '#settings']);
/** Only existing product HTML documents can navigate. Fetch/WS subresources are
 * governed by the trusted BFF's CSP, not this navigation callback. */
export function isProductDocument(origin: string, value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2200 || value.includes('?') || value.endsWith('#') || /[^\x21-\x7e]/.test(value)) return false;
  try {
    if (validateEndpoint(origin) !== origin) return false;
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password && !url.search && url.href === value &&
      (url.pathname === '/' && fragments.has(url.hash) || url.pathname === '/login' && url.hash === '');
  } catch { return false; }
}
export function initialDocument(origin: string): string {
  const canonical = validateEndpoint(origin);
  const initial = `${canonical}/login`;
  if (!isProductDocument(canonical, initial)) throw new MobilePolicyError();
  return initial;
}
/** '*' prevents WebViewShared from calling Linking.openURL before our predicate.
 * It is not a trust allowlist; isProductDocument is the mandatory decision. */
export const WEBVIEW_CALLBACK_WHITELIST: string[] = ['*'];
