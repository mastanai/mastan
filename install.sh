#!/usr/bin/env bash
# Mastan installer for a fresh Ubuntu server (22.04 or 24.04), run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/mastanai/mastan/main/install.sh | sudo bash
#
# What it does: installs Node.js, git, bubblewrap, the Claude Code CLI and the Codex CLI;
# creates the user "mastan"; puts the code in /opt/mastan-me, data in /var/lib/mastan-me and
# secrets in /etc/mastan-me; asks for your Telegram bot token and your Telegram ID; starts Mastan
# as a system service. Safe to run again: it updates the code and keeps your settings.
#
# Unattended use: set TELEGRAM_BOT_TOKEN and OWNER_TELEGRAM_ID in the environment first,
# or MASTAN_SKIP_TELEGRAM=1 to set Telegram up later.
set -euo pipefail

REPO_URL=${MASTAN_REPO:-https://github.com/mastanai/mastan.git}
BRANCH=${MASTAN_BRANCH:-main}
APP=/opt/mastan-me
DATA=/var/lib/mastan-me
ETC=/etc/mastan-me
ENVF=$ETC/env
AGENT_HOME=/var/lib/mastan/home
BACKUPS=/var/backups/mastan-me
NODE_DIR=$APP/runtime/node
NODE_MIN=26.5.0
NODE_LINE=26
SVC=mastan-me
USR=mastan

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }

# Version a >= version b (plain x.y.z).
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

# Last value of KEY in the env file, empty when missing.
env_get() { [ -f "$ENVF" ] && sed -n "s/^$1=//p" "$ENVF" | tail -n1 || true; }

have_tty() { [ -r /dev/tty ] && [ -w /dev/tty ] && { : </dev/tty; } 2>/dev/null; }

check_system() {
  [ "$(id -u)" = 0 ] || die "Run this as root (put sudo in front of the command)."
  [ -r /etc/os-release ] || die "This does not look like Ubuntu. Use a fresh Ubuntu 24.04 server."
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) die "This installer is made for Ubuntu. Found: ${PRETTY_NAME:-unknown}." ;;
  esac
  command -v systemctl >/dev/null || die "This server has no systemd. Use a normal Ubuntu server, not a container."
  case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) die "Unsupported processor type: $(uname -m)." ;;
  esac
  local mem_mb
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  if [ "$mem_mb" -lt 1800 ]; then
    note "Warning: this server has ${mem_mb} MB of memory. 4 GB is recommended."
  fi
}

install_packages() {
  say "Installing system packages (git, bubblewrap, curl)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git bubblewrap openssl xz-utils util-linux >/dev/null
}

install_node() {
  local have=""
  [ -x "$NODE_DIR/bin/node" ] && have=$("$NODE_DIR/bin/node" -v | sed 's/^v//')
  if [ -n "$have" ] && version_ge "$have" "$NODE_MIN"; then
    say "Node.js $have is already installed"
    return
  fi
  say "Installing Node.js $NODE_LINE"
  local base="https://nodejs.org/dist/latest-v${NODE_LINE}.x" tmp file sums
  tmp=$(mktemp -d)
  sums=$(curl -fsSL "$base/SHASUMS256.txt") || die "Could not reach nodejs.org. Check the server's internet connection."
  file=$(printf '%s\n' "$sums" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-${NODE_ARCH}\.tar\.xz$" | head -n1)
  [ -n "$file" ] || die "Could not find a Node.js $NODE_LINE download for this server."
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && printf '%s\n' "$sums" | grep " $file\$" | sha256sum -c --quiet -) || die "The Node.js download is damaged. Run the installer again."
  mkdir -p "$APP/runtime"
  rm -rf "$NODE_DIR.new"
  mkdir -p "$NODE_DIR.new"
  tar -xJf "$tmp/$file" -C "$NODE_DIR.new" --strip-components=1
  rm -rf "$NODE_DIR"
  mv "$NODE_DIR.new" "$NODE_DIR"
  rm -rf "$tmp"
  have=$("$NODE_DIR/bin/node" -v | sed 's/^v//')
  version_ge "$have" "$NODE_MIN" || die "Node.js $have was installed, but Mastan needs $NODE_MIN or newer."
  note "Node.js $have"
}

create_user() {
  say "Creating the user \"$USR\" and its folders"
  install -d -o root -g root -m 0755 /var/lib/mastan
  if ! getent passwd "$USR" >/dev/null; then
    useradd --system --user-group --home-dir "$AGENT_HOME" --shell /bin/bash "$USR"
  fi
  install -d -o "$USR" -g "$USR" -m 0700 "$AGENT_HOME" "$DATA" "$BACKUPS"
  install -d -o root -g "$USR" -m 0750 "$ETC"
}

