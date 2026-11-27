---
name: schedules
description: Set reminders and recurring checks, with exact local times and durable delivery into this chat.
---

# Reminders and scheduled checks

Use a reminder to say something at a time: a payment, renewal, call or follow-up. It posts the stored text without a model call. Use a check to read a source again and tell Owner when something worth hearing changed. Checks run as fresh background agents, with this chat's user, browser profile and delivery destination. They cannot see the conversation.

## Before saying it is set

1. Collect the text and an absolute local date and time, or the repeat. Ask only about a date that is really unclear ("next Friday" late on a Thursday, a time that could be morning or evening).
2. List first, so you do not create a duplicate.
3. Write the reminder text the way Owner should read it when it fires, in Owner's language, with the context he will need then. A plain reminder posts this text as is, with no model or tools.
4. Run the tool in this turn and read the receipt. Say it is set only after an ok receipt with a future `next_run_local`. Then confirm the weekday, date and local time in one line. A note you wrote is not a reminder.
5. If the receipt is not ok, say plainly that the reminder is not set. To change a time, add the new one and delete the old one, then confirm both.

## Commands

Write reminder text or a complete check brief into a workspace file, then run:

```sh
mastan-me-schedule add --remind --title "Pay rent" --at "2026-11-01 09:00" --repeat "monthly 1 09:00" < reminder.txt
mastan-me-schedule add --remind --title "Call back" --in 90m
mastan-me-schedule add --check --title "Appointment openings" --repeat "every 3h" --at now < brief.txt
mastan-me-schedule list
mastan-me-schedule pause <id>
mastan-me-schedule resume <id>
mastan-me-schedule delete <id>
mastan-me-schedule run <id>
```

For a check, include exactly what to look at (URL, file or other source), which account and paths it needs, what to compare, and what counts as a change worth telling Owner. Give it every fact and permission it needs to run alone. Pick the slowest interval that serves the purpose, never below 30 minutes. The harness adds the previous result. If nothing worth hearing changed, the agent returns NO_CHANGE on the first line and a one-line summary on the second; no message is posted. A source that cannot be read must be reported plainly, not called unchanged. A check has 15 minutes to finish. Three failed runs in a row pause it and notify Owner.

Times are Riyadh by default. Confirm the exact local date and time from `next_run_local`, in Riyadh terms, after an ok receipt. `--at HH:MM` is the next occurrence; `--at now` works only for checks. `--in` accepts 90m, 2h or 1d. A repeat without `--at` starts at its next slot. Repeats: `every <N>m|<N>h|<N>d`, `daily HH:MM`, `days sun,mon,... HH:MM` (ranges such as `sun-thu` too), or `monthly <day> HH:MM`. A day past a month's end fires on the last day. Owner's workdays are Sunday to Thursday. Use `--until YYYY-MM-DD` (inclusive) and/or `--times N` to end a schedule. No repeat means one firing.

"Snooze an hour" means create a new one-off reminder with `--in 1h`, carrying the original title and text from the conversation or follow-up note. Pause or delete the original only when Owner asks to change future firings. `run` fires once now; it also works on a paused schedule. Telegram and web accept `/schedules` to list this chat's active and paused schedules; manage them through this tool.

Limits per user: 50 active schedules, including at most 10 checks. Reminder repeats are at least 15 minutes apart. Checks run at most 48 times per day; later firings are skipped with one notice that day. Quiet hours default to 23:00 to 07:00: reminders still have sound, check posts are silent. No backlog is replayed after downtime: one overdue firing goes out, then the next future slot. A reminder over 10 minutes late says when it was due.

Titles accept 120 characters with no newlines, reminder text 2,000, check briefs 20,000. Exit codes: 0 accepted, 1 failed, 3 unavailable here. List before trying again after a lost service response. Never retry an uncertain delivery. If schedules are disabled, say they are unavailable; do not substitute cron, timers or a sleeping process.
