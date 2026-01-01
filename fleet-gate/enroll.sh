#!/bin/sh
# From the Mac: enroll.sh <ssh-alias> <name> [client]. Never retrieves the private key.
# OWN_KEY=1 gives this server its own key on dev-01 instead of the shared one.
set -eu
cd "$(dirname "$0")/.."
[ "$#" -ge 2 ] && [ "$#" -le 3 ] || { echo 'usage: enroll.sh <ssh-alias> <name> [client]' >&2; exit 1; }
ALIAS=$1
NAME=$2
CLIENT=${3:-$NAME}
python3 - "$ALIAS" "$NAME" "$CLIENT" <<'PY'
import re, sys
if any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', s) for s in sys.argv[1:]):
    sys.exit('bad alias, name or client')
PY
HOST_IP=$(ssh -G "$ALIAS" | awk '$1 == "hostname" {print $2; exit}')
python3 - "$HOST_IP" <<'PY'
import ipaddress, sys
ipaddress.ip_address(sys.argv[1])
PY
if [ "${OWN_KEY:-}" = 1 ]; then
  PUBLIC_KEY=$(ssh YOUR_SERVER mastan-fleet-admin own-key "$NAME")
  KEY_NAME=${NAME}_ed25519
else
  PUBLIC_KEY=$(ssh YOUR_SERVER cat /var/lib/mastan-ops/ssh/client_ed25519.pub)
  KEY_NAME=
fi
STAGE=$(ssh "$ALIAS" mktemp -d)
case "$STAGE" in /tmp/tmp.*) ;; *) echo 'unexpected staging path' >&2; exit 1 ;; esac
trap 'ssh "$ALIAS" "rm -rf '\''$STAGE'\''"' EXIT
COPYFILE_DISABLE=1 tar --no-xattrs -cf - -C fleet-gate client/audit-command.py client/enroll-key.py |
  ssh "$ALIAS" "tar -C '$STAGE' -xf -"
printf '%s\n' "$PUBLIC_KEY" | ssh "$ALIAS" "python3 -I '$STAGE/client/enroll-key.py' '$STAGE/client/audit-command.py'"
ssh YOUR_SERVER "mastan-fleet-admin add '$NAME' '$HOST_IP' '$CLIENT' $KEY_NAME"
