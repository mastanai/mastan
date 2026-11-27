# Presentation Design Skill

## Philosophy

Slides are **standalone documents**, not visual aids. A reader should understand your argument from titles alone. Lead with conclusions, support with evidence.

---

## Core Frameworks

### 1. Pyramid Principle (McKinsey/Minto)

**Present top-down, not bottom-up.**

```
LEVEL 1: Main Point (Recommendation/Conclusion)
    ↓
LEVEL 2: Key Arguments (3-4 supporting reasons)
    ↓
LEVEL 3: Evidence (Data, analysis, details)
```

**Every evidence slide title states its supported conclusion. A cover may name the subject.**
- ❌ "Q3 Sales Performance"
- ✅ "Q3 sales exceeded target by 15% driven by MENA expansion"

### 2. SCQA Framework (Opening Structure)

| Element | Purpose | Example |
|---------|---------|---------|
| **S**ituation | Shared context | "Company has grown 15% annually for 5 years" |
| **C**omplication | What changed | "Growth markets are saturating" |
| **Q**uestion | What to address | "How do we sustain growth?" |
| **A**nswer | Your recommendation | "Enter the German market" |

### 3. MECE (Mutually Exclusive, Collectively Exhaustive)

- **Mutually Exclusive**: No overlaps between categories
- **Collectively Exhaustive**: No gaps - all possibilities covered

Test: "Can any item fit in two buckets?" → Fix overlap  
Test: "Is anything missing?" → Add category or scope out

---

## Visual Hierarchy Principles

### Size = Importance
- Titles: 28-36pt
- Subtitles: 20-24pt
- Body: 14-18pt
- Source/footnotes: 10-12pt
- **Ratio guideline**: 3:1 between headers and body

### Color Strategy
- **Brand primary**: Headlines, key data
- **Brand secondary**: Supporting elements
- **Gray/muted**: Less important details
- **Accent color**: Call-outs, highlights (use sparingly)
- **Accessible encoding**: Don't rely on color alone; add labels or patterns

### Reading Flow

Mirror the following flow for Arabic: start top-right, read right-to-left and mirror comparisons, timelines and table columns. Page numbers stay bottom-right.

- Eye starts **top-left**
- Moves **left-to-right**, **top-to-bottom**
- Use this for information priority
- Bold/color draws attention - use to indicate starting point

### White Space
- Margins: Minimum 0.5" on all sides
- Don't crowd - let key elements breathe
- White space = visual rest = comprehension

---

## Slide Types & Structures

### 1. Title Slide
- Company/client name
- Presentation title (action-oriented)
- Date, presenter name
- Logo placement per brand guidelines

### 2. Executive Summary (1-2 slides)
- SCQA structure
- 3-5 key findings/recommendations
- Page references to detail sections

### 3. Section Divider
- Section title (action title, not topic)
- Optional: Key message preview
- Consistent placement across deck

### 4. Content Slide (Standard)
```
┌─────────────────────────────────────────┐
│ ACTION TITLE (conclusion statement)     │
├─────────────────────────────────────────┤
│                                         │
│  ┌─────────┐    ┌─────────┐            │
│  │ Visual  │    │ Visual  │            │
│  │  or     │    │  or     │            │
│  │ Data    │    │ Data    │            │
│  └─────────┘    └─────────┘            │
│                                         │
│  • Key point 1                          │
│  • Key point 2                          │
│  • Key point 3                          │
│                                         │
├─────────────────────────────────────────┤
│ Source: [citation]            Page XX   │
└─────────────────────────────────────────┘
```

### 5. Data/Chart Slide
- Chart title = insight, not description
- ❌ "Revenue by Region"
- ✅ "MENA drives 60% of revenue growth"
- Label data directly (not in legend when possible)
- Source every number

### 6. Comparison Slide
- Side-by-side or matrix format
- Clear labels for each option
- Highlight recommendation

### 7. Timeline/Process
- Left-to-right or top-to-bottom flow
- Numbered steps
- Visual connectors between stages

### 8. Appendix
- Detailed data, methodology, sources
- Reference from main deck
- Same formatting standards

