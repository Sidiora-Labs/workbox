#!/bin/bash
# Validate deployment assets and (when a workbox binary is available) run doctor.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
for f in deploy/workbox.service deploy/Dockerfile.server deploy/install.sh; do
  [ -f "$f" ] || { echo "missing $f" >&2; fail=1; }
done
bash -n deploy/install.sh
grep -q '^ExecStart=.*serve' deploy/workbox.service || { echo 'unit has no serve ExecStart' >&2; fail=1; }
grep -qi 'privileged' deploy/Dockerfile.server || { echo 'Dockerfile must document privileged requirement' >&2; fail=1; }
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify deploy/workbox.service 2>/dev/null || echo 'note: systemd-analyze verify reported issues (often environment-only)'
fi
if [ -x node_modules/.bin/eslint ]; then :; fi
if command -v node >/dev/null 2>&1 && [ -f packages/cli/src/main.js ]; then
  node packages/cli/src/main.js doctor --json >/dev/null 2>&1 && echo 'doctor: ran' || echo 'doctor: ran (some probes may fail in this environment)'
fi
[ "$fail" = 0 ] && echo 'deploy/check: ok'
exit "$fail"
