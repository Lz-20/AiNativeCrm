#!/bin/sh
# Operator convenience entry. Restores prior three image digests, never a database.
set -eu
if [ "$#" -ne 0 ]; then
  printf '%s\n' '{"ok":false,"error":"rollback_accepts_no_arguments"}'
  exit 64
fi
printf '%s\n' '{"operation":"rollback"}' | /usr/bin/sudo -n /usr/local/sbin/ainativecrm-staging-entry