---

## Executive Presentation Standards

### Action Titles
Write action titles as **complete thoughts** stating the slide's supported conclusion. Use a natural subject title for the cover.

| Bad (Topic) | Good (Action) |
|-------------|---------------|
| "Market Overview" | "The market will grow 12% annually through 2028" |
| "Competitor Analysis" | "Three competitors control 80% of market share" |
| "Recommendations" | "We recommend three initiatives to capture $50M" |

### One Message Per Slide
- If you have two points, you need two slides
- Audience should absorb message in <5 seconds
- "Newspaper test": Could this be a headline?

### Source Everything
- Every chart, every number, every claim
- Format: `Source: [Publication], [Date]` or `Source: Company analysis`
- Bottom-left or bottom-right, 10pt font

### Consistent Formatting
- Same margins, fonts, colors throughout
- Page numbers bottom-right on every slide, including Arabic
- No copyright footer; sources and page numbers only unless the user requests another label

---

## Typography

### Font Selection
- **Headings**: Sans-serif (bold) - Arial (default); another family only when explicitly requested
- **Body**: Arial (regular), including complex-script runs and theme defaults
- **Avoid**: Decorative fonts, too many font families (max 2)

### Text Rules
- No more than 6 bullet points per slide across all columns combined
- No more than 6 words per bullet (ideal)
- Natural sentence case in the user's language; preserve its capitalization conventions
- Left-align LTR body text; right-align Arabic with RTL paragraph direction (not justified)

---

## Data Visualization

### Chart Selection
| Data Type | Best Chart |
|-----------|------------|
| Comparison | Bar chart (horizontal if labels long) |
| Trend over time | Line chart |
| Part of whole | Pie chart (max 5 slices) or stacked bar |
| Correlation | Scatter plot |
| Distribution | Histogram |

### Chart Rules
- Remove chartjunk (gridlines, 3D effects, unnecessary borders)
- Direct label > legend
- Highlight the insight (color, callout)
- Y-axis starts at 0 for bar charts
- Title = insight, not description

---

## python-pptx Implementation

### Setup
```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
```

### Create Presentation
```python
# From template (recommended)
prs = Presentation('template.pptx')

# From scratch
prs = Presentation()
prs.slide_width = Inches(13.333)  # 16:9
prs.slide_height = Inches(7.5)
```

### Add Slide
```python
# Get layout from template
layout = prs.slide_layouts[1]  # Usually title + content
slide = prs.slides.add_slide(layout)

# Access placeholders
title = slide.shapes.title
title.text = "Action Title Goes Here"
```

### Add Text Box
```python
left = Inches(0.5)
top = Inches(1.5)
width = Inches(5)
height = Inches(1)

txBox = slide.shapes.add_textbox(left, top, width, height)
tf = txBox.text_frame
tf.word_wrap = True

p = tf.paragraphs[0]
p.text = "Key insight text"
p.font.size = Pt(18)
p.font.bold = True
p.font.color.rgb = RGBColor(0x00, 0x00, 0x00)
```

### Add Bullet Points
```python
tf = shape.text_frame
tf.clear()

p = tf.paragraphs[0]
p.text = "First bullet point"
p.level = 0

p = tf.add_paragraph()
p.text = "Second bullet point"
p.level = 0

p = tf.add_paragraph()
p.text = "Sub-bullet"
p.level = 1
```

### Add Image
```python
slide.shapes.add_picture(
    'image.png',
    left=Inches(1),
    top=Inches(2),
    width=Inches(4)  # Height auto-scales
)
```

### Add Table
```python
rows, cols = 3, 4
table = slide.shapes.add_table(rows, cols, left, top, width, height).table

# Set column widths
table.columns[0].width = Inches(2)

# Add content
table.cell(0, 0).text = "Header"
table.cell(1, 0).text = "Data"
```

