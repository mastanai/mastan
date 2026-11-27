#!/usr/bin/env python3
"""Build all fixtures, verify editable data/RTL, and attempt all slide renders."""
from __future__ import annotations

import argparse
import copy
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build_deck import Deck, build, load_brand, read_json, validate
from check_deck import audit, check, print_report
from pptx import Presentation
from pptx.util import Inches, Pt

FIXTURES = (("az-business", None), ("ru-lesson", None), ("ar-company", None), ("en-pitch", "en-brand.json"))


def verify_editable(path, content, brand):
    prs = Presentation(path)
    assert len(prs.slides) == len(content["slides"]), "slide count changed"
    rtl = content.get("direction") == "rtl" or content.get("language") == "ar"
    for i, (slide, spec) in enumerate(zip(prs.slides, content["slides"]), 1):
        visible = "\n".join(s.text for s in slide.shapes if s.has_text_frame)
        assert spec["title"] in visible, f"slide {i}: Unicode title lost"
        folio = next(s for s in slide.shapes if s.has_text_frame and s.text == str(i))
        assert folio.left > prs.slide_width * .85, "folio not bottom-right"
        assert folio.top > prs.slide_height * .9, "folio not bottom-right"
        for source_box in (s for s in slide.shapes if s.name == "Source"):
            assert source_box.left + source_box.width < folio.left, "source overlaps fixed folio"
        if spec.get("notes"):
            assert spec["notes"] in slide.notes_slide.notes_text_frame.text, "speaker notes missing"
        if spec["type"] == "chart":
            chart = next(s.chart for s in slide.shapes if s.has_chart)
            assert [c.label for c in chart.plots[0].categories] == spec["chart"]["categories"]
            for series, original in zip(chart.series, spec["chart"]["series"]):
                assert list(series.values) == original["values"], "native chart data changed"
            assert chart.part.chart_workbook.xlsx_part is not None, "chart has no editable workbook"
        if spec["type"] == "table":
            table = next(s.table for s in slide.shapes if s.has_table)
            for row_index, row in enumerate([spec["headers"]] + spec["rows"]):
                for col, value in enumerate(row):
                    assert table.cell(row_index, len(row) - 1 - col if rtl else col).text == str(value), "editable table changed"
        if rtl:
            for shape in slide.shapes:
                if not shape.has_text_frame:
                    continue
                for paragraph in shape.text_frame.paragraphs:
                    if not paragraph.text.strip():
                        continue
                    assert paragraph._p.get_or_add_pPr().get("rtl") == "1", "RTL paragraph direction missing"
            if spec["type"] == "timeline":
                positions = [next(s.left for s in slide.shapes if s.has_text_frame and s.text == step["title"]) for step in spec["steps"]]
                assert positions == sorted(positions, reverse=True), "Arabic timeline not mirrored"
    with zipfile.ZipFile(path) as package:
        assert any(p.startswith("ppt/embeddings/") for p in package.namelist()) == any(s["type"] == "chart" for s in content["slides"])
    first_bg = prs.slides[0].background.fill.fore_color.rgb
    assert str(first_bg) == brand["colors"]["primary"].lstrip("#").upper(), "brand colors ignored"
    cover = "\n".join(s.text for s in prs.slides[0].shapes if s.has_text_frame)
    if brand["name"]:
        assert brand["name"] in cover, "brand name missing"
    else:
        assert "Mastan" not in cover, "unrequested cover branding"


