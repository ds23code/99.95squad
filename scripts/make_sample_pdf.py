"""Generate a synthetic "TrialMaths 2023 2U" style PDF for testing.

This is NOT a real paper — it is an original, synthetic document that mimics
the *structure* of an HSC trial paper (Section I MCQs, numbered questions,
subparts, a multi-page question, a diagram, an answer section and worked
solutions) so the pipeline can be exercised end-to-end on realistic input.

Fonts are resolved cross-platform via ``pipeline.fonts`` (bundled DejaVu in
``assets/fonts/``, with system-font and PyMuPDF built-in fallbacks) — no user
font installation required on macOS, Linux, Windows or CI.

Usage:
    python -m pipeline sample [--out data/papers/TrialMaths_2023_2U_wsols_sample.pdf]
"""

from __future__ import annotations

import sys
from pathlib import Path

import pymupdf

from pipeline.fonts import DEFAULT as FONTS

PAGE_W, PAGE_H = 595.0, 842.0


def _fits(x: float, y: float) -> bool:
    return y < PAGE_H - 50


def _text(page: pymupdf.Page, x: float, y: float, s: str, size: float = 11,
          bold: bool = False, color=(0, 0, 0)) -> float:
    """Insert a line of text (cross-platform font); returns the next y."""
    return FONTS.text(page, x, y, s, size=size, bold=bold, color=color)


def _header(page: pymupdf.Page) -> None:
    y = 52
    y = _text(page, 50, y, "TrialMaths 2023", 20, bold=True)
    y = _text(page, 50, y + 4, "Mathematics Advanced — Trial Examination", 14, bold=True)
    _text(page, 50, y + 8, "General Instructions", 10, bold=True)
    _text(page, 50, y + 20,
          "• Reading time — 5 minutes    • Working time — 3 hours    • Write using black pen", 9)
    _text(page, 50, y + 33,
          "• Board-approved calculators may be used    • Marks are shown in brackets", 9)


def _graph(page: pymupdf.Page, x: float, y: float, w: float, h: float) -> None:
    """Draw a simple sine graph: y = 4 sin(pi x), x in [0, 2]."""
    import math

    # axes
    page.draw_line(pymupdf.Point(x, y + h), pymupdf.Point(x + w, y + h), color=(0.2, 0.2, 0.2), width=1)
    page.draw_line(pymupdf.Point(x, y), pymupdf.Point(x, y + h), color=(0.2, 0.2, 0.2), width=1)
    # ticks
    for i in range(0, 5):
        tx = x + i * w / 4
        page.draw_line(pymupdf.Point(tx, y + h - 3), pymupdf.Point(tx, y + h + 3), color=(0.2, 0.2, 0.2), width=1)
        _text(page, tx - 4, y + h + 14, str(i / 2), 8)
    _text(page, x - 6, y + 8, "4", 8)
    _text(page, x - 6, y + h - 8, "-4", 8)
    points = []
    for i in range(0, 101):
        px = x + i * w / 100
        py = y + h / 2 - 4 * math.sin(math.pi * (i / 100) * 2) * (h / 2 / 4.5)
        points.append(pymupdf.Point(px, py))
    page.draw_polyline(points, color=(0.1, 0.3, 0.8), width=1.2)


def _options(page: pymupdf.Page, x: float, y: float, options: list[str]) -> float:
    labels = ["A.", "B.", "C.", "D."]
    for label, text in zip(labels, options):
        y = _text(page, x + 12, y, f"{label} {text}", 10.5)
        y += 3
    return y


