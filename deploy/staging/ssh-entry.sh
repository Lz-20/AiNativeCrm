#!/bin/sh
# Forced command, root-owned along with every parent directory.
# SSH key options: restrict,command="/usr/local/libexec/ainativecrm-staging/ssh-entry.sh"
# The deploy principal has no docker group and one exact, argument-free sudo rule.
set -eu
if [ "$#" -ne 0 ] || [ "${SSH_ORIGINAL_COMMAND-}" != 'ainativecrm-deploy' ]; then
  printf '%s\n' '{"ok":false,"error":"ssh_command_not_allowed"}'
  exit 64
fi
exec /usr/bin/sudo -n /usr/local/sbin/ainativecrm-staging-entry
