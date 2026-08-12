"""Cross-platform font resolution for synthetic PDF generation.

Works on macOS, Linux, Windows and CI without requiring users to install
fonts:

1. **Bundled fonts** (``assets/fonts/``, committed to the repo — DejaVu,
   full Unicode, permissive licence). This is the primary path and is what
   keeps generated PDFs visually clean everywhere.
2. **Common system font locations** (Linux /usr/share, macOS /Library,
   Windows C:\\Windows\\Fonts) as a fallback if the bundled files are
   removed.
3. **PyMuPDF built-in fonts** (Helvetica family) as a last resort. Built-ins
   are Latin-1 only, so text is sanitised by :meth:`Fonts.text` — glyphs such
   as π/√/∫ degrade to ASCII rather than crashing the generator.

The generated PDFs are test fixtures / demo papers only — the *pipeline* that
renders real PDFs never needs fonts at all.
"""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BUNDLED_DIR = REPO_ROOT / "assets" / "fonts"

# (regular, bold) candidates in preference order
_CANDIDATES = [
    (BUNDLED_DIR / "DejaVuSans.ttf", BUNDLED_DIR / "DejaVuSans-Bold.ttf"),
    (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
     Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")),
    (Path("/Library/Fonts/DejaVuSans.ttf"),
     Path("/Library/Fonts/DejaVuSans-Bold.ttf")),
    (Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
     Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf")),
    (Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "DejaVuSans.ttf",
     Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "DejaVuSans-Bold.ttf"),
    (Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arial.ttf",
     Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arialbd.ttf"),
]


def get_font_paths() -> tuple[str | None, str | None]:
    """Return ``(regular, bold)`` TTF paths, or ``(None, None)`` when only
    PyMuPDF built-in fonts are available."""
    for regular, bold in _CANDIDATES:
        try:
            if regular.exists() and bold.exists():
                return str(regular), str(bold)
        except OSError:
            continue
    return None, None


def _sanitize_latin1(text: str) -> str:
    """Map out-of-Latin-1 glyphs to ASCII so built-in fonts never crash."""
    return text.encode("latin-1", "replace").decode("latin-1")


class Fonts:
    """Thread-safe text inserter used by the PDF generators."""

    def __init__(self) -> None:
        self.regular, self.bold = get_font_paths()
        self.builtin = self.regular is None or self.bold is None

    @property
    def source(self) -> str:
        if self.builtin:
            return "pymupdf-builtin"
        if Path(self.regular or "").parent == BUNDLED_DIR:
            return "bundled"
        return "system"

    def text(self, page, x: float, y: float, s: str, size: float = 11,
             bold: bool = False, color=(0, 0, 0)) -> float:
        """Insert a line of text; returns the next y position."""
        if self.builtin:
            page.insert_text(
                (x, y), _sanitize_latin1(s), fontsize=size,
                fontname="hebo" if bold else "helv", color=color,
            )
        else:
            page.insert_text(
                (x, y), s, fontsize=size, fontname="F0",
                fontfile=self.bold if bold else self.regular, color=color,
            )
        return y + size * 1.35


# Module-level shared instance (fonts are cheap to resolve once).
DEFAULT = Fonts()
