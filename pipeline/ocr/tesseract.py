"""Tesseract OCR engine.

Requires the ``tesseract`` binary on PATH (or ``config.ocr.tesseract_binary``).
Install on Ubuntu/Debian::

    sudo apt install tesseract-ocr
    # optional: sudo apt install tesseract-ocr-eng

macOS::

    brew install tesseract

Windows: install from https://github.com/UB-Mannheim/tesseract/wiki
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Optional

from .base import BaseOCREngine, OCRResult

try:
    import pytesseract
    from PIL import Image
except ImportError:  # pragma: no cover
    pytesseract = None
    Image = None


class TesseractOCR(BaseOCREngine):
    name = "tesseract"

    def __init__(self, language: str = "eng", psm: int = 6, binary: str | None = None):
        self.language = language
        self.psm = psm
        self.binary = binary
        if pytesseract is not None and binary:
            pytesseract.pytesseract.tesseract_cmd = binary

    @classmethod
    def available(cls) -> bool:
        if pytesseract is None:
            return False
        try:
            return shutil.which(pytesseract.pytesseract.tesseract_cmd) is not None
        except Exception:
            return False

    def _config(self) -> str:
        return f"--psm {self.psm}"

    def run(self, image, **kwargs) -> OCRResult:
        if pytesseract is None:  # pragma: no cover
            raise RuntimeError("pytesseract is not installed (pip install pytesseract)")
        if isinstance(image, (str, Path)):
            image = Image.open(image)
        lang = kwargs.get("language", self.language)
        try:
            data = pytesseract.image_to_data(
                image, lang=lang, config=self._config(), output_type=pytesseract.Output.DICT
            )
        except pytesseract.TesseractNotFoundError as exc:  # pragma: no cover
            raise RuntimeError(
                "Tesseract binary not found. Install it (see pipeline/ocr/tesseract.py "
                "docstring) or set ocr.engine to 'embedded'."
            ) from exc

        words, confs = [], []
        text_parts = []
        for i in range(len(data["text"])):
            word = (data["text"][i] or "").strip()
            conf = int(data["conf"][i])
            if not word or conf < 0:
                continue
            words.append(
                {
                    "text": word,
                    "x0": int(data["left"][i]),
                    "y0": int(data["top"][i]),
                    "x1": int(data["left"][i]) + int(data["width"][i]),
                    "y1": int(data["top"][i]) + int(data["height"][i]),
                    "conf": conf / 100.0,
                }
            )
            confs.append(conf)

        text = "\n".join(
            " ".join(w["text"] for w in words)
            for words in _group_words_into_lines(words)
        )
        avg_conf = (sum(confs) / len(confs) / 100.0) if confs else 0.0
        return OCRResult(
            text=text,
            confidence=avg_conf,
            engine=self.name,
            raw="\n".join(data["text"]),
            words=words,
        )


def _group_words_into_lines(words: list[dict], y_tolerance: int = 10) -> list[list[dict]]:
    """Group OCR words into approximate text lines by y-coordinate."""
    if not words:
        return []
    ordered = sorted(words, key=lambda w: (w["y0"], w["x0"]))
    lines: list[list[dict]] = [[ordered[0]]]
    for word in ordered[1:]:
        if abs(word["y0"] - lines[-1][-1]["y0"]) <= y_tolerance:
            lines[-1].append(word)
        else:
            lines.append([word])
    return lines
