"""Question cropping.

Crops the canonical question image from the rendered pages.  Everything that
belongs to the question stays in the crop — text, equations, diagrams,
tables, MC options, subparts.  Questions spanning pages are stitched into a
single vertical image with a thin separator line.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .models import QuestionRegion
from .render import render_page_pil

log = logging.getLogger(__name__)

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None


def _scale_y(y_points: float, dpi: int) -> int:
    return int(round(y_points * dpi / 72.0))


def crop_page_region(
    page_image: "Image.Image",
    y_top_points: float,
    y_bottom_points: float,
    dpi: int,
    padding_points: float = 8.0,
) -> "Image.Image":
    """Crop a horizontal band out of a page image (y in PDF points)."""
    width, height = page_image.size
    pad = _scale_y(padding_points, dpi)
    top = max(0, _scale_y(y_top_points, dpi) - pad)
    bottom = min(height, _scale_y(y_bottom_points, dpi) + pad)
    if bottom <= top:
        top, bottom = 0, height
    return page_image.crop((0, top, width, bottom))


def stitch_images(images: list["Image.Image"], separator_rgb=(200, 200, 200)) -> "Image.Image":
    """Stack images vertically with a thin separator line between them."""
    if not images:
        raise ValueError("no images to stitch")
    if len(images) == 1:
        return images[0].copy()
    sep = 4
    width = max(img.width for img in images)
    height = sum(img.height for img in images) + sep * (len(images) - 1)
    canvas = Image.new("RGB", (width, height), "white")
    y = 0
    for img in images:
        canvas.paste(img, (0, y))
        y += img.height
        if y < height:
            for x in range(width):
                canvas.putpixel((x, y), separator_rgb)
            y += sep
    return canvas


def crop_question(
    region: QuestionRegion,
    page_images: dict[int, "Image.Image"],
    dpi: int,
    padding_points: float = 8.0,
    footer_margin_points: float = 30.0,
) -> "Image.Image":
    """Crop a question region (possibly spanning pages) into one image."""
    if region.page_end == region.page_start:
        img = page_images[region.page_start]
        return crop_page_region(
            img, region.y_top, region.y_bottom, dpi, padding_points
        )

    # multi-page: bottom part of first page + full intermediate pages + top
    # of last page
    parts: list[Image.Image] = []

    first = page_images[region.page_start]
    height = first.height
    pad = _scale_y(padding_points, dpi)
    top = max(0, _scale_y(region.y_top, dpi) - pad)
    bottom = min(height, height - _scale_y(footer_margin_points, dpi))
    if bottom > top + 20:
        parts.append(first.crop((0, top, first.width, bottom)))

    for page_no in range(region.page_start + 1, region.page_end):
        img = page_images[page_no]
        parts.append(img)

    last = page_images[region.page_end]
    bottom = min(last.height, _scale_y(region.y_bottom, dpi) + pad)
    top_last = 0
    parts.append(last.crop((0, top_last, last.width, bottom)))

    return stitch_images(parts)


def load_page_images(paths: dict[int, Path]) -> dict[int, "Image.Image"]:
    return {num: Image.open(path) for num, path in paths.items()}
