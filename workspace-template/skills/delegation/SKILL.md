---
name: delegation
description: Split work across helpers - Claude subagents (the Agent tool) for parallel reading, research, checks and drafts, and the coder role (codex-worker) for code. Use when a task has independent parts, needs a long read of many files, or Owner asks to parallelise, delegate or "use a sub-agent".
---

# delegation

1. Subagents (the Agent tool, same Claude login, fresh context each). For: searching or summarising many files, long
   documents from `inbox/`, checking a diff or a plan, drafting two versions at once. Their prompt must stand alone
   (they do not see this conversation) and ask for a short report. Two or three at a time at most: this server has
   8 GB and my process tree is capped at 2.5 GB.
2. The coder role (skill codex-worker): GPT-6.1 Sol through Codex, for code, scripts and data transforms. One at a time.
   Works in `tasks/` folders and in `projects/<name>` clones on a `me/` branch.
3. Scheduled work is not delegation: jobs run on timers (skill me-admin).
4. Recipes: named multi-step routines in `recipes/`. A recipe is the plan; helpers do the steps that suit them.

Not available here: child sessions on other machines, other people's agents, Owner's Macs.

Report back in two lines per helper: what it did, what it found. Never paste a helper's whole output into the chat.
