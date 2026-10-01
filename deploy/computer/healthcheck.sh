#!/bin/bash
set -euo pipefail
xdpyinfo >/dev/null 2>&1
for port in 5901 5902 3210 3211; do
  (exec 3<>"/dev/tcp/127.0.0.1/$port")
done
node --input-type=module -e 'const r = await fetch("http://127.0.0.1:3210/", {signal: AbortSignal.timeout(2000)}); if (!r.ok) process.exit(1);'