### Add Chart
```python
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE

chart_data = CategoryChartData()
chart_data.categories = ['Q1', 'Q2', 'Q3', 'Q4']
chart_data.add_series('Revenue', (100, 120, 140, 160))

chart = slide.shapes.add_chart(
    XL_CHART_TYPE.COLUMN_CLUSTERED,
    left, top, width, height,
    chart_data
).chart
```

### Save
```python
prs.save('output.pptx')
```

---

## Workflow

### 1. Receive Brief
- Audience: Who is this for?
- Purpose: Inform, persuade, decide?
- Key message: What's the one takeaway?
- Length: How many slides/minutes?

### 2. Outline (Pyramid)
1. Write main conclusion first
2. Identify 3-4 supporting arguments
3. List verified evidence for each argument; label hypothetical examples explicitly
4. Map to slide count

### 3. Draft
- Action titles first (should tell the story alone)
- Rough content placement
- Identify needed visuals/data

### 4. Design
- Apply template/branding
- Create/source visuals
- Format consistently

### 5. Review
- Render and look at every slide image; automatic checks alone cannot establish visual quality
- At most two rebuilds after the initial build
- Read titles only - does story flow?
- Check sources cited
- Verify data accuracy
- Test on target device/projector

---

## Folder Structure

Use one job folder in the workspace, `tasks/<job>/`. Keep paths relative inside it.

```
tasks/<job>/
├── input/             # Copies of the user's source files and supplied brand assets
├── content.json       # Slide content for the engine
├── brand.json         # Only for an explicitly requested brand
├── previews/          # Checker output: report, PDF, slide PNGs
└── <Deck>_YYYY-MM-DD.pptx
```

## File Naming Rules

- **Always** append the date to output filenames: `_YYYY-MM-DD`
- Format: `Description_YYYY-MM-DD.pptx`
- Example: `Quarterly_Update_2026-03-15.pptx`

---

## 🎯 Design Thinking Process (Do This FIRST)

**Before authoring slides, complete these 5 design steps using the supplied brief and evidence.**

### Step 1: Identify the Story
Ask: **What should the audience think or feel after seeing this?**

- Don't start with layout. Start with the message.
- Every slide should have ONE takeaway. If you can't state it in one sentence, the slide is doing too much.
- For data slides: what's the "so what"? Numbers without context are forgettable.

**Example:**
- ❌ "Show 1,200 leads, 300 qualified, 45 customers" (just data)
- ✅ "Show how 1,200 leads narrow to 45 customers, and where most are lost" (a story about focus and conversion)
- (Illustrative numbers, not real data.)

### Step 2: Establish Visual Hierarchy
Decide what the eye should land on FIRST, SECOND, THIRD.

- **Not everything can be important.** If all elements have equal visual weight, nothing stands out.
- Most important → largest font, boldest color, most space
- Supporting details → smaller font, muted colors, less space
- Context/footnotes → smallest font, gray, bottom of slide

| Tool | Effect |
|------|--------|
| Font size gap | A clear gap between title, body and sources creates hierarchy |
| Color saturation | Brand primary for key, gray for secondary |
| Spatial prominence | Top-left and center get seen first |
| Whitespace | Empty space around an element makes it feel important |

### Step 3: Choose Layout Based on Content Type
Don't default to bullets. Match the layout to the content:

| Content Type | Best Layout |
|---|---|
| 3-6 key metrics | Card grid (2×2 or 2×3) |
| Process/pipeline | Horizontal flow with arrows |
| Comparison | Side-by-side columns |
| Single big insight | Hero number + supporting text |
| Timeline | Horizontal or vertical steps |
| Mixed data + narrative | Split layout (left text, right visuals) |

### Step 4: Apply Color with Intent
Every color choice should mean something. Don't assign colors randomly.

**The "60-30-10" rule:**
- 60% dominant (white or dark background)
- 30% secondary (accent cards, backgrounds)
- 10% highlight (specific emphasis only)

### Step 5: Manage Information Density
For slides with lots of data:

- **Split into zones.** Left column for one category, right for another
- **Use anchor bars** at bottom/top to group secondary info
- **Consistent element sizing.** All cards same height, all rows same height
- **Minimum 0.15" gaps** between elements

---

