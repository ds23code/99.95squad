"""Page layout extraction.

Turns a PDF page into a list of :class:`~pipeline.models.TextLine` with
bounding boxes (PDF points), font sizes and bold flags, using the embedded
text layer where usable, otherwise OCR word boxes.

The embedded text layer is used ONLY for layout/position info — corrupted
glyph text (Cambria Math etc.) is still positioned correctly, so boundaries
and crops remain reliable even when the text itself is garbage.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

import pymupdf

from .models import PageLayout, TextLine
from .ocr.base import BaseOCREngine
from .render import render_page_pil

log = logging.getLogger(__name__)


def _clean_span_text(text: str) -> str:
    return "".join(ch for ch in text if ch.isprintable() or ch in "\t\n").strip()


def extract_layout(
    page: pymupdf.Page,
    page_number: int,
    *,
    min_chars: int = 30,
    ocr_engine: Optional[BaseOCREngine] = None,
    detector_dpi: int = 150,
) -> PageLayout:
    """Extract line layout for one page (1-based ``page_number``)."""
    rect = page.rect
    layout = PageLayout(page_number=page_number, width=rect.width, height=rect.height)

    # ---- embedded text layer ----------------------------------------------
    try:
        data = page.get_text("dict")
    except Exception:  # pragma: no cover - defensive
        data = {"blocks": []}

    for block in data.get("blocks", []):
        if block.get("type") != 0:  # skip images
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue
            text = _clean_span_text("".join(s.get("text", "") for s in spans))
            if not text:
                continue
            bbox = line.get("bbox") or (0, 0, 0, 0)
            sizes = [s.get("size", 0) for s in spans]
            fonts = [s.get("font", "") for s in spans]
            bold = any(("bold" in f.lower()) or ("black" in f.lower()) for f in fonts)
            layout.lines.append(
                TextLine(
                    text=text,
                    x0=bbox[0],
                    y0=bbox[1],
                    x1=bbox[2],
                    y1=bbox[3],
                    font_size=max(sizes) if sizes else 0,
                    bold=bold,
                    font=fonts[0] if fonts else "",
                    source="embedded",
                )
            )

    total_chars = sum(len(l.text) for l in layout.lines)
    if total_chars >= min_chars:
        layout.has_text = True
        layout.text = "\n".join(l.text for l in layout.lines)
        return layout

    # ---- OCR fallback ------------------------------------------------------
    if ocr_engine is not None and ocr_engine.available():
        try:
            img = render_page_pil(page, detector_dpi)
            result = ocr_engine.run(img)
            if result.words:
                scale = 72.0 / detector_dpi
                for w in result.words:
                    layout.lines.append(
                        TextLine(
                            text=w["text"],
                            x0=w["x0"] * scale,
                            y0=w["y0"] * scale,
                            x1=w["x1"] * scale,
                            y1=w["y1"] * scale,
                            font_size=12,
                            source="ocr",
                        )
                    )
                layout.has_text = True
                layout.used_ocr = True
                layout.text = result.text
                return layout
        except Exception as exc:  # pragma: no cover
            log.warning("OCR fallback failed on page %s: %s", page_number, exc)

    layout.has_text = False
    layout.used_ocr = False
    return layout


# --------------------------------------------------------------------------
# column detection
# --------------------------------------------------------------------------
def detect_columns(layout: PageLayout, gap_fraction: float = 0.18) -> tuple[int, float | None]:
    """Return (n_columns, gap_x) for a page layout.

    Simple histogram approach: count line midpoints across the page width;
    the widest run of empty bins (>= gap_fraction of page width) with content
    on both sides implies two columns.  Returns (1, None) otherwise.
    """
    lines = layout.lines
    if len(lines) < 8:
        return 1, None
    n_bins = 40
    bins = [0] * n_bins
    for line in lines:
        mid = (line.x0 + line.x1) / 2
        idx = min(int(mid / layout.width * n_bins), n_bins - 1)
        bins[idx] += 1

    best_run, best_start, best_end = 0, -1, -1
    run, run_start = 0, -1
    for i, count in enumerate(bins):
        if count == 0:
            if run == 0:
                run_start = i
            run += 1
            if run > best_run:
                best_run, best_start, best_end = run, run_start, i
        else:
            run = 0

    if best_run < 2:
        return 1, None
    gap_frac = best_run / n_bins
    if gap_frac < gap_fraction:
        return 1, None
    left_count = sum(bins[:best_start])
    right_count = sum(bins[best_end + 1:])
    if left_count < 4 or right_count < 4:
        return 1, None
    gap_x = (best_start + best_end + 1) / 2.0 / n_bins * layout.width
    return 2, gap_x


def column_streams(layout: PageLayout, gap_x: float | None) -> list[list[TextLine]]:
    """Split lines into reading-order streams.

    Single column: one stream sorted by y.  Two columns: left column
    top-to-bottom, then right column top-to-bottom.
    """
    if gap_x is None:
        return [sorted(layout.lines, key=lambda l: (l.y0, l.x0))]
    left = [l for l in layout.lines if (l.x0 + l.x1) / 2 < gap_x]
    right = [l for l in layout.lines if (l.x0 + l.x1) / 2 >= gap_x]
    return [sorted(left, key=lambda l: (l.y0, l.x0)), sorted(right, key=lambda l: (l.y0, l.x0))]


# --------------------------------------------------------------------------
# junk (headers/footers/page numbers) filtering
# --------------------------------------------------------------------------
def is_junk_line(line: TextLine, layout: PageLayout, junk_regexes: list[re.Pattern]) -> bool:
    text = line.text.strip()
    if not text:
        return True
    # page-number-like short lines at top/bottom margins
    if len(text) <= 4 and text.isdigit():
        if line.y0 < layout.height * 0.06 or line.y1 > layout.height * 0.94:
            return True
    if any(r.match(text) for r in junk_regexes):
        return True
    return False
