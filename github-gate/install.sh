#!/bin/sh
# Install or update the GitHub gate on dev-01 from this Mac. Runs as root there over ssh.
# Never touches mastan-me.service, /opt/mastan-me or the token. Token: pbpaste | ssh dev-01 mastan-gh-admin set-token
#   /opt/mastan-gh/{gate.py,repos.json}   root-owned code and the repo list (the agent cannot change either)
#   /usr/local/bin/mastan-gh              the agent's client; /usr/local/sbin/mastan-gh-admin for root
#   /etc/mastan-gh/token                  mastan-gh 0400, in a root:mastan-gh 0750 folder the agent cannot open
#   /var/lib/mastan-gh/mirrors            read-only mirrors, group mastan (setgid); private/ holds audit + state
# Also puts the skills github and example-repo into the agent's workspace (until the next harness deploy does).
set -eu
cd "$(dirname "$0")/.."
HOST=${HOST:-dev-01}
python3 -c 'import json; json.load(open("github-gate/repos.json"))'
S=$(ssh "$HOST" mktemp -d)
COPYFILE_DISABLE=1 tar --no-xattrs -cf - -C github-gate gate.py mastan-gh mastan-gh-admin repos.json mastan-gh.service \
  mastan-gh.socket -C ../workspace-template skills/github/SKILL.md skills/example-repo/SKILL.md |
  ssh "$HOST" "tar -C '$S' -xf -"
ssh "$HOST" "S='$S' sh -s" <<'REMOTE'
set -eu
trap 'rm -rf "$S"' EXIT
id mastan-gh >/dev/null 2>&1 || useradd --system --home-dir /var/lib/mastan-gh --no-create-home --shell /usr/sbin/nologin mastan-gh
install -d -o root -g root -m 0755 /opt/mastan-gh
install -o root -g root -m 0644 "$S/gate.py" /opt/mastan-gh/gate.py
install -o root -g root -m 0644 "$S/repos.json" /opt/mastan-gh/repos.json
install -o root -g root -m 0755 "$S/mastan-gh" /usr/local/bin/mastan-gh
install -o root -g root -m 0750 "$S/mastan-gh-admin" /usr/local/sbin/mastan-gh-admin
install -d -o root -g mastan-gh -m 0750 /etc/mastan-gh
install -d -o mastan-gh -g mastan -m 0750 /var/lib/mastan-gh
install -d -o mastan-gh -g mastan -m 2750 /var/lib/mastan-gh/mirrors
install -d -o mastan-gh -g mastan-gh -m 0700 /var/lib/mastan-gh/private
install -o root -g root -m 0644 "$S/mastan-gh.service" "$S/mastan-gh.socket" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mastan-gh.socket >/dev/null 2>&1
systemctl try-restart mastan-gh.service
echo "mastan-gh.socket: $(systemctl is-active mastan-gh.socket)"
W=/var/lib/mastan-me/workspace/skills
if [ -d "$W" ]; then
  for s in github example-repo; do
    install -d -o mastan -g mastan -m 0755 "$W/$s"
    install -o mastan -g mastan -m 0644 "$S/skills/$s/SKILL.md" "$W/$s/SKILL.md"
  done
  mastan-me-admin skills-inventory || echo "skills copied; SKILLS.md not rebuilt"
fi
[ -s /etc/mastan-gh/token ] && echo "token: present" || echo "token: none yet (pbpaste | ssh dev-01 mastan-gh-admin set-token)"
REMOTE
