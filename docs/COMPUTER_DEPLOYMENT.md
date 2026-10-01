# Computer deployment blueprint

## Status and exact scope

These are authored deployment files, **not a deployed or runtime-verified desktop**. The supplied Compose recipe starts one local single-user app and one graphical desktop inside one container. It supplies real VNC transport to the existing gateway; it does not implement an AI computer executor. Return to AI remains disabled until a trusted same-display observation and remote-input settlement adapter is implemented. Unit-tested epoch arbitration is not proof of end-to-end desktop safety.

Docker, Docker Compose, Chromium, Xvfb, and x11vnc were not available for container/GUI validation in the authoring environment. Performed checks: Bash syntax, YAML parsing and key safety assertions, seccomp JSON parsing. Image build, package resolution, sandbox startup, remote desktop rendering, clipboard rejection, takeover/reconnection and frame latency remain untested. Do not advertise this as production-ready.

## Topology

- Host HTTP listener: `127.0.0.1:3210` only, Docker maps it to container port 3211.
- In-container TCP relay: port 3211 forwards unchanged HTTP/WebSocket bytes to `127.0.0.1:3210`, where the app already listens. Original Host/Origin stay compatible with its loopback-only checks.
- App serves pinned npm noVNC assets and its authenticated one-use WebSocket ticket bridge. A separate websockify server is unnecessary.
- Preview VNC: `127.0.0.1:5901`, x11vnc with `-viewonly -nosel -safer -nocmds`.
- Human-control VNC: `127.0.0.1:5902`, same display, clipboard also disabled.
- Both listeners attach to Xvfb `:99` using a temporary Xauthority cookie; X11 TCP is disabled.
- Openbox manages the headed Chromium window. No CDP port is started. Chromium uses a persistent dedicated profile and runs as UID 1000, with sandbox enabled.

No VNC/CDP/X11 port is published; no Docker socket or host filesystem is mounted. The single container intentionally puts desktop and app in one network namespace to satisfy the gateway's loopback endpoint restriction. **Do not join untrusted containers or arbitrary shell executors to this namespace.** The internal relay is not a public-service security boundary; do not attach other services to its Compose network.

This is one trusted user's workspace, not multi-tenant isolation. Processes sharing its UID/network/display can bypass the gateway. Do not expose arbitrary agent shell execution here. Do not run the Morphz executor in this container. In particular, unrestricted Runtime shell with network access or read-outside-workspace can reach VNC/Xauthority/profile data and defeats lease fencing. A future Runtime integration must isolate executable tools from this namespace, deny unrestricted network and outside-workspace reads, and expose only narrowly scoped, lease-checked computer actions. Endpoint privacy alone does not fix an unrestricted executor.

## Run only after reviewing host support

From the repository root, on a Linux Docker host with Compose v2:

```sh
docker compose -f deploy/computer/compose.yaml config
docker compose -f deploy/computer/compose.yaml build
docker compose -f deploy/computer/compose.yaml up
```

Then open `http://127.0.0.1:3210`. Keep this exact local port: the app deliberately rejects unexpected Host/Origin values. On a remote VPS use an authenticated SSH tunnel from your own computer:

```sh
ssh -N -L 127.0.0.1:3210:127.0.0.1:3210 user@your-vps
```

The browser URL remains `http://127.0.0.1:3210`. Do not open firewall ports for the app, VNC or debugger. This recipe is **not** an Internet-facing reverse-proxy deployment. Public deployment needs an explicitly designed login/access-control layer and reviewed Host/Origin policy changes; simply forwarding public requests or rewriting Origin is not sufficient. Local machine users with loopback access are inside the trust boundary.

This recipe does not install or launch Morphz and deliberately does not provide fake answers. The app will show Runtime configuration required until a separate, secure Runtime integration is supplied. Its Runtime URL adapter accepts loopback origins; the host's `127.0.0.1` is NOT this container's `127.0.0.1`. Do not solve this by exposing Runtime publicly, joining an unrestricted executor to this namespace, or putting operator credentials in the image. A reviewed narrowly scoped internal bridge is additional work. Remote Runtime connectivity and same-session AI execution are not completed by this Compose file.

## Chromium sandbox: fail closed

The official Node/Debian base runs packages installed from Debian's signed repositories. The final container and browser run as non-root, drop capabilities, enable no-new-privileges, and use the vendored Playwright seccomp profile that permits user namespace creation. There is no `--no-sandbox`, privileged container, host IPC, or unconfined seccomp fallback.

Startup checks unprivileged user namespace creation with `unshare --user --map-root-user true`. This is a prerequisite, not full proof of Chromium sandbox operation. Host kernel, AppArmor/SELinux or managed VPS restrictions may still prevent Chromium starting. If so, the container exits. Review host-specific security policy and explicitly authorize any change; do not automatically relax host policy or disable browser sandbox. Verify `chrome://sandbox` manually during deployment acceptance.

The vendored seccomp profile changes allowed system calls and is security-sensitive. Review it for the actual host architecture and kernel before running. It is pinned to an upstream release, not represented as the latest Docker policy. No host security settings were changed while authoring these files.

## Lifecycle and state

- `product-state`: SQLite application/control state, separate from browser data.
- `browser-profile`: dedicated Chromium user-data directory, persistent cookies and login sessions. File locking prevents two instances opening it simultaneously.
- `downloads`: user's browser downloads; treat files as untrusted.
- `/tmp`, user cache and desktop config: ephemeral tmpfs. Xauthority cookie and desktop session are recreated.
- Root filesystem: read-only. UID 1000 must own the named volumes. New named volumes copy their ownership from image directories; pre-existing/bind volumes need operator-managed ownership.

