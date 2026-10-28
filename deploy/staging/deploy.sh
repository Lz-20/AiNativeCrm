#!/bin/sh
# Install root:root 0755 as /usr/local/sbin/ainativecrm-staging-entry.
# JSON is read from stdin by the installed engine. No candidate checkout is run.
set -eu
if [ "$#" -ne 0 ]; then
  printf '%s\n' '{"ok":false,"error":"entry_accepts_json_stdin_only"}'
  exit 64
fi
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 \
  /usr/bin/python3 -I /usr/local/libexec/ainativecrm-staging/engine.py
