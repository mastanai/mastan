# me.example.com design system

One workspace for one owner. It should feel like good terminal software: dense, calm, every number readable, every action obvious. Not a neon gimmick, no glow, no matrix rain, no fake code, no CRT filter.

## Principles

1. Numbers and actions first. Decoration only if it carries information.
2. Same shell everywhere. The header never moves, on any route, at any width. A page cannot restyle or reposition it.
3. Same parts everywhere. One table, one card, one button set, one input, one chip, one tab/segment control, one empty state, one error state, one loading state. A new page uses these parts and adds no new visual language.
4. Long sessions. No pure white, no pure black, no saturated fills behind text. Colour means state, not branding.
5. Fast. No font files, no images except the cat, no blur. Shadows are only the 2px inset accent edge on hovered actions and a single flat shadow for floating layers.

## Tokens (the only colours allowed outside charts and atlas domain colours)

```
--bg:      #0c0f0e   page
--bg-1:    #111514   panel, card, header
--bg-2:    #171c1a   raised row, hover, input fill
--line:    #252c29   hairline
--line-2:  #36403b   strong hairline, hover border
--ink:     #d2d9d4   body text (about 12:1 on --bg)
--ink-2:   #98a39c   secondary text (at least 6:1)
--ink-3:   #86928a   labels, timestamps (at least 5.3:1 on --bg-2, never for sentences)
--accent:  #8fc7a8   soft phosphor sage: focus, current page, primary action, links
--accent-dim: #1a2a23 fill behind accent
--ok:      #8fc7a8
--warn:    #d9b26a   amber: needs Owner, due, pending
--warn-dim:#2a2317
--bad:     #dd7f70   failed, overdue, destructive
--bad-dim: #2c1a17
--info:    #86aecb   neutral state: running, cold
--info-dim:#17222a
--s0 ... --s7, --sx  chart series: #86aecb #d9b26a #8fc7a8 #b896c0 #d08a72 #a3b56e #9a9ad0 #6fb3b3, other #6b756f
```

## Light mode

Dark remains the default. Only `html[data-theme="light"]` selects light mode; no system colour preference is followed. The public synchronous `theme-boot.js` runs in the head before stylesheets on every page, including login, 404 and chat. It reads only `mm-theme` in localStorage; missing or invalid values mean dark. All storage access is guarded with try/catch. It sets `data-theme` and the theme-color meta value before first paint. Dark token values and existing dark surfaces stay unchanged.

Light tokens live in the same workspace-tokens layer, on the root, topbar and operator banner, with `color-scheme: light`:

```
--bg: #eef0ec; --bg-1: #f6f7f4; --bg-2: #e4e7e1;
--line: #d3d8d1; --line-2: #b6bfb6;
--ink: #1d2823; --ink-2: #47544c; --ink-3: #56635b;
--accent: #1f6a48; --accent-dim: #d9e9df; --ok: #1f6a48;
--warn: #7d5610; --warn-dim: #f1e6cd;
--bad: #a93a2a; --bad-dim: #f5ded9;
--info: #24597d; --info-dim: #dbe7ef;
--s0: #2f6c96; --s1: #96690f; --s2: #2a7a55; --s3: #80568d;
--s4: #a9553a; --s5: #657a24; --s6: #5757a3; --s7: #24807f; --sx: #657068;
--shadow: 0 8px 24px #1d282326;
```

The other-series token is darker than the initial proposal to keep chart marks at least 3:1 after their existing .78 fill opacity. Text must reach 4.5:1 on every surface where it appears, including ink-3 on bg-2, state text on dim fills, syntax tokens, own-bubble metadata and primary buttons at rest and on hover. Keep paper-like fills, no pure white or black painted surfaces, flat controls and unchanged cat images.

One `.shell-theme` button appears after stats inside the shared header sheet for owners and operators. Its text names the destination (`light` or `dark`) and its accessible label is `Switch to light mode` or `Switch to dark mode`. It uses mono header styling and a 44px phone target. All sheet links and buttons participate in focus handling. The server renders the dark default; shell.js corrects it on load, persists changes, updates the meta colour and dispatches `mastan-theme` for chat and domain swatches. Storage events apply changes across tabs, including clearing the preference. Only Atlas reloads after a theme change because it caches computed colours and canvas state. Every other page updates in place.

The chat skin overrides the shared client's root tokens at equal or higher specificity for light. The client's own theme controls remain hidden and its initial setTheme preserves the boot preference. Shared chat app.css stays unchanged. Bubbles, code, syntax, avatars, approvals, menus, emoji, toasts, sheets and lightbox use the same workspace tokens. Domain colours have a separate darker light palette in common.js; non-Atlas swatches use live custom properties. Atlas keeps its exact dark node/link palette and selects stronger links and domain colours in light. Fleet, Stats and Clients use chart tokens, with token-coloured labels.

