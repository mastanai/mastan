#!/usr/bin/env python3
"""Recalculate an .xlsx copy in LibreOffice, scan it for formula problems, and render it to PDF and PNG pages.

Exit codes: 0 clean and rendered (still look at every PNG), 1 formula problems found, 2 unverified
(recalculation or rendering failed, or some formulas still have no value).
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from openpyxl import load_workbook

ERRORS = ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!", "#SPILL!", "#CALC!")
KNOWN = {
    "soffice": ("/usr/bin/soffice", "/usr/lib/libreoffice/program/soffice"),
    "pdftoppm": ("/usr/bin/pdftoppm",),
}
# A throwaway profile that tells Calc to recalculate every formula on load.
RECALC_PROFILE = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
"""


def locate(name):
    found = shutil.which(name)
    return found or next((p for p in KNOWN[name] if Path(p).is_file()), None)


def run(command, timeout=120):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()[-800:]
        raise RuntimeError(f"command exited {result.returncode}: {detail}")


def convert(office, source, fmt, outdir):
    """One LibreOffice conversion with a fresh profile under /tmp. Returns the output path."""
    with tempfile.TemporaryDirectory(prefix="xlsx-office-", dir="/tmp") as profile:
        user = Path(profile) / "user"
        user.mkdir()
        (user / "registrymodifications.xcu").write_text(RECALC_PROFILE, encoding="utf-8")
        run([office, f"-env:UserInstallation={Path(profile).as_uri()}", "--headless", "--nologo", "--nodefault",
             "--nofirststartwizard", "--norestore", "--convert-to", fmt, "--outdir", str(outdir), str(source)])
    out = outdir / (source.stem + "." + fmt.split(":")[0])
    if not out.is_file() or not out.stat().st_size:
        raise RuntimeError(f"conversion to {fmt} returned no file")
    return out


def scan(original, recalculated):
    """Compare formulas in the original with the values LibreOffice stored."""
    formulas = load_workbook(original, data_only=False)
    values = load_workbook(recalculated, data_only=True) if recalculated else None
    report = {"formula_cells": 0, "errors": [], "no_value": [], "external_links": []}
    for ws in formulas.worksheets:
        vs = values[ws.title] if values is not None and ws.title in values.sheetnames else None
        for row in ws.iter_rows():
            for cell in row:
                text = cell.value
                if isinstance(text, str) and text.startswith("="):
                    report["formula_cells"] += 1
                    ref = f"{ws.title}!{cell.coordinate}"
                    if "[" in text or "http" in text.lower():
                        report["external_links"].append(ref)
                    if vs is None:
                        continue
                    value = vs[cell.coordinate].value
                    if value is None:
                        report["no_value"].append(ref)
                    elif isinstance(value, str) and value.strip() in ERRORS:
                        report["errors"].append(f"{ref} {value.strip()}")
                elif isinstance(text, str) and text.strip() in ERRORS:
                    report["errors"].append(f"{ws.title}!{cell.coordinate} {text.strip()} (typed value)")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("xlsx", type=Path)
    parser.add_argument("--outdir", type=Path, required=True)
    parser.add_argument("--dpi", type=int, default=70)
    parser.add_argument("--skip-render", action="store_true", help="formula scan only; result is unverified")
    args = parser.parse_args()

    source = args.xlsx.resolve()
    outdir = args.outdir.resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    result = {"file": source.name, "recalc": "skipped", "render": "skipped", "pngs": []}
    office, poppler = locate("soffice"), locate("pdftoppm")
    recalculated = staged_recalc = None

    with tempfile.TemporaryDirectory(prefix="xlsx-stage-", dir="/tmp") as stage_name:
        stage = Path(stage_name)
        # Office handles a fixed, space-free name on /tmp more reliably than the original path.
        staged = stage / "input.xlsx"
        shutil.copy2(source, staged)
        if args.skip_render or not office:
            result["recalc"] = "skipped" if args.skip_render else "failed: LibreOffice not found"
        else:
            try:
                (stage / "recalc").mkdir()
                staged_recalc = convert(office, staged, "xlsx:Calc MS Excel 2007 XML", stage / "recalc")
                recalculated = outdir / (source.stem + ".recalc.xlsx")
                shutil.copy2(staged_recalc, recalculated)
                result["recalc"] = "done"
                result["recalculated_copy"] = str(recalculated)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
                result["recalc"] = f"failed: {exc}"
        if recalculated and poppler:
            try:
                (stage / "pdf").mkdir()
                pdf = convert(office, staged_recalc, "pdf", stage / "pdf")
                for old in outdir.glob("page-*.png"):
                    old.unlink()
                final_pdf = outdir / (source.stem + ".pdf")
                shutil.copy2(pdf, final_pdf)
                run([poppler, "-png", "-r", str(args.dpi), str(final_pdf), str(outdir / "page")])
                result["pngs"] = sorted(str(p) for p in outdir.glob("page-*.png"))
                result["render"] = "done" if result["pngs"] else "failed: no pages"
                result["pdf"] = str(final_pdf)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
                result["render"] = f"failed: {exc}"
        elif recalculated:
            result["render"] = "failed: pdftoppm not found"

    result.update(scan(source, recalculated))
    (outdir / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"{source.name}: {result['formula_cells']} formulas; recalc: {result['recalc']}; render: {result['render']}")
    for line in result["errors"]:
        print("ERROR: " + line)
    for line in result["external_links"]:
        print("EXTERNAL LINK: " + line)
    if result["no_value"]:
        print(f"NO VALUE after recalc: {len(result['no_value'])} cells, first: {', '.join(result['no_value'][:10])}")
    for path in result["pngs"]:
        print("LOOK: " + path)
    if result["errors"] or result["external_links"]:
        return 1
    if result["recalc"] != "done" or result["render"] != "done" or result["no_value"]:
        print("Unverified: recalculation or rendering is incomplete. Do not call this file checked.")
        return 2
    print("Formulas clean. Look at every page image before sending.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