get_code() {
  say "Downloading Mastan into $APP"
  if [ -d "$APP/.git" ]; then
    git -C "$APP" fetch -q origin "$BRANCH"
    git -C "$APP" checkout -q "$BRANCH"
    git -C "$APP" merge -q --ff-only "origin/$BRANCH" \
      || die "$APP has local changes, so it cannot be updated. Move them away and run the installer again."
  elif [ -e "$APP" ] && [ -n "$(find "$APP" -mindepth 1 -maxdepth 1 ! -name runtime -print -quit)" ]; then
    die "$APP already exists and is not a Mastan download. Move it away and run the installer again."
  else
    local tmp
    tmp=$(mktemp -d /opt/.mastan-clone.XXXXXX)
    git clone -q --branch "$BRANCH" "$REPO_URL" "$tmp/code"
    mkdir -p "$APP"
    # Keep a runtime/ folder from an earlier, interrupted run.
    shopt -s dotglob
    mv "$tmp/code"/* "$APP"/
    shopt -u dotglob
    rm -rf "$tmp"
  fi
  chown -R root:root "$APP"
  chmod -R u=rwX,go=rX "$APP"
  chmod 755 "$APP"/bin/*
}

install_node_packages() {
  say "Installing Mastan's parts, the Claude Code CLI and the Codex CLI (a few minutes)"
  export PATH="$NODE_DIR/bin:$PATH"
  (cd "$APP" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
  npm install -g --no-audit --no-fund --loglevel=error @anthropic-ai/claude-code @openai/codex >/dev/null
  [ -x "$NODE_DIR/bin/claude" ] || die "The Claude Code CLI did not install."
  [ -x "$NODE_DIR/bin/codex" ] || die "The Codex CLI did not install."
  chown -R root:root "$APP"
  chmod -R u=rwX,go=rX "$APP"
  note "Claude Code $("$NODE_DIR/bin/claude" --version 2>/dev/null | head -n1)"
  note "Codex $("$NODE_DIR/bin/codex" --version 2>/dev/null | head -n1)"
}

# Can user mastan start the same bubblewrap sandbox the main agent uses?
probe_bwrap() {
  cd / && runuser -u "$USR" -- /usr/bin/bwrap --dev-bind / / --unshare-pid --unshare-ipc --proc /proc \
    --die-with-parent /bin/true >/dev/null 2>&1
}

# Ubuntu 24.04 blocks user namespaces for programs without an AppArmor profile that allows them.
# This gives bubblewrap (and the copy inside the Codex CLI, if any) the same small profile Ubuntu
# uses for browsers: unconfined, user namespaces allowed. Remove with: rm /etc/apparmor.d/mastan-bwrap*
# then systemctl reload apparmor.
allow_bwrap_userns() {
  local f=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
  [ -r "$f" ] && [ "$(cat "$f")" = 1 ] || return 1
  command -v apparmor_parser >/dev/null || return 1
  write_bwrap_profile mastan-bwrap /usr/bin/bwrap
  local i=0 b
  while IFS= read -r b; do
    i=$((i + 1))
    write_bwrap_profile "mastan-bwrap-codex$i" "$b"
  done < <(find "$NODE_DIR/lib/node_modules/@openai" -type f -name bwrap -perm -u+x 2>/dev/null)
  return 0
}

write_bwrap_profile() {
  local name=$1 path=$2
  cat > "/etc/apparmor.d/$name" <<EOF
# Written by the Mastan installer: lets $path create user namespaces (its sandbox needs them).
abi <abi/4.0>,
include <tunables/global>

profile $name $path flags=(unconfined) {
  userns,
  include if exists <local/$name>
}
EOF
  apparmor_parser -r "/etc/apparmor.d/$name"
}

setup_sandbox() {
  say "Checking the safety sandbox"
  SANDBOX=on
  if probe_bwrap; then note "Sandbox works."; return; fi
  if allow_bwrap_userns && probe_bwrap; then note "Sandbox works (AppArmor permission added)."; return; fi
  SANDBOX=off
  note "Warning: the sandbox does not work on this server, so Mastan runs without it."
  note "Mastan still works. The sandbox only adds a layer of protection."
}

ask_telegram() {
  TOKEN=${TELEGRAM_BOT_TOKEN:-$(env_get TELEGRAM_BOT_TOKEN)}
  OWNER=${OWNER_TELEGRAM_ID:-$(env_get OWNER_TELEGRAM_ID)}
  if [ -n "$TOKEN" ] && [ -n "$OWNER" ]; then
    say "Telegram is already set up (bot token kept, owner ID $OWNER)"
  elif [ "${MASTAN_SKIP_TELEGRAM:-0}" = 1 ] || ! have_tty; then
    say "Skipping Telegram for now"
    note "Run the installer again later to add your bot token and your Telegram ID."
  else
    say "Telegram"
    note "Mastan talks to you through your own Telegram bot."
    note "1. In Telegram, open @BotFather, send /newbot and follow the questions."
    note "2. BotFather gives you a token. It looks like 123456789:ABCdef..."
    note "3. Open @userinfobot in Telegram. It shows your ID, a number."
    while :; do
      printf '\n    Paste your bot token (it stays hidden) and press Enter: ' >/dev/tty
      IFS= read -rs TOKEN </dev/tty || TOKEN=""
      printf '\n' >/dev/tty
      TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
      [ -z "$TOKEN" ] && break
      valid_token "$TOKEN" && break
      note "That does not look like a bot token. Try again, or press Enter to skip."
    done
    if [ -n "$TOKEN" ]; then
      while :; do
        printf '    Paste your Telegram ID (a number) and press Enter: ' >/dev/tty
        IFS= read -r OWNER </dev/tty || OWNER=""
        OWNER=$(printf '%s' "$OWNER" | tr -d '[:space:]')
        valid_id "$OWNER" && break
        note "Your ID is only digits, for example 123456789. Try again."
      done
    else
      OWNER=""
      note "Skipped. Run the installer again later to add Telegram."
    fi
  fi
  if [ -n "$TOKEN" ]; then valid_token "$TOKEN" || die "The bot token does not look right."; fi
  if [ -n "$OWNER" ]; then valid_id "$OWNER" || die "The Telegram ID must be only digits."; fi
  if [ -z "$TOKEN" ] || [ -z "$OWNER" ]; then TOKEN=""; OWNER=""; fi
}

valid_token() { printf '%s' "$1" | grep -Eq '^[0-9]{5,}:[A-Za-z0-9_-]{30,}$'; }
valid_id()    { printf '%s' "$1" | grep -Eq '^[0-9]{3,}$'; }

write_env() {
  say "Saving settings in $ENVF"
  local secret managed tmp key
  secret=$(env_get SESSION_SECRET)
  [ -n "$secret" ] || secret=$(openssl rand -hex 32)
  managed='MASTAN_ME_DATA MASTAN_ME_HOSTNAME MASTAN_ME_RP_ID SESSION_SECRET AGENT_HOME CLAUDE_BIN CODEX_BIN CODEX_HOME_FOR_CODER TELEGRAM_BOT_TOKEN OWNER_TELEGRAM_ID MASTAN_ME_BWRAP MASTAN_ME_MAIN_SANDBOX MASTAN_ME_MAIL_ALERTS'
  tmp=$(umask 077; mktemp "$ETC/.env.XXXXXX")
  {
    echo "# Mastan settings. Written by install.sh; your own extra lines below the marker are kept."
    echo "MASTAN_ME_DATA=$DATA"
    echo "MASTAN_ME_HOSTNAME=$(env_get MASTAN_ME_HOSTNAME | grep . || echo localhost)"
    echo "MASTAN_ME_RP_ID=$(env_get MASTAN_ME_RP_ID | grep . || echo localhost)"
    echo "SESSION_SECRET=$secret"
    echo "AGENT_HOME=$AGENT_HOME"
    echo "CLAUDE_BIN=$NODE_DIR/bin/claude"
    echo "CODEX_BIN=$NODE_DIR/bin/codex"
    echo "CODEX_HOME_FOR_CODER=$AGENT_HOME/.codex"
    if [ -n "$TOKEN" ]; then
      echo "TELEGRAM_BOT_TOKEN=$TOKEN"
      echo "OWNER_TELEGRAM_ID=$OWNER"
    fi
    echo "MASTAN_ME_BWRAP=/usr/bin/bwrap"
    echo "MASTAN_ME_MAIN_SANDBOX=$SANDBOX"
    echo "MASTAN_ME_MAIL_ALERTS=off"
    echo "# --- your own lines below ---"
    if [ -f "$ENVF" ]; then
      sed -n '/^# --- your own lines below ---$/,$p' "$ENVF" | sed 1d | while IFS= read -r line; do
        key=${line%%=*}
        case " $managed " in *" $key "*) ;; *) printf '%s\n' "$line" ;; esac
      done
    fi
  } > "$tmp"
  chown root:"$USR" "$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$ENVF"
}

write_service() {
  say "Installing the Mastan service"
  cat > "/etc/systemd/system/$SVC.service" <<EOF
# Written by the Mastan installer (install.sh). Running the installer again rewrites it.
[Unit]
Description=Mastan, your private AI assistant
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$USR
Group=$USR
WorkingDirectory=$APP
EnvironmentFile=$ENVF
Environment=HOME=$AGENT_HOME
Environment=NODE_ENV=production
Environment=PATH=$APP/bin:$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_DIR/bin/node src/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA $AGENT_HOME -$BACKUPS
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
MemoryHigh=75%
MemoryMax=85%
TasksMax=256
LimitNOFILE=8192
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SVC

[Install]
WantedBy=multi-user.target
EOF
  ln -sf "$APP/bin/mastan-me-admin" /usr/local/bin/mastan-me-admin
  write_login_helper
}

# One short command per login, run as the right user with the right folders:
#   mastan-login claude      mastan-login codex
write_login_helper() {
  cat > /usr/local/bin/mastan-login <<EOF
#!/bin/sh
# Connect your own AI subscription to Mastan. Written by the Mastan installer.
set -eu
[ "\$(id -u)" = 0 ] || { echo "Run it as root: sudo mastan-login \${1:-claude}"; exit 1; }
B=$NODE_DIR/bin
as_mastan() { runuser -u $USR -- env HOME=$AGENT_HOME CODEX_HOME=$AGENT_HOME/.codex PATH=\$B:/usr/local/bin:/usr/bin:/bin "\$@"; }
case "\${1:-}" in
  claude)
    echo "Sign in with your own Claude account. Open the link it shows, approve, and paste the code back here if asked."
    if as_mastan "\$B/claude" auth login --help >/dev/null 2>&1; then as_mastan "\$B/claude" auth login
    else echo "When Claude opens, type /login and follow the steps, then type /exit."; as_mastan "\$B/claude"; fi ;;
  codex)
    echo "Sign in with your own ChatGPT account. Open the link it shows and enter the code."
    if as_mastan "\$B/codex" login --help 2>&1 | grep -q -- --device-auth; then as_mastan "\$B/codex" login --device-auth
    else as_mastan "\$B/codex" login; fi ;;
  status)
    as_mastan "\$B/claude" auth status 2>/dev/null || echo "Claude: run 'mastan-login claude' if Mastan does not answer."
    as_mastan "\$B/codex" login status 2>/dev/null || echo "Codex: not signed in." ;;
  *) echo "Usage: mastan-login claude | codex | status"; exit 1 ;;
esac
systemctl restart $SVC 2>/dev/null || true
EOF
  chmod 0755 /usr/local/bin/mastan-login
}

init_workspace() {
  say "Preparing Mastan's workspace"
  "$APP/bin/mastan-me-admin" init-workspace >/dev/null
}

start_service() {
  say "Starting Mastan"
  systemctl daemon-reload
  systemctl enable -q "$SVC"
  systemctl restart "$SVC"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://127.0.0.1:3100/healthz" >/dev/null 2>&1; then note "Mastan is running."; return; fi
    sleep 2
  done
  journalctl -u "$SVC" -n 30 --no-pager >&2 || true
  die "Mastan did not start. The last lines of its log are above."
}

logged_in() {
  # Claude keeps its login in ~/.claude/.credentials.json, Codex in CODEX_HOME/auth.json.
  case "$1" in
    claude) [ -s "$AGENT_HOME/.claude/.credentials.json" ] ;;
    codex)  [ -s "$AGENT_HOME/.codex/auth.json" ] ;;
  esac
}

next_steps() {
  printf '\n============================================================\n'
  printf ' Mastan is installed.\n'
  printf '============================================================\n'
  local n=1
  if ! logged_in claude; then
    printf '\n %s. Connect your Claude subscription. Paste this and press Enter:\n\n      mastan-login claude\n' "$n"; n=$((n + 1))
  fi
  if ! logged_in codex; then
    printf '\n %s. Connect your ChatGPT subscription (for coding tasks). Paste this:\n\n      mastan-login codex\n' "$n"; n=$((n + 1))
  fi
  if [ -z "$TOKEN" ]; then
    printf '\n %s. Add Telegram: run the installer again and paste your bot token and ID.\n' "$n"; n=$((n + 1))
  fi
  printf '\n %s. Open your bot in Telegram and say hello.\n' "$n"
  printf '\n Problems? See what Mastan is doing:  journalctl -u %s -f\n\n' "$SVC"
}

main() {
  check_system
  ask_telegram
  install_packages
  create_user
  get_code
  install_node
  install_node_packages
  setup_sandbox
  write_env
  write_service
  init_workspace
  start_service
  next_steps
}

main "$@"
