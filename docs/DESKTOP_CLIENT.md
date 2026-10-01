# Local desktop client

`apps/desktop` opens the existing opendots web UI against a separately running local product server. Its main process adds user-consented microphone requests and explicit artifact saving. It does not start a backend or expose a local executor or renderer filesystem bridge.

## Launch on a supported graphical machine

Start the configured backend with the repository startup workflow first. The default origin is `http://127.0.0.1:3210`. Then, from `apps/desktop`, install the pinned official Electron dependency with `npm ci`, and run `npm start`. To select a different explicit local port: `npm start -- --opendots-origin=http://127.0.0.1:4321`.

For an independently configured authenticated HTTPS deployment, explicitly use
`npm start -- --opendots-origin=https://dots.example` (illustrative only). The
origin must match the backend's `OPENDOTS_PUBLIC_ORIGIN`. This option neither
deploys a proxy nor bypasses a certificate failure. See
[canonical transport](REMOTE_TRANSPORT.md), especially the existing database
origin-binding restriction. No remote deployment was performed here.

Only a package-lock dependency resolution has been performed, without install scripts or an Electron download. These install/start instructions were **not executed here**. No GUI, real microphone, native save dialog, installer, signing or publication has been exercised. Run as a regular desktop user with a supported sandbox and graphics stack; never add `--no-sandbox`. Release acceptance still requires real graphical/platform tests and dependency review.

## Security boundary

- Exact configured numeric-loopback HTTP origin by default, or one explicitly selected canonical HTTPS origin. HTTPS configuration permits one root slash/default port normalization; credentials, paths, queries, fragments, ambiguous hostname spellings and alternate origins are refused. Loopback itself does not authenticate a process: use the separately managed backend's owner authentication. HTTPS native capabilities additionally reject auth-disabled backend responses. The shell never extracts cookies or inserts bearer tokens into URLs, logs or renderer storage.
- Sandbox, context isolation and web security remain on. Node integration, webviews, DevTools and experimental features remain off. There is no preload, IPC, shell or filesystem bridge.
- A dedicated nonpersistent browser session holds cookies and browser draft metadata only for this process. Backend state remains durable; unsent browser-only contents can be lost on exit. Repeated relogins can fill the backend device limit; use its documented authenticated-device revocation/rotation recovery.
- Main navigation is restricted to `/`, `/index.html`, and exact `/login`, with hash routing. Subframe navigation, popups and webviews are denied. Requests remain at the fixed origin; the only WebSocket endpoint is `/api/computer/stream`, using WS for local HTTP and WSS for HTTPS. Mixed schemes and noncanonical stream URL spellings are denied. Same-origin blob audio is permitted.
- Camera, screen capture, device access, notifications and all other permissions stay denied. HTTP authentication challenges and certificate failures never receive overrides. No external opener exists.
- Startup rejects known sandbox, debugging, mixed-content and certificate-exception switches, including single-dash and Windows slash spellings. It also checks Electron's normalized `app.commandLine` before startup and again before session/window creation, including certificate SPKI exceptions that can bypass the usual certificate-error callback. This is a tested launch guard, not evidence from a real Electron/TLS session.
- Closing the client leaves the independent backend and admitted Runtime tasks running.

## Microphone consent and revocation

The page's explicit recording control can request **audio only**. The main process accepts a request only from its exact live, visible, focused, nonminimized main-frame document. `requestingUrl` must match that document, `isMainFrame` must be true, and `mediaTypes` must be exactly `['audio']`. A supplied `securityOrigin` must equal the configured origin (the source's GURL spelling includes a trailing slash); absent optional metadata does not substitute for the required document checks.

A native, parented confirmation dialog defaults to **deny**. It describes recording, the separate page-controlled transmission step, and the close-on-revocation behavior. Each request gets fresh consent; the permission-check handler always denies cached/ambient permission. Only one capability dialog is admitted at a time. Consent expires after 60 seconds. Navigation (including same-document routes), hide/minimize, close, cookie changes, or a replaced frame invalidate pending answers. Native allow, OS permission, and final owner-session identity are each followed by current-document checks; a late answer never grants to a new document/device.

On macOS, after native allow, a `not-determined` OS microphone status may cause `askForMediaAccess('microphone')`. Windows status is checked without trying to change settings. Denied/unknown OS status stays denied. A distributed macOS build requires its own `NSMicrophoneUsageDescription`, packaging/entitlement review and real acceptance; none was provisioned by this task. Linux device availability is still determined by the OS/browser capture request.

Electron permission-handler changes alone do **not** stop an existing MediaStream. Therefore the native menu offers **“撤销麦克风并关闭窗口”**. Hide/minimize, navigation, auth-cookie changes, a 401, confirmed auth mutation, or failed active-session health check also destroy the owning renderer after an audio grant. The shell conservatively retains that grant marker until destruction, because there is no renderer bridge reporting track cessation: this can close the window after recording has already stopped. The consent dialog warns that unsent contents may be lost. The normal page Stop button still stops its bounded push-to-talk tracks; there is no full-duplex/native background recording claim.

