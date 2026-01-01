# Mastan harness

This is the server code behind Mastan, an AI assistant that one owner talks to on Telegram, WhatsApp and a passkey-protected web chat. It is a single Node.js process. It does not call model APIs itself: every model turn runs an installed command-line agent (the Claude Code CLI or the Codex CLI) as a child process, inside a workspace folder that holds the assistant's instructions, skills and memory.

The code is shared as it runs for one owner. Keys, user data, server addresses and deploy specifics are not included.

## What is in here

| Path | What |
|---|---|
| `src/server.js` | Entry point: HTTP on 127.0.0.1 (put nginx or another proxy in front), Telegram long polling, WhatsApp linked device, timers |
| `src/agent/` | Main agent turns, background tasks, schedules, busy replies |
| `src/providers/` | Model providers behind one interface (`claude-cli`, `codex-cli`, `deepseek-cli`) and the sandbox around them |
| `src/channels/` | Telegram, WhatsApp (baileys) and web chat |
| `src/web/` | Passkey login (WebAuthn), chat client, admin pages (atlas, board, fleet, mail, people, clients) |
| `src/atlas/`, `src/brain/` | The "atlas": the owner's positions, people, questions and dumps as markdown files in a local git repo |
| `src/jobs/` | Morning list, nightly consolidation, backup, health, mail alerts |
| `src/mail/` | IMAP/SMTP mailbox with client certificates |
| `src/clients/` | Owner-only sales and billing pages (Stripe restricted key, optional) |
| `bin/` | Small CLIs the agent calls from its tools (`mastan-me-send`, `mastan-me-task`, `mastan-me-schedule`, ...) and operator commands |
| `fleet-gate/`, `github-gate/` | Separate privileged services that hold SSH and GitHub credentials, so the agent never does |
| `workspace-template/` | Starting content of the agent's workspace: `SOUL.md` (identity and rules), `CLAUDE.md`, skills |
| `config/models.json` | Which provider and model each role uses |
| `deploy/` | systemd units, nginx example and a deploy script, with placeholders such as `YOUR_SERVER` |
| `docs/` | Module contracts, web routes, design system |

## How a turn flows

1. A message arrives on a channel: Telegram (`src/channels/telegram.js`), WhatsApp (`src/channels/whatsapp.js`) or the web chat (`src/channels/web-chat.js`). Only the owner's account is accepted.
2. The channel hands it to the `Agent` in `src/agent/runner.js`, which prefixes the local weekday and time and adds a short note about the channel (reply length, allowed formatting).
3. The agent looks up the role `main` in `config/models.json` and calls `runRole('main', ...)` in `src/providers/index.js`.
4. The provider starts the CLI with the workspace as its working directory, `SOUL.md` appended to the system prompt and a clean environment without the service's own secrets. For Claude, a long-lived "resident" process is kept per chat and reused for every turn (`--input-format stream-json`), so a turn costs model time only. Idle residents exit after a few hours and resume the same session from disk.
5. On Linux, the CLI runs inside bubblewrap (`src/providers/main-sandbox.js`), which hides the service's key files from anything the agent's tools run.
6. Streamed text and tool calls come back as events. The channel shows progress (tool lines, typing) and sends the final reply.
7. Tools the agent runs talk back to the service through `bin/` commands that use a short-lived per-chat token (`src/chat-tokens.js`): send a file, start a background task, add a schedule. Server changes go through `fleet-gate`, which needs the owner's passkey approval.
8. Every model call is logged to `<data>/logs/calls.jsonl` with task, role, provider, model, duration and exit code. Never content.

Other roles use the same path: `coder` (Codex CLI, for code tasks in a folder), `extractor` (atlas updates), `fast` (small classification calls).

## Providers and modes

Roles map to providers in `config/models.json`:

```json
"roles": {
  "main":      {"provider": "claude-cli", "model": "claude-opus-5-5", "effort": "high"},
  "coder":     {"provider": "codex-cli",  "model": "gpt-6.1-sol", "effort": "xhigh"},
  "extractor": {"provider": "claude-cli", "model": "claude-opus-5-5", "effort": "high"},
  "fast":      {"provider": "claude-cli", "model": "claude-haiku-5-5"}
}
```

The repo copy is the default. On first start it is copied to `<data>/config/models.json`, and that copy is the one in use. The owner changes it by editing the file or with `/model` in Telegram. Nothing switches on its own; fallbacks apply only if listed under `fallbacks`.

`models.json` picks a provider and a model. It does not decide how the CLI authenticates. That is decided by the login the CLI itself holds.

| Provider | Runs | Authenticates with |
|---|---|---|
| `claude-cli` | `claude -p` (Claude Code CLI) | whatever the CLI is logged in with under `AGENT_HOME` |
| `codex-cli` | `codex exec` | whatever the CLI is logged in with under `CODEX_HOME_FOR_CODER` |
| `deepseek-cli` | the same `claude` binary pointed at DeepSeek's Anthropic-compatible API | a DeepSeek API key read from `DEEPSEEK_KEY_FILE` |

