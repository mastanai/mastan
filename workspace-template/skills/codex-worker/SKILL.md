---
name: codex-worker
description: Hand a coding task to the coder role (Codex CLI, GPT-6.1 Sol by default) and get back its summary, the diff and the log. Use for writing or changing code, scripts, small tools, data transforms or tests inside the workspace when the job is more than a few lines, or when Owner asks for the coder or for Sol.
---

# codex-worker

The coder runs in its own task folder inside the workspace and cannot touch anything else.
The model comes from `config/models.json` (role `coder`). Only Owner changes it.

## Steps
1. Make a task folder: `tasks/<YYYY-MM-DD>-<slug>/`. Copy any input files into it.
2. Write `tasks/<...>/PROMPT.md`:
   - Goal in one or two lines.
   - Files to read and files to make or change.
   - Constraints (language, no new dependencies, no network unless needed).
   - How to test, and what done looks like.
3. Run it in the background (it can take 5 to 30 minutes):
   ```
   nohup mastan-me-coder tasks/<...> tasks/<...>/PROMPT.md > tasks/<...>/RESULT.md 2>&1 &
   ```
   Short tasks can run in the foreground: `mastan-me-coder tasks/<...> tasks/<...>/PROMPT.md`.
4. Wait until `RESULT.md` ends with a `Log:` line, or starts with "Coder unavailable" (exit code 3, see Rules).
   It holds: the coder's summary, the diff stat, the diff, the log path.
5. Check the work yourself: read the diff, run the tests, try the output.
6. Tell Owner: what changed, the test result, the path. Show only the key lines of the diff.

## Project clones (`projects/<name>`)
The same tool works inside a mirrored repo: `mastan-me-coder projects/<name> <prompt-file>`. Differences:
- I must be on a `me/<slug>` branch first (`git checkout -b me/<slug> origin/main`); the tool refuses otherwise.
- Nothing is committed. The result shows the working-tree diff and new files; I run the tests, review, commit on the branch and `git push origin me/<slug>`.
- The log goes to `tasks/coder-logs/`, not into the repo.

## Rules
- The task folder must be inside the workspace (`tasks/...` or `projects/<name>`). Each task folder is its own small git repo.
- Never put secrets in the prompt or in the task folder.
- If `mastan-me-coder` exits with code 3 ("Coder unavailable: ..."), do the coding task yourself and tell Owner in one line
  that the Codex sandbox could not start (MORNING.md has the fix).
- If the result says the coder needs a login, tell Owner in one line and do the task yourself.
- One coder run at a time unless Owner asks for more (the server has 8 GB).
- Re-run with a sharper prompt rather than patching a bad diff by hand, when the diff is mostly wrong.
