#!/bin/bash
set -Eeuo pipefail
umask 077
if [[ "$(id -u)" == 0 ]]; then echo 'Refusing root desktop/browser execution' >&2; exit 1; fi
# Fail closed: no fallback to --no-sandbox, privileged, or unconfined seccomp.
if ! unshare --user --map-root-user true; then
  echo 'Unprivileged user namespaces unavailable: Chromium sandbox preflight failed. Review host policy; do not disable browser sandbox.' >&2
  exit 1
fi
export DISPLAY=:99 XAUTHORITY=/tmp/opendots.Xauthority XDG_RUNTIME_DIR=/tmp/opendots-runtime
export PORT=3210 OPENDOTS_COMPUTER_ENABLED=1 OPENDOTS_VNC_PREVIEW_READ_ONLY=1
export OPENDOTS_VNC_PREVIEW_PORT=5901 OPENDOTS_VNC_CONTROL_PORT=5902
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/browser" "$HOME/Downloads"
chmod 700 "$XDG_RUNTIME_DIR"
for path in /state "$HOME/browser" "$HOME/Downloads"; do
  [[ -w "$path" ]] || { echo "Required volume not writable: $path" >&2; exit 1; }
done
# One owner per persistent profile, never remove another live browser's lock.
exec 9>"$HOME/browser/.opendots-owner.lock"
flock -n 9 || { echo 'Browser profile already owned by another session' >&2; exit 1; }
touch "$XAUTHORITY"
xauth -f "$XAUTHORITY" add "$DISPLAY" . "$(mcookie)"
pids=()
cleanup() {
  trap - EXIT TERM INT
  if ((${#pids[@]})); then
    kill -TERM "${pids[@]}" 2>/dev/null || true
    for ((i=0; i<50; i++)); do
      alive=0
      for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
      ((alive)) || break
      sleep .1
    done
    kill -KILL "${pids[@]}" 2>/dev/null || true
    wait || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp -auth "$XAUTHORITY" & pids+=("$!")
ready=0
for ((i=0; i<100; i++)); do
  if xdpyinfo >/dev/null 2>&1; then ready=1; break; fi
  sleep .1
done
((ready)) || { echo 'Virtual display failed to start' >&2; exit 1; }
openbox --sm-disable & pids+=("$!")
# Each listener exports the SAME authenticated X display. Preview is enforced
# by its server, independently of frontend viewOnly. Clipboard off in both.
vnc=(-norc -display "$DISPLAY" -auth "$XAUTHORITY" -listen 127.0.0.1 -no6 -forever -shared -nopw -nosel -nosetprimary -nosetclipboard -noadd_keysyms -safer -nocmds)
x11vnc "${vnc[@]}" -rfbport 5901 -viewonly & pids+=("$!")
if [[ -z "${OPENDOTS_COMPUTER_CONFIG:-}" ]]; then
  x11vnc "${vnc[@]}" -rfbport 5902 & pids+=("$!")
fi
# No remote-debugging port is opened. The opt-in Edge worker uses only the
# bounded X11 helper and owns a separate human input server lifecycle.
dbus-run-session -- chromium --user-data-dir="$HOME/browser" --no-first-run \
  --no-default-browser-check --disable-session-crashed-bubble \
  --window-size=1440,900 about:blank & browser_pid="$!"; pids+=("$browser_pid")
cd /opt/opendots
if [[ -n "${OPENDOTS_COMPUTER_CONFIG:-}" ]]; then
  export OPENDOTS_SUPERVISED_BROWSER_PID="$browser_pid"
  OPENDOTS_COMPUTER_CONFIG="$(node scripts/prepare-container-computer-config.mjs "$OPENDOTS_COMPUTER_CONFIG")"
  export OPENDOTS_COMPUTER_CONFIG
fi
node src/server.ts & pids+=("$!")
# Only this relay listens on container interfaces; compose publishes it on HOST
# LOOPBACK only. Raw VNC remains inaccessible through the published port.
socat TCP4-LISTEN:3211,bind=0.0.0.0,reuseaddr,fork TCP4:127.0.0.1:3210 & pids+=("$!")
# Do not silently restart a display/browser behind an existing control lease.
set +e
wait -n "${pids[@]}"
status=$?
set -e
echo "A required desktop/app process stopped (status $status); shutting down session" >&2
exit 1
