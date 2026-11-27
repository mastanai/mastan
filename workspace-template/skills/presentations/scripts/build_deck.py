#!/usr/bin/env python3
"""Build editable, widescreen presentations from content JSON (stdlib + python-pptx)."""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Inches, Pt

WIDTH, HEIGHT = 13.333333, 7.5
DEFAULT_BRAND = {
    "name": "", "logo_path": None,
    "colors": {"primary": "#172B4D", "secondary": "#EBF0F7",
               "accent": "#245BC4", "text": "#172B4D", "muted": "#52627A",
               "background": "#FFFFFF", "on_dark": "#FFFFFF"},
    "fonts": {"heading": "Arial", "body": "Arial"},
}
TYPES = {"title", "section", "content", "metrics", "comparison", "timeline",
         "hero", "chart", "table", "quote", "closing", "photo"}
PHOTO_TYPES = {".png", ".jpg", ".jpeg"}
CHARTS = {"column": XL_CHART_TYPE.COLUMN_CLUSTERED, "bar": XL_CHART_TYPE.BAR_CLUSTERED,
          "line": XL_CHART_TYPE.LINE_MARKERS, "pie": XL_CHART_TYPE.PIE,
          "stacked_bar": XL_CHART_TYPE.BAR_STACKED}
NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def rgb(value):
    return RGBColor.from_string(value.lstrip("#"))


def read_json(path):
    with Path(path).open(encoding="utf-8") as stream:
        return json.load(stream)


def load_brand(path=None):
    brand = json.loads(json.dumps(DEFAULT_BRAND))
    if path:
        custom = read_json(path)
        if not isinstance(custom, dict):
            raise ValueError("brand JSON must be an object")
        for key in ("name", "logo_path"):
            if key in custom:
                brand[key] = custom[key]
        for key in ("colors", "fonts"):
            brand[key].update(custom.get(key, {}))
        if brand["logo_path"]:
            logo = Path(brand["logo_path"])
            brand["logo_path"] = str((Path(path).resolve().parent / logo).resolve())
            if not Path(brand["logo_path"]).is_file():
                raise ValueError("brand logo does not exist")
    for color in brand["colors"].values():
        if not isinstance(color, str) or not re.fullmatch(r"#?[0-9a-fA-F]{6}", color):
            raise ValueError("brand colors must be six-digit RGB hex strings")
    for font in brand["fonts"].values():
        if not isinstance(font, str) or not font.strip() or re.match(r"^(calibri|aptos)(?:$|[ -])", font.strip(), re.I):
            raise ValueError("use Arial or an explicitly requested non-default font")
    return brand


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif isinstance(value, (int, float)):
        yield str(value)


def sources(spec):
    result = []
    def append(value):
        for entry in value if isinstance(value, list) else [value]:
            if entry and str(entry) not in result:
                result.append(str(entry))
    append(spec.get("sources", spec.get("source", [])))
    for metric in spec.get("metrics", []):
        append(metric.get("source", []))
    return result


