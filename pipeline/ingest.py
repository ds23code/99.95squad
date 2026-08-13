"""PDF ingestion: discovery, deduplication (sha256), filename metadata parsing.

Given ``data/papers/TrialMaths_2023_2U_wsols.pdf`` this module produces a
:class:`~pipeline.models.PaperRecord` with course/year/organisation/paper-type
metadata — everything that can be learned from the *name* of the file.
Everything learned here is treated as a *hint* with a confidence score; the
classifier can refine it later from paper text.
"""

from __future__ import annotations

import hashlib
import logging
import re
from pathlib import Path

from .config import Config
from .models import PaperRecord

log = logging.getLogger(__name__)

_EXTENSIONS = {".pdf"}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def sha256_of_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def _tokens(filename: str) -> list[str]:
    """Split a filename into alphanumeric tokens on separators + camelCase."""
    stem = Path(filename).stem
    stem = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", stem)  # camelCase split
    return re.findall(r"[a-zA-Z0-9]+", stem)


def _find_alias(tokens: list[str], aliases: list[str]) -> str | None:
    """Find the longest alias that appears (joined or as a token) in tokens."""
    joined = "".join(tokens).lower()
    joined_spaced = " ".join(tokens).lower()
    best = None
    for alias in aliases:
        a = re.sub(r"[^a-zA-Z0-9]+", "", alias).lower()
        if not a:
            continue
        if a in joined:
            if best is None or len(a) > len(best):
                best = a
    # also check spaced form for multi-word aliases
    for alias in aliases:
        a = alias.lower().strip()
        if len(a) > len(best or "") and a in joined_spaced:
            best = a
    return best


# --------------------------------------------------------------------------
# filename metadata parser
# --------------------------------------------------------------------------
class FilenameParser:
    def __init__(self, config: Config):
        self.config = config
        self.patterns = config.patterns
        self.courses = config.courses()
        self.paper_types = self.patterns.get("paper_types", [])
        self.year_re = re.compile(self.patterns.get("year_regex", r"(20\d{2})"), re.I)
        self.level_hints = self.patterns.get("year_level_hints", [])
        self.solution_indicators = self.patterns.get("solution_indicators", [])

    def parse(self, filename: str) -> dict:
        """Return a metadata dict (all values may be None/False)."""
        tokens = _tokens(filename)
        joined = "".join(tokens).lower()
        joined_spaced = " ".join(tokens).lower()

        meta: dict = {
            "year": None,
            "course_id": None,
            "subject_id": None,
            "organisation": None,
            "paper_type": None,
            "has_solutions": False,
            "year_level": None,
            "confidence": 1.0,
        }
        unknown: list[str] = []

        # --- year ---
        for token in tokens:
            m = self.year_re.match(token)
            if m:
                meta["year"] = int(m.group(1))
                break

        # --- course (longest alias wins) ---
        best: tuple[int, str, str] | None = None
        for course in self.courses:
            alias = _find_alias(tokens, course["aliases"])
            if alias:
                if best is None or len(alias) > len(best[0]):
                    best = (len(alias), course["id"], course["subject_id"])
        if best:
            meta["course_id"], meta["subject_id"] = best[1], best[2]
        else:
            unknown.append("course")

        # --- paper type ---
        best_type: tuple[int, str] | None = None
        for pt in self.paper_types:
            for alias in pt.get("aliases", []):
                a = re.sub(r"[^a-zA-Z0-9]+", "", alias).lower()
                if a and a in joined:
                    if best_type is None or len(a) > best_type[0]:
                        best_type = (len(a), pt["id"])
        if best_type:
            meta["paper_type"] = best_type[1]

        # --- solutions indicator ---
        for ind in self.solution_indicators:
            ind_norm = re.sub(r"[^a-zA-Z0-9]+", "", ind).lower()
            if ind_norm and ind_norm in joined:
                meta["has_solutions"] = True
                break

        # --- organisation: first raw (not camelCase-split) token that is not a
        #     recognised course/type/indicator token and not a year ---
        #     (split on separators only, so "TrialMaths" stays one token)
        reserved = set()
        for course in self.courses:
            for alias in course["aliases"]:
                reserved.add(re.sub(r"[^a-zA-Z0-9]+", "", alias).lower())
        for subj in self.config.subjects.get("subjects", []):
            for alias in subj.get("aliases", []):
                reserved.add(re.sub(r"[^a-zA-Z0-9]+", "", alias).lower())
        for pt in self.paper_types:
            for alias in pt.get("aliases", []):
                reserved.add(re.sub(r"[^a-zA-Z0-9]+", "", alias).lower())
        raw_tokens = re.findall(r"[a-zA-Z0-9]+", Path(filename).stem)
        for token in raw_tokens:
            low = token.lower()
            if token.isdigit():
                continue
            if low in reserved:
                continue
            if low in {"wsols", "sols", "solutions", "answers", "ms"}:
                continue
            if re.fullmatch(r"2u|3u|4u|1u|ext\d?|hsc|nsw|au", low):
                continue
            meta["organisation"] = token
            break
        if meta["organisation"] is None:
            unknown.append("organisation")

        # --- year level ---
        for hint in self.level_hints:
            if re.search(hint["regex"], joined_spaced, re.I):
                meta["year_level"] = hint["level"]
                break

        # --- confidence ---
        if unknown:
            meta["confidence"] = max(0.4, 1.0 - 0.2 * len(unknown))

        return meta

    def display_name(self, meta: dict) -> str:
        parts = []
        if meta["organisation"]:
            parts.append(meta["organisation"])
        if meta["year"]:
            parts.append(str(meta["year"]))
        if meta["course_id"]:
            course = self.config.course_by_id(meta["course_id"])
            parts.append(course["name"] if course else meta["course_id"])
        if meta["paper_type"]:
            for pt in self.paper_types:
                if pt["id"] == meta["paper_type"]:
                    parts.append(pt["name"])
                    break
        if meta["has_solutions"]:
            parts.append("with solutions")
        return " ".join(parts) or Path(meta["filename"]).stem


