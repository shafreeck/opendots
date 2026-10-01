# Linux same-display driver and human-control lifecycle

Status (2026-09-30): implemented and fixture-tested; native helper compiles and links with strict warnings. **No X display, Chromium, x11vnc, or desktop input was started for this work. Actual screenshot/input/handoff validation remains separate.** Importing these modules performs no process launch or input.

## Files and interfaces

- `src/linux-desktop.ts`: `LinuxDesktopDriver` implements `ComputerEdgeDriver`; `SpawnDesktopExecutor` owns the fixed native helper transport
- `src/linux-desktop-vnc.ts`: `HumanVncLifecycle` owns only the dedicated human-input x11vnc child
- `native/linux-desktop/desktop.c`: small product-owned Xlib/XTest/XInput2/libpng helper
- `test/linux-desktop*.test.ts`: injected display, process, and protocol fixtures; no actual desktop claims

Initialize the driver with `await LinuxDesktopDriver.connect(options)`. Operator configuration fixes the local `DISPLAY`, X authority file, a browser-instance identity, and a supervisor callback that rejects a dead/replaced browser. The same display must be used by the separate read-only preview. Neither module starts, replaces, or terminates Xvfb, Chromium, or that preview.

`display()` returns stable `{id, width, height}`. `capture({signal, assertCurrent})` returns `{id, width, height, png, capturedAt, displayGeneration, observationId, inputUncertain}`. The stable `id` is a native X-server generation plus the browser-instance identity; `observationId` identifies a fresh capture. The generation is a random root-window property that survives helper reconnections. Existing malformed properties are rejected rather than replaced. Geometry/generation changes require reinitialization under revoked control. The supervisor must revoke ownership when the browser dies and supply a new browser identity on replacement; the X property alone does not detect browser restarts. Initialization is read-only: reopening onto held input remains observable for human repair but marks AI physical input uncertain.

`act(operation, {signal, assertCurrent})` accepts only the Computer Edge union:

- Pointer move and left/middle/right click, within the observed display dimensions
- Scroll direction and 1–1000 requested pixels, translated to bounded discrete X11 wheel detents; this is **not pixel-exact scrolling**
- Explicit navigation/edit keys, plus exactly `Ctrl+L` and `Ctrl+A`; no general chord expression
- Printable text up to 4096 JS characters and 16 KiB UTF-8; no control characters or unpaired surrogates

Text is preflighted against the current X keyboard map before any character is emitted. Unsupported glyphs, alternate keyboard groups, or locked/latched modifiers fail closed. The helper does not rewrite the keyboard map, use clipboard paste, silently transliterate, or claim arbitrary Unicode/IME support. Whole text is never buffered as a series of already-authorized gestures. Text travels through the helper's private stdin pipe rather than OS command-line arguments.

No action accepts a shell command, executable path, URL, file destination, CDP method, arbitrary keycode, environment override, or extra field. The helper executable is fixed at `/usr/local/libexec/opendots-linux-desktop`; the human server is fixed at `/usr/bin/x11vnc`. Both launch with argument arrays and `shell:false`, under a minimal explicit environment.

## Bounded gestures and revocation

The helper preplans only allowlisted physical events and requests a separate `emit` permit for each bounded gesture: one pointer move, complete click, key tap, character (including its required Shift pair), or wheel detent. Each gesture contains at most four XTest events and no sleeps. The TypeScript executor checks the current control epoch immediately before granting it. It does not queue later permits.

If control is revoked after an admitted key/button press, **that gesture finishes only its own matching release/restoration**, then the next gesture is rejected. Killing an otherwise healthy helper between its owned press and release would risk stuck keys or autorepeat. Ordinary abort therefore waits for that tiny gesture's acknowledgement and sends `stop` at the next boundary. The helper returns a held-free cancelled receipt. The driver reports `desktop_action_cancelled_settled`; this is a cancelled partial action, not success or an invitation to replay it.

