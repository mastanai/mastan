#!/bin/sh
# Install/update only the fleet gate on dev-01. No client connections except host-key scans.
set -eu
cd "$(dirname "$0")/.."
HOST=${HOST:-YOUR_SERVER}
STAGE=$(ssh "$HOST" mktemp -d)
COPYFILE_DISABLE=1 tar --no-xattrs -cf - -C fleet-gate gate.mjs mastan-fleet mastan-fleet-admin mastan-fleet.service mastan-fleet.socket \
  -C ../workspace-template skills/fleet/SKILL.md | ssh "$HOST" "tar -C '$STAGE' -xf -"
ssh "$HOST" "STAGE='$STAGE' sh -s" <<'REMOTE'
set -eu
trap 'rm -rf "$STAGE"' EXIT
id mastan-ops >/dev/null
test -r /var/lib/mastan-ops/ssh/client_ed25519
test -x /opt/mastan-me/runtime/node/bin/node
test -f /opt/mastan-me/node_modules/@simplewebauthn/server/esm/index.js
install -d -o root -g root -m 0755 /opt/mastan-fleet
install -o root -g root -m 0644 "$STAGE/gate.mjs" /opt/mastan-fleet/gate.mjs
install -o root -g root -m 0755 "$STAGE/mastan-fleet" /usr/local/bin/mastan-fleet
install -o root -g root -m 0750 "$STAGE/mastan-fleet-admin" /usr/local/sbin/mastan-fleet-admin
install -d -o root -g mastan-ops -m 0750 /etc/mastan-fleet-gate
install -d -o mastan-ops -g mastan-ops -m 0700 /var/lib/mastan-fleet-gate
if [ ! -f /opt/mastan-fleet/servers.json ]; then printf '{"servers": []}\n' > /opt/mastan-fleet/servers.json; fi
if [ ! -f /opt/mastan-fleet/known_hosts ]; then touch /opt/mastan-fleet/known_hosts; fi
chown root:root /opt/mastan-fleet/servers.json /opt/mastan-fleet/known_hosts
chmod 0644 /opt/mastan-fleet/servers.json /opt/mastan-fleet/known_hosts
mastan-fleet-admin trust-passkeys
mastan-fleet-admin add client-a-01 203.0.113.40 client-a
install -o root -g root -m 0644 "$STAGE/mastan-fleet.service" "$STAGE/mastan-fleet.socket" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mastan-fleet.socket >/dev/null 2>&1
systemctl try-restart mastan-fleet.service
WORKSPACE=/var/lib/mastan-me/workspace/skills
if [ -d "$WORKSPACE" ]; then
  install -d -o mastan -g mastan -m 0755 "$WORKSPACE/fleet"
  install -o mastan -g mastan -m 0644 "$STAGE/skills/fleet/SKILL.md" "$WORKSPACE/fleet/SKILL.md"
  mastan-me-admin skills-inventory || echo 'skill copied; SKILLS.md not rebuilt'
fi
echo "mastan-fleet.socket: $(systemctl is-active mastan-fleet.socket)"
REMOTE
