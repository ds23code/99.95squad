"""OCR engine registry.

Usage::

    engine = get_engine(config)             # auto-selects
    result = engine.run(image, ...)         # -> OCRResult

To add a new engine: subclass BaseOCREngine, import it here and add it to
ENGINES.  ``auto`` picks the first available engine in priority order.
"""

from __future__ import annotations

from typing import Optional

from ..config import Config
from .base import BaseOCREngine, OCRResult
from .clean import clean_ocr
from .embedded import EmbeddedTextOCR

ENGINES: dict[str, type[BaseOCREngine]] = {}

try:  # tesseract import may fail if pytesseract missing entirely
    from .tesseract import TesseractOCR

    ENGINES["tesseract"] = TesseractOCR
except ImportError:  # pragma: no cover
    pass

ENGINES["embedded"] = EmbeddedTextOCR

_PRIORITY = ["tesseract", "embedded"]


def get_engine(config: Config | None = None, name: str | None = None) -> BaseOCREngine | None:
    """Return an OCR engine.

    - ``name=None``/``auto``: first available engine in priority order
    - ``name="none"``: returns None
    - explicit name: that engine, or None if unavailable
    """
    from ..config import default_config

    cfg = config or default_config()
    requested = name or cfg.get("ocr", "engine", default="auto")
    if requested == "none":
        return None
    if requested == "auto":
        for engine_name in _PRIORITY:
            engine_cls = ENGINES.get(engine_name)
            if engine_cls and engine_cls.available():
                return _instantiate(cfg, engine_cls)
        return EmbeddedTextOCR()  # always available
    engine_cls = ENGINES.get(requested)
    if engine_cls is None:
        raise ValueError(f"Unknown OCR engine {requested!r}. Known: {list(ENGINES)}")
    return _instantiate(cfg, engine_cls)


def _instantiate(cfg: Config, engine_cls: type[BaseOCREngine]) -> BaseOCREngine:
    if engine_cls.name == "tesseract":
        return engine_cls(
            language=cfg.get("ocr", "language", default="eng"),
            psm=int(cfg.get("ocr", "psm", default=6)),
            binary=cfg.get("ocr", "tesseract_binary"),
        )
    return engine_cls()


def engines_available() -> list[str]:
    return [name for name in _PRIORITY if name in ENGINES and ENGINES[name].available()]


__all__ = [
    "BaseOCREngine",
    "OCRResult",
    "clean_ocr",
    "get_engine",
    "engines_available",
    "ENGINES",
]
