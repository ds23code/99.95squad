"""Page rendering.

The visual rendering of the PDF is the *source of truth*.  We never rely on
the embedded text layer for mathematics — only for layout hints (positions,
font sizes) and search text.

Renders are produced with PyMuPDF at a configurable DPI (default 200,
math-safe).  Full pages are kept on disk so crops can be re-derived without
re-opening the source PDF.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pymupdf

log = logging.getLogger(__name__)

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None


def render_page_pil(page: pymupdf.Page, dpi: int) -> "Image.Image":
    """Render a PDF page to a PIL image at the given DPI."""
    if Image is None:  # pragma: no cover
        raise RuntimeError("Pillow is required for rendering")
    scale = dpi / 72.0
    pix = page.get_pixmap(
        matrix=pymupdf.Matrix(scale, scale),
        alpha=False,
        colorspace=pymupdf.csRGB,
    )
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def open_pdf(path: str | Path) -> pymupdf.Document:
    return pymupdf.open(str(path))


def render_paper_pages(
    doc: pymupdf.Document,
    paper_id: str,
    pages_dir: str | Path,
    dpi: int,
    *,
    force: bool = False,
) -> list[Path]:
    """Render every page of a document to PNG files.

    Returns the list of rendered image paths (one per page, 1-based order).
    Existing renders are reused unless ``force`` is set.
    """
    out_dir = Path(pages_dir) / paper_id
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for page_number in range(len(doc)):
        out = out_dir / f"page_{page_number + 1:03d}.png"
        if not out.exists() or force:
            page = doc.load_page(page_number)
            img = render_page_pil(page, dpi)
            img.save(out, format="PNG")
        paths.append(out)
    return paths


def page_size_points(doc: pymupdf.Document, page_number: int) -> tuple[float, float]:
    page = doc.load_page(page_number)
    rect = page.rect
    return rect.width, rect.height
