#!/bin/sh
# Workbox launch chain, stage 1 and 2. Runs on the host as root, detached from the daemon.
#   1. join the sandbox cgroup, so every descendant is accounted and killable as one unit
#   2. enter a range-mapped user namespace plus a private mount namespace, becoming uid 0 inside
#   3. mount the overlay (base rootfs read-only below, the sandbox upper layer on top)
#   4. exec bwrap with the arguments the daemon prepared ("$@")
# Inputs: WB_CGROUP WB_MAP WB_LOWER WB_UPPER WB_WORK WB_MERGED, then the bwrap argv.
set -eu
echo $$ > "$WB_CGROUP/cgroup.procs"
exec unshare --user --mount --propagation private \
  --map-users="$WB_MAP" --map-groups="$WB_MAP" --setuid 0 --setgid 0 -- \
  /bin/sh -c '
    set -eu
    mount -t overlay overlay -o "lowerdir=$WB_LOWER,upperdir=$WB_UPPER,workdir=$WB_WORK" "$WB_MERGED"
    exec bwrap "$@"
  ' workbox-stage2 "$@"
