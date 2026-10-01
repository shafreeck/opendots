# Canonical application origin transport

## Current status

The canonical-origin policy is integrated into the HTTP server, owner sessions,
computer ticket/upgrade transport and Electron origin handling. It is an
**opt-in source implementation**, not a deployed remote service. Without explicit
configuration, the product keeps its local mode. No public listener, TLS proxy,
certificate, DNS record, firewall change, credential, mobile binary or deployment
was created.

`OPENDOTS_PUBLIC_ORIGIN=https://dots.example` (illustrative only), or the
`publicOrigin` option to `createApplication`, chooses one canonical HTTPS browser
origin. It requires an explicitly configured, validated owner-auth file and a
saved Runtime owner binding. Invalid origins or missing authentication fail
before product storage/workers start. The BFF still binds to `127.0.0.1`; setting
the option creates no route from a phone and performs no TLS setup.

A phone's `127.0.0.1` addresses the phone. Packaging the current web UI in a native
WebView cannot make the backend reachable from a phone. HTTPS transport and real
device validation remain separate work. Pure policy and local HTTP/WS fixtures
below prove neither TLS/proxy deployment nor phone connectivity.

## Frozen helper contract

```ts
const policy = createApplicationOrigin({
  localPort: actualBoundLoopbackPort,
  ownerAuthEnabled: true,
  publicOrigin: 'https://dots.example', // optional; illustrative, not deployed
});
```

`localPort` is the existing listener's actual port, in `1..65535`, not an
ephemeral bind request of `0`. `ownerAuthEnabled` must be a boolean based on
successfully validated owner configuration, never a browser-supplied claim.
`publicOrigin` must come from explicit operator configuration. The helper does
not read environment variables or discover configuration.

The returned object is frozen and exposes:

- `mode`: `loopback` or `https-proxy`
- `origin`: the one canonical browser origin
- `host`: its exact authority for HTTP Host matching
- `webSocketOrigin`: the matching `ws:` or `wss:` origin
- `computerStreamUrl`: that origin plus exactly `/api/computer/stream`
- `ownerAuthRequired`: true in HTTPS proxy mode
- `matchesHost(value)`: exact scalar Host check
- `matchesOrigin(value, required = true)`: exact scalar Origin check; missing
  Origin is allowed only when the caller deliberately passes false
- `matchesWebSocketUrl(value)`: exact complete computer-stream URL check
- `matchesRequest(request, purpose)`: validates parsed and raw headers; purpose
  must explicitly be `read`, `mutation` or `websocket`. There is no default;
  omitted or unknown purposes return false even for untyped JavaScript callers

`canonicalPublicOrigin(value)` separately validates and normalizes HTTPS
configuration, allowing preflight before a listener exists. It does not establish
authentication. `createApplicationOrigin` additionally refuses HTTPS proxy mode
without owner authentication. `ApplicationOriginError` carries a fixed generic
`code`; errors do not echo potentially credential-bearing input.

### Configuration normalization versus request matching

Without `publicOrigin`, the origin is numeric-loopback HTTP for `localPort`:
`http://127.0.0.1:3210`, for example. Port 80 is represented canonically as
`http://127.0.0.1`. The policy itself has **no localhost or IPv6 alias**.
Authenticated loopback and HTTPS requests use that strict policy. A separate
unauthenticated development-only branch preserves the historical local Host
aliases (`127.0.0.1:PORT` and `localhost:PORT`) and CSRF-protected POSTs without an
Origin header. Local alias WebSocket requests still require their exact Origin.
Neither authenticated mode can enter this compatibility branch; it is not a
fallback when HTTPS, login or CSRF validation fails.

HTTPS configuration accepts a bare lowercase ASCII origin, optionally with one
root slash. Explicit default `:443` is removed. For example, all of these become
`https://dots.example`:

```text
https://dots.example
https://dots.example/
https://dots.example:443
https://dots.example:443/
```

