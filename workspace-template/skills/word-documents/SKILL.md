---
name: word-documents
description: Create or update editable Word (.docx) documents such as policies and procedures, letters, reports, contracts, forms, and documents built from Excel criteria. Handles Arabic right to left, branding only from the owner's own assets, approval fields without invented names, and a rendered page check. Use for any Word or .docx request.
---

# Word documents

File work: run it as a background task (skill `background-tasks`). If tasks are unavailable here (on WhatsApp), do it in this chat. Work in `tasks/<job>/`, where `<job>` is the date and a short slug, for example `2026-12-01-budget`. `python3` below means `/opt/mastan-me/runtime/py/bin/python3`; it has python-pptx, openpyxl, python-docx and Pillow. LibreOffice (`soffice`) and `pdftoppm` are installed. Never install packages or swap tools.
Build with `python-docx`.

## Procedure

1. **Read the sources directly.** Open every supplied file (docx, xlsx, pdf): each sheet, criterion, threshold,
   percentage, formula, note and role. Don't rely on attachment previews.
2. **Acceptance checklist.** Title, purpose, sections, language and direction, branding, role fields, editable DOCX,
   every source calculation. Each item gets a place in the document.
3. **Branding.** Use only a logo and colours this user supplied in this conversation. Otherwise use neutral styling
   and no logo. Never take a logo, colours or a brand from anywhere else: not from the web, not from another document,
   not from earlier work.
4. **People.** Never invent preparer, reviewer or approver names. Use a name only when this user gave it in this
   conversation. Otherwise leave a labelled blank field (role, name, signature, date). If the user wrote dots or left
   a field empty, it stays blank.
5. **Rules exactly as given.** Take business rules and numbers from the source. Resolve formulas from the source
   values and worked examples. Leave genuinely missing governance details as clear placeholders or as "requires
   approval" clauses, labelled as proposed. Never invent them.
6. **Build.** Native paragraphs, heading styles and tables. A4 unless the user asks otherwise. Headers, footers, page
   numbers and document title. Arial by default, or a font that covers the language. For Arabic: right-to-left
   paragraphs and tables, right alignment, complex-script font set. Every other language stays left to right.
7. **Structure for a policy.** Use only the sections the source supports: cover with approval roles, document
   control, purpose, scope, definitions, eligibility, tiers or rules, calculation method with worked examples, cycle
   and timing, roles, controls, exceptions and appeals, implementation checklist, signatures. No filler sections.
8. **Recalculate every example** independently: totals, splits, tier boundaries, units, period labels.
9. **Amending an existing document.** Copy neighbouring styled paragraphs or rows instead of rebuilding the layout.
   Carry each change through every dependent reference, the version number and the change log. The new clause appears
   once, in its proper section.
10. **Package check.** The file opens as a DOCX, the zip is not corrupt, relationships resolve, there are no unexpected
    external links, a logo is embedded only if one was supplied, Arabic has its right-to-left settings, the page size
    is right.
11. **Render and look.** Convert to PDF with LibreOffice and a throwaway profile, then to page images:
    ```sh
    P=$(mktemp -d /tmp/lo-XXXXXX); mkdir -p tasks/<job>/check
    cp tasks/<job>/<file>.docx "$P/input.docx"
    soffice -env:UserInstallation=file://$P/profile --headless --convert-to pdf --outdir "$P" "$P/input.docx"
    pdftoppm -png -r 70 "$P/input.pdf" tasks/<job>/check/page
    rm -rf "$P"
    ```
    Up to 20 pages, look at every page. Above that, the first, middle and last pages plus every special layout.
    Check clipping, blank or spill pages, split tables, headings, Arabic shaping, margins, headers, footers and
    signature space. Fix and render again. If rendering fails, say the visual check is incomplete.

## Deliver

Send with `mastan-me-send tasks/<job>/<file>.docx --caption "<one line in the user's language>"`. Claim delivery only
after the receipt says `sent`. A `sent` receipt proves delivery, not correctness: both gates must pass.
