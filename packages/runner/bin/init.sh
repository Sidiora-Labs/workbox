#!/bin/sh
# Workbox sandbox init. Runs as PID 2 under bwrap with the 14-capability profile already applied.
# It locks the capability bounding set to that profile, forbids new privileges for every
# descendant, then execs the runner. Anything the agent later runs inherits both.
set -eu
CAPS="-all,+chown,+dac_override,+fowner,+fsetid,+kill,+setgid,+setuid,+setpcap,+net_bind_service,+net_raw,+sys_chroot,+mknod,+audit_write,+setfcap"
exec setpriv --no-new-privs --bounding-set="$CAPS" -- \
  /opt/workbox/node/bin/node --disable-warning=ExperimentalWarning /opt/workbox/lib/runner/src/main.js "$@"