A process crash, protocol failure, or hard deadline is different: partial physical state is uncertain. The driver remains faulted and rejects additional AI input and ordinary AI-transfer observations; read-only human repair capture remains available. The action deadline is 10 seconds, capture deadline 5 seconds, native hard alarm 12 seconds, PNG bound 16 MiB, and frame bound 4096×2160. These limits are not evidence that a crashed gesture completed. The arbiter/gateway must keep AI control paused and never replay an uncertain action automatically.

Preexisting held input is never released as a recovery trick. The helper checks core keyboard state and XInput2 button state, including buttons beyond the core five. It requires exactly one master pointer and keyboard; unsupported/multi-seat state is refused. Normal capture can show a display with held inputs; `inspectAndCaptureUnheld()` refuses it. An explicit operator/human recovery is needed if a failed handoff leaves held input; an automatic release could complete an external click and is deliberately absent.

## Owned human x11vnc lifecycle

`await lifecycle.start({repair?})` returns a frozen `{id}` handle for that specific child. Concurrent starts/stops are refused. Every asynchronous startup step rechecks its instance/state, so closing a pending startup prevents a late process launch. `stopAndFence(handle, {acknowledgeUncertainty?}, context?)` rejects a stale handle without signaling a newer child. Gateway code must retain the exact handle and recheck its control epoch before minting a human ticket; stale startup cleanup must use that handle, never “stop the latest server.”

An explicit user takeover may call `start({repair:true})` when the lifecycle is paused. This is allowed only if any previous owned child's closure is confirmed and the configured port is unused. Human startup uses a **read-only capture**, so existing held keys/buttons or an uncertain AI action do not lock the user out of repair. The uncertainty flag is retained; neither takeover nor server start synthesizes releases. An unconfirmed previous process remains a blocker even for repair.

An uncertain return requires the user's `acknowledgeUncertainty:true`; without it, the human server stays running and AI handback is refused. After that explicit acknowledgement and a clean owned-child stop, the lifecycle calls `driver.acknowledgeRepair(true, context)`. That method requires a verified held-free same-display capture before clearing only the driver's physical-input latch. It does not clear the lifecycle's historical uncertainty flag, prior effects, the control arbiter's audit, or execution receipts. A failed/held capture preserves the latch. This method is a trusted handback hook, not a model/browser API for clearing uncertainty.

Startup requires a reviewed build declaration `{version: '0.9.16', sha256}`. The implementation verifies the installed executable's bytes and version before starting it. The hash must be supplied by the reviewed deployment build; this module does not guess a default or regard a version string alone as proof of shutdown behavior. A loopback port already in use is rejected. Readiness requires both the owned child's `PORT=` announcement and an RFB banner at the configured loopback port.

Fixed arguments include local-only IPv4 listening, no IPv6, no rcfile, no command hooks, and both clipboard-selection sending and receiving disabled. No `-clear_keys`, `-clear_mods`, or `-clear_all` recovery option is enabled. The separate preview must enforce view-only server-side and disable clipboard input; a frontend view-only flag is insufficient. Raw VNC/X11 endpoints must remain inaccessible to untrusted clients. These components assume the isolated product's single-user display; they are not a security boundary against another trusted OS user or arbitrary same-display X client.

For transfer back to AI:

1. Gateway revokes human tickets and closes/discards its RFB transport queues
2. Lifecycle sends **SIGINT** to its exact owned human child
3. It requires a requested clean process close with **exit code 0 and no terminating signal**; an arbitrary exit, even code 0 outside this stop, is not a fence
4. Only afterward does the helper perform an X round trip, inspect held keys/buttons, and capture the same display under a short X server grab
5. The lifecycle returns `{capture, inputFence:'settled', externalEffects:'unknown'}` only if identity is unchanged and no input remains held

