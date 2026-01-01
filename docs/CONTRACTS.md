# Module contracts (for the parallel build tracks)

Plain Node 26 ESM (`"type": "module"`, `.js` files), no build step, few dependencies (`yaml`, `@simplewebauthn/server`, `@simplewebauthn/browser`). Node's built-ins only otherwise (`node:http`, `node:sqlite`, global `fetch`).

## Layout and owners

| Path | Owner | What |
|---|---|---|
| `src/config.js` | lead | `config` (paths, env), `loadModels()`, `saveModels()`, `role(name)`, `today()` |
| `src/db.js` | lead | `openDb()`, `kvGet/kvSet`, `jobStart/jobEnd/lastJobRuns` |
| `src/atlas/store.js` | lead | `atlas()` singleton, class `Atlas` (see below) |
| `src/providers/` | lead | `runRole(role, opts)`: claude-cli and codex-cli behind one interface |
| `src/brain/index.js` | lead | `brain.answer(questionId, text, channel)`, `brain.dump(text, channel)`; both async, apply changes to the atlas and commit |
| `src/agent/` | lead | main agent turns, sessions, background tasks |
| `src/channels/telegram.js`, `telegram-api.js` | lead | poller; `sendToOwner(text, {html})` for jobs |
| `src/server.js` | lead | http server on 127.0.0.1:3100, `/healthz`, mounts the web handler, starts Telegram |
| `src/web/**` | track B | `export function createWeb(ctx)` returns `async (req, res) => void`; everything except `/healthz` |
| `src/board/client.js` | track D | `createBoardClient(config)` |
| `src/jobs/*.js`, `bin/mastan-me-job` | track D | `node bin/mastan-me-job <name>` |
| `workspace-template/**` | track D | `SOUL.md`, `CLAUDE.md`, harness skills, copied into the workspace by `bin/mastan-me-admin init-workspace` |
| `deploy/*.service`, `deploy/*.timer` | lead (service) / D (job timers) | systemd units |
| `deploy/nginx-me.example.com.conf` | lead | vhost |

## ctx (passed to createWeb and jobs)

```js
ctx = {config, db, atlas, brain, board, agent, telegram, models: {load, save}}
```

- `ctx.atlas` (`src/atlas/store.js`):
  - `positions()`, `people()`, `questions(status?)`, `dumps()`; each item is the frontmatter plus `id`, `body`, `file`
  - `get(kind, id)`, `put(kind, doc)` where kind is `positions|people|questions`
  - `setPositionStatus(id, 'active'|'superseded'|'needs_confirmation', extra)` (active sets last_confirmed and confidence >= 0.8)
  - `setQuestionStatus(id, 'open'|'answered'|'skipped'|'later', answer?)`
  - `addDump(text, source)` returns `{id, file}`
  - `stats()` returns `{positions, needs_confirmation, people, connections, tensions, dumps, open_questions, last_updated}`
  - `graph()` returns `{nodes: [{id, kind, label, domain, confidence, status, relationship, role}], links: [{source, target, type}]}`
  - `tensions()`, `morningSet(limit)`, `renderAtlasMd()`, `commit(message)`
  - `DOMAINS` exported (10 domains)
- `ctx.brain.answer(questionId, text, channel)` returns a promise of `{summary, created: [ids], changed: [ids], followups: [ids]}`. It marks the question answered first, so the UI can return immediately and let the promise run.
- `ctx.brain.dump(text, channel)` returns a promise; files the dump immediately (`atlas.addDump`) and processes it in the background.
- `ctx.board`: see track D. Reads come from the cached snapshot in `workspace/board/`, writes go to the board API. Every area comes through, Work included (since 26 Oct).
- `ctx.models.load()` / `ctx.models.save(models, by)`: `config/models.json` in the data dir.

## Atlas file formats

See `BRIEF.md` (Architecture > Workspace) and the Track C prompt. Frontmatter is YAML between `---` lines. Ids: lowercase kebab, prefixes `p-` (position), `q-` (question), `person-` / `org-` / `project-` (people).

## Rules for every track

- Never print, log or commit secrets or atlas content. Logs say what happened, not what Owner wrote.
- Never touch existing services, vhosts or files on the server outside `/opt/mastan-me`, `/var/lib/mastan-me`, `/etc/mastan-me`, `/var/backups/mastan-me`, and the new unit and vhost files named `mastan-me*`.
- Deploy with `deploy/deploy.sh` only (rsync to `/opt/mastan-me`, `npm ci`, restart `mastan-me`).
- Text Owner reads: no em dashes, plain words, short lines.