## 📐 Layout Patterns Library

Use these proven patterns instead of inventing layouts from scratch.

### Pattern: Metric Card
```
┌─────────────────────┐
│ 🎯 Label            │  ← Label, 16-18pt
│                     │
│   1,200             │  ← Big number, 26-36pt, bold
│                     │
│   Sub-text          │  ← Context, 16-18pt, muted
└─────────────────────┘
```

### Pattern: Funnel/Pipeline Row
```
┌──────┐     ┌──────┐     ┌──────┐
│ 1200 │  →  │ 300  │  →  │  45  │
│Leads │     │Fit   │     │Won   │
└──────┘     └──────┘     └──────┘
```
Use decreasing intensity to show narrowing.

### Pattern: Split Dashboard
```
┌─────────────┬─────────────┐
│  Left data  │  Right data │
├─────────────┴─────────────┤
│  Context bar / summary    │
└───────────────────────────┘
```

### Pattern: Hero Number
```
┌───────────────────────────┐
│                           │
│        12,500             │  ← 48-64pt, bold
│     Orders delivered      │  ← 16-20pt, muted
│     across 4 regions      │
│                           │
└───────────────────────────┘
```

### Pattern: Dark Header Strip
```
┌───────────────────────────┐
│ SECTION    Title Text     │  ← Dark bg, accent label, white title
├───────────────────────────┤
│  (content below)          │
└───────────────────────────┘
```

---

## 📊 Data Storytelling Rules

### Always Add Context to Numbers
- ❌ "1,200 leads" (so what?)
- ✅ "1,200 leads → 300 qualified → 45 customers" (conversion story, illustrative)

### Show Relationships, Not Just Values
- ❌ 4 separate numbers in 4 separate boxes
- ✅ How those numbers relate: funnel, progression, cause→effect

### Use Benchmarks When Available
- "4.5/5 satisfaction" is good
- "4.5/5 satisfaction (industry avg: 3.8)" is better

### Label Your Categories
Name your metric groups: "SCALE", "REACH", "QUALITY". Gives audience a mental framework.

### Breakdowns Should Add Up
If you say "45 customers" then show a breakdown, the parts must equal 45. Include "Other" if needed.

---

## ❌ Common Mistakes to Avoid

| Mistake | Fix |
|---------|-----|
| All elements same visual weight | Create 3+ levels of hierarchy |
| Random color assignment | Give each color a meaning and stick to it |
| Text overflow / cramping | Shorten copy, split slides or enlarge the box before reducing font size |
| Disconnected layout | Use alignment, shared backgrounds, anchor bars |
| Bullets for everything | Use cards, grids, flows - bullets are last resort |
| Generic subtitle placeholder | Write a real subtitle that frames the message |
| Numbers without context | Add conversion rates, benchmarks, trends |
| Inconsistent spacing | Set a grid (e.g., 0.2" gaps) and stick to it |

---

## Quick Reference Card

| Principle | Rule |
|-----------|------|
| Title | Action statement, not topic |
| Message | One per slide |
| Bullets | Max 6 points, max 6 words each |
| Sources | Cite every number |
| Fonts | Max 2 families |
| Colors | Brand palette + 1 accent |
| Data | Insight title, direct labels |

---

## Adaptations

- All slide copy, chart labels, sources, speaker notes and delivery captions use the user's language.
- The engine always writes Arial by default, including Latin, East Asian and complex-script font declarations.
  See the package README for Liberation Sans, DejaVu Sans and Noto Sans Arabic rendering fallbacks.
- No em dashes or copyright/rights footers. Source every number, including user data and assumptions.
- Keep source data private: aggregate personal records and exclude identifiers from notes as well as slides.
- Never read another user's saved brand or copy a private organization's assets.
- Native charts and tables remain editable. Check every embedded value against its category and source.
- The pattern sizes are conceptual, not a reason to shrink labels below legibility. Use the engine's larger
  type sizes, remove filler, and split crowded content. Do not fabricate benchmarks to supply context.
- Factual examples in this reference demonstrate wording, not real market data or evidence for a new deck.