Any held state, changed display, unexpected exit, failed observation, timeout, forced kill, or stale transfer leaves the lifecycle paused. A timeout may terminate its owned child for cleanup, but that forced termination can never become a successful handoff. Preview, browser, and X server continue independently.

This is an **input-dispatch fence**, not a guarantee that a website or network operation is finished. A click already delivered may have submitted a purchase, sent a message, or started a request whose consequences continue after the fence. The returned `externalEffects:'unknown'` is intentional. A screenshot or X round trip cannot settle those external effects or undo them.

## Source-verified shutdown contract

For x11vnc 0.9.16, [cleanup.c](https://github.com/LibVNC/x11vnc/blob/0.9.16/src/cleanup.c#L532-L535) handles SIGINT by asking the normal loop to shut down; other termination paths differ. [Normal cleanup](https://github.com/LibVNC/x11vnc/blob/0.9.16/src/cleanup.c#L140-L249) closes the X connection. [options.c](https://github.com/LibVNC/x11vnc/blob/0.9.16/src/options.c#L191) leaves key-clearing disabled by default. [screen.c](https://github.com/LibVNC/x11vnc/blob/0.9.16/src/screen.c#L3766-L3782) emits the owned startup port announcement. Deployment patches must be reviewed against these behaviors before supplying the executable hash; a future version or modified build is not automatically equivalent.

## Build and verification evidence

2026-09-30 verification performed:

- 21 injected driver/lifecycle tests passed, covering limits, privacy-safe errors, held input, display replacement, mid-gesture epoch/abort revocation, same-display configuration, clean versus bad exits, timeout/forced exit, startup revocation, stale process handles, late observation revocation, explicit human repair, blocked unacknowledged return, and held-input recovery after reopening
- Native Node syntax checks passed for both TypeScript modules
- Repository strict TypeScript check passed after concurrent integration changes
- Native C compilation **and linking** passed with `-O2 -std=c11 -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2` and linker RELRO/NOW flags
- The compiled helper rejected missing arguments and remote/malformed DISPLAY values with a bounded fixed error before opening any X display

Compilation used official Debian trixie development packages downloaded from `deb.debian.org`, verified against their SHA-256 entries in the official HTTPS package index, and extracted into a private `/tmp` sysroot with `dpkg-deb --extract`. No package was installed and no package-maintainer script ran. Existing system runtime libraries were used for linking. Relevant header versions were libX11 1.8.12, libXtst 1.2.5, libXi 1.8.2, libpng 1.6.48, and x11proto 2024.1. The build artifact stayed under `/tmp`, not the installed helper path. This compilation is not validation of the final deployment image or a live X session.

For a reviewed deployment build, install the required development headers in its build stage, run `make -C native/linux-desktop`, and copy only the executable to the fixed helper path with non-user-writable permissions. The Makefile itself installs nothing. Runtime libraries are X11, Xtst, Xi, and libpng. The later product-host integration wires the helper build and owned-control mode into the provided Dockerfile/startup scripts. That image has not been built/run here, the helper has not been installed on a live display, and production Computer Edge access has not been enabled.

Still required before claiming graphical acceptance: build the actual deployment image; validate PNG pixels against its preview; observe real pointer/key/text and allowed chord behavior; test a live human takeover/return while typing, clicking and reconnecting; verify real x11vnc SIGINT exit behavior for the exact deployed digest; confirm held-input/failed-process cases stay paused; confirm browser/display replacement revokes the old identity. These are product desktop checks, not upstream Morphz sandbox tests.

## Privacy and authority

Screenshots and typed text are sensitive. The driver neither logs nor persists either; native stderr, command details, and OS errors are not relayed. Public failures use fixed error codes. Screenshot persistence/retention and hashed action journals belong to the Computer Edge layer. Operator Xauthority configuration never comes from model arguments, and ambient environment secrets are not inherited. The driver supplies physical mechanics only: human confirmation, tool authorization, one-use observations, native execution receipts, and control leases remain the caller's responsibility.
