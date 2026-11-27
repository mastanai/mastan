---
name: excel-workbooks
description: Build, fix or redesign Excel workbooks. KPI trackers and dashboards (sales, stock, orders, staff, service, collections), registers built from a written policy (eligibility, payouts, approvals, audit trail, boundary tests), and formula-driven reports. Recalculates and renders before sending. Use for any spreadsheet or .xlsx request.
---

# Excel workbooks

File work: run it as a background task (skill `background-tasks`). If tasks are unavailable here (on WhatsApp), do it in this chat. Work in `tasks/<job>/`, where `<job>` is the date and a short slug, for example `2026-12-01-budget`. `python3` below means `/opt/mastan-me/runtime/py/bin/python3`; it has python-pptx, openpyxl, python-docx and Pillow. LibreOffice (`soffice`) and `pdftoppm` are installed. Never install packages or swap tools.
Build with `openpyxl`.
`<skill dir>` below means this skill's base directory, shown when the skill loads.

## Inspect first (every workbook)

1. Read every supplied sheet directly. Classify the source: operational records, a schema or report catalogue, a
   policy document, or a mix. List the identifiers, dates, entities, targets, measures, formulas, named ranges,
   tables and charts. Done when every requested KPI or rule maps to a source field or is marked unavailable.
2. For a redesign, write down exactly which sheet or range may change. A reference image is visual direction only,
   never a source of numbers. Nothing outside that boundary changes unless the user allows it.
3. Be honest about data. Real rows: keep them and calculate from them. Only a schema: keep the original and build
   clean input tables. If the user expects a filled dashboard, use clearly labelled sample data and say it must be
   replaced with real records. No generated value may pass for real performance.

## Branch A: KPI trackers and dashboards

4. One input table per grain, for example products, stores, staff, staff-day results, orders, tickets, stock
   movements. For a collections tracker: cases, payment promises, calls, stage changes. Use stable IDs and check that
   related tables agree.
5. A settings sheet holds the period, as-of date, targets, weights and thresholds. Inputs look different from
   calculated cells. Every formula reads from settings, so one change updates everything.
6. Define each metric before any visual. Examples: sales against target, conversion, average order value, days of
   stock, on-time delivery, first-response time, service level, revenue per hour. Collections example: collected
   against target, contact rate, promises kept by amount, stuck cases and stuck balance. Guard every ratio against a
   zero denominator. Keep amounts, counts and rates separate. One definition in every view.
7. Make exceptions explicit: overdue, due today, stuck (active and past its stage threshold), below reorder point.
   Give each a priority score and rank actionable exceptions above completed or closed ones.
8. Build linked detail reports before dashboards. A composite score normalizes each metric against its target,
   uses documented weights, treats penalty metrics in the right direction, and shows a status and a next action.
9. Dashboards show the period, KPI cards, target comparisons, trend or stage charts, top and bottom performers and
   the top exceptions. For a reference-image redesign, copy its visual grammar (header, card hierarchy, chart rhythm,
   palette, spacing) using only metrics the workbook supports. Feed charts from formula-linked helper ranges, never
   typed numbers. If helper columns are hidden, set the charts to plot hidden cells and confirm they still render.
   Every card and chart traces to a visible detail table or helper range.

## Branch B: a register from a written policy

10. Extract the policy text from the supplied document: tables, headings, footnotes, version and approval clauses.
    Build a rule inventory: eligibility, calculation, exclusions, settlement, recovery, record keeping.
11. Turn it into an implementation matrix: source clause, inputs, formula or decision, output, evidence field.
    Settle ranges, boundary operators (at least versus more than), precedence, mutually exclusive schemes, rounding
    and carry-forward before building.
12. Sheets: instructions, policy settings, transaction evidence, person-period performance and eligibility,
    management summary, boundary tests. Validation lists, frozen headers, inputs clearly marked.
13. Qualification before payout. Exclude unapproved, cancelled, reversed, duplicate or invalid records as the policy
    says. Each excluded record shows a visible reason and cannot reach the payout base.
14. Each eligibility gate is its own visible result. Combine them into one status with a readable reason. Then rate,
    gross amount, adjustments, prior recovery, payable amount, remaining recovery and payout readiness. An ineligible
    record always earns zero. Nobody types an entitlement by hand.
15. If the data can arrive as individual transactions or as a certified period total, support both: the certified
    total needs a reference, takes documented precedence only when filled, and is never counted twice.
16. Approval fields by role (review, finance check, final approval), payout status, date and reference. "Ready for
    payout" only after every gate and approval passes. Never invent names for approvers.
17. A boundary-test sheet covers every percentage and tranche boundary plus ineligible, excluded, duplicate,
    reversal, prior-recovery and missing-approval cases. Compute the expected results independently. Workbook outputs
    must match exactly.

## Layout (both branches)

- Right to left only when the workbook language is Arabic (sheet view right to left, right-aligned text). Every
  other language stays left to right.
- Inputs in a distinct fill colour. Readable number formats with units. Frozen header rows and filters.
- A short "How to use" sheet in the user's language.
- Set `wb.calculation.fullCalcOnLoad = True` so spreadsheet apps recalculate on open.
- Clear file name with a date when none is given.

## Recalculate and render (required)

```sh
/opt/mastan-me/runtime/py/bin/python3 <skill dir>/scripts/recalc_check.py tasks/<job>/<file>.xlsx --outdir tasks/<job>/check
```

It recalculates a copy in LibreOffice with a throwaway profile, lists formula errors (#REF!, #DIV/0!, #VALUE!,
#NAME?, #N/A and others), formulas left without a value and external links, then renders the sheets to PDF and
PNG pages. Exit 0: formulas clean and rendered. Exit 1: problems to fix. Exit 2: unverified.

- Fix every error, then run it again.
- Recompute representative totals, statuses, flags and rankings yourself in Python from the input rows and compare.
- For a redesign, confirm cells, formulas, sheet order and tables outside the boundary are unchanged.
- Look at every page image: direction, clipping, chart titles and legends, charts fed by hidden helpers,
  conditional formatting, readability.
- The check also writes `<name>.recalc.xlsx`, a copy with stored values. Phone previews show only stored values,
  so send that copy when its pages look right (charts, colours and direction intact). Otherwise send the original
  and tell the user to open it in a spreadsheet app.
- If recalculation or rendering is unavailable, say the check is incomplete. Never call the file checked.

## Deliver

Send with `mastan-me-send tasks/<job>/<file>.xlsx --caption "<one line in the user's language>"`. Claim delivery
only after the receipt says `sent`. In the final message, say in plain words where to enter data, what calculates
by itself, and who approves what.
