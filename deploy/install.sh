#!/bin/sh
# Install Workbox host prerequisites (idempotent). Run as root on Debian/Ubuntu.
set -eu
if [ "$(id -u)" != "0" ]; then echo "install.sh must run as root" >&2; exit 1; fi
export WORKBOX_ROOT="${WORKBOX_ROOT:-/var/lib/workbox}"
mkdir -p "$WORKBOX_ROOT" /etc/workbox
chmod 700 "$WORKBOX_ROOT"

# Subordinate uid/gid range for the daemon user (root here) — range-mapped userns needs it.
for f in /etc/subuid /etc/subgid; do
  touch "$f"
  grep -q '^root:200000:65536' "$f" || echo 'root:200000:65536' >> "$f"
done

# Unprivileged user namespaces (idempotent sysctl where applicable).
if [ -w /proc/sys/kernel/unprivileged_userns_clone ]; then
  echo 1 > /proc/sys/kernel/unprivileged_userns_clone || true
fi

# cgroup v2 parent with delegated controllers.
CG=/sys/fs/cgroup/workbox
mkdir -p "$CG" || true
if [ -w /sys/fs/cgroup/cgroup.subtree_control ]; then
  for c in cpu memory pids; do
    grep -qw "$c" /sys/fs/cgroup/cgroup.subtree_control || echo "+$c" > /sys/fs/cgroup/cgroup.subtree_control || true
  done
fi
echo "workbox host install done (root=$WORKBOX_ROOT). Next: workbox doctor && workbox rootfs build minimal && workbox runtime install"