An active grant rechecks `/api/auth` through the same Chromium session once per second, with a 5-second request bound. A remote revocation or unreachable backend therefore fails closed after detection; it is **not** instantaneous server-push revocation. Before a logout POST, pending dialogs/downloads are canceled, but the granted renderer is not destroyed until the server response, so teardown does not prevent the logout from reaching the backend. Responses and cookie changes are observed without logging bodies or cookie values. No raw audio is accessed by this main-process controller.

## Explicit artifact save

Only a gesture-initiated download from the exact main frame and same initiating origin can enter the save flow. The URL must match `/api/artifacts/<64 lowercase hex>/content`, without query/fragment or redirects. Other downloads, blobs, uploads, filesystem paths and arbitrary URLs are refused.

The original Electron DownloadItem is synchronously canceled. The controller copies only its validated route and sanitized filename suggestion before Electron invalidates that item; it never reads it again. A parented **native save dialog** selects the destination. Cancel means no subsequent artifact fetch/write. The selection is not sent to the renderer/backend or remembered. Default filenames cannot supply directories, hidden-file prefixes, control/bidirectional characters or reserved device names.

After explicit selection, `session.fetch` uses the existing Chromium session with `credentials: 'include'`, `redirect: 'error'`, and `cache: 'no-store'`. It never reads or builds a Cookie header. Responses must be 200 with product attachment/octet-stream, `nosniff`, `no-store`, a valid Content-Length, and at most **32 MiB** both declared and actually received. Truncation is rejected. Electron documents `Response.url` as unreliable for this API, so routing is enforced by the original exact URL, no redirects, and the session request allowlist, rather than trusting that property.

Owner identity is read before the dialog, after it, and again after receiving the bytes. Navigation, close, hide, logout/cookie change, or the native **“取消正在保存的成果”** action aborts pending work. The whole flow has a 120-second bound. Save dialogs do not have an Electron AbortSignal option: a late native selection after cancellation is ignored, even if the platform dialog remains visible until dismissed. Only one save is pending at a time, preventing dialog floods.

The final local commit is a bounded synchronous exclusive-create write to the absolute path returned by the native dialog. Existing files, final-component symlinks and devices are refused; there is no silent overwrite, directory creation or automatic opening. The user must select a new filename even if the platform presents overwrite confirmation. On POSIX a new file is requested with mode 0600. Downloads are ephemeral in bounded memory before this commit and buffers are cleared afterward; there are no path/body/cookie/error logs. Filesystem failure can leave an incomplete **user-selected new** file; the error tells the user to inspect it, and the app does not delete or open it. Completed saves are not undone by later logout. As with any local save dialog, this assumes the user's destination filesystem is trusted; no claim is made to isolate a same-user malicious filesystem process.

## Verification and remaining acceptance

`node --test test/desktop-client.test.ts test/desktop-capabilities.test.ts` covers real route/schema checks with injected Electron handlers and synthetic responses: camera/subframe/origin rejection, per-request native consent, navigation/hide/close/session/timeout races, OS-prompt late completion, renderer-destruction revocation, exact artifact routes/initiators/gesture, explicit save cancel/late responses, bounded headers/bytes, exclusive write refusal, and logout delivery ordering. Local filesystem tests write only isolated synthetic temporary fixtures.

These tests, syntax checks and TypeScript checks do not prove real Electron window focus behavior, native dialog ownership, OS capture, cookie integration or platform file-chooser behavior. Those remain required on a supported graphical machine. Electron is pinned at `44.5.1`; no dependency installation, device permission acceptance or real user save was performed here.

Source/API references checked for this implementation:
- [Electron session permissions, will-download and session.fetch](https://www.electronjs.org/docs/latest/api/session)
- [MediaAccessPermissionRequest fields](https://www.electronjs.org/docs/latest/api/structures/media-access-permission-request)
- [PermissionRequest document fields](https://www.electronjs.org/docs/latest/api/structures/permission-request)
- [Native dialogs and cancellation support](https://www.electronjs.org/docs/latest/api/dialog)
- [DownloadItem initiator, user gesture and URL chain](https://www.electronjs.org/docs/latest/api/download-item)
- [WebContents navigation and destruction](https://www.electronjs.org/docs/latest/api/web-contents)
- [OS microphone status and macOS usage descriptions](https://www.electronjs.org/docs/latest/api/system-preferences)
- [Normalized Electron command-line checks](https://www.electronjs.org/docs/latest/api/command-line)
- [Electron certificate-error command-line switch](https://www.electronjs.org/docs/latest/api/command-line-switches#--ignore-certificate-errors)
- [Pinned v44.5.1 media details producer](https://github.com/electron/electron/blob/v44.5.1/shell/browser/web_contents_permission_helper.cc#L256-L281)
- [Pinned v44.5.1 requesting frame attribution](https://github.com/electron/electron/blob/v44.5.1/shell/browser/electron_permission_manager.cc#L259-L268)

The existing Morphz application desktop source was inspected for isolation/origin patterns. No Runtime source was edited.
