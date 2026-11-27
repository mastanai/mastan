---
name: presentations
description: Create and revise editable PPTX decks for deck, slides, presentation, PowerPoint, pptx, təqdimat, slayd, презентация, sunum, and عرض تقديمي requests. Includes story, layout, data verification, Arabic RTL, rendering, and delivery checks. Use for any slide or deck request, including dashboards built from tables or CSV files.
---

# Presentations

Return an editable PPTX in the user's language. Use the supplied engine, not a new generator.
Read [design-guide.md](references/design-guide.md) for the full story and layout method;
read [README.md](README.md) for the JSON schema and runtime setup.
For an existing deck, preserve requested content and branding. Review-only requests authorize inspection,
not edits. Rebuild into this engine only if the user permits restructuring; otherwise edit the original.

`<skill dir>` below means this skill's base directory, shown when the skill loads (normally `skills/presentations`).
Work in `tasks/<job>/`, where `<job>` is the date and a short slug. `python3` below means
`/opt/mastan-me/runtime/py/bin/python3` (python-pptx is installed there); LibreOffice and `pdftoppm` are installed.

## Where this runs

- A deck is file work: it runs as a background task (skill `background-tasks`). If tasks are unavailable
  here (on WhatsApp), do it in this chat. Questions about presentations that need no file are answered
  in the chat.
- Ask any essential question in the chat before starting the task. Inside the task you cannot ask.
- In the task, combine JSON authoring, build and check in one run, then look at every PNG in one batch.
  No exploratory commands, no installs.
- Quick mode is the default for up to 12 slides: frame and story in your head, at most three web searches for key
  numbers (labelled as estimates), write the JSON, build and check in one run, look at the PNGs once, at most one
  rebuild, send. Aim for 2 to 3 minutes in total.
- Photos or pictures requested: use real photos of the actual subject on most content slides (type
  `photo`), not on two or three. Find them with web search, prefer Wikimedia Commons file pages or
  official sources, download the full image into `tasks/<job>/images/` and open each one to check it
  shows what the slide says before using it. Give each a short caption and a credit (author or archive
  and site). If a fitting photo cannot be found, use a chart, map or diagram instead and never a wrong
  picture.
- Full mode only when the person asks for depth (investor or board deck, "detailed", "professional", more than 12
  slides): the phases below in full, at most two rebuilds after the initial build, no extra review rounds.
- Inspect every revised slide image yourself. If quality is still not right, say so honestly in the final message.
- Keep the requested slide count. Never claim a slide was inspected if you did not look at its image.

## Phase 0 - Frame

1. Establish audience, one takeaway, the ask (or informative purpose), slide count and language.
2. Ask at most ONE concise question, only when an essential fact cannot be inferred. Otherwise use
   sensible defaults and state them briefly in the user's language: general audience, six slides for a
   pitch, update or short talk, 12 slides (cover, ten content slides, closing) for a deck about a topic
   (history, a subject, a report), concise explanation, neutral palette, Arial. Honor any
   supplied count, purpose or brand. A 12-slide topic deck still runs in quick mode.
3. Define acceptance checks for required topics, editable objects, source coverage and output format.
   Use only files the owner supplied or pointed to.

## Phase 1 - Story

1. Write the summary as SCQA: shared situation, complication, question, answer. Adapt it to the task;
   a lesson can end in understanding instead of an approval request. Do not invent a commercial ask.
2. Write supported action titles before body copy. Read titles alone: they must form a coherent story
   ending at the takeaway/ask. Use natural language, not slogans; the cover can name the subject.
3. Group supporting arguments with MECE: no duplicated ideas, no essential missing branch.
4. One message per slide. Choose layout from content: metrics, comparison, timeline, hero, native
   chart, table, quote, or concise text. Never default to bullets.
5. Reconcile source data before using it: identify row grain, units, dates, unique counts, totals,
   percentages, bucket boundaries, missing values and top-N coverage. Parts must sum to their total.
   Distinguish supplied facts, calculations, estimates and proposed actions. Do not invent sources.
   Normalize category labels (for example merchant or city names) only through a stated, documented
   mapping. Label truncated rankings as top-N.
6. Aggregate private datasets. Exclude names, contact details, IDs and row-level identifiers from
   slides AND speaker notes unless this user explicitly requires and is authorized to use them.
   Use demographic fields (such as nationality or gender) only when relevant to the stated purpose,
   and only aggregated.

## Phase 2 - Build

