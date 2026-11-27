#!/usr/bin/env python3
"""Audit a PPTX, render it to PDF/PNGs, and report paths for human inspection."""
from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from pptx import Presentation

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
KNOWN = {
    "soffice": ("/Applications/LibreOffice.app/Contents/MacOS/soffice", "/usr/bin/soffice"),
    "pdftoppm": ("/opt/homebrew/bin/pdftoppm", "/usr/bin/pdftoppm"),
}


def locate(name):
    found = shutil.which(name)
    if found:
        return found
    return next((p for p in KNOWN[name] if Path(p).is_file()), None)


def glyph_width(character, size):
    if unicodedata.combining(character) or unicodedata.category(character) == "Cf":
        return 0
    if character.isspace():
        return .28 * size
    if unicodedata.east_asian_width(character) in {"W", "F"}:
        return size
    if character in "ilI.,:;!'|":
        return .26 * size
    if character in "MW@%":
        return .86 * size
    return (.63 if character.isupper() else .53) * size


def estimated_height(frame, width):
    """Conservative approximation, not a font shaper or a substitute for viewing PNGs."""
    usable = max(1, width / 12700 - (frame.margin_left + frame.margin_right) / 12700)
    height = 0
    for paragraph in frame.paragraphs:
        max_size = max([r.font.size.pt if r.font.size else (paragraph.font.size.pt if paragraph.font.size else 18)
                        for r in paragraph.runs] or [paragraph.font.size.pt if paragraph.font.size else 18])
        lines, used = 1, 0
        # Break by words; handle an overlong URL/word without assuming it fits on one line.
        for word in re.findall(r"\S+\s*|\n", paragraph.text):
            word_width = sum(glyph_width(c, max_size) for c in word)
            if word == "\n":
                lines, used = lines + 1, 0
            elif word_width > usable:
                if used:
                    lines += 1
                extra = max(1, math.ceil(word_width / usable))
                lines, used = lines + extra - 1, word_width % usable
            elif used + word_width > usable:
                lines, used = lines + 1, word_width
            else:
                used += word_width
        spacing = paragraph.line_spacing
        line_height = spacing.pt if hasattr(spacing, "pt") else max_size * (spacing or 1.15)
        height += lines * line_height
        height += (paragraph.space_before.pt if paragraph.space_before else 0)
        height += (paragraph.space_after.pt if paragraph.space_after else 0)
    return height + (frame.margin_top + frame.margin_bottom) / 12700


def audit(path, expected=None, allowed_fonts=None):
    presentation = Presentation(path)
    errors, warnings, fonts = [], [], set()
    allowed = {f.casefold() for f in (allowed_fonts or ["Arial"])}
    if not presentation.slides:
        errors.append("No slides")
    if expected is not None and len(presentation.slides) != expected:
        errors.append(f"Expected {expected} slides; found {len(presentation.slides)}")
    if abs(presentation.slide_width / presentation.slide_height - 16 / 9) > .005:
        errors.append("Slide size is not 16:9")

    def inspect_frame(frame, width, height, label):
        if not frame.text.strip():
            return
        required = estimated_height(frame, width)
        available = height / 12700
        if required > available * 1.1 + 2:
            warnings.append(f"{label}: possible overflow (estimated {required:.0f}pt in {available:.0f}pt)")

    def inspect_shape(shape, index, prefix=""):
        label = f"Slide {index} {prefix}{shape.name}"
        if shape.left < -1270 or shape.top < -1270 or shape.left + shape.width > presentation.slide_width + 1270 or shape.top + shape.height > presentation.slide_height + 1270:
            errors.append(f"{label}: shape outside slide")
        if shape.is_placeholder and not getattr(shape, "text", "").strip() and shape.shape_type != 13:
            errors.append(f"{label}: empty placeholder")
        if shape.has_text_frame:
            inspect_frame(shape.text_frame, shape.width, shape.height, label)
        if shape.has_table:
            for r, row in enumerate(shape.table.rows):
                for c, cell in enumerate(row.cells):
                    inspect_frame(cell.text_frame, shape.table.columns[c].width, row.height, f"{label} cell {r+1},{c+1}")
        if hasattr(shape, "shapes"):
            for child in shape.shapes:
                inspect_shape(child, index, prefix=shape.name + "/")

    for index, slide in enumerate(presentation.slides, 1):
        for shape in slide.shapes:
            inspect_shape(shape, index)
    # Inspect defaults too: inherited fonts can reappear in charts and when editing.
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if not name.startswith("ppt/") or not name.endswith(".xml"):
                continue
            root = ET.fromstring(archive.read(name))
            for node in root.iter():
                font = node.get("typeface")
                if font and not font.startswith("+"):
                    fonts.add(font)
            if name.startswith(("ppt/slides/slide", "ppt/notesSlides/notesSlide", "ppt/charts/chart")):
                text = " ".join(n.text or "" for n in root.iter() if n.tag in {f"{{{NS['a']}}}t", "{http://schemas.openxmlformats.org/drawingml/2006/chart}v"})
                if "\u2014" in text:
                    errors.append(f"{name}: em dash")
                if "©" in text or re.search(r"all rights reserved", text, re.I):
                    errors.append(f"{name}: copyright footer/text requires removal")
    for font in sorted(fonts):
        if re.match(r"^(calibri|aptos)(?:$|[ -])", font.strip(), re.I):
            errors.append(f"Office default font leak: {font}")
        elif font.casefold() not in allowed:
            errors.append(f"Unexpected font: {font} (allow only explicit user font choices)")
    if not fonts:
        warnings.append("No explicit fonts found; inherited defaults require inspection")
    return {"slides": len(presentation.slides), "fonts": sorted(fonts), "errors": errors, "warnings": warnings}


