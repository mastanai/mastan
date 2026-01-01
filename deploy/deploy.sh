#!/bin/sh
# Deploy the code from this Mac to YOUR_SERVER:/opt/mastan-me and restart mastan-me.
# Never copies data (atlas-build, tests, BRIEF.md) and never touches other services.
set -eu
cd "$(dirname "$0")/.."
HOST=${HOST:-YOUR_SERVER}
rsync -rlt --delete \
  --exclude .git --exclude node_modules --exclude runtime --exclude atlas-build --exclude BRIEF.md \
  --exclude test --exclude 'tmp/' --exclude '.DS_Store' \
  ./ "$HOST:/opt/mastan-me/"
ssh "$HOST" "NO_RESTART=${NO_RESTART:-0} sh -s" <<'REMOTE'
set -eu
cd /opt/mastan-me
chmod -R u=rwX,go=rX /opt/mastan-me/src /opt/mastan-me/bin /opt/mastan-me/config /opt/mastan-me/deploy /opt/mastan-me/package.json /opt/mastan-me/package-lock.json; chmod 755 bin/* deploy/*.sh 2>/dev/null || true
chown -R root:root /opt/mastan-me/src /opt/mastan-me/bin /opt/mastan-me/config /opt/mastan-me/deploy
PATH=/opt/mastan-me/runtime/node/bin:$PATH npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null
# Check the pinned revision, including the headless shell and ffmpeg installed by `install chromium`.
install -d -o root -g root -m 0755 /opt/mastan-me/runtime/ms-playwright
if ! PLAYWRIGHT_BROWSERS_PATH=/opt/mastan-me/runtime/ms-playwright /opt/mastan-me/runtime/node/bin/node -e '
  const fs = require("node:fs");
  const {registry, browserDirectoryToMarkerFilePath} = require("playwright-core/lib/coreBundle").registry;
  const installed = registry.resolveBrowsers(["chromium"], {}).every(e =>
    fs.existsSync(e.executablePath()) && fs.existsSync(browserDirectoryToMarkerFilePath(e.directory)));
  process.exit(installed ? 0 : 1);
'; then
  PLAYWRIGHT_BROWSERS_PATH=/opt/mastan-me/runtime/ms-playwright /opt/mastan-me/runtime/node/bin/node node_modules/playwright/cli.js install chromium
fi
chown -R root:root /opt/mastan-me/runtime/ms-playwright
chmod -R u=rwX,go=rX /opt/mastan-me/runtime/ms-playwright
install -m 0644 deploy/mastan-me.service /etc/systemd/system/mastan-me.service
for u in deploy/mastan-me-*.service deploy/mastan-me-*.timer deploy/mastan-me-job@.service; do if [ -f "$u" ]; then install -m 0644 "$u" /etc/systemd/system/; fi; done
ln -sf /opt/mastan-me/bin/mastan-me-admin /usr/local/bin/mastan-me-admin
# The coder's sandbox (an AppArmor profile for Codex's bwrap) is NOT installed here: Owner runs deploy/enable-coder-sandbox.sh once.
systemctl daemon-reload
if [ "${NO_RESTART:-}" != 1 ]; then systemctl restart mastan-me.service; sleep 2; systemctl is-active mastan-me.service; fi
REMOTE