def validate(content):
    if not isinstance(content, dict) or not isinstance(content.get("slides"), list) or not content["slides"]:
        raise ValueError("content must contain a nonempty slides array; covers are explicit slides")
    if content.get("direction", "auto") not in {"auto", "ltr", "rtl"}:
        raise ValueError("direction must be auto, ltr or rtl")
    if any("\u2014" in text for text in strings(content)):
        raise ValueError("replace em dashes throughout content and notes")
    for index, spec in enumerate(content["slides"], 1):
        if not isinstance(spec, dict):
            raise ValueError(f"slide {index}: expected an object")
        kind = spec.get("type", "content")
        prefix = f"slide {index} ({kind})"
        if kind not in TYPES or not isinstance(spec.get("title"), str) or not spec["title"].strip():
            raise ValueError(f"{prefix}: supply a supported type and a nonempty title")
        bullets = spec.get("bullets", []) + spec.get("left_items", []) + spec.get("right_items", [])
        if len(bullets) > 6:
            raise ValueError(f"{prefix}: at most six bullets per slide; split the content")
        if kind == "content" and not (bullets or spec.get("body")):
            raise ValueError(f"{prefix}: supply body or bullets")
        if kind == "content" and spec.get("body") and spec.get("bullets"):
            raise ValueError(f"{prefix}: choose body or bullets; never silently discard either")
        if kind == "metrics" and not 1 <= len(spec.get("metrics", [])) <= 6:
            raise ValueError(f"{prefix}: supply one to six metrics")
        if kind == "comparison" and not all(spec.get(k) for k in ("left_title", "right_title", "left_items", "right_items")):
            raise ValueError(f"{prefix}: supply both titles and item lists")
        if kind == "timeline" and not 2 <= len(spec.get("steps", [])) <= 5:
            raise ValueError(f"{prefix}: supply two to five steps")
        if kind == "hero" and not all(str(spec.get(k, "")).strip() for k in ("value", "label")):
            raise ValueError(f"{prefix}: supply value and label")
        if kind == "photo":
            image = spec.get("image")
            if not isinstance(image, dict) or not all(str(image.get(k, "")).strip() for k in ("path", "caption", "credit")):
                raise ValueError(f"{prefix}: supply image with path, caption and credit (where the picture comes from)")
            path = Path(image["path"])
            if path.suffix.lower() not in PHOTO_TYPES or not path.is_file() or path.stat().st_size < 1000:
                raise ValueError(f"{prefix}: image must be a downloaded PNG or JPEG file")
            if len(spec.get("bullets", [])) > 4 or spec.get("body") and spec.get("bullets"):
                raise ValueError(f"{prefix}: a photo slide takes body or up to four bullets")
        if kind == "quote" and not all(spec.get(k) for k in ("quote", "attribution")):
            raise ValueError(f"{prefix}: supply quote and attribution")
        if kind == "chart":
            data = spec.get("chart", {})
            categories, series = data.get("categories", []), data.get("series", [])
            if data.get("kind", "column") not in CHARTS or not categories or not series:
                raise ValueError(f"{prefix}: supply chart kind, categories and series")
            if len(categories) > 12 or len(series) > 4:
                raise ValueError(f"{prefix}: split charts over twelve categories or four series")
            if data.get("kind") == "pie" and (len(categories) > 5 or len(series) != 1):
                raise ValueError(f"{prefix}: pie charts allow one series and up to five slices")
            for series_item in series:
                values = series_item.get("values", [])
                if not series_item.get("name") or len(values) != len(categories):
                    raise ValueError(f"{prefix}: each named series must match category count")
                if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
                    raise ValueError(f"{prefix}: chart values must be finite numbers")
                if data.get("kind") == "pie" and (min(values) < 0 or sum(values) <= 0):
                    raise ValueError(f"{prefix}: pie values must be nonnegative and sum above zero")
        if kind == "table":
            headers, rows = spec.get("headers", []), spec.get("rows", [])
            if not 1 <= len(headers) <= 6 or not 1 <= len(rows) <= 8 or any(len(r) != len(headers) for r in rows):
                raise ValueError(f"{prefix}: table needs one to six columns, one to eight data rows, matching widths")
        visible = {k: v for k, v in spec.items() if k not in {"notes", "sources", "source", "type"}}
        if (kind in {"metrics", "hero", "chart", "table", "quote"} or any(re.search(r"\d", s) for s in strings(visible))) and not sources(spec):
            raise ValueError(f"{prefix}: supply sources, including for user data or illustrative assumptions")


def apply_font(font, size, color, family, bold=False):
    font.name, font.size, font.bold = family, Pt(size), bold
    font.color.rgb = rgb(color)


def set_script_fonts(properties, family, language):
    properties.set("lang", language)
    for tag in ("a:latin", "a:ea", "a:cs"):
        element = properties.find(f"{{{NS}}}{tag.split(':')[1]}")
        if element is None:
            element = OxmlElement(tag)
            properties.append(element)
        element.set("typeface", family)


