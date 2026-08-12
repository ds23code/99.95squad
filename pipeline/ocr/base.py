"""Pluggable OCR interface.

An OCR engine turns a rendered question image into text.  The output is
*never* treated as authoritative — the image is.  OCR text powers search,
topic classification and review.

Add a new engine by subclassing :class:`BaseOCREngine` and registering it in
``pipeline/ocr/__init__.py``.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class OCRResult:
    text: str                 # raw text
    confidence: float = 0.0   # 0..1
    engine: str = "unknown"
    raw: str = ""             # engine-specific dump (e.g. TSV)
    words: list[dict] = field(default_factory=list)
    # word dicts: {"text": str, "x0": float, "y0": float, "x1": float, "y1": float,
    #              "conf": float} in *image pixels*


class BaseOCREngine(abc.ABC):
    name: str = "base"

    @classmethod
    @abc.abstractmethod
    def available(cls) -> bool:
        """Whether this engine can run in the current environment."""

    @abc.abstractmethod
    def run(self, image, **kwargs) -> OCRResult:
        """OCR a PIL image (or path to one)."""

    def clean_text(self, text: str) -> str:
        """Light, conservative cleanup — never 'fixes' mathematics."""
        from .clean import clean_ocr

        return clean_ocr(text)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<OCREngine {self.name}>"
