"""OCR tests (engine selection + cleaning)."""

from __future__ import annotations

from pipeline.ocr import clean_ocr, get_engine
from pipeline.ocr.embedded import EmbeddedTextOCR


def test_clean_ocr_basic():
    text = "Find the  derivative   of\n y = 2x^2\n\ndiffer-\nentiate"
    cleaned = clean_ocr(text)
    assert "Find the derivative of" in cleaned
    assert "differentiate" in cleaned  # hyphenated line break joined


def test_clean_ocr_never_corrupts():
    text = "√(5x − 4) = 3"
    assert clean_ocr(text) == "√(5x − 4) = 3"


def test_engine_auto_returns_something():
    engine = get_engine(name="auto")
    assert engine is not None
    assert engine.name in ("tesseract", "embedded")


def test_embedded_engine():
    engine = EmbeddedTextOCR()
    result = engine.run(None, source_text="y = 4sin(πx)")
    assert result.text == "y = 4sin(πx)"
    assert result.engine == "embedded"
    assert result.confidence > 0