# --------------------------------------------------------------------------
# discovery
# --------------------------------------------------------------------------
def discover_pdfs(papers_dir: str | Path) -> list[Path]:
    root = Path(papers_dir)
    if not root.exists():
        return []
    return sorted(p for p in root.rglob("*") if p.suffix.lower() in _EXTENSIONS and p.is_file())


def paper_id_from_path(path: str | Path, meta: dict) -> str:
    """Stable paper id: ``<org>-<year>-<course>-<sha16>``.

    Sixteen hexadecimal characters give corpus-scale collision resistance while
    keeping IDs readable. ``register_paper`` first looks up the full SHA-256, so
    papers already stored under the former eight-character suffix retain their
    existing IDs on every rerun.
    """
    p = Path(path)
    org = re.sub(r"[^a-z0-9]+", "-", (meta.get("organisation") or "paper").lower()).strip("-")
    year = meta.get("year") or "yyyy"
    course = meta.get("course_id") or "unknown"
    digest = sha256_of_file(p)[:16]
    return f"{org}-{year}-{course}-{digest}"


def register_paper(config: Config, path: str | Path) -> tuple[PaperRecord | None, str]:
    """Hash + parse a PDF file into a PaperRecord.

    Returns (record, status) where status is one of
    ``new`` | ``exists-complete`` | ``exists-incomplete``.
    """
    from .database import get_db

    path = Path(path)
    digest = sha256_of_file(path)
    db = get_db(config)
    existing = db.get_paper_by_sha256(digest)
    if existing:
        record = PaperRecord(
            id=existing["id"],
            filename=path.name,
            file_path=str(path),
            sha256=digest,
            display_name=existing["display_name"] or path.stem,
            organisation=existing["organisation"],
            year=existing["year"],
            paper_type=existing["paper_type"],
            subject_id=existing["subject_id"],
            course_id=existing["course_id"],
            year_level=existing["year_level"],
            has_solutions=bool(existing["has_solutions"]),
            page_count=existing["page_count"],
        )
        status = "exists-complete" if existing["status"] == "complete" else "exists-incomplete"
        return record, status

    parser = FilenameParser(config)
    meta = parser.parse(path.name)
    record = PaperRecord(
        id=paper_id_from_path(path, meta),
        filename=path.name,
        file_path=str(path),
        sha256=digest,
        display_name=parser.display_name(meta),
        organisation=meta["organisation"],
        year=meta["year"],
        paper_type=meta["paper_type"],
        subject_id=meta["subject_id"],
        course_id=meta["course_id"],
        year_level=meta["year_level"],
        has_solutions=meta["has_solutions"],
        parsed_confidence=meta["confidence"],
    )
    return record, "new"