### Subscription mode (one owner, personal use)

This is how the reference server runs. The Claude Code CLI is logged in with the owner's own Claude subscription, and the Codex CLI with the owner's own ChatGPT subscription. Use this only for yourself: a personal subscription is for your own use, not for serving other people.

```sh
# as the service user, with HOME set to AGENT_HOME
claude login
CODEX_HOME=/path/to/codex-home codex login
```

### API-key mode (required when the assistant serves anyone other than you)

If other people talk to the assistant, use API keys under your own developer account and the providers' commercial terms.

Expected to work without harness changes, through each CLI's own stored configuration. This is CLI behavior and has not been verified with this harness or its tests:

- Codex: `printenv OPENAI_API_KEY | CODEX_HOME=/path/to/codex-home codex login --with-api-key` stores the key for the CLI. The harness passes `CODEX_HOME` (from `CODEX_HOME_FOR_CODER`) to every Codex run.
- Claude Code: configure an API key in the CLI's own settings under `AGENT_HOME` (for example an `apiKeyHelper` command in `~/.claude/settings.json`). The harness sets `HOME` to `AGENT_HOME` for every Claude run.

Planned, not built: passing `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from the service environment to the CLIs. Today `childEnv()` in `src/providers/common.js` builds a clean environment for every child process on purpose, so those variables are not forwarded. Setting them in the service environment alone has no effect.

DeepSeek is always API-key mode: put the key in the file named by `DEEPSEEK_KEY_FILE` (default `/etc/mastan-me/deepseek-key`). DeepSeek chats run inside their own sandbox and never fall back to Claude.

## Quickstart

Requirements: Linux, Node.js 26.5 or newer, the Claude Code CLI, optionally the Codex CLI and bubblewrap.

The code is written for one reference layout: a service user `mastan`, code in `/opt/mastan-me`, data in `/var/lib/mastan-me`, secrets in `/etc/mastan-me` (see `deploy/mastan-me.service` and `deploy/deploy.sh`). Data and binary paths can be overridden with environment variables (`src/config.js`), but some are fixed in code: the child process `PATH` in `childEnv()` (`src/providers/common.js`) points at `/opt/mastan-me/bin`, so the agent's `mastan-me-*` tools are only found when the code lives there, and the sandbox's hidden paths in `src/providers/main-sandbox.js` assume `/etc/mastan-me`. The steps below follow that layout. They have not been tested outside it.

```sh
npm ci
npm test                       # unit tests, no network, no model calls

export MASTAN_ME_DATA=$PWD/data          # data dir: workspace, sqlite, logs
export MASTAN_ME_HOSTNAME=localhost      # public host name of the web UI
export MASTAN_ME_RP_ID=localhost         # passkey relying party id
export SESSION_SECRET=$(openssl rand -hex 32)
export AGENT_HOME=$HOME                  # HOME for the Claude CLI (holds its login)
export CLAUDE_BIN=$(command -v claude)
export CODEX_BIN=$(command -v codex)     # optional, coder role
export CODEX_HOME_FOR_CODER=$HOME/.codex
export TELEGRAM_BOT_TOKEN=...            # optional: your own bot from @BotFather
export OWNER_TELEGRAM_ID=...             # your numeric Telegram user id
export MASTAN_ME_MAIN_SANDBOX=off        # only if bubblewrap is not installed
bin/mastan-me-admin init-workspace       # create the workspace repo from workspace-template
npm start
```

The server listens on 127.0.0.1:3100. Put a TLS proxy in front for the web UI; `deploy/nginx-mastan-me.conf` is an example. Run `bin/mastan-me-admin` for operator commands; `mastan-me-admin enrol` prints a one-time passkey enrollment link.

Telegram stays off without `TELEGRAM_BOT_TOKEN` and `OWNER_TELEGRAM_ID`. Other optional parts (Topic Board, mail, Stripe, YouTube, WhatsApp, the fleet and GitHub gates) expect their own key files or services; read the matching file in `src/` before enabling one. Features can be switched off with `MASTAN_ME_TELEGRAM`, `MASTAN_ME_MAIL_ALERTS`, `MASTAN_ME_TASKS`, `MASTAN_ME_SCHEDULES`, `MASTAN_ME_BROWSER`, `MASTAN_ME_WARM` or `MASTAN_ME_BUSY_REPLY` set to `off`.

## Not included

- Keys, tokens, passwords, certificates and CLI logins.
- User data: the atlas, memory, chat history, databases, logs.
- Real server addresses, host names and deploy details. `deploy/` and `fleet-gate/` use placeholders.
- Client records and internal notes.
- Some defaults still point at the original setup. The passkey domain (`MASTAN_ME_RP_ID`) and host name (`MASTAN_ME_HOSTNAME`) can be overridden through the environment. The time zone is fixed in `src/config.js` (`tz`), and the Topic Board client only accepts the original board URL (`src/board/client.js`); change those in code.

## License

MIT, see `LICENSE`. Security reports: see `SECURITY.md`.