Nondefault ports remain significant. Canonical IPv4 and IPv6 literals and ASCII
internationalized domain names are accepted; DNS resolution is not performed.
Unspecified addresses `0.0.0.0` and `[::]` are refused. Input must already use
canonical lowercase hostname/IP spelling. The helper rejects credentials,
non-HTTPS schemes, paths, empty or nonempty queries/fragments, whitespace/control
characters, Unicode hosts, escaped hosts, backslashes, dot-segment rewrites,
wildcards, trailing DNS dots, invalid DNS labels, shorthand/octal/hexadecimal IPs,
empty/zero/out-of-range/zero-padded ports and other URL-parser rewrites.

Request headers are **not normalized**. A policy configured with
`https://dots.example:443/` requires Host `dots.example` and Origin
`https://dots.example`. Request values with `:443`, a trailing slash, uppercase,
commas, whitespace, arrays or additional origins are rejected. The proxy must
send the browser's canonical Host and Origin without rewriting them.

`matchesRequest` requires both `headers` and the original Node `rawHeaders`.
Exactly one raw Host is required. Duplicate Host, Origin or Sec-Fetch-Site fields
are rejected even when Node discarded a duplicate in its parsed map; parsed/raw
disagreements also fail. Do not reconstruct raw headers from the parsed map.
Malformed raw header pairs, names or CR/LF/NUL values fail closed.

For `read`, a missing Origin is permitted; a present Origin must match exactly.
For `mutation` and `websocket`, Origin is mandatory and exact. Sec-Fetch-Site may
be absent or `same-origin`; `none` is additionally permitted for reads. Neither
`same-site` nor `cross-site` is accepted. A missing fetch-metadata header is not
an authentication grant.

Forwarded and X-Forwarded-* have no authority. They are ignored, not used to
repair a rejected Host/Origin or to infer HTTPS. An attacker supplying a matching
X-Forwarded-Host with a wrong real Host still fails. This helper has no CORS
allowlist and adds no Access-Control-Allow-Origin headers.

## Integrated boundary and required deployment work

The intended topology is a separately managed TLS reverse proxy in front of the
loopback BFF. The BFF and unchanged Morphz Runtime remain on their explicitly
configured numeric-loopback endpoints. The public origin describes only the
product-facing browser entry point. It must never replace `MORPHZ_URL`, an
operator endpoint, an executor endpoint, a VNC endpoint or a BYOK provider URL.
There is no direct phone-to-Runtime path and no movement of server-side model or
operator credentials to the phone.

Implemented behavior:

- `server.ts` validates explicit HTTPS/auth configuration before opening product
  storage, then verifies the actual bound address is `127.0.0.1` before starting
  workers. It constructs the policy with the actual listener port. The helper
  itself remains pure and opens no socket.
- Authenticated HTTP uses explicit read versus mutation policy purposes; login
  and every state-changing route require exact Origin. Wrong Host, duplicate raw
  headers and absolute/foreign request targets fail before route execution.
- `OwnerAuth` binds to the canonical browser origin. HTTPS emits Secure,
  HttpOnly, SameSite=Strict, host-only `__Host-` cookies. CSRF remains tied to the
  current device session; expiry, current-session checks and revocation remain
  authoritative. A matching Host never authenticates a user.
- The computer gateway mints only the configured WS/WSS endpoint, validates
  original upgrade Host/Origin and raw duplicates, and keeps one-use protocol
  tickets, auth-session matching, expiry/revocation fences, preview isolation and
  control epochs. The request target must still be `/api/computer/stream`.
  Authenticated gateways have no localhost alias. Raw VNC connections remain
  fixed numeric loopback.
- HTTPS CSP adds the one configured WSS origin to `connect-src`, because some
  browser engines do not map `self` to WebSocket schemes. There is no wildcard
  network allowance or CORS bypass.
- Electron accepts an explicitly selected canonical HTTPS origin using
  `--opendots-origin=https://dots.example`. Its dependency-free CJS parser mirrors
  the backend normalization policy, with parity fixtures. HTTPS uses matching
  WSS only; mixed content, external navigation, certificate overrides and native
  capabilities against an auth-disabled HTTPS backend remain rejected. The
  default numeric-loopback HTTP launch remains unchanged.

