# Single-owner authentication and device sessions

This is an optional product-layer authentication foundation for one personal
account with multiple revocable browser/device sessions. It does not create a
Runtime identity, a multi-tenant gateway, a signup service, an OAuth account, TLS,
or a public listener. Normal unconfigured development remains trusted loopback.
After authentication has been enabled for a database, removing its configuration
must fail closed, including after a restart.

## Source reuse and additions

The unchanged Morphz source at commit
`7e8f7d81f8b00fd45544d94d5b9a321214633df1` provides these application contracts:

- `application/packages/application/src/identity.ts`: operator-supplied identity
  mappings, SHA-256 hashes of random 32-byte login tokens, random session tokens
  hashed at rest, per-session CSRF, credential-change revocation, duplicate-cookie
  rejection, and a durable requirement to keep authentication enabled
- `identity-config.ts`: explicit private operator configuration, descriptor
  permission checks and generic failures without dumping the file
- `application/apps/service/src/http.ts`: strict same-origin login, Strict and
  HttpOnly cookies, current identity checks around actions and active streams
- `application/docs/14-local-center-and-identity.md`: a native random login token
  is not a human password; identity configuration is outside Agent-readable data

`auth-config.ts` and `auth-sessions.ts` adapt those patterns to OpenDots' existing
single-owner product store. They do not import Morphz's WorkspaceStore, Actant or
project authorization graph. Native token hashes can be reused when an operator
has explicitly chosen a single-owner application credential. There is no search
for a native `members.json`, automatic user mapping, or credential import.

