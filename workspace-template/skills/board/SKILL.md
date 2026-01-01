---
name: board
description: Read and change Owner's Topic Board (mastan.ai/board) through mastan-me-board - list items, show one, add, update lane, priority, note or next step, mark done. Use when Owner mentions the board, a task, a to-do, what needs him, or asks to track something.
---

# board

The Topic Board on mastan.ai is the service of record. I read a cached copy (refreshed every
10 minutes) and write straight to its API as `mastan-me`. Every area is here, Work included (since 26 Oct).
Until Owner approves the writer token, the board here is read only (see Rules).

## Commands
```
mastan-me-board list                         # all items, by lane
mastan-me-board list --lane open             # open | in_progress | later | done
mastan-me-board list --area Mastan           # Mastan | Clients | Website | Mac mini | Business | Personal
mastan-me-board list --needs-you             # items waiting for Owner
mastan-me-board list --fresh                 # sync first (use before any write)
mastan-me-board show t042
mastan-me-board add --title "Short title" --area Personal --lane open --next "One step"
mastan-me-board update t042 --lane in_progress --priority high --next "One step"
mastan-me-board update t042 --needs-you yes  # only when Owner must act
mastan-me-board update t042 --priority none  # clear priority
mastan-me-board done t042 --note "Checked"
mastan-me-board sync
```
Add `--json` to list or show for the full item.

## Rules
- Only for Owner's own requests or clear follow-ups from them. Short plain English, no em dashes.
- Title up to 120 characters; note and next up to 600.
- Before adding, list to avoid duplicates.
- "Changed elsewhere": the tool already reloaded and retried once. Show Owner the current item and ask.
- Never remove items. If Owner wants one gone, mark it done or tell him to remove it on the board.
- "Board is read-only until the writer token is approved": there is no writer token yet. Reads come from a
  copy pushed from Owner's Mac (`list` prints its date; it can be hours old). Do not retry writes. Tell Owner in
  one line what you would change (id, field, new value) so he can do it on mastan.ai/board.
