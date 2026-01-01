---
name: atlas
description: Keep Owner's Worldview Atlas (atlas/) up to date - add or update a position, add a question, file a dump, confirm or reject a position, rebuild ATLAS.md and commit. Use whenever Owner states a belief, preference, rule or decision, corrects something about himself, answers a question, or sends raw thoughts to file.
---

# atlas

Markdown files with YAML frontmatter in `atlas/`. Ids are lowercase kebab case.
Domains (exact strings): Self & psychology | Work & building | Money & investing | Meaning & spirituality |
Family & parenting | Technology & AI | Science & cosmos | Health & body | Mastan & product | Decisions I delegate

## Position: `atlas/positions/p-<slug>.md`
```
---
id: p-walk-daily
domain: Health & body
statement: I want to walk 30 minutes every day.
confidence: 0.8
since: 2026-10-14
last_confirmed: 2026-10-26
status: active
sources:
  - file: telegram
    date: 2026-10-26
    quote: walk 30 minutes a day
links:
  - id: p-sleep-before-midnight
    type: supports
tags: [health]
---
Optional short body: why, context.
```
- `statement`: first person, one idea, plain words, as Owner would say it.
- `status`: `active` (Owner confirmed) | `needs_confirmation` (inferred) | `superseded` (replaced; add `superseded_by: <id>`).
- `confidence`: 0 to 1. Inferred: 0.6 or less. Owner said it to me directly: 0.8. Confirmed: 0.8 or more.
- `sources`: where it came from. `quote` is 15 words at most, his words. `file` is a path, or `telegram` or `web`.
- `links[].type`: `supports` | `depends` | `tension` | `about_person` (id of a people entry).
- "Decisions I delegate" statements start with GREEN (I act), YELLOW (I act and tell him) or RED (ask first).

## People, orgs, projects: `atlas/people/<person-|org-|project-><slug>.md`
Frontmatter: `id, kind (person|org|project), name, relationship (self|family|friend|colleague|manager|client|partner|vendor|other|owner|contributor), role, context, since, links [{id, type}], sources, notes`.
`links[].type` between people: `family | friend | colleague | works_at | works_on | client | reports_to | partner | vendor | related`. The web atlas draws each type in its own colour, so pick the specific one, not `related`.
Work colleagues: name, role and relationship only.

## Notes (positions and people)
`notes: [{date: YYYY-MM-DD, by: owner|agent, text}]`, newest last, 60 at most. Owner writes them from the web panel (`by: owner`); when you add one, `by: agent`. A note from Owner outranks the body: read the notes before you argue with a position.

## Question: `atlas/questions/q-<slug>.md`
Frontmatter: `id, domain, text, why, status (open|answered|skipped|later), asked_at (YYYY-MM-DD), answered_at, answer, positions [ids], source`.
Good questions are specific, quote Owner's own words, and push on a tension or a missing number or date.
Keep at most 12 open.

## Dump: `atlas/dumps/<YYYY-MM-DD>-<slug>.md`
Frontmatter: `id, date, created (ISO time), source (telegram|web), status (new|processed)`, body under `## Raw`.
File it exactly as Owner wrote it. Process it later into positions.

## Confirm or reject
- Owner confirms: `status: active`, `last_confirmed: <today>`, `confidence` at least 0.8.
- Owner rejects: `status: superseded`, `rejected_at: <today>`, `rejected_reason: <his words>` and a body line `<today> rejected by Owner: <reason>`; add the corrected position if he gave one. The web Reject button does the same. Rejected positions are listed to the extractor and the nightly job as "do not create again", so never recreate one in other words.
- Owner corrects: update `statement`, keep the old wording in the body, add the source.

## After any change
```
mastan-me-admin atlas-commit "atlas: <what changed>"
```
That rebuilds `atlas/ATLAS.md` (under about 4,000 tokens) and commits the workspace as mastan-me.

## Rules
- Never put secrets, phone numbers, emails, addresses or ids in the atlas.
- Nothing about Work-project access content.
- One idea per position. Search first (`grep -ril "<word>" atlas/positions`) and update rather than duplicate.
