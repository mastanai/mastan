# Web (me.example.com)

Track B. Code in `src/web/`, operator commands in `src/admin/auth.js`, tests in `test/web.test.js` and `test/web-admin.test.js`.

## Entry

`createWeb(ctx)` in `src/web/index.js` returns `async (req, res)`. `src/server.js` calls it for everything except `/healthz`.
Uses `ctx.config`, `ctx.db`, `ctx.atlas`, `ctx.brain`, `ctx.board`, `ctx.models`. A missing or failing `ctx.board` shows "Board unavailable"; a missing `ctx.brain` falls back to plain atlas writes.

## Routes

Public (no session):

| Method | Path | What |
|---|---|---|
| GET, HEAD | `/login` | Sign-in page. Handles `#enrol=` and `#operator=` (fragment dropped from history at once) |
| GET, HEAD | `/static/app.css`, `mastan.png`, `icon-64.png`, `icon-180.png`, `login.js`, `webauthn.js` | Login assets (`webauthn.js` = `@simplewebauthn/browser` 14.0.0 from node_modules). The three PNGs are the Mastan cat: header and login mark, tab icon, iPhone home-screen icon |
| POST | `/auth/login/options`, `/auth/login/verify` | Passkey sign-in |
| POST | `/auth/register/options`, `/auth/register/verify` | New passkey from an enrol link |
| POST | `/auth/operator` | Redeem an operator link |

Signed in (pages redirect to `/login` with 303, API returns 401 without a session):

| Method | Path | What |
|---|---|---|
| GET, HEAD | `/` | Atlas (3D force graph, 2D canvas fallback): views for tensions, new since the last visit, focus on one star; line colours per relation type; panel with Confirm, Reject with a reason, Focus, Ask (hands a draft to the chat), notes |
| GET, HEAD | `/chat` | Chat in threads (chip row, menu for rename, new session, archive and restore; `?t=<id>` opens one; typed `/new` = fresh session in the thread, `/thread <name>` = new thread, handled by the page) |
| GET, HEAD | `/questions`, `/board`, `/positions`, `/dump`, `/settings` | Pages |
| GET, HEAD | `/static/common.js`, `atlas.js`, `chat.js`, `questions.js`, `board.js`, `positions.js`, `dump.js`, `settings.js` | Page scripts |
| GET, HEAD | `/static/vendor/3d-force-graph-1.80.1.min.js` | Vendored from npm `3d-force-graph@1.80.1` (sha512 integrity checked at download, MIT licence next to it) |
| GET | `/api/stats`, `/api/graph`, `/api/node/:id` | Atlas stats, graph (nodes carry `added`, the date the file entered the repo), one position or person (with `notes`, people with `context`) |
| POST | `/api/positions/:id/note`, `/api/people/:id/note` `{text}` | Appends `{date, by: owner or operator, text}` to the file's `notes` (60 kept) |
| GET | `/api/questions` | Open questions grouped by domain, plus Later |
| POST | `/api/questions/:id/answer` `{text}` | Calls `brain.answer`, responds once the question is marked answered |
| GET | `/api/questions/:id/answer` | Poll: `filing`, `done` (summary, follow-ups) or `error` |
| POST | `/api/questions/:id/later` `skip` `reopen` | `setQuestionStatus` |
| GET | `/api/positions` | All active and unconfirmed positions |
| POST | `/api/positions/:id/confirm` `reject {reason?}` `edit {statement}` | confirm: `setPositionStatus` active. reject: `rejectPosition` (superseded, `rejected_at`, `rejected_reason`, body line; listed to the extractor as "do not create again"). edit: put |
| GET | `/api/chat/threads` | `{cap: 5, open, threads: [{id, title, created, updated, archived, running, queued, last}]}`, archived last |
| POST | `/api/chat/threads` `{title?}` | New thread (409 when five are open) |
| POST | `/api/chat/threads/:id/rename {title}` `archive` `unarchive` | archive refuses a running thread (409); unarchive respects the cap |
| GET | `/api/chat/history?thread=&before=` | One thread's messages (`thread` in the reply); without `thread`, the one used last (created when none) |
| GET | `/api/chat/stream` | Server-sent events for every thread of the identity; `hello {who, lives: {thread: live}}`, every event carries `thread`, `thread` events on create, rename, archive |
| POST | `/api/chat/send {text, files, thread?}` `stop {thread?}` `new {thread?}` | Agent chat id is `who#thread`, one Claude session per thread; sending to an archived thread is 409 |
| GET, POST | `/api/dumps` `{text}` | Recent dumps; save calls `brain.dump` without waiting for processing |
| GET | `/api/board` | Snapshot, every area; `available`, `read_only`, `synced_at` |
| POST | `/api/board/items` `/api/board/items/:id` `/api/board/items/:id/done` | add, update (note, next, lane, needs_you, title, area, priority), done |
| GET | `/api/settings` | Roles, choices, last job runs, atlas stats |
| POST | `/api/settings/models` `{roles: {name: model}}` | Only models listed in `choices` for the role's provider. Refused for operator sessions |
| POST | `/api/logout` | Ends this session |