class Deck:
    def __init__(self, content, brand):
        self.content, self.brand = content, brand
        self.colors, self.fonts = brand["colors"], brand["fonts"]
        language = content.get("language", "en")
        self.language = {"az": "az-Latn-AZ", "ru": "ru-RU", "ar": "ar-SA",
                         "en": "en-US", "tr": "tr-TR"}.get(language, language)
        self.rtl = content.get("direction", "auto") == "rtl" or (
            content.get("direction", "auto") == "auto" and language.split("-")[0] == "ar")
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = Inches(WIDTH), Inches(HEIGHT)
        self.prs.core_properties.title = content.get("title", content["slides"][0]["title"])
        self.prs.core_properties.author = brand["name"]
        self.prs.core_properties.subject = ""

    def x(self, left, width):
        return WIDTH - left - width if self.rtl else left

    def rect(self, slide, left, top, width, height, color):
        shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(self.x(left, width)),
                                       Inches(top), Inches(width), Inches(height))
        shape.fill.solid()
        shape.fill.fore_color.rgb = rgb(self.colors.get(color, color))
        shape.line.fill.background()
        return shape

    def paragraph(self, paragraph, text, size, color, bold=False, heading=False, align=None, rtl=None):
        direction = self.rtl if rtl is None else rtl
        family = self.fonts["heading" if heading else "body"]
        paragraph.alignment = align if align is not None else (PP_ALIGN.RIGHT if direction else PP_ALIGN.LEFT)
        paragraph.space_before = paragraph.space_after = Pt(0)
        paragraph.line_spacing = 1.12
        props = paragraph._p.get_or_add_pPr()
        props.set("rtl", "1" if direction else "0")
        apply_font(paragraph.font, size, self.colors.get(color, color), family, bold)
        set_script_fonts(props.get_or_add_defRPr(), family, self.language)
        run = paragraph.add_run()
        run.text = str(text)
        apply_font(run.font, size, self.colors.get(color, color), family, bold)
        set_script_fonts(run._r.get_or_add_rPr(), family, self.language)

    def text(self, slide, text, left, top, width, height, size=22, color="text", bold=False,
             heading=False, align=None, mirror=True):
        box = slide.shapes.add_textbox(Inches(self.x(left, width) if mirror else left), Inches(top), Inches(width), Inches(height))
        box.text_frame.clear()
        box.text_frame.word_wrap = True
        box.text_frame.margin_left = box.text_frame.margin_right = Inches(.015)
        box.text_frame.margin_top = box.text_frame.margin_bottom = Inches(.025)
        box.text_frame.vertical_anchor = MSO_ANCHOR.TOP
        for i, line in enumerate(str(text).split("\n")):
            self.paragraph(box.text_frame.paragraphs[0] if i == 0 else box.text_frame.add_paragraph(),
                           line, size, color, bold, heading, align)
        return box

    def logo(self, slide):
        if not self.brand.get("logo_path"):
            return
        picture = slide.shapes.add_picture(self.brand["logo_path"], 0, 0)
        scale = min(1.0 / picture.width, .48 / picture.height) * 914400
        picture.width, picture.height = int(picture.width * scale), int(picture.height * scale)
        picture.left, picture.top = Inches(self.x(11.65, picture.width / 914400)), Inches(.4)

    def base(self, spec, number, dark=False):
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb = rgb(self.colors["primary" if dark else "background"])
        self.logo(slide)
        if not dark:
            self.rect(slide, .65, .42, .65, .055, "accent")
            self.text(slide, spec["title"], .65, .66, 10.9 if self.brand.get("logo_path") else 12.0,
                      1.03, 30, bold=True, heading=True)
        # Folio stays bottom-right even in an RTL presentation.
        folio = self.text(slide, str(number), 12.05, 7.0, .6, .28, 11,
                          "on_dark" if dark else "muted", align=PP_ALIGN.RIGHT, mirror=False)
        folio.name = "Slide number"
        citation = " | ".join(sources(spec))
        if citation:
            # Keep the source region clear of the fixed right-hand folio in both directions.
            source_box = self.text(slide, citation, .65, 6.85, 10.95, .5, 10,
                                   "on_dark" if dark else "muted", mirror=False)
            source_box.name = "Source"
        notes = spec.get("notes", "")
        if citation:
            notes = (notes + "\n\n" + citation).strip()
        if notes:
            frame = slide.notes_slide.notes_text_frame
            frame.clear()
            for i, line in enumerate(notes.split("\n")):
                self.paragraph(frame.paragraphs[0] if i == 0 else frame.add_paragraph(), line, 12, "text")
        return slide

    def bullets(self, slide, items, left, top, width, available=4.5):
        step = min(.95, available / max(len(items), 1))
        for i, item in enumerate(items):
            self.rect(slide, left, top + i * step + .15, .055, .26, "accent")
            self.text(slide, item, left + .25, top + i * step, width - .25, step - .07, 22)

    def build_slide(self, spec, number):
        kind = spec.get("type", "content")
        dark = kind in {"title", "section", "closing"}
        slide = self.base(spec, number, dark)
        if dark:
            self.rect(slide, .8, 2.0, 1.2, .07, "accent")
            self.text(slide, spec["title"], .8, 2.35, 11.7, 1.8, 44, "on_dark", True, True)
            if spec.get("subtitle"):
                self.text(slide, spec["subtitle"], .8, 4.42, 11.5, 1.1, 23, "on_dark")
            if kind == "title" and self.brand["name"]:
                self.text(slide, self.brand["name"], .8, .75, 9.8, .55, 16, "on_dark", True)
        elif kind == "content":
            top = 1.95
            if spec.get("subtitle"):
                self.text(slide, spec["subtitle"], .65, top, 12, .8, 21, "muted")
                top += 1.0
            if spec.get("body"):
                self.text(slide, spec["body"], .65, top, 11.8, 6.5 - top, 25)
            else:
                self.bullets(slide, spec["bullets"], .75, top, 11.7, 6.5 - top)
        elif kind == "metrics":
            metrics = spec["metrics"]
            cols = 2 if len(metrics) in {2, 4} else min(3, len(metrics))
            rows = math.ceil(len(metrics) / cols)
            width, height = (12 - .35 * (cols - 1)) / cols, (4.45 - .35 * (rows - 1)) / rows
            for i, metric in enumerate(metrics):
                x, y = .65 + (i % cols) * (width + .35), 1.95 + (i // cols) * (height + .35)
                self.rect(slide, x, y, width, .035, "accent")
                self.text(slide, metric["label"], x, y + .18, width, .58, 18, "muted")
                self.text(slide, metric["value"], x, y + .83, width, .86, 40, "accent", True)
                if metric.get("context"):
                    self.text(slide, metric["context"], x, y + 1.72, width, height - 1.72, 16, "muted")
        elif kind == "comparison":
            for side, x in (("left", .65), ("right", 6.9)):
                self.rect(slide, x, 1.95, 5.75, .045, "accent")
                self.text(slide, spec[side + "_title"], x, 2.18, 5.7, .9, 26, bold=True)
                self.bullets(slide, spec[side + "_items"], x, 3.28, 5.6, 3.1)
        elif kind == "timeline":
            steps = spec["steps"]
            width = (12 - .25 * (len(steps) - 1)) / len(steps)
            self.rect(slide, .65, 2.4, 12, .035, "secondary")
            for i, step in enumerate(steps):
                x = .65 + i * (width + .25)
                self.rect(slide, x, 2.28, .16, .28, "accent")
                self.text(slide, step.get("label", ""), x, 2.85, width, .75, 20, "accent", True)
                self.text(slide, step["title"], x, 3.8, width, 1.05, 23, bold=True)
                if step.get("detail"):
                    self.text(slide, step["detail"], x, 5.03, width, 1.35, 18, "muted")
        elif kind == "hero":
            self.text(slide, spec["value"], .7, 2.0, 11.9, 1.55, 76, "accent", True, align=PP_ALIGN.CENTER)
            self.text(slide, spec["label"], 1.45, 3.85, 10.4, 1.0, 30, bold=True, align=PP_ALIGN.CENTER)
            if spec.get("context"):
                self.text(slide, spec["context"], 1.45, 5.2, 10.4, 1.05, 22, "muted", align=PP_ALIGN.CENTER)
        elif kind == "chart":
            self.chart(slide, spec["chart"])
            if spec.get("context"):
                self.text(slide, spec["context"], .8, 6.23, 11.8, .45, 16, "muted")
        elif kind == "table":
            self.table(slide, spec)
        elif kind == "photo":
            self.photo(slide, spec)
        elif kind == "quote":
            self.rect(slide, .75, 2.05, .07, 3.3, "accent")
            self.text(slide, spec["quote"], 1.15, 2.1, 10.9, 2.8, 32, heading=True)
            self.text(slide, spec["attribution"], 1.15, 5.4, 10.9, .8, 20, "muted")
        return slide

    def photo(self, slide, spec):
        image = spec["image"]
        text = bool(spec.get("body") or spec.get("bullets"))
        # A photo with text takes the right half (left in RTL); alone it fills the slide body.
        left, top, width, height = (6.75, 1.95, 5.9, 4.2) if text else (.65, 1.95, 12.0, 4.2)
        picture = slide.shapes.add_picture(str(image["path"]), 0, 0)
        scale = min(Inches(width) / picture.width, Inches(height) / picture.height)
        picture.width, picture.height = int(picture.width * scale), int(picture.height * scale)
        shown = picture.width / 914400
        offset = left + (width - shown) / 2
        picture.left, picture.top = Inches(self.x(offset, shown)), Inches(top + (height - picture.height / 914400) / 2)
        picture.name = "Photo"
        self.text(slide, f"{image['caption']} ({image['credit']})", left, top + height + .08, width, .55, 12, "muted")
        if spec.get("body"):
            self.text(slide, spec["body"], .65, 1.95, 5.75, 4.6, 22)
        elif spec.get("bullets"):
            self.bullets(slide, spec["bullets"], .75, 1.95, 5.65, 4.6)

    def chart(self, slide, spec):
        kind = spec.get("kind", "column")
        data = CategoryChartData()
        data.categories = spec["categories"]
        for series in spec["series"]:
            data.add_series(series["name"], series["values"])
        chart = slide.shapes.add_chart(CHARTS[kind], Inches(self.x(.75, 11.8)), Inches(1.95),
                                       Inches(11.8), Inches(4.15), data).chart
        chart.has_title = False
        apply_font(chart.font, 15, self.colors["text"], self.fonts["body"])
        chart.has_legend = len(spec["series"]) > 1 or kind == "pie"
        if chart.has_legend:
            chart.legend.position = XL_LEGEND_POSITION.BOTTOM
            chart.legend.include_in_layout = False
            apply_font(chart.legend.font, 14, self.colors["text"], self.fonts["body"])
        palette = [self.colors["accent"], self.colors["primary"], self.colors["muted"], "8197B8", "BBC9DF"]
        for i, series in enumerate(chart.series):
            color = rgb(palette[i % len(palette)])
            series.format.fill.solid()
            series.format.fill.fore_color.rgb = color
            series.format.line.color.rgb = color
            if kind == "pie":
                for j, point in enumerate(series.points):
                    point.format.fill.solid()
                    point.format.fill.fore_color.rgb = rgb(palette[j])
        plot = chart.plots[0]
        plot.has_data_labels = True
        labels = plot.data_labels
        apply_font(labels.font, 14, self.colors["on_dark"] if kind == "stacked_bar" else self.colors["text"], self.fonts["body"])
        labels.number_format = spec.get("number_format", "0.##")
        labels.position = XL_LABEL_POSITION.BEST_FIT if kind == "pie" else (
            XL_LABEL_POSITION.CENTER if kind == "stacked_bar" else XL_LABEL_POSITION.OUTSIDE_END)
        if kind == "line":
            labels.position = XL_LABEL_POSITION.ABOVE
        if kind == "pie":
            labels.show_category_name, labels.show_value = True, True
            chart.has_legend = False
        else:
            for axis in (chart.category_axis, chart.value_axis):
                apply_font(axis.tick_labels.font, 14, self.colors["muted"], self.fonts["body"])
                axis.has_major_gridlines = False
            if kind in {"bar", "column", "stacked_bar"}:
                all_values = [v for series in spec["series"] for v in series["values"]]
                # Zero remains visible; negative data is never clipped to a positive-only axis.
                minimum = min(0, min(all_values))
                if kind == "stacked_bar":
                    minimum = min(0, *(sum(min(0, series["values"][i]) for series in spec["series"])
                                       for i in range(len(spec["categories"]))))
                chart.value_axis.minimum_scale = minimum
            if self.rtl:
                scaling = chart.category_axis._element.find("{http://schemas.openxmlformats.org/drawingml/2006/chart}scaling")
                orientation = scaling.find("{http://schemas.openxmlformats.org/drawingml/2006/chart}orientation")
                if orientation is None:
                    orientation = OxmlElement("c:orientation")
                    scaling.append(orientation)
                orientation.set("val", "maxMin")

    def table(self, slide, spec):
        headers, rows = spec["headers"], spec["rows"]
        table = slide.shapes.add_table(len(rows) + 1, len(headers), Inches(.65), Inches(1.95),
                                       Inches(12), Inches(4.55)).table
        for row_index, row in enumerate([headers] + rows):
            for col_index, value in enumerate(row):
                physical_col = len(headers) - 1 - col_index if self.rtl else col_index
                cell = table.cell(row_index, physical_col)
                cell.margin_left = cell.margin_right = Inches(.12)
                cell.margin_top = cell.margin_bottom = Inches(.06)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                cell.fill.solid()
                cell.fill.fore_color.rgb = rgb(self.colors["primary" if row_index == 0 else (
                    "secondary" if row_index % 2 else "background")])
                cell.text_frame.clear()
                self.paragraph(cell.text_frame.paragraphs[0], str(value), 17,
                               "on_dark" if row_index == 0 else "text", row_index == 0)

    def normalize_fonts(self):
        # Theme/master defaults affect chart labels, complex scripts and later edits.
        # Remove inherited office defaults as well as setting every authored text run.
        for part in self.prs.part.package.iter_parts():
            if not part.content_type.endswith("+xml"):
                continue
            element = getattr(part, "_element", None)
            if element is None:
                if "/theme/" not in str(part.partname):
                    continue
                element = ET.fromstring(part.blob)
                for node in element.iter():
                    if "typeface" in node.attrib:
                        node.set("typeface", self.fonts["body"])
                part._blob = ET.tostring(element, encoding="utf-8", xml_declaration=True)
            else:
                for node in element.iter():
                    if "typeface" in node.attrib and ("/theme/" in str(part.partname) or
                            re.match(r"^(calibri|aptos)(?:$|[ -])", node.get("typeface", ""), re.I) or
                            node.get("typeface", "").lower() == "times new roman"):
                        node.set("typeface", self.fonts["body"])
                if "/charts/" in str(part.partname):
                    for paragraph in element.iter(f"{{{NS}}}p"):
                        props = paragraph.get_or_add_pPr()
                        props.set("rtl", "1" if self.rtl else "0")
                        if self.rtl:
                            props.set("algn", "r")
                        set_script_fonts(props.get_or_add_defRPr(), self.fonts["body"], self.language)

    def save(self, output):
        for number, spec in enumerate(self.content["slides"], 1):
            self.build_slide(spec, number)
        self.normalize_fonts()
        output = Path(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        self.prs.save(output)
        return output


def build(content_path, output, brand_path=None):
    content, brand = read_json(content_path), load_brand(brand_path)
    validate(content)
    if any("\u2014" in s for s in strings(brand)):
        raise ValueError("replace em dashes in brand text")
    return Deck(content, brand).save(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--content", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--brand", "--config", type=Path)
    args = parser.parse_args()
    try:
        output = build(args.content, args.output, args.brand)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f"Build failed: {exc}\n")
    print(f"Built {output} ({len(Presentation(output).slides)} slides)")


if __name__ == "__main__":
    main()
