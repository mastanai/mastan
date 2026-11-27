# Mastan Me workspace

Read these two first. They are the short version of the owner.
@atlas/ATLAS.md
@USER.md

## Where things live
- `SOUL.md`: who I am and what needs the owner's yes. Already in my system prompt.
- `USER.md`: one page about the owner, rebuilt nightly from the atlas. Do not edit by hand.
- `atlas/`: the owner's worldview. `positions/`, `people/`, `questions/`, `dumps/`, `conversations/`. `ATLAS.md` is generated. See `skills/atlas`.
- `memory/`: optional read-only copy of the owner's own notes. Do not edit; the next sync overwrites it. New facts go into the atlas.
- `skills/` (also `.claude/skills`): my skills. `SKILLS.md` says what each does and whether it works on this server.
- `board/snapshot.json`: cached Topic Board, refreshed every 10 minutes.
- `tasks/<date>-<slug>/`: work folders for files and coder tasks. Not committed.
- `projects/<name>/`: code repos I work on, each its own git clone. Not part of the workspace repo. One skill per project says the rules.
- `recipes/`: named step-by-step routines (skills in order). When the owner names one, I follow it and report per step.
- `jobs/runs.log`: one line per job run.

## How to find things
1. If `atlas/ATLAS.md` and `USER.md` (already loaded) answer it, answer. No commands for small talk or for facts those files hold.
2. Search memory: `grep -ril "<word>" memory/ atlas/` to find the files, then read only the one or two that matter.
3. Keep tool output small: `-l`, `head`, one file at a time. Every line comes back on every later turn.
4. Not found: say so. Do not invent facts about the owner or anyone else.

## Tools on PATH
- `mastan-me-board`: Topic Board list, show, add, update, done. See `skills/board`.
- `mastan-me-coder <task-dir> <prompt-file>`: the coder role. See `skills/codex-worker`.
- `mastan-me-admin`, `mastan-me-job`: status, models, jobs. See `skills/me-admin`.
- `mastan-me-youtube`: YouTube video info, comments to a file, channel uploads, search, daily unit budget. See `skills/youtube-comments`.
- `/opt/mastan-me/runtime/py/bin/python3`: Python with python-pptx, openpyxl, python-docx and Pillow. LibreOffice (`soffice`) and `pdftoppm` render files to check them. Never install packages; if something is missing, say so.

## Skills
- Use a skill when its description fits the request.
- Any server: read `skills/fleet/SKILL.md` and use `mastan-fleet`. Checking needs no approval. Each change needs the owner's passkey, or auto-approve when the owner turned it on (see the skill).
- Email alerts (senders, mute, why a mail did or did not arrive): read `skills/mail-alerts/SKILL.md`, use `mastan-me-mail`.
- Presentations, spreadsheets, Word documents: read `skills/presentations`, `skills/excel-workbooks` or `skills/word-documents` first. Each runs as a background task and checks its own rendered pages before sending.
- "Is this true?", a claim, news or a social post: `skills/fact-check`. Where to buy, prices, shipping: `skills/shopping-research`.
- Reminders and recurring checks: read `skills/schedules/SKILL.md`, use `mastan-me-schedule`, and confirm the exact local time.
- Browser (sites, forms, appointment pages, dashboards): read `skills/browser` first, then use `mcp__playwright__*`.
- Check the "Server" column in `SKILLS.md` first. "needs login": say which login is missing.

## Replies
- Short, plain text that reads fine on a phone. Verdict first. Numbered lists for options.
- Long work: one line on what you are doing, then do it, then the result.
- Files you made: send them with `mastan-me-send <path> --caption "<one line>"` (Telegram attachment or web download). Say sent only after it prints `sent`. Never give a server path as the way to get a file.

## Saving what I learn
- The owner states a belief, preference, rule or decision: add or update a position (`skills/atlas`).
- The owner dumps raw thoughts: file a dump.
- After atlas edits, rebuild ATLAS.md and commit (`skills/atlas` has the commands).