Atlas writes from the web run `renderAtlasMd()` then `commit('web: ...')`. Answer and dump commits are the brain's. `Atlas.commit` takes `run/workspace.lock` first (cross-process: the service, `mastan-me-admin atlas-commit` inside agent turns, jobs), so parallel chat threads never race the workspace repo.
The atlas page remembers the last visit in `localStorage` (`mm-atlas-seen`, set when the page is left); stars added after it are drawn larger and listed under New. "Ask" on a star puts a draft in `sessionStorage` (`mm-chat-draft`) and opens `/chat`, where it lands in the box of the current thread.
Board: every area is shown and editable, Work included (Owner, 26 Oct; before that Work was filtered in the client, the API and the page). When the snapshot has `read_only` set, the page shows a banner and no write controls, and the API refuses writes with 403.

Typed `/schedules` lists the current thread's active and paused schedules (id, kind, title, local next run and repeat) without a model call. Management goes through the agent's `mastan-me-schedule` tool. Reminder and changed-check posts stay in their originating thread, carry a `schedule` id in history and a visible Schedule marker, and arrive through a `schedule` SSE event without replacing a running reply. Their one-time follow-up notes reach the next successful main turn. Simulated deliveries never become web posts.

## Auth design

- Topic Board pattern, `@simplewebauthn/server` 14.0.3. RP ID `config.rpId` (`mastan.ai`), expected origin `config.origin` (`https://me.example.com`). Discoverable credentials, user verification required, counter compare-and-set on every sign-in.
- Because the RP ID is the parent domain, the Topic Board passkey works here once its row is copied with `import-passkeys` (origin `board`).
- New passkeys use their own user id (`sha256('mastan-me-owner')`), so registering one never replaces the board passkey on the device. `excludeCredentials` lists only passkeys registered here, so an imported board passkey never blocks the enrol fallback.
- Session cookie `__Host-mastan_me`: 30 days, `HttpOnly; Secure; SameSite=Lax; Path=/`. Ceremony cookie `__Host-mastan_me_ceremony`: 5 minutes, `SameSite=Strict`, single use.
- Only sha256 hashes of session, enrol, operator and challenge secrets are stored (`sessions`, `enrollments`, `operator_links`, `challenges` in `me.sqlite`). `operator_links` is created by `src/web/auth.js`.
- CSRF: every POST needs `Origin` equal to `https://me.example.com` (or `http://127.0.0.1:<port>` on loopback), `Sec-Fetch-Site` same-origin when sent, `Content-Type: application/json`, and either `X-Mastan-Me: 1` (auth endpoints) or `X-CSRF-Token` equal to the per-session token (API). The token is in a `<meta>` of each signed-in page.
- Rate limit: 30 auth requests per 5 minutes per client IP (`X-Real-IP` trusted only from loopback), persisted in `limits`.
- Host header must be `config.host` or `127.0.0.1:<port>`, otherwise 403.
- Headers on every response: CSP `default-src 'none'; script-src 'self' 'nonce-...'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`, `X-Frame-Options DENY`, `X-Robots-Tag noindex`, `nosniff`, `no-referrer`, COOP and CORP same-origin, HSTS (1 year, no subdomains), `Cache-Control: no-store` (static assets with a matching `?v=` hash are immutable).
- No inline handlers or inline styles in markup. 3d-force-graph injects three small `<style>` tags that the CSP blocks; `app.css` restyles those classes. The browser console shows those blocks as CSP errors; they are harmless.
- Body limits: 16 KB, 64 KB for answers and dumps.
- Logs: only `[web] <method> <route kind> <status> <error class>` for 5xx, and failures of commit, board or brain by error class. Never URLs, ids, bodies, tokens or atlas text (tested).