def make_sample_pdf(out_path: str | Path) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open()

    # ============================ page 1 ====================================
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    _header(page)
    y = 150
    y = _text(page, 50, y, "Section I — Multiple Choice — 10 marks", 12, bold=True)
    y = _text(page, 50, y + 4, "Attempt Questions 1–10. Allow about 15 minutes for this section.", 9)
    y += 12

    y = _text(page, 50, y, "Question 1 (1 mark)", 11, bold=True)
    y = _text(page, 50, y + 3, "What is the value of sin(π/3)?", 11)
    y = _options(page, 50, y + 4, ["1/2", "√3/2", "1", "√2/2"])
    y += 12

    y = _text(page, 50, y, "Question 2 (1 mark)", 11, bold=True)
    y = _text(page, 50, y + 3, "The graph of y = 4sin(πx) is shown. The period of the function is:", 11)
    _graph(page, 90, y + 16, 180, 90)
    y = _options(page, 50, y + 130, ["1", "2", "4", "2π"])
    y += 12

    y = _text(page, 50, y, "Question 3 (1 mark)", 11, bold=True)
    y = _text(page, 50, y + 3,
             "For a normal distribution with mean μ and standard deviation σ, the percentage of data", 11)
    y = _text(page, 50, y + 3, "within two standard deviations of the mean is approximately:", 11)
    y = _options(page, 50, y + 4, ["68%", "95%", "99.7%", "50%"])
    y += 12

    y = _text(page, 50, y, "Question 4 (1 mark)", 11, bold=True)
    y = _text(page, 50, y + 3, "The derivative of y = x³ ln x is:", 11)
    y = _options(page, 50, y + 4, ["3x² ln x + x²", "3x² ln x", "x³ ln x + x²", "3x² ln x + x³"])

    # ============================ page 2 ====================================
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 70
    y = _text(page, 50, y, "Question 5 (2 marks)", 11, bold=True)
    y = _text(page, 50, y + 3, "Differentiate y = x²e^x.", 11)
    y += 20

    y = _text(page, 50, y, "Question 6 (4 marks)", 11, bold=True)
    y = _text(page, 50, y + 3, "(a) Find ∫(6x² − 4x + 1) dx.", 11)
    y = _text(page, 50, y + 3, "(b) Find the area bounded by y = 6x² − 4x + 1 and the x-axis", 11)
    y = _text(page, 50, y + 3, "     from x = 0 to x = 2.", 11)
    y = _text(page, 50, y + 3,
             "(c) Show that F(x) = 2x³ − 2x² + x + 5 is an antiderivative of 6x² − 4x + 1.", 11)
    y += 20

    y = _text(page, 50, y, "Question 7 (3 marks)", 11, bold=True)
    y = _text(page, 50, y + 3, "Solve 2cos(x) − 1 = 0 for 0 ≤ x ≤ 2π. Leave answers in terms of π.", 11)
    y += 20

    y = _text(page, 50, y, "Question 8 (2 marks)", 11, bold=True)
    y = _text(page, 50, y + 3, "(a) Write down the first three terms of the sequence defined by", 11)
    y = _text(page, 50, y + 3, "     t₁ = 3 and tₙ₊₁ = tₙ + 5.", 11)

    # ============================ page 3 ====================================
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 90
    y = _text(page, 50, y, "(b) Hence find the 20th term of the sequence.", 11)
    y += 30

    y = _text(page, 50, y, "Question 9 (2 marks)", 11, bold=True)
    y = _text(page, 50, y + 3,
             "The heights of a group of students are normally distributed with mean 170 cm", 11)
    y = _text(page, 50, y + 3, "and standard deviation 8 cm. Find the probability that a randomly chosen", 11)
    y = _text(page, 50, y + 3, "student is taller than 186 cm.", 11)
    y += 20

    y = _text(page, 50, y, "Question 10 (2 marks)", 11, bold=True)
    y = _text(page, 50, y + 3, "An amount of $5000 is invested at 4% per annum compounded quarterly.", 11)
    y = _text(page, 50, y + 3, "Find the value of the investment after 3 years, correct to the nearest dollar.", 11)
    y += 30

    y = _text(page, 50, y, "Section II — Free Response — 20 marks", 12, bold=True)
    y = _text(page, 50, y + 4, "Attempt Questions 11–13. Allow about 45 minutes for this section.", 9)
    y += 12
    y = _text(page, 50, y, "Question 11 (2 marks)", 11, bold=True)
    y = _text(page, 50, y + 3, "A bag contains 5 red and 3 blue marbles. Two marbles are drawn", 11)
    y = _text(page, 50, y + 3, "without replacement. Find the probability that both marbles are red.", 11)

    # ============================ page 4 ====================================
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 70
    y = _text(page, 50, y, "Question 12 (3 marks)", 11, bold=True)
    y = _text(page, 50, y + 3, "Find the area enclosed between the curves y = x² and y = 4.", 11)
    y += 24

    y = _text(page, 50, y, "Question 13 (6 marks)", 11, bold=True)
    y = _text(page, 50, y + 3, "Consider the function f(x) = x³ − 3x.", 11)
    y = _text(page, 50, y + 4, "(a) Find the coordinates of any stationary points.", 11)
    y = _text(page, 50, y + 3, "(b) Determine the nature of each stationary point.", 11)
    y = _text(page, 50, y + 3, "(c) Sketch the curve y = f(x), labelling all intercepts.", 11)
    y = _text(page, 50, y + 3, "(d) Find the area bounded by the curve and the x-axis between the", 11)
    y = _text(page, 50, y + 3, "     two x-intercepts.", 11)

    # ============================ page 5: answers ===========================
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 70
    y = _text(page, 50, y, "Answers", 16, bold=True)
    y = _text(page, 50, y + 6, "Section I", 11, bold=True)
    answers = [
        "1. B", "2. B", "3. B", "4. A", "5. y' = 2xe^x + x²e^x",
        "6. (a) 2x³ − 2x² + x + C", "7. x = π/3, 5π/3", "8. (a) 3, 8, 13",
        "9. 0.025", "10. $5637",
    ]
    for ans in answers:
        y = _text(page, 50, y + 3, ans, 10.5)
    y += 14
    y = _text(page, 50, y, "Worked Solutions", 14, bold=True)

    worked = [
        ("Solution 1", "sin(π/3) = √3/2 from the unit circle, so the answer is B."),
        ("Solution 2", "The graph y = 4sin(πx) completes one cycle on [0, 2], so the period is 2."),
        ("Solution 3", "The empirical rule states 95% of data lies within two standard deviations."),
        ("Solution 4", "Using the product rule, y' = 3x² ln x + x³ · (1/x) = 3x² ln x + x²."),
        ("Solution 5", "y' = 2xe^x + x²e^x = e^x(x² + 2x)."),
        ("Solution 9", "186 cm is two standard deviations above the mean, so P(Z > 2) = 0.025."),
        ("Solution 13", "f'(x) = 3x² − 3 = 0 when x = ±1, giving stationary points (−1, 2) and (1, −2)."),
    ]
    for title, body in worked:
        y = _text(page, 50, y + 3, title, 10.5, bold=True)
        y = _text(page, 62, y + 3, body, 10)

    doc.save(str(out_path))
    doc.close()
    return out_path


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "data/papers/TrialMaths_2023_2U_wsols_sample.pdf"
    print(make_sample_pdf(out))
