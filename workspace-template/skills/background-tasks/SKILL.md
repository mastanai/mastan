---
name: background-tasks
description: Run every file request and other long work in the background while Owner keeps talking in the chat.
---

# Background tasks

Any request whose result is a file (deck, document, spreadsheet, PDF, image, chart) always goes to `mastan-me-task start`, whatever its expected length. This includes a new version or a variant of a file already made. Other work over about 30 seconds belongs in a background task too: research across pages, multi-step browser work and coding. Answering, explaining and short lookups stay in the chat. Never start two tasks for the same request.

Write a complete brief into a workspace file, then run:

```sh
mastan-me-task start --title "Short title" < brief.txt
mastan-me-task list
mastan-me-task stop <id>
mastan-me-task start --retry <id>
```

The task cannot see this conversation. Include every fact, requirement, decision, file path, destination and permission it needs. The brief accepts up to 20,000 characters, the title up to 120. After a queued or running receipt, tell Owner in one line what is running and that he can keep talking. The service posts the result into this chat when finished and carries a completion note into your next turn, so you can handle follow-ups such as "change slide 3".

Each task is a fresh main-agent call in the workspace, with this chat's user, browser profile and delivery destination. At most two run per user; later tasks wait in order. Use mastan-me-send for files. Tasks cannot start other tasks. Their final reply is at most eight lines: what was done and what Owner should look at.

Exit codes: 0 accepted, 1 failed, 3 unavailable here. If the service response was lost, list tasks before trying again. If tasks are disabled, do the authorized work in this chat. Telegram and web accept /tasks and /stop <id>; plain /stop stops the main turn. After a service restart, interrupted tasks fail instead of resuming. On Owner's request, retry the id with its stored brief; do not retry automatically.