## Operator commands

Run as root on the server (`mastan-me-admin` drops to user `mastan` with the service env):

```
mastan-me-admin import-passkeys <rows.json>   # [{id, public_key_b64, counter, transports, created}], idempotent
mastan-me-admin passkeys                      # handle, origin, created, transports
mastan-me-admin revoke <handle>               # passkey and its sessions
mastan-me-admin enrol                         # https://me.example.com/login#enrol=<token>, 10 minutes, single use
mastan-me-admin test-login                    # https://me.example.com/login#operator=<token>, 10 minutes, single use
mastan-me-admin sessions [--revoke-all]
```

`test-login` is for operator verification. Open the link in any browser: it signs in for 30 minutes, shows an "Operator session" banner, can read everything and make atlas and board changes, and cannot change models. Revoke with `sessions --revoke-all` when done.

## Tested

`node --test test/web.test.js test/web-admin.test.js` (27 tests, invented fixture atlas in `test/fixtures/atlas/`, temp data dir):

1. Host check; login page headers, nonce on every script, no inline handlers.
2. Unauthenticated: pages 303 to `/login`, API 401, private assets 401, public assets 200, HEAD works.
3. Auth endpoints: wrong or missing Origin, missing custom header, cross-site fetch, non-JSON, extra keys.
4. Enrol: options carry RP `mastan.ai` and UV required, verification gets origin `https://me.example.com`, cookie attributes, single use, expiry, exclude list.
5. Imported board passkey signs in (mocked verification checks origin, RP, UV, public key bytes, counter), counter stored, challenge single use, failures 401, revoke ends sessions.
6. Operator link: single use, 30 minute session, banner, models refused, expiry.
7. CSRF on API writes; every page renders with nav, stats chips and CSRF meta; empty atlas renders.
8. Graph (with `added`), node detail (notes, context), questions grouping and waiting days, Later, Skip, Reopen, answer flow with follow-ups, positions confirm, edit, reject with a reason (file fields, body line, `rejected()`), notes on positions and people (attribution, limits, operator), dumps, board (every area, lane mapping, writes, read-only, unavailable), settings save validation, body limit, logout, rate limit, logs.
10. `test/chat.test.js`: threads (General on first visit, create, cap of five, rename, per-thread history and agent sessions `who#thread`, archive refused while running, archived threads refuse messages, restore respects the cap, other identities get 404), migration of rows from before threads. `test/atlas-store.test.js`: reject reason in both extractor prompts, notes, first-seen dates, the commit lock with three processes committing at once.
9. CLI: import idempotent, enrol and test-login print links and store hashes, passkeys, revoke, sessions.

Also checked by hand in a WebKit browser pane against a local server with about 300 invented nodes: atlas 3D and 2D render, tap opens the panel, Confirm works, Question Panel answer flow shows follow-ups, board lane move, positions, dump, settings, phone width 375 px.

## Not verified

