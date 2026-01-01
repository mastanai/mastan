#!/bin/sh
# Enables the coder's sandbox on this server: the bubblewrap that Codex ships may create user namespaces
# (Ubuntu 24.04 restricts them for unconfined programs). Owner runs this himself, once, as root on YOUR_SERVER:
#   sh /opt/mastan-me/deploy/enable-coder-sandbox.sh
# It is the one security-relevant change the harness never applies by itself. Undo: docs/ROLLBACK.md, section 2c.
set -eu
cd "$(dirname "$0")"
install -m 0644 apparmor/codex-bwrap /etc/apparmor.d/codex-bwrap
apparmor_parser -r /etc/apparmor.d/codex-bwrap
if sudo -u mastan /opt/mastan-me/runtime/codex-vendor/codex-resources/bwrap --unshare-user --ro-bind / / /bin/true; then
  echo "coder sandbox enabled: bwrap creates user namespaces as mastan"
else
  echo "bwrap still cannot create user namespaces; check: journalctl -k | grep -i apparmor" >&2
  exit 1
fi