def run(command, timeout=60):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Conversion diagnostics only; no document contents or environment dump.
        detail = (result.stderr or result.stdout).strip()[-1200:]
        raise RuntimeError(f"conversion exited {result.returncode}: {detail}")


def render(path, output, slide_count, safe_converter=None, dpi=100):
    office, poppler = locate("soffice"), locate("pdftoppm")
    if not office or not poppler:
        raise RuntimeError("missing renderer: " + ", ".join(k for k, v in (("soffice", office), ("pdftoppm", poppler)) if not v))
    output.mkdir(parents=True, exist_ok=True)
    # Office cannot reliably load paths on external volumes or paths containing spaces.
    # Always convert a copy with a fixed, space-free name on the system temp volume.
    # Preview staging under the requested outdir keeps incomplete PNGs unpublished.
    with tempfile.TemporaryDirectory(prefix="deck-render-", dir="/tmp") as stage_name, \
            tempfile.TemporaryDirectory(prefix=".deck-preview-", dir=output) as preview_name:
        stage = Path(stage_name).resolve()
        preview = Path(preview_name).resolve()
        staged_input = stage / "input.pptx"
        shutil.copy2(path, staged_input)
        if sys.platform == "darwin":
            wrapper = Path(safe_converter).expanduser() if safe_converter else None
            if wrapper is None or not wrapper.is_file():
                raise RuntimeError("Mac safe conversion wrapper unavailable (pass --safe-converter); direct office launch is disabled")
            run([sys.executable, str(wrapper), str(staged_input), "--convert-to", "pdf",
                 "--outdir", str(stage), "--timeout-seconds", "55"], 60)
        else:
            # Linux conversion uses a disposable profile, never the service user's default.
            with tempfile.TemporaryDirectory(prefix="deck-office-", dir="/tmp") as profile:
                run([office, f"-env:UserInstallation={Path(profile).as_uri()}", "--headless", "--nologo",
                     "--nodefault", "--nofirststartwizard", "--norestore", "--convert-to", "pdf",
                     "--outdir", str(stage), str(staged_input)])
        pdf = stage / "input.pdf"
        if not pdf.is_file() or not pdf.stat().st_size:
            raise RuntimeError("conversion returned no PDF")
        run([poppler, "-png", "-r", str(dpi), str(pdf), str(preview / "slide")], 60)
        images = sorted(preview.glob("slide-*.png"), key=lambda p: int(p.stem.split("-")[-1]))
        if len(images) != slide_count:
            raise RuntimeError(f"rendered {len(images)} pages for {slide_count} slides")
        # Publish only a complete render; old preview images are removed after success.
        for old in output.glob("slide-*.png"):
            old.unlink()
        destination_pdf = output / (path.stem + ".pdf")
        shutil.copy2(pdf, destination_pdf)
        published = []
        for image in images:
            destination = output / image.name
            shutil.copy2(image, destination)
            published.append(str(destination.resolve()))
    return {"status": "passed", "pdf": str(destination_pdf.resolve()), "pngs": published,
            "visual_inspection": "pending: look at every PNG; automated success is not visual approval"}


def check(path, output=None, expected=None, allowed_fonts=None, skip_render=False, safe_converter=None):
    path = Path(path).resolve()
    output = Path(output or path.with_suffix("")).resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = audit(path, expected, allowed_fonts)
    report["file"] = str(path)
    if skip_render:
        report["render"] = {"status": "skipped", "reason": "static checks only", "pngs": []}
    else:
        try:
            report["render"] = render(path, output, report["slides"], safe_converter)
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
            report["render"] = {"status": "failed", "reason": str(exc), "pngs": []}
    report["status"] = "failed" if report["errors"] else (
        "unverified" if report["render"]["status"] != "passed" or report["warnings"] else "ready_for_visual_inspection")
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def print_report(report):
    print(f"{Path(report['file']).name}: {report['slides']} slides; fonts: {', '.join(report['fonts'])}")
    print(f"Static: {len(report['errors'])} errors, {len(report['warnings'])} fit warnings; render: {report['render']['status']}")
    for message in report["errors"]:
        print("ERROR: " + message)
    for message in report["warnings"]:
        print("LOOK: " + message)
    if report["render"].get("reason"):
        print(report["render"]["reason"])
    for path in report["render"].get("pngs", []):
        print("LOOK: " + path)
    print("Every slide image requires visual inspection before delivery.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--outdir", type=Path)
    parser.add_argument("--expected-slides", type=int)
    parser.add_argument("--allow-font", action="append", dest="fonts", help="explicit requested font; repeat as needed")
    parser.add_argument("--skip-render", action="store_true", help="static checks only; exits 2 when otherwise clean")
    parser.add_argument("--safe-converter", type=Path, help="Mac safe conversion wrapper")
    args = parser.parse_args()
    try:
        report = check(args.pptx, args.outdir, args.expected_slides, args.fonts, args.skip_render, args.safe_converter)
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        parser.exit(1, f"Check failed: {exc}\n")
    print_report(report)
    return 1 if report["errors"] else 2 if report["status"] == "unverified" else 0


if __name__ == "__main__":
    sys.exit(main())
