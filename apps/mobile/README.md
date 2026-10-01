# OpenDots mobile client

A native React Native/Expo client for an existing, independently configured
OpenDots HTTPS server. It contains a native connection, offline/retry and local
disconnect screen, then loads the actual owner login and product interface.
Chat, background tasks, approvals, calendar proposals and other visible data
come from that server. There is no sample conversation, bundled mock backend,
automatic account setup or privileged JavaScript message bridge.

The server must already have a reachable canonical HTTPS `publicOrigin`, valid
trusted TLS certificate and owner authentication. A phone's `localhost` is the
phone. This client neither publishes the BFF nor reaches a desktop's loopback
Runtime automatically. See [the backend transport contract](../../docs/REMOTE_TRANSPORT.md).

## Local verification and dependency pins

The lockfile pins the official Expo SDK 57 compatibility set:

- Expo 57.0.26, React Native 0.86.3, React 19.2.3
- react-native-webview 13.16.1, react-native-safe-area-context 5.7.0
- react-native-url-polyfill 4.0.0, imported explicitly by the URL policy
- TypeScript 5.9.2 and exact React/Node development types

`node_modules/expo/bundledNativeModules.json` from the installed official package
is the compatibility reference, rather than an unpinned latest template. The
root product package and dependencies remain separate.

```sh
cd apps/mobile
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
npm run export
```

The export command sets `EXPO_OFFLINE=1` and `EXPO_NO_TELEMETRY=1`, uses one Metro
worker and creates production Android/iOS JavaScript/Hermes bytecode assets.
It does **not** compile, sign or produce an APK/IPA. Generated `dist`, `.expo`,
`node_modules`, Android and iOS generated projects are ignored by Git.

Own-build Android/iOS packaging and device acceptance are still required. Android
SDK/build tools and Xcode are not installed by this task. No EAS/account login,
SDK licence acceptance, signing identity, provisioning profile, store listing or
release deployment is created. The configured bundle/package identifier is a
local source value, not proof that any app-store identity is registered.

Expo Go and web execution are refused before the client mounts: Expo Go uses
its own OS permissions and would invalidate this app's manifest assumptions.
The optional `start` command only starts an offline local Metro development
server for a separately prepared own native client; it does not build that
client or expose the product backend. Do not use Expo Go as capability evidence.

## Connection and lifecycle contract

The user explicitly enters one canonical HTTPS origin. Independent initial URL
validation rejects credentials, paths, queries, fragments, Unicode or rewritten
host spellings, invalid ports and phone-local/unspecified/mapped-loopback
addresses. A root slash and default port 443 normalize to one origin. A LAN IP
with a valid trusted HTTPS certificate may be used; it is not automatically
reachable or trusted just because it parses.

The client performs one public `GET /api/auth`, using the explicitly imported
`expo/fetch`, `credentials: omit`, `redirect: error`, an eight-second deadline
and a 16-KiB response limit. It sends only an Accept header, never a Cookie or
Authorization header. It checks the final exact URL, status, JSON type and the
current public API flags: enabled true, authenticated false, session null, and a
recognized credentialKind. It keeps none of the returned authentication data.
Errors use fixed messages; input/response exception details are not logged by the
app. Failed or auth-disabled preflight never mounts a WebView.

The initial document is the separately validated origin plus `/login`. Owner
login stays within the existing HTTPS page; the client neither reads nor copies
its password, connection token, cookie or CSRF token. The BFF's owner sessions,
Origin/CSRF checks, expiry and device revocation remain authoritative. API/XHR
errors stay with the page; only main-document failures close the native view.

All delayed preflight, page-load and native disconnect-dialog decisions carry a
connection generation. Disconnect, a newer connection, backgrounding or disposal
invalidates it. Late callbacks cannot reopen a disconnected page or close a newer
connection. Background/inactive state unmounts the page; resuming requires an
explicit new connection check. No pending mutation is automatically replayed.
This JS lifecycle behavior is not a guarantee about OS task-switcher screenshots.

The origin is only held in app memory. Disconnect closes the local page, not the
server session or native background jobs. Use the product's own logout/device
revocation for server-side logout. Incognito is requested with cache/form saving
and cookie sharing disabled. iOS uses WK nonPersistentDataStore. Android's pinned
implementation clears old cookies on creation but flushes the platform cookie
store after page completion: **memory-only cookie storage or secure erasure on
unmount is not proven**. The app has no app-managed credential/token storage;
platform cookie and storage lifecycle needs device acceptance testing.

## Navigation and unsupported native capabilities

Only the exact trusted origin's `/`, `/login`, and six known root SPA hashes can
navigate. API/artifact routes, queries, external origins, custom schemes, file,
data, blob and popup targets are rejected by the application callback. Initial
source validation is mandatory because Android does not invoke that callback
for its first `loadUrl`.

`originWhitelist=['*']` is deliberate: WebView's whitelist rejection otherwise
calls `Linking.openURL` before the application's callback. Every scheme instead
reaches the strict application predicate. There is no app `Linking.openURL`,
external browser helper, deep-link scheme or `onMessage` handler. Explicit
`onOpenWindow` consumes the normal popup path. Unexpected late navigation is
stopped and the view unmounted. Certificate errors are not bypassed.

