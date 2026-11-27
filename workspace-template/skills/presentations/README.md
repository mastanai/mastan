# Presentations skill

An editable, 16:9 PPTX engine and a bounded story, verification and delivery workflow.
The package runs with Python 3.9+ and `python-pptx` (tested here with 1.0.2); the engine uses
only that library and the standard library. Conversion also needs LibreOffice and Poppler.

## Install

This folder ships in the Mastan workspace template under `skills/presentations`. The installer puts
`python-pptx` in `/opt/mastan-me/runtime/py` and installs LibreOffice, Poppler and the fonts below.
Generated files go in the workspace's `tasks/<job>/`, never inside this folder.

## Runtime packages and fonts

On Debian/Ubuntu, provide `python3-pptx` (or `python-pptx` in the service's Python environment),
`libreoffice-impress`, `poppler-utils`, `fontconfig`, `fonts-liberation2`, `fonts-dejavu-core`,
and `fonts-noto-core`. For a Python virtual environment, install `python-pptx` there instead
of mixing a system Python package and a different interpreter. No package download is needed
at generation time.

Files explicitly declare **Arial** for Latin, East Asian and complex scripts, including theme
defaults, notes, tables and charts. Azerbaijani, Turkish, Cyrillic and Arabic stay Unicode.
On Linux without licensed Arial, LibreOffice/fontconfig normally substitutes **Liberation Sans**
for Latin/Cyrillic, then **Noto Sans Arabic** or **DejaVu Sans** for Arabic glyphs. This substitution
is for rendering only; the PPTX keeps Arial. Actual fontconfig choices vary by server: inspect
`fc-match Arial`, `fc-match 'Arial:lang=az'`, and `fc-match 'Arial:lang=ar'`, and visually check
all glyphs. Installing Noto alone does not guarantee its priority. For closer cross-device fidelity,
install legally supplied Arial fonts on the rendering host. Do not bundle proprietary font files.
An explicit user font choice may override heading/body families; install its licensed fonts or
record the render fallback and inspect it. The default remains Arial; Calibri/Aptos are rejected.

The checker discovers `soffice` and `pdftoppm` from PATH, then the known paths in its code.
Every conversion uses a fresh `/tmp/deck-render-.../input.pptx` copy, even when the original is
on an external volume or has spaces in its filename. Office writes its PDF beside that copy.
Poppler stages PNGs inside the requested output directory; only a complete render is published,
and the final PDF retains the original deck's basename. Temporary copies and profiles are removed.
Linux uses `--headless` and a fresh `-env:UserInstallation=file:///tmp/...` profile per conversion.
On a Mac development machine it never invokes the office executable directly: pass a safe
conversion wrapper with `--safe-converter`, or rendering fails clearly. The wrapper must create an
isolated profile. If rendering is unavailable, do not change flags, launch another browser or
install tools; report the visual check as incomplete.

## Build and check

Self-test, from this skill folder (use `/opt/mastan-me/runtime/py/bin/python3` for `python3`):

```sh
python3 scripts/build_deck.py --content tests/az-business.json --output tests/out/az-business.pptx
python3 scripts/check_deck.py tests/out/az-business.pptx --outdir tests/out/az-business --expected-slides 5
python3 tests/run_tests.py
```

The runner builds and audits all four fixtures into `tests/out/`, verifies Unicode, RTL, page
counts, notes, branding, chart data and editable table cells, and attempts every render.
It also tests space-containing source paths, temporary copies/profiles, safe-wrapper dispatch,
and incomplete-render cleanup using simulated converters; these tests never launch office.
It writes `tests/out/summary.json`. Open **every** listed PNG yourself before signing off.
The runner never claims human inspection. Exit codes for the checker/runner: `0` means automatic
checks and conversion succeeded (visual inspection still pending), `1` means a failed invariant,
and `2` means rendering is incomplete or estimated fit needs review. `--skip-render` is an honest
static-only mode and does not turn an unrendered deck into a passing result. `report.json` records
errors, fit warnings and the current render's paths. Do not use stale PNGs after a failed render.
Fit checks estimate glyph widths, wrapping and font size; they cannot detect all overlapping shapes,
shaping, font substitutions, chart-label clipping or visual problems. No PDF-only fallback replaces
the requested editable PPTX. Correct copy/layout and rebuild at most twice, then report remaining issues.

## Content JSON

All slides are explicit, including cover/closing. No inferred extra cover, closing or placeholders.
The slides array length is the output count. Required root: `slides`. Optional root: `title`
(document metadata), `language` (default `en`), `direction` (`auto`, `ltr`, `rtl`). Arabic language
codes such as `ar`/`ar-SA` imply RTL unless explicitly overridden. Every slide requires `title` and
uses a `type` (default `content`). Common optional slide fields: `notes` (text), `sources` (string
or list of strings; `source` is a singular alias). Sources appear in the footer AND notes. Keep
visible citations concise; long source details can be in notes with matching short source IDs.
Numeric slides and factual quotes require a nonempty source. User-provided files, classroom
examples and illustrative scenarios still get explicit source/assumption labels.

```json
{
  "language": "az", "direction": "auto",
  "slides": [
    {"type":"title", "title":"Satış artımı davam edir", "subtitle":"Rəhbərlik üçün yeniləmə"},
    {"type":"hero", "title":"Gəlir hədəfi üstələyir", "value":"120 min ₼", "label":"Rüblük gəlir",
     "context":"Hədəfdən 20% yüksək", "sources":["Nümunə məlumatları, gəlir cədvəli"],
     "notes":"Hədəf 100 min ₼; fərq 20 min ₼ / 100 min ₼ = 20%."}
  ]
}
```

| Type | Fields in addition to title | Limits and behavior |
|---|---|---|
| `title` | `subtitle` optional | Explicit cover, brand name, proportional optional logo |
| `section` | `subtitle` optional | Dark section divider |
| `content` | `body` OR `bullets`, optional `subtitle` | Paragraph or max six bullets, around six words each |
| `metrics` | `metrics: [{label,value,context?,source?}]` | One to six metrics; `value` is display text |
| `comparison` | `left_title`, `left_items`, `right_title`, `right_items` | Six bullets total across both sides |
| `timeline` | `steps: [{label?,title,detail?}]` | Two to five milestones, in reading order |
| `hero` | `value`, `label`, optional `context` | One big number and its meaning |
| `chart` | `chart: {kind,categories,series,number_format?}`, optional `context` | Native chart, editable embedded data |
| `table` | `headers: [...]`, `rows: [[...]]` | One to six columns, one to eight data rows |
| `quote` | `quote`, `attribution` | Source required; do not invent quotations |
| `closing` | `subtitle` optional | The ask or final takeaway, no forced English text |

Chart `kind`: `column`, `bar`, `line`, `pie`, `stacked_bar`. Each series is
`{"name":"Revenue","values":[100,120]}` with one finite numeric value per category.
Up to twelve categories and four series; pie charts have one nonnegative series and up to five
slices. Choose smaller counts for readable labels. For example:

```json
{"type":"chart", "title":"Revenue grew across the quarter",
 "chart":{"kind":"line","categories":["April","May","June"],
          "series":[{"name":"Revenue, thousands","values":[30,40,50]}],"number_format":"0"},
 "sources":["Illustrative scenario, monthly revenue worksheet"]}
```

Units belong in labels/series or the supplied number format, not hidden assumptions. Sources
must support the numbers and headlines; the engine checks presence, not factual truth. Keep a
calculation audit for derived data. Extra content is never silently truncated; unsupported types,
excess lists, malformed data, missing numeric sources and em dashes fail the build.

RTL sets paragraph direction, right alignment, Arabic language metadata and complex-script fonts.
It mirrors text positions, comparison columns, metrics and milestone order; table arrays are supplied
in reading order, with their first column rendered at the right. Chart categories reverse along
their category axis; data remain bound to their original labels. Page numbers stay bottom-right.
For Arabic with embedded Latin names/URLs or mixed numbers, inspect actual shaping and ordering.

## Optional brand JSON

Use only assets and choices authorized for the current user. Relative logo paths resolve beside
the brand JSON; PNG/JPEG are supported by the presentation library. Missing logos fail clearly.

```json
{"name":"Northstar", "logo_path":null,
 "colors":{"primary":"#172B4D","secondary":"#EBF0F7","accent":"#245BC4",
           "text":"#172B4D","muted":"#52627A","background":"#FFFFFF","on_dark":"#FFFFFF"},
 "fonts":{"heading":"Arial","body":"Arial"}}
```

```sh
python3 scripts/build_deck.py --content tests/en-pitch.json --brand tests/en-brand.json --output tests/out/en-pitch.pptx
```

The neutral default palette adds no visible brand name or logo. A supplied brand name appears
on the cover; a supplied logo appears proportionally in the reserved corner of each slide.
Choose dark/light brand colors with readable contrast. With an explicit custom font, pass all
chosen families to the checker, for example `--allow-font Arial --allow-font 'Noto Sans Arabic'`.
The schema does not read profiles, saved brand files, credentials or other organizations' assets.
The skill only builds/checks files; delivery is `mastan-me-send`, claimed only after its `sent` receipt.