`theme-color` is paper in light and returns to each page's original value in dark. The Apple mobile status bar meta stays `black-translucent`; its appearance in light on installed iOS pages remains an OS-level limitation to check on a device.

Use `SHELL_THEME=light node test/shell-check.mjs` against the orchestrator's preview for the light screenshot pass; filenames gain `-light`, while the default pass remains dark.

Radius: 3px on controls and cards, 8px on chat bubbles, circle only for the cat and status dots. Spacing scale: 4, 8, 12, 16, 24, 32.

## Type

- Sans for sentences (questions, chat prose, notes): `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif`, 15px/1.5.
- Mono for data, labels, nav, headings, buttons, tables, timestamps, code: `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace`, with `font-variant-numeric: tabular-nums`.
- Labels: mono 11px, uppercase, letter-spacing .06em, `--ink-3`.
- Page title: mono 16px weight 600, not a big display heading. KPI value: mono 24px weight 500 (20px on phone).
- Section headings: label style, mono 11px weight 400, uppercase, `--ink-3`. Tile sublabels: mono 12px/1.5, `--ink-2`, sentence case on every page.
- Phone inputs stay 16px so iOS does not zoom.

## Shell

- Signed-in pages start with a visible-on-focus skip link to `#main`; existing navigation anchors and brand markup stay intact.
- `.topbar`: fixed height `--shell-h` 44px plus the top safe area, `--bg-1`, bottom hairline. Same markup from one function in `pages.js` on every signed-in route including `/chat`.
- Left to right: cat (22px) + `mastan` in mono, then the nav as plain window names: `chat atlas questions ...` (no numbers, Owner 2026-11-13), current window in `--accent` with `--accent-dim` fill. Right side: stat chips as `questions 10  tensions 18 ...`, then clock in Riyadh time (`HH:MM`). The questions count links to `/questions`; on phones it reads `10 questions`. The phone brand has a padded 44px by 44px target.
- Desktop keys: Alt+1..9, Alt+0, Alt+- jump to windows (use `event.code`, because Option+digit types a character on a Mac). Never steal plain keys: the chat needs them.
- Phone and narrow screens (under 900px): cat, current window name, open-questions count, and a menu button at the right. The same `<nav>` element becomes a bottom sheet listing all windows, stat chips under it, instant open and close, Escape and scrim close it, focus moves in and back. Tap targets 44px.
- `.scanline`: a 1px high, 72px wide segment on the header's bottom edge. It slides back and forth with scroll: position is a triangle wave of cumulative scroll distance (any scroller on the page, including the chat timeline, via a passive capture listener). Opacity is 0 at rest and .9 while scrolling. About 400ms after the last scroll event, it fades to 0 over 200ms. Transform and opacity only, one rAF per frame at most, reads only `event.target.scrollTop`. Reduced motion: it is not drawn and scroll updates are skipped. This is the one signature animation; do not add others beyond state feedback.
- Between pages: no transition. `@view-transition` threw an uncaught error on most link clicks in Chromium and the fade did not run.
- Operator sessions keep their banner directly under the header, in the same style as other warnings.
- Owner-only routes stay out of the nav for operator sessions, on every page including `/chat`.

## Parts

