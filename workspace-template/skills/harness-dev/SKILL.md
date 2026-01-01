---
name: harness-dev
description: Change Mastan Me itself (this harness - Telegram and web chat, the web design, atlas, board, jobs, skills, SOUL) in projects/mastan-me - read its docs, change code or CSS, run the node tests, commit on a me/ branch and hand Owner the branch to deploy. Use when Owner asks to change how the harness looks, behaves, answers or is organised.
---

# harness-dev

I am the running copy of `/opt/mastan-me` (root-owned, deployed from Owner's Mac). The source is mirrored at
`projects/mastan-me` (Owner pushes `main` with `bin/sync-project mastan-me`; he fetches my `me/*` branches with
`--fetch`, reviews, merges and runs `sh deploy/deploy.sh`). I cannot deploy or restart myself; a change is live only
after his deploy.

## Map
- `README.md`, `docs/CONTRACTS.md` (what each module promises), `docs/WEB.md` (routes and pages), `docs/WORKSPACE.md`
  (skills, memory, board, jobs), `docs/DECISIONS.md` (why things are the way they are), `MORNING.md` (the log for Owner).
- `src/server.js` start-up and health; `src/agent/runner.js` a turn, the system prompt (SOUL + channel note);
  `src/providers/claude-cli.js` resident Claude processes, `codex-cli.js` the coder, `common.js` child env and MCP configs;
  `src/channels/telegram.js`, `web-chat.js`, `tool-line.js` (status lines); `src/web/` passkey auth, `api.js`, `pages.js`
  (HTML shells) and `public/*.css`, `public/*.js` (the design and the pages: chat, atlas, board, settings);
  `src/board/`, `src/atlas/`, `src/brain/`, `src/jobs/`; `workspace-template/` (SOUL.md, CLAUDE.md, skills, recipes: what I run on).
- Tests: `test/*.test.js`, node's own runner, temp dirs only, never the live data.

## Workflow
1. `cd projects/mastan-me && git fetch origin && git checkout -b me/<slug> origin/main`.
2. First time only: `npm ci --omit=dev` (three dependencies).
3. Change. Design changes live in `src/web/public/*.css` and `pages.js`; keep the phone layout (375 px) working.
4. `node --test test/*.test.js` (about 60 tests, 5 s). Add a test when the change is behaviour.
5. Commit small, as mastan-me, no secrets, no data. `git push origin me/<slug>`.
6. Tell Owner: branch, commit, tests, what to look at. The coder may do steps 3 and 4 (`mastan-me-coder projects/mastan-me <prompt-file>`).

## Rules
- Never edit `/opt/mastan-me`, `/var/lib/mastan-me/run`, `config/models.json` or the live workspace copies of SOUL.md,
  CLAUDE.md and skills: those come from `workspace-template/` in the repo and reach the workspace at deploy.
- Secrets stay out of code and logs. Data (atlas, memory, sqlite) never goes into the repo.
- No preview of the web design here: the pages need a passkey login. Tests plus Owner's Mac are the check.
- If a change touches what I may do on my own (SOUL.md), say so to Owner explicitly; he decides.
