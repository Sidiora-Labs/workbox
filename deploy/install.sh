#!/bin/sh
# Prepare a host for the Workbox daemon, idempotently: the Workbox root, the config directory,
# the daemon user's subordinate uid/gid range and the cgroup v2 parent with cpu, memory and pids
# delegated. A second run changes nothing. Run as root.
#
# Usage: install.sh [--root DIR] [--etc DIR] [--cgroup-root DIR] [--cgroup-parent NAME]
#                   [--subuid FILE] [--subgid FILE] [--user NAME] [--uid-base N] [--uid-count N]
#                   [--dry-run]
# Environment defaults: WORKBOX_ROOT (/var/lib/workbox), WORKBOX_ETC (/etc/workbox),
# WORKBOX_CGROUP_ROOT (/sys/fs/cgroup), WORKBOX_CGROUP_PARENT (workbox), WORKBOX_SUBUID_FILE
# (/etc/subuid), WORKBOX_SUBGID_FILE (/etc/subgid), WORKBOX_USER (root), WORKBOX_UID_BASE
# (200000), WORKBOX_UID_COUNT (65536). --dry-run prints every change it would make and makes none.
# The cgroup parent lives in cgroupfs and is gone after a reboot; the daemon recreates it at start.
set -eu

root="${WORKBOX_ROOT:-/var/lib/workbox}"
etc="${WORKBOX_ETC:-/etc/workbox}"
cgroot="${WORKBOX_CGROUP_ROOT:-/sys/fs/cgroup}"
parent="${WORKBOX_CGROUP_PARENT:-workbox}"
subuid="${WORKBOX_SUBUID_FILE:-/etc/subuid}"
subgid="${WORKBOX_SUBGID_FILE:-/etc/subgid}"
user="${WORKBOX_USER:-root}"
base="${WORKBOX_UID_BASE:-200000}"
count="${WORKBOX_UID_COUNT:-65536}"
dry=0

die() {
  echo "install.sh: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --root | --etc | --cgroup-root | --cgroup-parent | --subuid | --subgid | --user | --uid-base | --uid-count)
      [ $# -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --root) root="$2" ;;
        --etc) etc="$2" ;;
        --cgroup-root) cgroot="$2" ;;
        --cgroup-parent) parent="$2" ;;
        --subuid) subuid="$2" ;;
        --subgid) subgid="$2" ;;
        --user) user="$2" ;;
        --uid-base) base="$2" ;;
        --uid-count) count="$2" ;;
      esac
      shift
      ;;
    -h | --help)
      sed -n '2,13p' "$0"
      exit 0
      ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done

case "$base$count" in *[!0-9]*) die "--uid-base and --uid-count must be numbers" ;; esac
case "$parent" in . | .. | "" | */* | *[!A-Za-z0-9_.-]*) die "invalid cgroup parent name $parent" ;; esac
for p in "$root" "$etc" "$cgroot"; do
  case "$p" in /*) ;; *) die "$p must be an absolute path" ;; esac
done
if [ "$dry" = 0 ] && [ "$(id -u)" != 0 ]; then die "must run as root (or with --dry-run)"; fi
uid="$(id -u "$user" 2>/dev/null)" || die "no such user $user"

change() {
  if [ "$dry" = 1 ]; then echo "would $*"; else "$@"; fi
}

private_dir() {
  if [ -d "$1" ]; then
    state=present
  else
    change mkdir -p "$1"
    state=created
  fi
  if [ "$dry" = 0 ] && [ "$(stat -c %a "$1")" != 700 ]; then chmod 700 "$1"; fi
  echo "$2 $1: $state (mode 700)"
}

# The user's own entry covering base..base+count-1, if any.
covering() {
  [ -f "$1" ] || return 0
  awk -F: -v u="$user" -v id="$uid" -v b="$base" -v c="$count" \
    '($1 == u || $1 == id) && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $2 + 0 <= b && $2 + $3 >= b + c { print; exit }' "$1"
}

# Other users' entries that overlap base..base+count-1.
overlapping() {
  [ -f "$1" ] || return 0
  awk -F: -v u="$user" -v id="$uid" -v b="$base" -v c="$count" \
    '$1 != u && $1 != id && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $2 + 0 < b + c && $2 + $3 > b { printf "%s ", $0 }' "$1"
}

append_line() {
  if [ -s "$2" ] && [ -n "$(tail -c 1 "$2")" ]; then echo >>"$2"; fi
  echo "$1" >>"$2"
}

subid() {
  entry="$user:$base:$count"
  have="$(covering "$2")"
  if [ -n "$have" ]; then
    echo "$1 $2: $entry present (covered by $have)"
  elif [ "$dry" = 1 ]; then
    echo "would append $entry to $2"
  else
    append_line "$entry" "$2"
    echo "$1 $2: appended $entry"
  fi
  others="$(overlapping "$2")"
  if [ -n "$others" ]; then
    echo "$1 $2: warning: $base..$((base + count - 1)) overlaps ${others% }; those users can map sandbox ids" >&2
  fi
}

enable_controllers() {
  for c in $2; do
    if ! grep -qw "$c" "$1/cgroup.subtree_control" 2>/dev/null; then
      if [ "$dry" = 1 ]; then
        echo "would enable +$c in $1/cgroup.subtree_control"
      else
        echo "+$c" >"$1/cgroup.subtree_control"
      fi
    fi
  done
}

cgroup_parent() {
  [ -f "$cgroot/cgroup.controllers" ] || die "$cgroot is not a cgroup v2 mount"
  wanted=""
  for c in cpu memory pids io; do
    if grep -qw "$c" "$cgroot/cgroup.controllers"; then
      wanted="$wanted $c"
    elif [ "$c" != io ]; then
      die "$cgroot lacks the $c controller"
    fi
  done
  enable_controllers "$cgroot" "$wanted"
  cg="$cgroot/$parent"
  if [ -d "$cg" ]; then state=present; else
    change mkdir "$cg"
    state=created
  fi
  enable_controllers "$cg" "$wanted"
  if [ "$dry" = 0 ]; then
    echo "cgroup $cg: $state, delegates $(cat "$cg/cgroup.subtree_control")"
  else
    echo "cgroup $cg: $state"
  fi
}

private_dir "$root" root
private_dir "$etc" etc
subid subuid "$subuid"
subid subgid "$subgid"
cgroup_parent
echo "install.sh: done. Next: workbox doctor && workbox rootfs build minimal && workbox runtime install"
