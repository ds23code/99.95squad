"""Generate a validation suite of diverse, original (synthetic) papers.

These papers are NOT real exam content — they are original documents that
mimic the *characteristics* real papers exhibit, so the pipeline can be
validated against realistic input:

  1. DigitalMaths_Clean_2023_2U_wsols        clean embedded text layer
  2. BrokenFont_Maths_2023_2U_wsols          Symbol-font math (renders π, extracts "p")
  3. Scanned_Physics_2022                    pages are images, no text layer
  4. Chemistry_Trial_2023_wsols              chemistry content (equilibrium, acids, organic)
  5. DiagramHeavy_Maths_2024_3U_wsols        every question has drawn diagrams
  6. MultiPage_Maths_2022_2U_wsols           two questions span 2–3 pages
  7. NoSolutions_Maths_2021_2U               no answers / solutions section

Each entry carries ground-truth metadata so the validation report can score
detection accuracy. Usage:

    python -m pipeline validate                 # runs the built-in suite
    python scripts/make_validation_papers.py --out /tmp/vpapers
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import pymupdf

from pipeline.fonts import DEFAULT as FONTS

PAGE_W, PAGE_H = 595.0, 842.0

GROUND_TRUTH: list[dict] = [
    {
        "filename": "DigitalMaths_Clean_2023_2U_wsols.pdf",
        "expected_questions": 10,
        "multi_page": [6],
        "has_solutions": True,
        "text_layer": "clean",
        "course_id": "mathematics-advanced",
        "notes": "clean digital paper, MCQ + short answer + one multi-page question",
    },
    {
        "filename": "BrokenFont_Maths_2023_2U_wsols.pdf",
        "expected_questions": 10,
        "multi_page": [],
        "has_solutions": True,
        "text_layer": "broken",
        "course_id": "mathematics-advanced",
        "notes": "Symbol-font encoding: renders π/θ correctly, extracts as p/q",
    },
    {
        "filename": "Scanned_Physics_2022.pdf",
        "expected_questions": 8,
        "multi_page": [],
        "has_solutions": False,
        "text_layer": "scanned",
        "course_id": "physics",
        "notes": "image-only pages, no text layer (OCR required for layout)",
    },
    {
        "filename": "Chemistry_Trial_2023_wsols.pdf",
        "expected_questions": 8,
        "multi_page": [],
        "has_solutions": True,
        "text_layer": "clean",
        "course_id": "chemistry",
        "notes": "chemistry topics: equilibrium, acids and bases, organic",
    },
    {
        "filename": "DiagramHeavy_Maths_2024_3U_wsols.pdf",
        "expected_questions": 6,
        "multi_page": [],
        "has_solutions": True,
        "text_layer": "clean",
        "course_id": "mathematics-extension-1",
        "notes": "every question includes a drawn diagram",
    },
    {
        "filename": "MultiPage_Maths_2022_2U_wsols.pdf",
        "expected_questions": 5,
        "multi_page": [2, 4],
        "has_solutions": True,
        "text_layer": "clean",
        "course_id": "mathematics-advanced",
        "notes": "two questions spanning multiple pages",
    },
    {
        "filename": "NoSolutions_Maths_2021_2U.pdf",
        "expected_questions": 6,
        "multi_page": [],
        "has_solutions": False,
        "text_layer": "clean",
        "course_id": "mathematics-advanced",
        "notes": "questions only, no answer section",
    },
]


# --------------------------------------------------------------------------
# building helpers
# --------------------------------------------------------------------------
def _text(page: pymupdf.Page, x: float, y: float, s: str, size: float = 11,
          bold: bool = False, symb: bool = False) -> float:
    if symb:
        # deliberate broken-font simulation: Symbol font renders π/θ but
        # the text layer extracts as p/q (see docs/QUALITY.md)
        page.insert_text((x, y), s, fontsize=size, fontname="symb")
    else:
        return FONTS.text(page, x, y, s, size=size, bold=bold)
    return y + size * 1.35


def _q(page: pymupdf.Page, x: float, y: float, num: int, marks: int) -> float:
    return _text(page, x, y, f"Question {num} ({marks} marks)", 11, bold=True)


def _options(page: pymupdf.Page, x: float, y: float, opts: list[str]) -> float:
    labels = ["A.", "B.", "C.", "D."]
    for label, text in zip(labels, opts):
        y = _text(page, x + 12, y, f"{label} {text}", 10.5)
        y += 3
    return y


def _graph(page: pymupdf.Page, x: float, y: float, w: float, h: float,
           fn="sin", color=(0.1, 0.3, 0.8)) -> None:
    page.draw_line(pymupdf.Point(x, y + h), pymupdf.Point(x + w, y + h), color=(0.3, 0.3, 0.3), width=1)
    page.draw_line(pymupdf.Point(x, y), pymupdf.Point(x, y + h), color=(0.3, 0.3, 0.3), width=1)
    pts = []
    for i in range(0, 101):
        px = x + i * w / 100
        if fn == "sin":
            py = y + h / 2 - 4 * math.sin(math.pi * (i / 100) * 2) * (h / 2 / 4.5)
        elif fn == "parabola":
            py = y + h - ((i / 100) - 0.5) ** 2 * 4 * h
        else:
            py = y + h / 2 + ((i / 100) - 0.5) * h * 0.6
        pts.append(pymupdf.Point(px, py))
    page.draw_polyline(pts, color=color, width=1.2)


def _triangle(page: pymupdf.Page, x: float, y: float, size: float) -> None:
    page.draw_line(pymupdf.Point(x, y + size), pymupdf.Point(x + size, y + size), color=(0.2, 0.2, 0.2))
    page.draw_line(pymupdf.Point(x, y + size), pymupdf.Point(x + size / 2, y), color=(0.2, 0.2, 0.2))
    page.draw_line(pymupdf.Point(x + size / 2, y), pymupdf.Point(x + size, y + size), color=(0.2, 0.2, 0.2))


def _circuit(page: pymupdf.Page, x: float, y: float, w: float, h: float) -> None:
    page.draw_rect(pymupdf.Rect(x, y, x + w, y + h), color=(0.2, 0.2, 0.2), width=1)
    page.draw_line(pymupdf.Point(x + w / 2, y), pymupdf.Point(x + w / 2, y + h / 3), color=(0.2, 0.2, 0.2))
    page.draw_circle(pymupdf.Point(x + w / 2, y + h / 3 + 10), 8, color=(0.2, 0.2, 0.2), width=1)
    page.draw_line(pymupdf.Point(x + w / 2, y + h / 3 + 18), pymupdf.Point(x + w / 2, y + h), color=(0.2, 0.2, 0.2))


def _arrow(page: pymupdf.Page, x: float, y: float, dx: float, dy: float) -> None:
    page.draw_line(pymupdf.Point(x, y), pymupdf.Point(x + dx, y + dy), color=(0.8, 0.2, 0.2), width=1.6)
    import math as _m

    ang = _m.atan2(dy, dx)
    L = 8
    for off in (0.6, -0.6):
        page.draw_line(
            pymupdf.Point(x + dx, y + dy),
            pymupdf.Point(x + dx - L * _m.cos(ang - off), y + dy - L * _m.sin(ang - off)),
            color=(0.8, 0.2, 0.2), width=1.4,
        )


def _answers(page: pymupdf.Page, answers: list[str], worked: list[tuple[str, str]]) -> None:
    y = 70
    y = _text(page, 50, y, "Answers", 16, bold=True)
    for ans in answers:
        y = _text(page, 50, y + 3, ans, 10.5)
    y += 14
    y = _text(page, 50, y, "Worked Solutions", 14, bold=True)
    for title, body in worked:
        y = _text(page, 50, y + 3, title, 10.5, bold=True)
        y = _text(page, 62, y + 3, body, 10)


# --------------------------------------------------------------------------
# individual papers
# --------------------------------------------------------------------------
def _clean_maths(doc, symb=False) -> None:
    """Shared maths content builder (used for clean + broken-font papers)."""
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 60
    y = _text(page, 50, y, "Northside High 2023 Mathematics Advanced — Trial", 16, bold=True, symb=symb)
    y = _text(page, 50, y + 2, "Section I — Multiple Choice", 12, bold=True, symb=symb)
    y += 8
    for num, (stem, opts) in enumerate([
        ("The value of sin(\u03c0/3) is:", ["1/2", "\u221a3/2", "1", "\u221a2/2"]),
        ("The derivative of x\u00b2e^x is:", ["e\u02e3(x\u00b2+2x)", "2xe^x", "x\u00b2e^x", "e\u02e3(2x)"]),
        ("For a normal distribution, 95% of data lies within:", ["1 sd", "2 sd", "3 sd", "4 sd"]),
        ("If log\u2081\u2080x = 3, then x =", ["30", "300", "1000", "3"]),
    ], start=1):
        y = _q(page, 50, y, num, 1)
        y = _text(page, 50, y + 3, stem, 11, symb=symb)
        y = _options(page, 50, y + 4, opts)
        y += 10

    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 60
    y = _q(page, 50, y, 5, 2)
    y = _text(page, 50, y + 3, "Differentiate y = x\u00b3ln(x).", 11, symb=symb)
    y += 22
    y = _q(page, 50, y, 6, 4)
    y = _text(page, 50, y + 3, "(a) Find \u222b(6x\u00b2 \u2212 4x + 1) dx.", 11, symb=symb)
    y = _text(page, 50, y + 3, "(b) Find the area bounded by y = 6x\u00b2 \u2212 4x + 1 and the x-axis", 11, symb=symb)
    y = _text(page, 50, y + 3, "     from x = 0 to x = 2.", 11, symb=symb)
    y += 22
    y = _q(page, 50, y, 7, 3)
    y = _text(page, 50, y + 3, "Solve 2cos(x) \u2212 1 = 0 for 0 \u2264 x \u2264 2\u03c0.", 11, symb=symb)
    y += 22
    y = _q(page, 50, y, 8, 2)
    y = _text(page, 50, y + 3, "(a) Write down the first three terms of the sequence t\u2081 = 3, t\u2099\u208a\u2081 = t\u2099 + 5.", 11, symb=symb)
    y = _text(page, 50, y + 3, "(b) Find the 20th term.", 11, symb=symb)

    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 70
    y = _q(page, 50, y, 9, 2)
    y = _text(page, 50, y + 3, "The heights of students are normally distributed with mean 170 cm and", 11, symb=symb)
    y = _text(page, 50, y + 3, "standard deviation 8 cm. Find P(X > 186).", 11, symb=symb)
    y += 22
    y = _q(page, 50, y, 10, 2)
    y = _text(page, 50, y + 3, "$5000 is invested at 4% p.a. compounded quarterly. Find the value after 3 years.", 11, symb=symb)


def _clean_paper(path: Path, symb: bool) -> None:
    doc = pymupdf.open()
    _clean_maths(doc, symb=symb)
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    if symb:
        _answers(
            page,
            ["1. B", "2. A", "3. B", "4. C", "5. 3x\u00b2ln x + x\u00b2", "6. (a) 2x\u00b3 \u2212 2x\u00b2 + x + C"],
            [("Solution 1", "sin(\u03c0/3) = \u221a3/2 from the unit circle."),
             ("Solution 6", "\u222b(6x\u00b2 \u2212 4x + 1) dx = 2x\u00b3 \u2212 2x\u00b2 + x + C.")],
        )
    else:
        _answers(
            page,
            ["1. B", "2. A", "3. B", "4. C", "5. 3x\u00b2ln x + x\u00b2", "6. (a) 2x\u00b3 \u2212 2x\u00b2 + x + C",
             "7. x = \u03c0/3, 5\u03c0/3", "8. (a) 3, 8, 13", "9. 0.025", "10. $5637"],
            [("Solution 1", "sin(\u03c0/3) = \u221a3/2 from the unit circle."),
             ("Solution 6", "\u222b(6x\u00b2 \u2212 4x + 1) dx = 2x\u00b3 \u2212 2x\u00b2 + x + C."),
             ("Solution 9", "186 cm is two standard deviations above the mean.")],
        )
    doc.save(str(path))
    doc.close()


def _scanned_physics(path: Path) -> None:
    """Physics paper: render pages to images so the PDF has NO text layer."""
    tmp = path.parent / (path.stem + "_tmp.pdf")
    doc = pymupdf.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 60
    y = _text(page, 50, y, "Lakeside High 2022 Physics — Trial Examination", 16, bold=True)
    y = _text(page, 50, y + 2, "Attempt all questions. Marks shown in brackets.", 10)
    y += 14
    physics_qs = [
        (1, 2, "A car accelerates from rest at 4 m/s\u00b2 for 5 s. Find its final velocity.", "kinematics"),
        (2, 3, "A projectile is launched at 30\u00b0 with speed 20 m/s. Find the maximum height.", "kinematics"),
        (3, 3, "A 2 kg mass is pulled along a rough surface (\u03bc = 0.3) by a 10 N force. Find the friction force.", "dynamics"),
        (4, 2, "State Newton's third law and give an example.", "dynamics"),
    ]
    for num, marks, stem, _topic in physics_qs:
        y = _q(page, 50, y, num, marks)
        y = _text(page, 50, y + 3, stem, 11)
        if num == 2:
            _arrow(page, 150, y + 30, 60, -40)
            y += 40
        if num == 4:
            _arrow(page, 150, y + 20, 60, 0)
            _arrow(page, 150, y + 34, -60, 0)
            y += 50
        y += 16

    # second page (realistic multi-page scan)
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 60
    physics_qs2 = [
        (5, 3, "A wave has frequency 500 Hz and wavelength 0.68 m. Find its speed.", "waves"),
        (6, 4, "(a) Draw a circuit with a 12 V battery and two 6 \u03a9 resistors in series.", "electricity"),
        (7, 3, "A force of 8 N acts at 60\u00b0 to the horizontal. Resolve it into components.", "dynamics"),
        (8, 2, "Define electric current and state its SI unit.", "electricity"),
    ]
    for num, marks, stem, _topic in physics_qs2:
        y = _q(page, 50, y, num, marks)
        y = _text(page, 50, y + 3, stem, 11)
        if num == 6:
            _circuit(page, 120, y + 14, 120, 70)
            y += 90
        y += 16

    doc.save(str(tmp))
    doc.close()

    # rasterize every page into a new image-only PDF (simulates a scan)
    src = pymupdf.open(str(tmp))
    out = pymupdf.open()
    for i in range(len(src)):
        pix = src.load_page(i).get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5), alpha=False)
        img_path = path.parent / f"{path.stem}_p{i}.png"
        pix.save(str(img_path))
        npage = out.new_page(width=PAGE_W, height=PAGE_H)
        npage.insert_image(npage.rect, filename=str(img_path))
        img_path.unlink()
    out.save(str(path))
    out.close()
    src.close()
    tmp.unlink()


def _chemistry(path: Path) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 60
    y = _text(page, 50, y, "Harbour College 2023 Chemistry — Trial Examination", 16, bold=True)
    y += 14
    chem_qs = [
        (1, 2, "Write the equilibrium expression Kc for N\u2082(g) + 3H\u2082(g) \u21cc 2NH\u2083(g)."),
        (2, 3, "State Le Chatelier's principle and predict the effect of increasing pressure."),
        (3, 2, "Calculate the pH of a 0.01 M solution of HCl."),
        (4, 3, "Name the functional group in CH\u2083CH\u2082OH and write its structural formula."),
        (5, 2, "Balance the equation: C\u2083H\u2088 + O\u2082 \u2192 CO\u2082 + H\u2082O."),
        (6, 3, "Explain the difference between a strong and a weak acid, giving one example of each."),
        (7, 2, "During a titration, 25.0 mL of NaOH neutralises 20.0 mL of 0.10 M HCl. Find [NaOH]."),
        (8, 3, "Describe an addition polymer. Draw the repeat unit of polyethene."),
    ]
    for num, marks, stem in chem_qs:
        y = _q(page, 50, y, num, marks)
        y = _text(page, 50, y + 3, stem, 11)
        if num == 7:
            y += 6
        y += 14
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    _answers(
        page,
        ["1. Kc = [NH\u2083]\u00b2/([N\u2082][H\u2082]\u00b3)", "2. pressure increase shifts right",
         "3. pH = 2", "4. alcohol, CH\u2083CH\u2082OH", "5. C\u2083H\u2088 + 5O\u2082 \u2192 3CO\u2082 + 4H\u2082O",
         "6. strong fully ionises (HCl); weak partially (CH\u2083COOH)", "7. 0.08 M"],
        [("Solution 1", "Only gases appear in Kc: [NH\u2083]\u00b2/([N\u2082][H\u2082]\u00b3)."),
         ("Solution 3", "pH = \u2212log(0.01) = 2.")],
    )
    doc.save(str(path))
    doc.close()


def _diagram_heavy(path: Path) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 60
    y = _text(page, 50, y, "2024 Mathematics Extension 1 — Diagram Practice", 16, bold=True)
    y += 12
    pairs = [
        (1, 2, "Sketch y = 4sin(\u03c0x) for 0 \u2264 x \u2264 2.", "sin", "The period of y = 4sin(\u03c0x) is 2."),
        (2, 2, "Sketch y = x\u00b2 \u2212 4x + 3.", "parabola", "Roots at x = 1 and x = 3."),
        (3, 3, "Find the length of the side marked x in the triangle.", "triangle", "x = 5 cm (3-4-5 triangle)."),
        (4, 2, "The graph shows y = f(x). State the number of stationary points.", "sin", "Two stationary points."),
        (5, 3, "Sketch the curve y = 1/(x \u2212 2) showing the asymptote.", "parabola", "Vertical asymptote x = 2."),
        (6, 2, "Describe the transformation that maps y = x\u00b3 to y = 2(x \u2212 1)\u00b3.", "sin", "Vertical stretch by 2, shift right 1."),
    ]
    for num, marks, stem, kind, sol in pairs:
        if y > PAGE_H - 160:
            page = doc.new_page(width=PAGE_W, height=PAGE_H)
            y = 60
        y = _q(page, 50, y, num, marks)
        y = _text(page, 50, y + 3, stem, 11)
        if kind == "triangle":
            _triangle(page, 90, y + 8, 90)
            y += 100
        else:
            _graph(page, 90, y + 10, 170, 80, fn=kind)
            y += 100
        y += 14
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    _answers(page, [f"{i}. " + b for i, b in enumerate(
        ["period 2", "roots 1,3", "5 cm", "two", "x = 2", "stretch 2, shift 1"], start=1)],
        [(f"Solution {i}", b) for i, b in enumerate(
            ["The period of y = 4sin(\u03c0x) is 2.", "x\u00b2 \u2212 4x + 3 = (x\u22121)(x\u22123).",
             "3-4-5 triangle.", "Two stationary points.", "Vertical asymptote x = 2.",
             "Vertical stretch by 2, then translate right 1."], start=1)])
    doc.save(str(path))
    doc.close()


def _multipage(path: Path) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 60
    y = _text(page, 50, y, "2022 Mathematics Advanced — Multi-page questions", 16, bold=True)
    y += 12
    y = _q(page, 50, y, 1, 2)
    y = _text(page, 50, y + 3, "Find the exact value of cos(\u03c0/3).", 11)
    y += 20
    # Question 2 is the LAST question on this page; it continues on page 2
    # (the layout real papers use, so the continuation is unambiguous).
    y = _q(page, 50, y, 2, 6)
    y = _text(page, 50, y + 3, "Consider f(x) = x\u00b3 \u2212 6x\u00b2 + 9x.", 11)
    y = _text(page, 50, y + 3, "(a) Find f\u2032(x) and the stationary points.", 11)
    y = _text(page, 50, y + 3, "(b) Determine their nature.", 11)

    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 70
    y = _text(page, 50, y, "(c) Sketch y = f(x) labelling all intercepts.", 11)
    _graph(page, 90, y + 10, 170, 90, fn="parabola")
    y = _text(page, 50, y + 110, "(d) Find the area bounded by the curve and the x-axis.", 11)
    y += 130
    y = _q(page, 50, y, 3, 2)
    y = _text(page, 50, y + 3, "A bag has 4 red and 6 blue marbles. Find P(two red without replacement).", 11)
    y += 20
    # Question 4 is last on this page; continues on page 3.
    y = _q(page, 50, y, 4, 5)
    y = _text(page, 50, y + 3, "The function g(x) = 3sin(2x) is defined for 0 \u2264 x \u2264 2\u03c0.", 11)
    y = _text(page, 50, y + 3, "(a) State the amplitude and period.", 11)
    y = _text(page, 50, y + 3, "(b) Solve g(x) = 1.5 for 0 \u2264 x \u2264 2\u03c0.", 11)

    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 70
    y = _text(page, 50, y, "(c) Sketch one full cycle of y = g(x).", 11)
    _graph(page, 90, y + 10, 170, 80, fn="sin")
    y += 100
    y = _q(page, 50, y, 5, 2)
    y = _text(page, 50, y + 3, "Find the 8th term of the geometric sequence 2, 6, 18, \u2026", 11)

    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    _answers(
        page,
        ["1. 1/2", "2. (a) f\u2032 = 3x\u00b2 \u2212 12x + 9 = 0 at x = 1, 3", "3. 2/15",
         "4. (a) amp 3, period \u03c0", "5. 4374"],
        [("Solution 2", "f\u2032(x) = 3(x\u22121)(x\u22123)."), ("Solution 4", "3sin(2x) = 1.5 \u21d2 sin(2x) = 0.5.")],
    )
    doc.save(str(path))
    doc.close()


def _no_solutions(path: Path) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 60
    y = _text(page, 50, y, "2021 Mathematics Advanced — Paper 2", 16, bold=True)
    y += 12
    qs = [
        (1, 2, "Solve 3x \u2212 7 = 2x + 5."),
        (2, 3, "The points A(1, 2) and B(5, 8) lie on a line. Find its equation."),
        (3, 2, "Evaluate \u222b\u2080\u00b9 (3x\u00b2) dx."),
        (4, 3, "A car travels 240 km in 3 hours. Find the average speed in m/s."),
        (5, 2, "Write 0.000045 in scientific notation."),
        (6, 3, "Find the probability of rolling two dice and getting a sum of 7."),
    ]
    for num, marks, stem in qs:
        y = _q(page, 50, y, num, marks)
        y = _text(page, 50, y + 3, stem, 11)
        y += 18
    doc.save(str(path))
    doc.close()


def make_validation_papers(out_dir: str | Path) -> list[dict]:
    """Generate all papers; returns the ground-truth list."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for entry in GROUND_TRUTH:
        path = out_dir / entry["filename"]
        if path.exists():
            continue
        name = entry["filename"]
        if name.startswith("DigitalMaths"):
            _clean_paper(path, symb=False)
        elif name.startswith("BrokenFont"):
            _clean_paper(path, symb=True)
        elif name.startswith("Scanned"):
            _scanned_physics(path)
        elif name.startswith("Chemistry"):
            _chemistry(path)
        elif name.startswith("DiagramHeavy"):
            _diagram_heavy(path)
        elif name.startswith("MultiPage"):
            _multipage(path)
        elif name.startswith("NoSolutions"):
            _no_solutions(path)
    return list(GROUND_TRUTH)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="data/exports/validation_papers")
    args = parser.parse_args()
    make_validation_papers(args.out)
    print(f"validation papers written to {args.out}")
