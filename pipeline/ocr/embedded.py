"""Embedded text-layer "OCR" fallback.

Many PDFs carry a usable text layer (font-encoded correctly).  For those we
can obtain search text without any OCR binary.  This is NOT real OCR: for
papers with broken font encodings (Cambria Math etc.) it returns the same
corrupted text that `page.get_text()` returns — which is exactly why the
rendered image remains the canonical representation.

Used automatically when tesseract is unavailable and as a fast first pass
when it is.
"""

from __future__ import annotations

from typing import Optional

from .base import BaseOCREngine, OCRResult


class EmbeddedTextOCR(BaseOCREngine):
    """Engine that 'reads' an image by extracting the embedded text layer of
    the PDF region the image was cropped from.

    The image itself is not inspected; ``source_text`` must be supplied by the
    caller (the detector already has per-question embedded text).
    """

    name = "embedded"

    @classmethod
    def available(cls) -> bool:
        return True

    def run(self, image=None, *, source_text: str | None = None, **kwargs) -> OCRResult:
        text = source_text or kwargs.get("text", "")
        return OCRResult(
            text=text,
            confidence=0.9 if text.strip() else 0.0,
            engine=self.name,
            raw=text,
        )