Profiles contain credentials/session material. Restrict host access and backups, encrypt sensitive storage, and do not include profile contents, screenshots or raw keystrokes in routine logs. No secrets are checked into this recipe. Browser downloads default to `$HOME/Downloads`; verify that setting in acceptance.

A required process exiting tears down the entire container rather than quietly replacing the desktop behind a valid lease. Automatic restart is disabled. Stop/restart discards in-memory desktop state and must require explicit new connection/takeover; do not imply that persisted SQLite restores the old visual session. Chromium may restore some prior tabs, which is not identical to a live session. `docker compose down` preserves volumes; `down -v` destroys profile/download/product data and must be a deliberate user-approved action.

## Control and acceptance gates

The gateway issues one-use tickets, checks same-origin/loopback requests and human epoch immediately before each socket write, and revokes human sockets on pause/transfer. Preview read-only behavior is enforced by the separate VNC server, not the noVNC toggle. `-nosel` disables clipboard exchange; `-safer` disables x11vnc remote configuration so a client cannot turn view-only off through that channel. No file-transfer option is enabled.

A socket write completing only means bytes were handed to the transport. It does **not** prove that X11 or Chromium processed input, nor undo a form submission already dispatched. That is why AI return remains disabled until trusted settlement and fresh observation exist. Every future AI CDP/keyboard/mouse action must go through the same arbiter. Merely opening CDP and attaching a model is insufficient.

Before marking GUI support validated, test:

1. Image builds, non-root UID, sandbox enabled, expected listeners only; no host VNC/CDP access.
2. Live preview shows the same actual Chromium window; submit raw key/pointer/clipboard messages on preview and verify no desktop mutation.
3. Explicit human takeover, lease renewal, duplicate/stale requests, expired ticket replay, cross-origin attempts, and socket revocation.
4. Disconnect during human control pauses; reconnect preserves authoritative state without silent AI execution.
5. Frame freshness and coordinate mapping at zoom/resize; IME, modifiers, mouse release on interrupted drag.
6. Browser/process failure, container restart, persistent profile isolation, volume locking, and SQLite recovery.
7. Only when implemented: gate AI actions, drain/cancel queued commands, settle remote input, capture fresh same-desktop observation after the fence, and resume from it.

Measure input-to-visible latency p50/p95, frame age, CPU/RAM, bandwidth, and reconnect time. A starting single-user estimate is 2–4 vCPU and 4–8 GB RAM, not a benchmark or capacity guarantee; this Compose uses 2 CPU/4 GB as an initial bound. LLM inference via API is separate. GPU is optional for basic desktop tasks. For more fluid motion/audio, evaluate a video/WebRTC transport later, including signalling, ICE/TURN, codec support and relay cost.

## Sources, pins and license inventory

- [Official Node image](https://github.com/nodejs/docker-node): explicit `node:24.21.0-bookworm-slim` version tag. Tags remain mutable; resolve and review a digest before a release. No image digest is invented here.
- npm dependencies are installed with the repository lockfile, including noVNC 1.7.0.
- Debian package versions intentionally follow signed Bookworm repositories so security updates are not frozen. Every build records exact installed versions at `/usr/local/share/opendots-os-packages.txt`. This is **not** a bit-reproducible image until a reviewed base digest and repository snapshot/package lock are recorded. Do not freeze vulnerable browser packages for reproducibility.
- `deploy/computer/seccomp.json` is unmodified from [Playwright v1.56.1](https://github.com/microsoft/playwright/blob/v1.56.1/utils/docker/seccomp_profile.json); SHA-256 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`. Its Apache-2.0 license is included as `LICENSE.playwright`.
- [Playwright container sandbox guidance](https://playwright.dev/docs/docker)
- [x11vnc option manual](https://manpages.debian.org/bookworm/x11vnc/x11vnc.1.en.html)
- [Xvfb](https://xorg.freedesktop.org/archive/X11R7.0/doc/html/Xvfb.1.html)
- [noVNC API](https://novnc.com/noVNC/docs/API.html)
- [Docker daemon attack surface](https://docs.docker.com/engine/security/)

System package license/copyright notices remain in `/usr/share/doc/*/copyright` in the image. Before redistributing images, review Chromium's bundled notices and applicable source-offer obligations for components such as x11vnc/Openbox, plus the repository's existing third-party notices. The recipe does not replace a distribution-license/SBOM review.

## Current opt-in Edge/driver wiring

The earlier blueprint's “AI return missing” limitation has been replaced by code,
not by a live deployment claim. `OPENDOTS_COMPUTER_CONFIG` selects the explicit
existing-node configuration documented in COMPUTER_CONFIG.md. The image builds the
native X11 helper; startup keeps preview independent and lets Node own the human
control VNC lifecycle. Each action needs exact local approval; no generic shell,
CDP, filesystem or automatic effect authorization is exposed by the narrow worker.

The supplied compose file still does not invent a Runtime endpoint, operator
credential, Edge pairing or public origin. An operator must supply the reviewed
private connectivity and config/credential mounts. Preserve namespace separation:
Runtime must not be able to reach raw VNC/X sockets or forge requests to the local
BFF relay. A shared Docker network alone does not prove this isolation. Do not
publish the current local single-owner BFF or reuse it as a multiuser gateway.
Docker build, live screen/input, and deployed isolation remain unverified here.
