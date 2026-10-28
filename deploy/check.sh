#!/bin/bash
# Validate the deployment assets and this host, one line per check; exit 1 when any check fails.
# install.sh runs only against a private temp root, temp copies of /etc/subuid and /etc/subgid
# and a test cgroup parent that is removed on exit; the real /etc files are never written.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fails=0
ok() { echo "ok    $*"; }
bad() {
  echo "FAIL  $*"
  fails=$((fails + 1))
}
skip() { echo "skip  $*"; }
judge() {
  local name="$1"
  shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/workbox-deploy-check.XXXXXX")"
cgroot=/sys/fs/cgroup
parent="workbox-deploy-check-$$"
cleanup() {
  if [ -d "$cgroot/$parent" ]; then rmdir "$cgroot/$parent" || echo "warn  could not remove $cgroot/$parent"; fi
  rm -rf "$tmp"
}
trap cleanup EXIT

unit=deploy/workbox.service
dockerfile=deploy/Dockerfile.server
for f in "$unit" "$dockerfile" "$dockerfile.dockerignore" deploy/install.sh deploy/check.sh; do
  judge "present $f" test -f "$f"
done
judge "install.sh parses (sh -n)" sh -n deploy/install.sh
judge "check.sh parses (bash -n)" bash -n deploy/check.sh
if command -v shellcheck >/dev/null 2>&1; then
  judge "shellcheck install.sh check.sh" shellcheck deploy/install.sh deploy/check.sh
else
  skip "shellcheck not installed"
fi

# --- systemd unit -------------------------------------------------------------------------------
judge "unit ExecStart runs workbox serve" grep -Eq '^ExecStart=.* serve( |$)' "$unit"
for d in ProtectSystem=full PrivateTmp=yes NoNewPrivileges=yes; do
  judge "unit hardening $d" grep -qx "$d" "$unit"
done
breaking="PrivateUsers RestrictNamespaces CapabilityBoundingSet AmbientCapabilities ProtectControlGroups
ProtectKernelTunables PrivateNetwork IPAddressDeny RestrictAddressFamilies PrivateDevices DevicePolicy
DeviceAllow ProtectClock ProtectProc ProcSubset RestrictSUIDSGID ProtectHome ReadWritePaths
MemoryDenyWriteExecute"
found=""
for d in $breaking; do
  if grep -Eq "^$d=" "$unit"; then found="$found $d"; fi
done
if [ -z "$found" ]; then ok "unit sets no directive that breaks the launch chain"; else bad "unit sets$found, which break the launch chain"; fi
if command -v systemd-analyze >/dev/null 2>&1; then
  mkdir -p "$tmp/unit"
  cp "$unit" "$tmp/unit/workbox.service"
  if systemd-analyze verify --man=no --recursive-errors=no "$tmp/unit/workbox.service" >"$tmp/verify.log" 2>&1 &&
    ! grep -q 'workbox.service' "$tmp/verify.log"; then
    ok "systemd-analyze verify (temp copy, not installed)"
  else
    bad "systemd-analyze verify: $(head -c 300 "$tmp/verify.log" | tr '\n' ' ')"
  fi
else
  skip "systemd-analyze not installed"
fi

# --- server Dockerfile --------------------------------------------------------------------------
judge "Dockerfile documents privileged mode" grep -q 'PRIVILEGED MODE REQUIRED' "$dockerfile"
judge "Dockerfile shows the --privileged --cgroupns=host run line" grep -q -- 'docker run --privileged --cgroupns=host' "$dockerfile"
echo "note  the server container must run with --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw"
if command -v docker >/dev/null 2>&1; then
  if docker build --check -f "$dockerfile" . >"$tmp/docker-check.log" 2>&1; then
    ok "docker build --check $dockerfile (lint only, nothing built or pushed)"
  else
    bad "docker build --check: $(grep -Ei 'error|warn' "$tmp/docker-check.log" | head -3 | tr '\n' ' ')"
  fi
else
  skip "docker not installed: Dockerfile syntax not checked"
fi

# --- install.sh against a private prefix --------------------------------------------------------
real_ids() { sha256sum /etc/subuid /etc/subgid 2>/dev/null; }
snapshot() {
  find "$tmp/root" "$tmp/etc" -printf '%p %m %u %g %s\n' | sort
  sha256sum "$tmp"/subuid* "$tmp"/subgid*
  cat "$cgroot/$parent/cgroup.subtree_control"
}
install_run() {
  sh deploy/install.sh --root "$tmp/root" --etc "$tmp/etc" --cgroup-root "$cgroot" \
    --cgroup-parent "$parent" --subuid "$1" --subgid "$2" >"$3" 2>&1
}
real_before="$(real_ids)"
for f in subuid subgid; do
  if [ -f "/etc/$f" ]; then cp "/etc/$f" "$tmp/$f"; else : >"$tmp/$f"; fi
  grep -Ev '^(root|0):' "$tmp/$f" >"$tmp/$f.bare" || true
done
judge "install.sh first run (root, etc, subid copies, cgroup $parent)" install_run "$tmp/subuid" "$tmp/subgid" "$tmp/install1.log"
judge "install.sh root and etc are mode 700" test "$(stat -c %a "$tmp/root")$(stat -c %a "$tmp/etc")" = 700700
judge "install.sh cgroup parent delegates cpu memory pids" grep -qE 'cpu.*memory.*pids' "$cgroot/$parent/cgroup.subtree_control"
copies_unchanged() { cmp -s "$tmp/subuid" /etc/subuid && cmp -s "$tmp/subgid" /etc/subgid; }
rerun_quiet() { ! grep -Eq 'created|appended' "$tmp/install3.log" "$tmp/install4.log"; }
dry_run_clean() {
  sh deploy/install.sh --dry-run --root "$tmp/dry/root" --etc "$tmp/dry/etc" --cgroup-root "$cgroot" \
    --cgroup-parent "$parent-dry" --subuid "$tmp/subuid.dry" --subgid "$tmp/subgid.dry" >"$tmp/dry.log" 2>&1 &&
    grep -q 'would mkdir' "$tmp/dry.log" && test ! -e "$tmp/dry" && test ! -e "$tmp/subuid.dry" &&
    test ! -e "$cgroot/$parent-dry"
}
if grep -q 'subuid .*present (covered by' "$tmp/install1.log"; then
  judge "install.sh detects the existing subuid/subgid range and appends nothing" copies_unchanged
else
  judge "install.sh appends the range once to the subuid copy" test "$(grep -c '^root:200000:65536$' "$tmp/subuid")" = 1
fi
grep 'warning' "$tmp/install1.log" | sed 's/^/note  /'
judge "install.sh appends root:200000:65536 to subid files without one" install_run "$tmp/subuid.bare" "$tmp/subgid.bare" "$tmp/install2.log"
judge "install.sh appended exactly one subuid line" test "$(diff <(grep -Ev '^(root|0):' /etc/subuid) "$tmp/subuid.bare" | grep -c '^>')" = 1
judge "install.sh appended exactly one subgid line" test "$(diff <(grep -Ev '^(root|0):' /etc/subgid) "$tmp/subgid.bare" | grep -c '^>')" = 1
state1="$(snapshot)"
if install_run "$tmp/subuid" "$tmp/subgid" "$tmp/install3.log" &&
  install_run "$tmp/subuid.bare" "$tmp/subgid.bare" "$tmp/install4.log"; then
  ok "install.sh re-run succeeds"
else
  bad "install.sh re-run failed: $(tail -c 300 "$tmp/install3.log" "$tmp/install4.log" | tr '\n' ' ')"
fi
judge "install.sh re-run is byte-identical (tree, modes, subid files, cgroup)" test "$state1" = "$(snapshot)"
judge "install.sh re-run reports no change" rerun_quiet
judge "install.sh --dry-run on a fresh prefix writes nothing" dry_run_clean
judge "real /etc/subuid and /etc/subgid untouched" test "$real_before" = "$(real_ids)"

# --- workbox doctor on the prepared prefix ------------------------------------------------------
links_before="$(ip -br link 2>&1)"
if WORKBOX_ROOT="$tmp/root" WORKBOX_CGROUP_ROOT="$cgroot" WORKBOX_CGROUP_PARENT="$parent" \
  node packages/cli/src/main.js doctor --json >"$tmp/doctor.json" 2>"$tmp/doctor.err"; then
  ok "workbox doctor --json ran (root $tmp/root, cgroup $parent)"
else
  bad "workbox doctor --json exited $?: $(tail -c 300 "$tmp/doctor.err")"
fi
node --input-type=module - "$tmp/doctor.json" <<'EOF'
import fs from 'node:fs';
const required = ['privileges', 'kernel', 'node', 'bwrap', 'unshare', 'tool.newuidmap', 'tool.newgidmap',
  'tool.nsenter', 'tool.setpriv', 'subuid', 'subgid', 'subuid.exclusive', 'subgid.exclusive', 'userns',
  'overlay', 'cgroup', 'tool.slirp4netns', 'tool.nft', 'proxy-link', 'docker', 'rootfs', 'runtime', 'disk'];
let report;
try {
  report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
} catch (e) {
  console.log(`FAIL  doctor output is not JSON: ${e.message}`);
  process.exit(1);
}
let bad = 0;
for (const c of report.checks) {
  const shape = typeof c.id === 'string' && typeof c.title === 'string' && typeof c.detail === 'string';
  const known = ['pass', 'fail', 'warn'].includes(c.status);
  const remedy = c.status === 'pass' || (typeof c.remedy === 'string' && c.remedy.length > 0);
  const okLine = shape && known && remedy && c.status !== 'fail';
  if (!okLine) bad++;
  const why = !shape || !known ? ' (malformed)' : !remedy ? ' (no remedy)' : '';
  console.log(`${okLine ? 'ok  ' : 'FAIL'}  doctor ${c.status} ${c.id}: ${c.detail}${c.remedy ? ` | remedy: ${c.remedy}` : ''}${why}`);
}
const ids = new Set(report.checks.map((c) => c.id));
const missing = required.filter((id) => !ids.has(id));
console.log(missing.length ? `FAIL  doctor lacks probes ${missing.join(', ')}` : `ok    doctor covers all ${required.length} host prerequisites`);
console.log(report.ok ? 'ok    doctor: host is ready' : 'FAIL  doctor: host is NOT ready');
process.exit(bad || missing.length || !report.ok ? 1 : 0);
EOF
doctor_rc=$?
if [ "$doctor_rc" != 0 ]; then fails=$((fails + 1)); fi
judge "doctor left host links unchanged (workbox0 probed read-only)" test "$links_before" = "$(ip -br link 2>&1)"

if [ "$fails" = 0 ]; then
  echo "deploy/check: ok"
else
  echo "deploy/check: $fails failed"
fi
[ "$fails" = 0 ]
