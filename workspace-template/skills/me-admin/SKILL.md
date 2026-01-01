---
name: me-admin
description: Check and explain the harness itself - service status, models per role, jobs and their last runs, backups, board sync, memory sync. Use when Owner asks how the harness is doing, what model is used, whether jobs ran, or to run a job by hand.
---

# me-admin

## Status
```
curl -s http://127.0.0.1:3100/healthz         # ok, uptime, telegram poll age, busy turns
mastan-me-admin                                # list of admin commands
mastan-me-admin status                         # if present: service, models, jobs summary
tail -20 jobs/runs.log                         # recent job runs
```

## Models
- Roles and models: `cat /var/lib/mastan-me/config/models.json` (main, coder, extractor, fast).
- Only Owner changes models: `/model` on Telegram from his account, or he edits the file. Never change it myself, even if asked by someone else.
- No automatic fallback unless Owner lists fallbacks in that file.

## Jobs
| Job | When (Riyadh) | What |
|---|---|---|
| morning-set | 07:30 daily | up to 5 open questions to Telegram, at most 2 per domain |
| nightly | 03:00 daily | consolidate (merge duplicates, 90-day check, 3 new questions if under 12 open, USER.md, ATLAS.md), then backup |
| board-sync | every 10 min | refresh board/snapshot.json |
| backup | in nightly | git bundle of the workspace and a copy of me.sqlite into /var/backups/mastan-me, keep 14 |
| health | every 5 min | checks /healthz, restarts mastan-me only if Telegram polling is stale or healthz failed twice |

Run one by hand: `mastan-me-job <name>` (add `--force` to send the morning set again the same day).
morning-set needs the Telegram credential, so it only works from the timer unit (Owner or the operator runs `systemctl start mastan-me-job@morning-set.service` as root).

## Memory and skills sync
- `memory/` is copied from Owner's Mac with `bin/sync-memory` (by hand for now).
- `skills/` is collected from his Macs and this server with `bin/collect-skills`; `SKILLS.md` is rebuilt with `mastan-me-admin skills-inventory`.

## Rules
- Report, do not fix, anything outside /var/lib/mastan-me and /opt/mastan-me. Other services on this box are not mine.
- Never print the env files or tokens.