1. Write UTF-8 content JSON with an explicit `slides` array, including any cover and closing.
   No automatic extra slides. Use `language`: `az`, `ru`, `en`, `tr` or `ar`; set `direction: rtl`
   for Arabic (automatic for `ar`). All visible text, sources, notes and chart labels use that language,
   preserving proper names, quoted originals when requested, and source URLs.
2. Every slide needs a title and type. A `photo` slide takes `image` {`path`, `caption`, `credit`}
   plus `body` or up to four `bullets`; the picture fills the right half (left for Arabic), or the whole
   body when there is no text. Supply `sources` for every number and factual quote; include
   file/date/table location for user data and calculation method for derived values. Label sample or
   hypothetical data explicitly. Sources are visible and repeated in notes; sources do not prove claims.
3. Brand only from the user's current request or assets this user supplied in this conversation.
   Optional brand JSON has `name`, `logo_path`, `colors`, `fonts`. Default to neutral colors and
   Arial, with no visible brand name or logo unless requested. Never borrow a private organization's
   brand, icons, personal names, or assets. Keep logos proportional.
4. Run:
   ```sh
   /opt/mastan-me/runtime/py/bin/python3 <skill dir>/scripts/build_deck.py --content tasks/<job>/content.json --output tasks/<job>/<Deck_Name_YYYY-MM-DD>.pptx
   # Add --brand tasks/<job>/brand.json only for an explicitly requested brand.
   /opt/mastan-me/runtime/py/bin/python3 <skill dir>/scripts/check_deck.py tasks/<job>/<Deck_Name_YYYY-MM-DD>.pptx --outdir tasks/<job>/previews --expected-slides 6
   ```
5. Keep all core text, tables, charts and data editable. Use 16:9; Arial on every run and in theme
   defaults (including Arabic/complex-script fonts). A font override is only for an explicit user
   request; pass each chosen family with `--allow-font`. Calibri and Aptos remain prohibited.

## Phase 3 - Check

1. Run the checker: structural audit, isolated office conversion to PDF, then a PNG for every slide.
   It converts with LibreOffice headless and a throwaway profile under `/tmp`. Rendering failures are
   unverified, not a pass.
2. LOOK at EVERY PNG at a useful reading size. Check clipping, overlap, line breaks, chart labels,
   glyph coverage (ə ğ ı ö ş ü ç, Cyrillic, Arabic), RTL reading order, tables, logos, contrast,
   alignment and slide numbers. Automatic text-fit estimates cannot replace visual review.
3. Fix content before shrinking type. Rebuild and check affected outputs within the two-rebuild limit,
   then inspect all resulting slide images. Never install or swap in another renderer. If rendering
   is unavailable, say in plain words that the visual check is incomplete.
4. Red-team the final artifact: titles still tell the story; every number matches its source; no
   unsupported conclusion or falsely mandatory rule; the hardest audience questions are answered
   or clearly flagged. Check requested slide count, language, editability and privacy separately.

## Hard rules

- The user's language throughout, including final caption. No forced English labels or subtitles.
- No em dashes in slides, chart labels, notes or brand text. No copyright/rights footers.
- Page numbers bottom-right on every slide, including Arabic; sources occupy a separate footer area.
- At most six bullets per slide, roughly six words each. Split instead of clipping or dropping text.
- One takeaway per slide; clear hierarchy, consistent spacing, restrained colors, source every number.
- Match chart to evidence. Bars include zero, negative values remain visible, no 3D; label data.
- Never present an automated report, successful save or send receipt as proof of visual quality.

## Phase 4 - Deliver

1. Verify the actual final PPTX, filename and acceptance checks. Use a descriptive filename with date
   when no naming convention is supplied. Deliver only the requested file, not scratch JSON or PNGs.
2. Send it with `mastan-me-send tasks/<job>/<Deck_Name_YYYY-MM-DD>.pptx --caption "<short caption>"`.
   One file, one send. Never send a bare filename or a path as text, and never send a second copy.
3. One short caption in the user's language. Keep scripts, paths, internal checks and attribution out of
   replies and deck content. If rendering was blocked, say in plain language that the visual check is
   incomplete; do not claim it was checked.
4. Claim delivery only after the receipt says `sent`. If it says `uncertain`, do not resend. If it
   says `failed`, say so once and offer a fallback. Content, visual review and delivery are separate gates.
5. End with one short line in the user's language offering a useful bigger version.