Deployment still requires independent review of reverse-proxy Host preservation,
TLS trust, upgrade forwarding, request limits, log redaction and network exposure.
Never rewrite browser Origin to localhost, ignore certificate errors, trust
arbitrary forwarding headers or expose native Runtime/VNC listeners to make a
test pass. A desktop and phone sharing one authenticated BFF use the same
canonical product origin. Login rate limits continue to use the actual socket
address, so devices behind one proxy share its per-address bucket; no
X-Forwarded-For interpretation or Internet anti-abuse claim is introduced.

The helper does not attest TLS: traffic between an external TLS terminator and
the loopback BFF is a separately configured trust boundary. A matching Host
header alone is not proof of TLS or proxy identity. Authentication remains
mandatory in HTTPS mode, and the proxy's actual deployment must be verified.

## Existing database origin binding

`OwnerAuth` stores a single exact origin with its saved owner. Reopening an
authenticated database under a different origin currently fails with
`authentication_owner_binding_mismatch`. Changing from loopback HTTP to a new
HTTPS product origin is therefore **not an environment-variable-only upgrade**.

This integration deliberately does not modify, delete or rebind that state.
An eventual migration needs an explicit operator-reviewed procedure, rollback
planning, invalidation of previous device sessions/tickets, correct cookie
transition and tests for startup failure and rollback. Never silently rewrite
the stored origin, drop authentication tables, expose old sessions at a new
origin or use a second BFF that races the same local store. Until that work is
approved and implemented, an existing authenticated database must retain its
current binding.

A new explicitly selected deployment database with a configured loopback
Runtime binding, or an existing saved owner database that has **never enabled
owner authentication**, can establish its first auth-origin binding as HTTPS.
The original saved owner/Runtime identity is retained. This code never selects a
replacement database to bypass a mismatch. An already authenticated HTTP or
different-HTTPS database fails closed. Restarting at the same canonical HTTPS
origin preserves its sessions even if the internal loopback port changes;
changing a port that is part of an HTTP loopback browser origin remains an
origin change.

## Verification and mobile gates

`node --test test/application-origin.test.ts` exercises numeric loopback defaults,
configuration-only default-port/root-slash normalization, strict request values,
hostile URL forms, required HTTPS owner authentication, missing/foreign/duplicate
headers, forwarding-header non-authority and exact WS/WSS mapping. These are pure
fixtures; no TLS server, proxy or public endpoint is contacted.

`test/remote-transport.test.ts` uses actual local HTTP/WS sockets and synthetic
credentials/display endpoints. Tests send the explicit canonical Host/Origin
headers directly to the loopback BFF, simulating only an independently trusted
proxy's internal hop. They verify Secure cookie attributes, device CSRF,
canonical WSS ticket URLs, duplicate/foreign/missing-header rejection, active
stream logout/revoke-all/expiry, no-auth startup failure, original Runtime
binding, fatal auth-origin mismatch and unauthenticated local compatibility.
They do not negotiate TLS or prove that a real browser accepts/stores a cookie.

The focused checks include:

```text
node --test test/application-origin.test.ts test/remote-transport.test.ts test/auth-http.test.ts test/auth-sessions.test.ts test/computer-gateway.test.ts test/desktop-client.test.ts test/desktop-capabilities.test.ts test/server.test.ts
npm run typecheck
npm run check
```

Passing these checks does not validate a native mobile package, a real Electron
window, OS microphone/file permissions or real device connectivity.

Native scaffolding should eventually contain a working connection/login flow,
clear failures and the existing authenticated UI, not a hardcoded phone-local
URL. A native WebView remains subject to OS-specific navigation, permission and
download behavior. Actual Android/iOS compilation, signing, installation,
trusted HTTPS login, session revocation and same-session desktop preview/takeover
must be tested before calling a mobile release usable.

Primary references consulted for mobile delivery:

- [Expo local native builds and export distinction](https://docs.expo.dev/more/expo-cli/)
- [Expo SDK and native toolchain compatibility](https://docs.expo.dev/versions/latest/)
- [React Native WebView navigation, permissions and downloads](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md)
- [Android WebView native bridge safety](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)
- [Android command-line builds](https://developer.android.com/build/building-cmdline)
- [Apple device testing and distribution membership](https://developer.apple.com/support/compare-memberships/)
- [Browser CSP WebSocket source behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src)