Human passwords need a password KDF rather than the native random-token hash.
The optional verifier uses Node's asynchronous scrypt with fixed
`N=131072, r=8, p=1`, a 32-byte salt and a 64-byte output. It permits one verification
in flight per host, with no queue, and caps the configured memory budget at
192 MiB. This follows the [OWASP scrypt profile](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
The implementation uses the [Node crypto scrypt API](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)
and constant-time comparison of equal-length derived bytes. Password bytes are
not trimmed, case-folded, Unicode-normalized, persisted, or logged.

## Explicit operator configuration

`readOwnerAuthConfig(absolutePath)` reads only that selected file. It never scans
HOME, environment variables, conventional filenames or user directories. Imports
have no side effects. The file must be a private ordinary single-link file, owned
by the effective service UID, with mode `0400` or `0600`, at most 16384 bytes.
Symlinks and untrusted writable parent paths are rejected. Actual descriptor
ownership/mode/type is checked before bytes are read. It neither changes file
permissions nor creates a password, key, token, account or configuration file.

The strict configuration has exactly these fields:

```json
{
  "version": 1,
  "credential": {
    "kind": "scrypt",
    "saltHex": "<32-byte salt, 64 lowercase hexadecimal characters>",
    "hashHex": "<64-byte scrypt result, 128 lowercase hexadecimal characters>",
    "N": 131072,
    "r": 8,
    "p": 1
  },
  "sessionTtlSeconds": 86400,
  "idleTtlSeconds": 3600,
  "maximumDevices": 16
}
```

The alternative existing native application credential shape is:

```json
{
  "kind": "morphz_login_token_sha256",
  "hashHex": "<SHA-256 of the original 64-character lowercase random token>"
}
```

That second mode accepts only the native random-token format. Do not configure it
with the SHA-256 of a human password. The module contains no hash-generation or
credential-provisioning endpoint. Example placeholders are intentionally invalid.
Actual setup/provisioning must be performed separately through an authorized
secure operator workflow; never put a real credential in chat, Git, an Agent
workspace, a URL, diagnostics, or a request-body log.

Configuration bounds are 300 seconds–30 days absolute lifetime, 60 seconds–1 day
idle lifetime no greater than absolute lifetime, and 1–32 active devices. Changes
to the credential or any of these security settings invalidate all sessions.

## Host integration API

Only trusted server code uses this API. No browser request supplies `ownerId`,
database, configuration path, Runtime identity, or canonical origin.

```ts
const config = readOwnerAuthConfig(explicitAuthConfigPath);
assertAuthenticationMode(productDatabase, Boolean(config));
const auth = new OwnerAuth({
  db: productDatabase,
  ownerId: savedBinding.userId,
  origin: canonicalBffOrigin,
  config,
});
```

When no configuration path was explicitly selected, call
`assertAuthenticationMode(productDatabase, false)` **before serving any product
data**. Do not catch its failure and enable the old unauthenticated mode.
Use the same guard in every launcher, including demo/CLI entrypoints that open an
existing database. An authenticated database is pinned to its product owner and
exact canonical BFF origin; neither can silently change.

- `login({credential, deviceLabel}, {origin, remoteAddress, signal?})` returns
  `{setCookie, session}` after verification and durable insertion. The origin is
  the exact request Origin header, and the address comes from the socket, never
  `X-Forwarded-For` or request JSON. The optional signal discards a login if the
  request disconnects. Labels are user-entered plain text of 1–80 characters;
  render with textContent. Do not invent a verified hardware identity from a label
- `authenticate(cookieHeader)` synchronously returns a safe session projection or
  `null`; it never authenticates a device ID on its own
- `requireMutation(cookieHeader, csrfHeader, originHeader)` rechecks the live
  session and its CSRF token and returns that projection, or fails
- `listDevices(cookieHeader)` returns `{devices}` with opaque IDs, label,
  creation/last-active/expiry timestamps and a `current` marker
- `revokeDevice(cookie, csrf, origin, id)` returns
  `{revoked, current, setCookie?}`. Only revoking the current device clears its
  cookie. Revoking a missing ID is an honest `revoked:false`
- `logout(cookie, csrf, origin)` revokes the current session
- `revokeAll(cookie, csrf, origin)` revokes all sessions, including the caller,
  increments the auth generation and returns `{revoked, setCookie}`
- `replaceConfiguration(validatedConfig)` is operator-only; changed configuration
  revokes all sessions and increments the auth generation
- `onInvalidate(listener)` returns an unsubscribe function. The listener receives
  an opaque session ID, or `null` for all sessions. Explicit revoke, logout,
  revoke-all, config change and service close signal immediately; no token is sent
- `isCurrentSession(id)` is a bounded synchronous check for a connection that was
  already authenticated. It does not grant access from a browser-supplied ID
- `clearCookie()` formats a same-policy expiry cookie; `close()` closes the
  authentication service, signals its connections and waits for an active
  verification to settle. It does not close the caller-owned database

The safe session projection is:

```text
id, ownerId, deviceLabel, createdAt, lastSeenAt,
expiresAt, absoluteExpiresAt, csrfToken
```

`setCookie` is sensitive and belongs only in a response header. Do not include it
in JSON, logs, command receipts, audit records or frontend storage. Cookie headers
and login bodies need redaction throughout the host/proxy stack. The safe
projection's CSRF token belongs in memory, not persistent browser storage.

### Implemented HTTP integration

`server.ts` mounts these routes while preserving its Host/Origin/Fetch-Metadata/CSP
checks. Enable the existing private configuration explicitly with
`OPENDOTS_AUTH_CONFIG=/absolute/operator/path/auth.json`, or supply
`createApplication({authConfigPath, ...})`. There is no automatic path fallback.
No credentials are provisioned by that option.

- `GET /api/auth`: minimal configured/authenticated status and current safe session
- `POST /api/auth/login`: bounded JSON `{credential, deviceLabel}`, exact Origin
- `GET /api/auth/devices`: authenticated device metadata only
- `POST /api/auth/logout`: current authenticated cookie + CSRF
- `POST /api/auth/devices/:id/revoke`: same protections, opaque device ID
- `POST /api/auth/revoke-all`: same protections, explicit user all-device action

Do not auto-run any logout, revoke-all, rotation or setup action. The BFF gates
**all** private GET/binary/download/stream/WebSocket paths, not only writes.
Login is exempt from the session CSRF requirement but requires exact same-origin
JSON and the usual host/fetch-site checks to prevent login CSRF. Limit the full
request body before parsing; the verifier itself caps credential bytes at 1024.
The host returns generic `AuthError.code/status`, never native error details.

The only unauthenticated static assets are `/login`, `/login.js` and `/styles.css`.
Unauthenticated `/` redirects to `/login`; private APIs and application scripts
return 401. `GET /api/auth` returns only
`{enabled, authenticated, credentialKind, session}` where an unauthenticated
session is null and the credential kind is `password`, `connection_token`, or
null. The login response contains `{authenticated:true,session}` and puts the
bearer exclusively in Set-Cookie. Credential bodies are bounded to 4096 bytes,
not logged/persisted, and the minimal login page clears the input immediately
upon submission and on page exit. It uses the existing product stylesheet.

The auth-enabled `/api/state` keeps `csrfToken` in its existing field but derives
it from the authenticated device. It additionally exposes
`authentication:{enabled,session}`. Device list returns `{devices}`; revoke/logout
responses exclude the internal `setCookie` field, placing cookie changes only in
the response header. Every mutation requires this device's CSRF plus exact Origin.
Main-client navigation and device-management UI are separate callers of these
implemented endpoints; a revoked client must clear sensitive live state and
return to `/login` on 401.

Startup constructs Runtime with background start deferred. The private config,
durable authentication-mode guard and saved `binding.userId` are checked before
starting any Runtime refresh or computer worker. A configured `MORPHZ_URL` creates
the fixed product binding even if Runtime is temporarily offline. Authentication
does not create an ad-hoc owner for an unconfigured backend or a demo database.
After the numeric-loopback listener binds, authentication pins the actual
`http://127.0.0.1:PORT` origin by default. Explicit `OPENDOTS_PUBLIC_ORIGIN`, or
`createApplication({publicOrigin, ...})`, instead selects a canonical HTTPS
browser origin behind a separately configured TLS proxy and requires owner
authentication. The same origin policy gates HTTP and computer WebSockets.
The selected origin is validated against the persisted binding before workers
start. Startup failure closes the listener and inert resources. Existing bound
databases cannot be silently moved to HTTPS or another origin; see
[remote transport](REMOTE_TRANSPORT.md) for first-binding versus migration limits.
`app.ready` resolves at this host-configuration boundary, not at Runtime/model
readiness. Callers should await it. Changing the port of an authenticated database
is an origin change in default HTTP loopback mode and fails closed; keep its
configured PORT when restarting. In HTTPS mode, the public origin is the binding
and the separately configured internal loopback port is not part of that origin.

Computer tickets are internally bound to the authenticated session that created
them. The same cookie session and exact Origin are required at WebSocket upgrade;
another valid device cannot redeem the ticket. Revocation removes unused tickets
and closes matching active sockets. Session validity is rechecked before every
new upstream input write, before desktop output, and by the existing 250 ms
expiry timer. An old device's closure retains the existing epoch protections and
cannot revoke a newer human takeover. Preview/control isolation and physical
input-fence semantics are unchanged.

Request authentication is rechecked after a mutation body arrives and before
responding with private async JSON or binary bytes. Return-to-AI also rechecks
the requesting session **inside the synchronous final granting transaction**,
after the trusted capture. A check in the capture callback alone would leave a
microtask gap. Computer action decisions likewise recheck after asynchronous
Runtime revalidation and immediately before issuing an approval permit.

Non-durable native mutations run inside a per-request AsyncLocalStorage guard.
The guard is isolated from concurrent devices and runs before every native fetch,
after its response, and before local admissions that follow asynchronous checks.
Revocation during model/account catalogue reads therefore blocks the subsequent
native write rather than merely hiding its response. Fixed Runtime bootstrap,
background refresh and already persisted durable command dispatch deliberately
leave that browser guard: accepted background jobs remain the same owner's work,
and logging out does not silently cancel or replay them. Connector/native host
callbacks must keep their own service and job authority, rather than impersonate
a browser session or add a generic exemption to the main listener.

## Revocation, persistence and recovery

Each successful login receives a fresh 256-bit random bearer and opaque device ID.
Only its SHA-256 hash is stored. A domain-separated HMAC of the bearer and device
identity gives a stable per-session CSRF value without storing its plaintext.
Restart retains valid devices, absolute expiry and idle expiry. Activity touches
last-seen at most every 30 seconds and never extends the absolute lifetime.

Connect `onInvalidate` to authenticated SSE and computer WebSocket closure.
Bind short-lived computer tickets to the originating auth session and check
`isCurrentSession` on every control packet and a bounded timer. Expiry does not
spontaneously call the explicit-revocation listener, so a cookie-only handshake
is insufficient. Recheck authentication after long awaits and immediately before
new consequential actions. These checks are in addition to computer lease epochs,
one-time action approval and native Runtime authority. Revocation cannot undo an
already accepted command or a physical/network effect already in flight.

Pending login verification records the authentication generation. Revoke-all or
credential/config change during the await prevents that old login from issuing a
new session. Cancellation and shutdown also refuse issuance. Native scrypt work
cannot be forcibly cancelled; the single-verification slot remains occupied until
it settles, avoiding an unbounded cancelled-work queue.

The durable attempt guard permits at most 5 attempts per socket address and 20
globally in a five-minute fixed window, including failed and successful attempts.
Counters survive restart. Addresses are stored only as hashes; at most 256 remote
buckets are retained. Unknown addresses share one bucket, and no proxy forwarding
header is trusted. Fixed windows and a global single-owner limit can temporarily
block the legitimate owner under abuse; this is bounded throttling, not a complete
Internet-facing anti-abuse system. No public network is enabled here.

At device capacity the service refuses to create another device. It never evicts
an active session silently. An ephemeral-cookie client such as a process-local
Electron browser can accumulate devices across restarts. Supported recovery is:

1. Use an already authenticated device to revoke stale devices or revoke all, or
2. Perform an explicitly authorized operator credential/configuration rotation,
   which revokes all sessions, or wait for idle/absolute expiry

There is no unauthenticated device-management or password-recovery bypass.
Signing out all devices does not delete conversations, change the saved user, or
create a new native Session.

## Boundary and test evidence

Cookie policy is `HttpOnly; SameSite=Strict; Path=/`, without Domain. Already
configured canonical HTTPS adds `Secure` and uses a `__Host-` name; HTTP loopback
uses an origin-derived ordinary name because Secure is not portable over HTTP.
This file does not configure HTTPS, a proxy, DNS, firewall rules, or a listener.
HTTP loopback cookies are not a transport-security claim. A future explicitly
approved remote deployment needs its own reviewed TLS/proxy/auth boundary.

One BFF owns the product/auth database. Private directory/database/WAL permissions,
backups and crash dumps remain operator responsibilities. The configuration
fingerprint and session hashes do not replace OS access control. JavaScript and
native memory cannot guarantee forensic erasure, despite clearing temporary
password buffers where possible. No secret values are logged by these modules.

`node --test test/auth-*.test.ts` uses only isolated SQLite fixtures, temporary
private files, synthetic random-token-shaped values and one synthetic scrypt
password. It exercises verification, generic rejection, cookies/CSRF, session
restart/expiry, current/other/all-device revocation, invalidation hooks, pending
login races, persistent throttling, capacity and strict file/config checks. It
does not create a real account, read a real credential, send a real password, or
change network/TLS configuration. `test/auth-http.test.ts` additionally runs real
loopback HTTP and WebSocket servers with synthetic TCP display endpoints. It
verifies private-route and binary gating, cookie/CSRF isolation, ticket binding,
immediate revocation, device expiry, revocation during async downloads/request
bodies, same-origin restart/no-downgrade, shutdown during real Node scrypt, a
blocked native account write after logout, and a blocked action approval after
asynchronous revalidation. A deterministic synthetic microtask test checks the
final AI-grant transaction, separately from the HTTP/socket fixtures.
These tests prove the authentication transport boundaries under those fixtures;
they do not constitute live browser, real-desktop or Internet-deployment acceptance.
