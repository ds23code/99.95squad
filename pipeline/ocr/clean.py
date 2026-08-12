"""Conservative OCR text cleanup.

Rules:
- collapse runs of whitespace
- join hyphenated line breaks ("differ-\nentiate" -> "differentiate")
- remove control characters (keep tabs/newlines)
- never "correct" mathematics (no symbol rewriting, no spell fixing)
"""

from __future__ import annotations

import re

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SPACES = re.compile(r"[ \t]+")
_LINEBREAK = re.compile(r"(\w)-\n(\w)")


def clean_ocr(text: str) -> str:
    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _CONTROL.sub("", text)
    text = _LINEBREAK.sub(r"\1\2", text)  # hyphenated word split across lines
    lines = [_SPACES.sub(" ", line).strip() for line in text.split("\n")]
    # drop entirely empty lines but keep single blank between blocks
    cleaned: list[str] = []
    for line in lines:
        if line:
            cleaned.append(line)
    return "\n".join(cleaned)