- Page head: `.page-head` has a 44px minimum height, with the mono title and actions vertically centred. All desktop heads start 24px below the shell, including Atlas, so titles share a baseline with or without actions. All pages fill to 1600px including gutters, left-aligned, with a 16px phone gutter and 24px desktop gutter. Under 900px the header carries the page name, so the real h1 is visually hidden and remains available to screen readers. An empty head takes no space; a small status note uses 24px plus an 8px bottom gap. Remaining actions stay right aligned and vertically centred. The header's open-questions link has a 44px target.
- Card lists: at 1280px and wider, Questions, Board, Positions and recent Dumps use `grid-template-columns: repeat(2, minmax(0, 1fr))`, top aligned in left-to-right source order. Domain and section labels span both columns. Settings cards use the same grid. Dump's input remains one prominent full-width card.
- Card: `--bg-1`, 1px `--line`, radius 3px, padding 12 to 16px, no shadow. A label strip at the top where the card has a title.
- Table: one style. Mono 13px, label-style header, right-aligned numbers, hairline rows, sticky first column when scrolling sideways. Clients and Settings tables sit inside one card, with no nested border and no bottom border on the last row. Rows containing an open action share the hover signature. On phones wide tables become cards where they already do; otherwise they scroll inside their own box. The page itself never scrolls sideways.
- Hover: one instant signature for nav links, neutral buttons, segments, actionable chips, KPI buttons, clickable rows, and table rows with an open action: `background: var(--bg-2); box-shadow: inset 2px 0 0 var(--accent)`. This is the same 2px edge as the current chat session. Text links underline. No hover transitions.
- Buttons: mono 13px, radius 3px, height 32px desktop and 44px on phones. Default: outlined `--line-2` on `--bg-1`. Primary: `--accent` text and border over `--accent-dim`. Danger: `--bad` text and border over `--bad-dim`. Primary and danger invert to their state colour with `--bg` text on hover, without an inset edge. Positions Confirm is primary; Reject stays neutral until its danger hover. Press returns the fill one step. Focus uses a 2px `--accent` outline inside scrolling boxes. Gradients are only used for overflow fades.
- Inputs and selects: `--bg-2`, 1px `--line`, focus border `--accent`, mono for filters, sans for prose text areas.
- Chips and badges: mono 11 to 12px, radius 3px, outlined, coloured by state tokens only.
- Segment control: one component for `.fu-seg`, lanes on the board, and Clients tag filters. Filter rows order segments, search, then selects, at 40px on desktop and 44px on phones. Desktop Board groups share one top edge and height; areas scroll within their group. Clients uses segments and right-aligned Clear filters on row one, then scrolling tags, search and selects on row two. Phone searches occupy their own full-width row. Range and filter rails scroll with a visible scrollbar and a fade at each overflowing edge; the fade clears at the end of the rail. Secondary Clients filters collapse behind Filters on phones.
- Dates: `5 Nov 2026`, or `5 Nov 14:20` with time, always Riyadh time. Native date input values and server payloads stay unchanged.
- KPI tile: label on top, value under it, one line of context. Left aligned. Clients phone KPIs form one horizontal strip of 72px tiles, with overflow fades.
- Questions: the answer textarea is about 40px high while empty and unfocused. CSS `:focus` and `:not(:placeholder-shown)` expand it to 96px. The longest-waiting open question has a `--warn` left edge when waiting days are positive; source order stays unchanged.
- People on phones: name and number, country/language/plan, then last date and counts. Server and first-seen date remain in each row's More disclosure.
- Fleet pending approvals: command, reason and timing on the left, approval and denial buttons on the right on desktop; stack on phones.
- Atlas: People has a separate counted legend row below the scrolling domain list. Related and about-a-person lines are quiet but visible. Reduced motion settles the simulation before the first displayed frame, fits the camera once, and disables automatic camera rotation, damping and further simulation ticks. The 2D fallback redraws on demand under reduced motion.
- Public pages: login and 404 use the header cat's circular crop at 80px, with no tint or filter.
- States: loading is a mono `loading...` line (no spinner). Empty is a mono line with what to do next. Error is a `--bad` line with the action to retry. Same parts on every page.
- Floating layers (toast, menu, dialog, sheet): `--bg-1`, 1px `--line-2`, flat shadow `0 8px 24px #0008`. No backdrop blur. Chat floating layers enter over 80ms using transform and opacity only; off under reduced motion.

## Chat

Keeps the Telegram Web and WhatsApp Web feel and all behaviour: bubbles, session list with pane on desktop, list-to-chat slide on phone, click anywhere or type to reach the box, streaming, attachments, emoji, approvals. Voice stays off until the server supports speech transcription. Skin changes live in `src/web/chatclient/me-skin.css`, loaded after `chatclient/app.css`, so the client code stays mergeable with my.example.com. Uses the workspace theme, with dark as the default.

- Timeline background `--bg`, no wallpaper pattern. Own bubble `#1a2a23` (accent-dim) with `--ink`. Mastan bubble `--bg-1` with a `--line` border. Radius 8px, tails off or very small.
- Prose in sans 15px. Timestamps, session times, tool status lines, day dividers, code, approval commands in mono.
- Session list: compact rows, current row `--bg-2` with a 2px accent left edge. Unread badge in accent.
- Composer: flat, `--bg-1`, 1px `--line`, focus border accent. Send button flat accent.
- Approval cards: like a fleet request card: mono command, `--warn` edge. At two or more pending, a summary collapses the list at every width. A new arrival expands it; one pending stays open.
- Session previews and the reply tray show plain text with Markdown markers removed. Quote prose uses the body font. Emoji search is 36px high, with 16px phone text.
- Timestamps sit at the bubble's bottom right. A final paragraph can share its last line when there is room; otherwise the timestamp takes its own right-aligned line. Other final blocks always use a separate line.
- The cat avatar is unchanged and never tinted or filtered.