This is a **trusted-BFF wrapper**, not a hostile-page browser sandbox. Android's
native callback waits only 250 ms and allows navigation on timeout/interruption;
it also does not intercept every POST/app-initiated navigation. An unexpected
request may begin before the late containment callback. The allowlist cannot
be represented as a universal native network boundary. The owner must point
this client only at their known OpenDots BFF with its existing CSP and document
routes. Arbitrary sites, altered BFF pages or attacker-controlled content are
not a supported browsing mode.

Microphone, file upload and download controls are disabled by a fixed script
with capture listeners and a MutationObserver so SPA rerenders stay disabled.
The script is an advisory compatibility layer, never a native security boundary.
It does not fetch, send messages or expose native operations. Android before-load
injection is not guaranteed; the normal end-of-document script is also supplied.
No existing `public/*` product file is changed.

The own Android manifest removes audio, camera, location and storage/media
permissions. iOS explicitly denies media capture; its file-download handler does
nothing. Both platforms disable geolocation, file URL access, mixed content,
automatic JS windows, third-party/shared cookies and link previews where the
pinned API supports those settings.

Android still has a native file chooser (including possible external camera
intents), and Android 10+ DownloadManager can save a response without storage
permission. Hiding controls/removing storage permission is **not** a global
chooser/download prohibition. The supported existing BFF has no automatic
picker/capture behavior, and its download/API document paths are rejected; these
trusted-document assumptions are part of this bounded client. Strict universal
native blocking would require a separately implemented/tested native WebView
layer. That larger layer is not claimed here.

## Source references

The installed package/lockfile is the exact evidence; these upstream references
explain the inspected behavior:

- [Expo SDK 57 compatibility](https://github.com/expo/expo/blob/sdk-57/packages/expo/bundledNativeModules.json)
- [Expo fetch JavaScript](https://github.com/expo/expo/blob/sdk-57/packages/expo/src/winter/fetch/fetch.ts), [Android request](https://github.com/expo/expo/blob/sdk-57/packages/expo/android/src/main/java/expo/modules/fetch/NativeRequest.kt), [iOS task](https://github.com/expo/expo/blob/sdk-57/packages/expo/ios/Fetch/ExpoURLSessionTask.swift): explicit error redirects and cookie omission. Omission does not sanitize an explicitly supplied auth header; the client supplies none
- [WebView 13.16.1 shared navigation](https://github.com/react-native-webview/react-native-webview/blob/v13.16.1/src/WebViewShared.tsx): automatic Linking fallback on whitelist miss
- [Android navigation/error/cookies](https://github.com/react-native-webview/react-native-webview/blob/v13.16.1/android/src/main/java/com/reactnativecommunity/webview/RNCWebViewClient.java): timeout fallback, main-frame error behavior and cookie flush
- [Android popup/permissions/picker](https://github.com/react-native-webview/react-native-webview/blob/v13.16.1/android/src/main/java/com/reactnativecommunity/webview/RNCWebChromeClient.java), [downloads/incognito](https://github.com/react-native-webview/react-native-webview/blob/v13.16.1/android/src/main/java/com/reactnativecommunity/webview/RNCWebViewManagerImpl.kt), [native chooser](https://github.com/react-native-webview/react-native-webview/blob/v13.16.1/android/src/main/java/com/reactnativecommunity/webview/RNCWebViewModuleImpl.java)
- [iOS native WebView](https://github.com/react-native-webview/react-native-webview/blob/v13.16.1/apple/RNCWebViewImpl.m): popup cancellation, media denial, download callbacks and nonpersistent store
- [Maintained URL parser](https://github.com/charpeni/react-native-url-polyfill): the installed 4.0.0 implementation supplies every getter used by the policy. Tests execute that actual parser, replacing only its unused native Blob hook; they do not substitute Node URL for policy parsing

## Validation record

Tests cover URL parser/getters and hostile inputs, initial source, redirect/auth
rejection, response size, unread/stalled body cancellation, delayed callbacks,
newer connections, native-dialog decisions, background/disconnect, timeouts and
rerendered unsupported controls. These are executable policy/state/script tests,
not an emulator, phone, TLS-proxy or native-permission test.

An initial default-worker Metro export was killed with exit 137. A one-worker
offline production export succeeded for iOS (601 modules) and Android (599
modules), each producing an approximately 1.5-MB Hermes bytecode bundle. No APK
or IPA was built. A final clean-lockfile install/export result follows below.

Final 2026-09-30 verification: a clean `npm ci --offline --ignore-scripts
--no-audit --no-fund` succeeded from the exact lockfile; `npm ls --depth=0`
reported no extraneous packages. All 17 mobile tests and strict TypeScript
passed. A subsequent one-worker offline export succeeded for both platforms,
with approximately 1.5-MB `.hbc` files identified by `dist/metadata.json`.
Android SDK manager, adb and xcodebuild were unavailable. No native package,
emulator/device, live HTTPS server, cookie persistence or OS-permission flow
was tested. The generated export is a local verification artifact, not a release.

A separate read-only lockfile audit reported 19 moderate affected package nodes
tracing to [GHSA-w5hq-g745-h8pq](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq).
The resolved dependency is uuid 7.0.3 through xcode 3.0.1 in Expo's config/build
tooling. The inspected `xcode/lib/pbxProject.js` call uses `uuid.v4()` without a
caller buffer; this app does not import uuid. The advisory concerns v3/v5/v6
caller-buffer bounds, so that inspected call is not the described vulnerable
path. This limited exposure inspection does not remove the advisory or establish
release clearance. The supported Expo dependency set remains pinned; no blind
major override or `npm audit fix` was applied. See the repository's dependency
inventory/audit notes for the full recorded package graph.
