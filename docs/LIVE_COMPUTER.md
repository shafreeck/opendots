# Headed computer and shared control

The product must expose a live, headed browser/desktop. A headless-only automation endpoint is insufficient. Human preview, takeover and return to AI must keep the SAME browser profile, tabs and live session.

## Target topology

One isolated non-root Linux graphical session per user: Xvfb + a small window manager + headed Chromium + x11vnc + websockify + embedded noVNC. A graphical framebuffer needs no physical display or GPU. Keep Chromium's sandbox enabled. AI uses that same browser via a private adapter; arbitrary direct CDP access is forbidden outside the arbiter.

VNC/CDP listen only on the private session network/loopback. A TLS gateway authorizes each user/session for both HTTP and WebSocket. Never publish 5900/6080/9222 or mount a host Docker socket in the app/browser. Provisioning is a separate limited control plane. No cloud machine has been provisioned by this work.

## Ownership contract implemented

`src/computer-control.ts` is a persistent single-process control arbiter:
- Initial/reopened sessions pause and revoke old epochs
- Every physical action validates actor + epoch + lease immediately before dispatch
- Takeover revokes queued AI authority before waiting for the currently dispatched action to settle
- Control is granted only after in-flight work drains; external effects cannot be undone
- Disconnect pauses rather than automatically resuming AI
- Return to AI requires a fresh trusted screenshot/DOM observation of the same session
- Failed physical actions expose uncertainty and leave an audit trail

This primitive does NOT by itself enforce VNC or CDP access. It must be the exclusive gate for all input. Multi-process distributed arbitration and process ownership locking are not implemented; run one arbiter per session until that gate is completed.

## Required input enforcement

A noVNC `viewOnly` toggle is only UI behavior. An authenticated raw WebSocket to websockify still permits input. Production must use a server-side RFB-aware input gate, or independently enforced view-only/control credentials and revocable connections. Key/pointer/clipboard mutations require current human authority. AI CDP and OS input must pass through the same arbiter; possession of a direct CDP socket would bypass it.

Read-only preview remains available during AI ownership; takeover is not acknowledged as complete until old in-flight input settles. If a form submission's result is unknown, show uncertainty instead of announcing it was undone. Control return cannot revive a stale queued click plan.

## Actual acceptance required

Use a real headed session: open a tab, type text as AI, take over while another AI action is pending, verify pending input is rejected, edit as human, return with a fresh observation, continue in the same tab. Test reconnect, expired lease, process restart, clipboard permissions, cross-user session routing and WebSocket authorization. Record input-to-visible latency and frame age; no performance numbers are claimed before measurement.

Sources: [Xvfb](https://xorg.freedesktop.org/archive/X11R7.0/doc/html/Xvfb.1.html), [noVNC](https://novnc.com/noVNC/), [noVNC API](https://novnc.com/noVNC/docs/API.html), [websockify](https://github.com/novnc/websockify), [Playwright CDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp), [Chromium sandbox](https://playwright.dev/docs/docker), [Chrome debugging profile isolation](https://developer.chrome.com/blog/remote-debugging-port?hl=en), [Docker daemon security](https://docs.docker.com/engine/security/).