def regression_checks(output):
    """Exercise failure gates and RTL/data cases beyond the four demonstration decks."""
    from test_render_paths import RenderPathsTest
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(RenderPathsTest)
    result = unittest.TestResult()
    suite.run(result)
    assert result.wasSuccessful(), "render-path regressions: " + str(result.failures + result.errors)
    base = {"language":"ar", "slides":[
        {"type":"table","title":"جدول تجريبي","headers":["الفئة","القيمة"],"rows":[["الأولى",2],["الثانية",3]],"sources":["بيانات افتراضية"]},
        {"type":"chart","title":"قيم موجبة وسالبة","chart":{"kind":"column","categories":["أ","ب"],"series":[{"name":"القيمة","values":[-2,3]}]},"sources":["بيانات افتراضية"]},
        {"type":"comparison","title":"مقارنة الخيارات","left_title":"الخيار الأول","left_items":["سهل التنفيذ"],"right_title":"الخيار الثاني","right_items":["يحتاج إلى وقت"]}
    ]}
    validate(base)
    with tempfile.TemporaryDirectory(prefix="regression-", dir=output) as folder:
        temp = Path(folder)
        path = Deck(base, load_brand()).save(temp / "rtl.pptx")
        prs = Presentation(path)
        table = next(s.table for s in prs.slides[0].shapes if s.has_table)
        assert table.cell(0, 1).text == "الفئة", "RTL first table column is not rightmost"
        chart = next(s.chart for s in prs.slides[1].shapes if s.has_chart)
        assert chart.value_axis.minimum_scale == -2, "negative chart values clipped"
        assert chart.category_axis._element.xpath("./c:scaling/c:orientation")[0].get("val") == "maxMin"
        paragraphs = chart._chartSpace.xpath(".//a:pPr")
        assert paragraphs and all(p.get("rtl") == "1" for p in paragraphs), "Arabic chart text lacks RTL"
        first = next(s for s in prs.slides[2].shapes if s.has_text_frame and s.text == "الخيار الأول")
        second = next(s for s in prs.slides[2].shapes if s.has_text_frame and s.text == "الخيار الثاني")
        assert first.left > second.left, "comparison columns not mirrored"
        assert not audit(path)["errors"], "unexpected structural failure"
        # Corruptions demonstrate that checker gates detect actual bad files.
        box = prs.slides[0].shapes.add_textbox(Inches(1), Inches(1), Inches(.5), Inches(.15))
        box.text = "A deliberately overlong line of text \u2014 invalid punctuation"
        box.text_frame.paragraphs[0].runs[0].font.name = "Calibri Light"
        box.text_frame.paragraphs[0].runs[0].font.size = Pt(30)
        prs.slides.add_slide(prs.slide_layouts[1])
        invalid_path = temp / "invalid.pptx"
        prs.save(invalid_path)
        report = audit(invalid_path, expected=3, allowed_fonts=["Arial", "Calibri Light"])
        assert any("Calibri" in e for e in report["errors"]), "font leak not detected"
        assert any("em dash" in e for e in report["errors"]), "em dash not detected"
        assert any("empty placeholder" in e for e in report["errors"]), "empty placeholder not detected"
        assert any("Expected 3" in e for e in report["errors"]), "slide count mismatch not detected"
        assert any("overflow" in w for w in report["warnings"]), "overflow not estimated"
        # Every advertised chart kind must build with native, unchanged data.
        for kind in ("column", "bar", "line", "pie", "stacked_bar"):
            spec = {"slides":[{"type":"chart","title":"Illustrative chart","sources":["Illustrative scenario"],
                     "chart":{"kind":kind,"categories":["A","B"],"series":[{"name":"Value","values":[2,3]}]}}]}
            validate(spec)
            chart_path = Deck(spec, load_brand()).save(temp / (kind + ".pptx"))
            native = next(s.chart for s in Presentation(chart_path).slides[0].shapes if s.has_chart)
            assert list(native.series[0].values) == [2, 3], f"{kind}: chart values changed"
            assert not audit(chart_path)["errors"], f"{kind}: font/structural failure"
        stacked = {"slides":[{"type":"chart","title":"Negative stacks","sources":["Illustrative scenario"],
                    "chart":{"kind":"stacked_bar","categories":["A","B"],"series":[
                        {"name":"First","values":[-2,3]},{"name":"Second","values":[-4,5]}]}}]}
        validate(stacked)
        stacked_path = Deck(stacked, load_brand()).save(temp / "negative-stack.pptx")
        native = next(s.chart for s in Presentation(stacked_path).slides[0].shapes if s.has_chart)
        assert native.value_axis.minimum_scale == -6, "negative stacked total clipped"
    invalids = []
    no_source = copy.deepcopy(base)
    no_source["slides"][0].pop("sources")
    invalids.append(no_source)
    wrong_length = copy.deepcopy(base)
    wrong_length["slides"][1]["chart"]["series"][0]["values"] = [1]
    invalids.append(wrong_length)
    too_many = {"slides":[{"type":"content","title":"Too much","bullets":["Point"] * 7}]}
    invalids.append(too_many)
    invalids.append({"slides":[{"type":"unknown","title":"Unsupported"}]})
    for invalid in invalids:
        try:
            validate(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid content accepted")
    return "passed: native chart/table data, RTL mirroring, negative axes, rejection and audit gates"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-render", action="store_true")
    args = parser.parse_args()
    output = ROOT / "tests/out"
    output.mkdir(parents=True, exist_ok=True)
    summary = {"decks": [], "regressions": None, "visual_inspection": "pending"}
    for name, brand_name in FIXTURES:
        try:
            content = read_json(ROOT / "tests" / (name + ".json"))
            brand_path = ROOT / "tests" / brand_name if brand_name else None
            path = build(ROOT / "tests" / (name + ".json"), output / (name + ".pptx"), brand_path)
            verify_editable(path, content, load_brand(brand_path))
            report = check(path, output / name, len(content["slides"]), skip_render=args.skip_render)
            print_report(report)
            summary["decks"].append(report)
        except Exception as exc:
            print(f"FAIL {name}: {exc}")
            summary["decks"].append({"name":name,"status":"failed","reason":str(exc)})
    try:
        summary["regressions"] = regression_checks(output)
    except Exception as exc:
        summary["regressions"] = "failed: " + str(exc)
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    failures = any(r["status"] == "failed" for r in summary["decks"]) or summary["regressions"].startswith("failed")
    unverified = any(r["status"] == "unverified" for r in summary["decks"])
    built = sum("file" in r for r in summary["decks"])
    rendered = sum(r.get("render", {}).get("status") == "passed" for r in summary["decks"])
    print(f"Summary: {built}/4 built and structurally checked; {rendered}/4 rendered. {summary['regressions']}")
    return 1 if failures else 2 if unverified else 0


if __name__ == "__main__":
    sys.exit(main())