- A real passkey ceremony on a device (needs Owner's Face ID). The imported board row path is unit tested with mocked verification only.
- Frame rate on an actual iPhone with the real atlas.

## Files both ways

The chat picker accepts images and `.xlsx .xls .xlsm .csv .tsv .docx .doc .rtf .odt .ods .odp .pptx .ppt .txt .md .json .pdf .zip` (and the existing `.log`). MIME-only office uploads get an extension. Existing upload limits still apply: six files, 15 MB per file, 24 MB together. Office files appear as name and size chips without a preview. Telegram inbound downloads are unchanged.

`POST /internal/send-file` is a direct loopback route with no `X-Real-IP`, authenticated by `X-Chat-Token`. The operator `X-Internal-Token` cannot authorize it. It accepts `{path, caption?, name?}` and returns `{status, artifact, receipt?, error?, name, size}` after storage and delivery. Invalid paths and delivery refusals return failed with a reason. It uses the chat token's user and destination, never a destination in the body.

For web chats the copy attaches to the assistant message of the turn running in that thread, or to a new assistant message if idle. `web_messages.files` entries are `{name, mime, size, artifact}`. The `artifact` SSE event carries `{who, thread, message, running}` so it appears at once. `hello` and history include a running message's files; `done` also carries files. Reloads keep the same download chips and image previews.

`GET, HEAD /api/chat/out/<artifact id>` needs a session. Its identity must equal the artifact's user, including for operator sessions. Unknown ids, another user's artifact and missing files return 404; no session returns 401. Downloads use the stored MIME and byte length, `Content-Disposition: attachment` with an ASCII fallback and RFC 6266 `filename*`, `Cache-Control: private, no-store`, and `X-Content-Type-Options: nosniff`. `?inline=1` is allowed only for raster images and is used for previews; other files return 404.

Offline checks in `test/files.test.js` cover path and size policy, copies and hashes, chat-token authorization, injected Telegram multipart transport and receipt states, simulation capture, live web attachments, SSE/history, per-user downloads, picker types and send-tool exit codes. `test/chat-tokens.test.js` runs fake Claude children to check resident and one-shot credentials, clean job/extractor environments and isolation of two chats. No external service is called.

## Background tasks

The thread header shows small chips for this thread's running and queued background tasks, each with a Stop control. Thread views include `tasks: [{id, title, status, created, started, finished, minutes}]`. The `tasks` SSE event carries the current active list for one thread; reconnecting reloads history and the thread list.

Type `/tasks` in the composer to list this thread's tasks, including finished ones, with id, title, status and elapsed minutes. `/stop <id>` stops one background task; plain `/stop` stops the main turn. Commands bypass a busy main turn. `/new` and `/thread <name>` keep their existing behavior. `POST /api/chat/stop {thread?, task}` powers the chip control and checks the signed-in identity and thread before stopping.

A completed task adds an assistant message in its originating thread, with `task: <id>` in history and a visible task marker. The `task` SSE event carries `{who, thread, message}` and does not finish or replace a main reply currently streaming there. Background file sends create their own assistant messages with the same task marker, so they never attach to an unrelated running main turn. Failed and stopped results are posted too. The next main turn receives a durable completion note once, so follow-up edits can refer to the result.

`POST /internal/tasks` accepts `{action: "start", title, brief}`, `{action: "start", retry: <id>}`, `{action: "list"}` or `{action: "stop", id}`. It requires direct loopback, no `X-Real-IP`, and this chat's `X-Chat-Token`; the operator token cannot authorize it. The service derives user and destination from the token. Task children have send-only credentials for starting work: they can deliver files and inspect or stop tasks in their own chat, but cannot start or retry a task.

## Fleet (29 Oct)

`/fleet` is available only to a signed-in Owner passkey session. Anonymous and operator
sessions get 404 for the page and all Fleet API routes. The menu hides Fleet from
operators. Pending approvals appear first, showing server, exact command, reason,
age, Approve with passkey and Deny; server cards show client, reachability and health.
Recent requests show state, exit code and expandable output. `/fleet#r<id>` scrolls
to the request. The phone-first page uses the existing shell and refreshes every
10 seconds while visible. If the socket is absent it says the gate is not installed.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/fleet` | Servers, pending requests, newest 20 requests; missing gate gives `installed: false` |
| GET | `/api/fleet/challenge/:id` | Fresh gate-owned WebAuthn options for exactly that request |
| POST | `/api/fleet/approve/:id` | Browser `startAuthentication` assertion as the JSON body, relayed without interpretation |
| POST | `/api/fleet/deny/:id` | Empty JSON body; denies only pending work |

All POSTs use the existing Origin, fetch-site, JSON body and session CSRF checks.
The web service talks to `/run/mastan-fleet.sock` and never reads SSH keys or trusted
passkeys. Gate verification, counter compare-and-set and one-use challenge claims
are independent of web auth. Fleet deliberately verifies RP ID `me.example.com`;
existing login credentials use `mastan.ai` and need compatible provisioning before
real Face ID approval. See `fleet-gate/README.md`. Offline route tests cover access,
CSRF and a fake gate socket; no client server is contacted.
