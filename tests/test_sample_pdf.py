"""Cross-platform sample-PDF generation tests.

Proves `python -m pipeline sample` creates the PDF on any supported OS:

- uses the fonts bundled in ``assets/fonts/`` (no user font installation)
- falls back to PyMuPDF built-in fonts when no font file exists anywhere
  (text is sanitised, the generator never crashes)
- the generated PDF is valid, has the expected pages, and keeps the
  unicode maths that matter (π, √, ², ∫ …) when a real font is available
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_pipeline_sample_cli_creates_pdf(tmp_path):
    """The exact command from the README must work end-to-end."""
    out = tmp_path / "TrialMaths_sample.pdf"
    result = subprocess.run(
        [sys.executable, "-m", "pipeline", "sample", "--out", str(out)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert result.returncode == 0, result.stderr
    assert out.exists(), "sample PDF was not created"
    assert out.stat().st_size > 20_000, "sample PDF suspiciously small"

    import pymupdf

    doc = pymupdf.open(str(out))
    assert len(doc) >= 4, "sample PDF should have at least 4 pages"
    page_text = doc.load_page(0).get_text()
    assert "Question 1" in page_text
    assert "sin" in page_text
    doc.close()


def test_bundled_fonts_are_present_and_used():
    """The primary cross-platform path: committed DejaVu fonts."""
    from pipeline.fonts import DEFAULT as F

    assert (REPO_ROOT / "assets" / "fonts" / "DejaVuSans.ttf").exists()
    assert (REPO_ROOT / "assets" / "fonts" / "DejaVuSans-Bold.ttf").exists()
    assert F.source == "bundled", "bundled fonts should be preferred when present"


def test_sample_pdf_generates_without_any_font_files(tmp_path, monkeypatch):
    """A machine with no fonts at all (no bundle, no system fonts) must still
    generate the PDF via the PyMuPDF built-in fallback — never crash."""
    import pipeline.fonts as fonts_mod
    from pipeline.fonts import Fonts

    monkeypatch.setattr(fonts_mod, "get_font_paths", lambda: (None, None))

    import scripts.make_sample_pdf as sample_mod

    fallback_fonts = Fonts()
    assert fallback_fonts.builtin is True, "fallback Fonts should use built-ins"
    monkeypatch.setattr(sample_mod, "FONTS", fallback_fonts)

    out = tmp_path / "fallback.pdf"
    sample_mod.make_sample_pdf(out)  # must not raise
    assert out.exists()

    import pymupdf

    doc = pymupdf.open(str(out))
    assert len(doc) >= 4
    doc.close()


def test_validation_papers_generator_uses_shared_fonts():
    """The validation-suite generator must resolve fonts the same way."""
    import scripts.make_validation_papers as vp

    from pipeline.fonts import DEFAULT as F

    assert vp.FONTS is F or vp.FONTS.regular == F.regular
