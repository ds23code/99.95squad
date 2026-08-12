"""Question boundary detection.

Strategy (in order of trust):

1. Use the embedded text layer for *positions* (bboxes, font sizes, bold).
   Even when glyph text is corrupted, the positions are reliable.
2. If no usable text layer, fall back to OCR word boxes (if an engine is
   available).
3. Scan each page's line stream for question-start markers
   (``config/patterns.yaml``): "Question N", "Q1", "1.", "1)" ...
4. Track sections ("Section I"), subparts "((a) (b) (c))", marks, MCQs.
5. Questions continue across pages: if a page's first content line is not a
   question start, the previous question is extended.
6. Answer/solution sections are detected and excluded from questions; they
   become solution regions cropped by :mod:`pipeline.solutions`.

Uncertainty is never hidden: low-confidence boundaries produce flags and the
question is queued for human review (``python -m pipeline review``).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Optional

import pymupdf

from .config import Config
from .layout import column_streams, detect_columns, extract_layout, is_junk_line
from .models import DetectionResult, PageLayout, QuestionRegion, TextLine
from .ocr.base import BaseOCREngine

log = logging.getLogger(__name__)


@dataclass
class _Stream:
    """A single reading-order stream of lines plus a page reference."""

    lines: list[TextLine]
    page: int
    height: float


class QuestionDetector:
    def __init__(self, config: Config, ocr_engine: Optional[BaseOCREngine] = None):
        self.config = config
        self.ocr_engine = ocr_engine
        pat = config.patterns
        flags = re.IGNORECASE

        self.q_starts: list[dict] = []
        for item in pat.get("question_starts", []):
            self.q_starts.append({"regex": re.compile(item["regex"], flags), "kind": item["kind"]})
        self.section_headers = [
            re.compile(item["regex"], flags) for item in pat.get("section_headers", [])
        ]
        self.subpart_starts = [
            re.compile(item["regex"], flags) for item in pat.get("subpart_starts", [])
        ]
        self.answer_headers = [
            re.compile(item["regex"], flags) for item in pat.get("answer_section_headers", [])
        ]
        self.solution_headers = [
            {"regex": re.compile(item["regex"], flags), "max_len": item.get("max_len", 45)}
            for item in pat.get("solution_headers", [])
        ]
        self.option_starts = [
            re.compile(item["regex"], flags) for item in pat.get("option_starts", [])
        ]
        self.marks_patterns = [
            re.compile(item["regex"], flags) for item in pat.get("marks_patterns", [])
        ]
        self.junk_patterns = [
            re.compile(item["regex"], flags) for item in pat.get("junk_lines", [])
        ]
        self.max_q = int(config.get("detect", "max_question_number", default=300))
        self._page_cache: Optional[PageLayout] = None

    # ------------------------------------------------------------------ API
    def detect(self, doc: pymupdf.Document) -> DetectionResult:
        n_pages = len(doc)
        det = self.config.get("detect", default={})
        min_chars = int(det.get("min_text_chars", 30))
        gap_frac = float(det.get("column_gap_fraction", 0.18))
        detector_dpi = int(self.config.get("render", "detector_dpi", default=150))

        pages: list[PageLayout] = []
        for i in range(n_pages):
            layout = extract_layout(
                doc.load_page(i), i + 1,
                min_chars=min_chars,
                ocr_engine=self.ocr_engine,
                detector_dpi=detector_dpi,
            )
            pages.append(layout)
            if not layout.has_text:
                log.debug("page %s: no usable text layer", i + 1)

        return self._detect_from_layouts(pages, n_pages, gap_frac)

    def detect_from_text(self, page_texts: list[str], page_sizes: list[tuple[float, float]]) -> DetectionResult:
        """Test helper: detect from plain page texts (no positions)."""
        pages = []
        y_cursor = 50.0
        for i, text in enumerate(page_texts):
            height = page_sizes[i][1] if i < len(page_sizes) else 842.0
            width = page_sizes[i][0] if i < len(page_sizes) else 595.0
            lines = []
            y = y_cursor
            for raw in text.splitlines():
                lines.append(TextLine(raw.strip(), 50.0, y, 500.0, y + 12, 12, False, "", "embedded"))
                y += 13
            y_cursor = y + 20
            pages.append(PageLayout(i + 1, width, height, lines, text, has_text=True))
        return self._detect_from_layouts(pages, len(pages), 0.18)

    # ------------------------------------------------------------- internals
    def _detect_from_layouts(self, pages: list[PageLayout], n_pages: int, gap_frac: float) -> DetectionResult:
        questions: list[QuestionRegion] = []
        solution_regions: list[QuestionRegion] = []
        answer_pages: list[int] = []
        flags: list[str] = []
        pages_without_text: list[int] = []

        current: Optional[QuestionRegion] = None
        in_answer_section = False
        current_section: Optional[str] = None

        for page_no in range(1, n_pages + 1):
            layout = pages[page_no - 1]
            if not layout.has_text:
                pages_without_text.append(page_no)

            n_columns, gap_x = detect_columns(layout, gap_frac)
            if n_columns == 2:
                flags.append(f"two-column-page-{page_no}")
            streams = column_streams(layout, gap_x)

            self._page_cache = layout
            for stream in streams:
                current, in_answer_section, current_section = self._scan_stream(
                    stream,
                    page_no,
                    current,
                    in_answer_section,
                    current_section,
                    questions,
                    solution_regions,
                    answer_pages,
                )

        if current is not None and current.is_solution_block:
            solution_regions.append(current)
        elif current is not None:
            questions.append(current)

        result = DetectionResult(
            questions=questions,
            solution_regions=solution_regions,
            answer_pages=answer_pages,
            flags=flags,
            pages_without_text=pages_without_text,
        )
        self._finalise(result, pages)
        return result

    def _scan_stream(
        self,
        stream: list[TextLine],
        page_no: int,
        current: Optional[QuestionRegion],
        in_answer_section: bool,
        current_section: Optional[str],
        questions: list[QuestionRegion],
        solution_regions: list[QuestionRegion],
        answer_pages: list[int],
    ) -> tuple[Optional[QuestionRegion], bool, Optional[str]]:
        """Scan one reading-order stream; return
        (current_question, in_answer_section, current_section)."""
        lines = [l for l in stream if not is_junk_line(l, self._page_cache, self.junk_patterns)]
        first_line = True
        for line in lines:
            # ----- answer-section header (may appear anywhere) --------------
            if self._match_answer_header(line):
                if not in_answer_section:
                    in_answer_section = True
                    if page_no not in answer_pages:
                        answer_pages.append(page_no)
                if current is not None and not current.is_solution_block:
                    questions.append(current)
                elif current is not None:
                    solution_regions.append(current)
                current = None  # start a fresh block after a header
                first_line = False
                continue

            # ----- section headers (close the open question first) ----------
            sec = self._match_section(line)
            if sec:
                if current is not None and not current.is_solution_block:
                    questions.append(current)
                elif current is not None:
                    solution_regions.append(current)
                current = None
                current_section = sec
                first_line = False
                continue

            start = self._match_question_start(line)

            # ----- page/column boundary: continuation -----------------------
            if first_line:
                first_line = False
                if start is None and current is not None and not in_answer_section:
                    current.page_end = page_no
                    current.flags.append("continuation")
                    current.confidence *= 0.98
                    if self._maybe_solution_header(line):
                        current.solution_y_top = line.y0
                    self._absorb(current, line, page_no)
                    continue
                if start is None and current is not None and current.is_solution_block:
                    current.page_end = page_no
                    self._absorb(current, line, page_no)
                    continue

            if in_answer_section:
                # ---- answer/solution material ------------------------------
                current = self._absorb_or_open_solution(current, line, page_no, solution_regions)
                continue

            # ----- new question ---------------------------------------------
            if start is not None:
                if current is not None and not current.is_solution_block:
                    questions.append(current)
                elif current is not None:
                    solution_regions.append(current)
                current = QuestionRegion(
                    number=start["number"],
                    page_start=page_no,
                    page_end=page_no,
                    y_top=line.y0,
                    y_bottom=line.y1,
                    section=current_section,
                    confidence=self._start_confidence(start["kind"]),
                )
                if self._maybe_solution_header(line):
                    current.solution_y_top = line.y0
                self._absorb(current, line, page_no)
                continue

            # ----- inline solution block -------------------------------------
            if self._maybe_solution_header(line) and current is not None:
                if current.solution_y_top is None:
                    current.solution_y_top = line.y0

            if current is not None:
                self._absorb(current, line, page_no)
        return current, in_answer_section, current_section

    def _absorb(self, region: QuestionRegion, line: TextLine, page_no: int) -> None:
        """Merge a line into the current region."""
        region.text = (region.text + "\n" + line.text).strip()
        region.lines.append(line)
        if page_no == region.page_end:
            region.y_bottom = max(region.y_bottom, line.y1)
        elif page_no > region.page_end:
            region.page_end = page_no
            region.y_bottom = line.y1
        # subparts
        for pat in self.subpart_starts:
            m = pat.match(line.text)
            if m:
                label = m.group(1)
                if label not in region.subparts:
                    region.subparts.append(label)
                break
        # marks
        if region.marks is None:
            for pat in self.marks_patterns:
                m = pat.search(line.text)
                if m:
                    try:
                        region.marks = int(m.group(1))
                    except ValueError:
                        pass
                    break
        # multiple choice: option letters accumulate across the whole region
        if not region.is_mcq:
            opts = getattr(region, "_option_letters", None)
            if opts is None:
                opts = set()
                region._option_letters = opts
            for pat in self.option_starts:
                for m in pat.finditer(line.text):
                    opts.add(m.group(1))
            if len(opts) >= 2:
                region.is_mcq = True
                region.question_type = "multiple_choice"

    def _absorb_or_open_solution(
        self,
        current: Optional[QuestionRegion],
        line: TextLine,
        page_no: int,
        solution_regions: list[QuestionRegion],
    ) -> QuestionRegion:
        """Inside the answer section: group lines into solution blocks by
        leading question number or explicit "Solution N" headers."""
        sol_number = self._match_solution_header_with_number(line)
        if sol_number is not None:
            if current is not None:
                solution_regions.append(current)
            num = sol_number if sol_number != "" else (current.number if current else "?")
            current = QuestionRegion(
                number=num,
                page_start=page_no,
                page_end=page_no,
                y_top=line.y0,
                y_bottom=line.y1,
                is_solution_block=True,
            )
            current.text = line.text
            current.lines.append(line)
            return current
        # a new answer block requires a number followed by ".", ")", ":" or a
        # letter option — "186 cm is two standard deviations..." must NOT
        # start a new block
        m = re.match(r"^(\d{1,3})\s*(?:[.):]\s*|[A-E][.):]\s*)", line.text)
        if m:
            num = m.group(1)
            if current is None or current.number != num or current.is_solution_block is False:
                if current is not None:
                    solution_regions.append(current)
                current = QuestionRegion(
                    number=num,
                    page_start=page_no,
                    page_end=page_no,
                    y_top=line.y0,
                    y_bottom=line.y1,
                    is_solution_block=True,
                )
            current.page_end = page_no
            current.y_bottom = line.y1
            current.text = (current.text + "\n" + line.text).strip()
            current.lines.append(line)
        elif current is not None:
            current.page_end = page_no
            current.y_bottom = max(current.y_bottom, line.y1)
            current.text = (current.text + "\n" + line.text).strip()
            current.lines.append(line)
        return current

    # ------------------------------------------------------------- matchers
    def _match_question_start(self, line: TextLine) -> Optional[dict]:
        text = line.text.strip()
        lowered = text.lower()
        for item in self.q_starts:
            m = item["regex"].match(text)
            if m:
                number = m.group(1)
                try:
                    num = int(number)
                except ValueError:
                    continue
                if num > self.max_q:
                    continue
                # "Question 8 continues on the next page" is not a question
                if "continue" in lowered:
                    continue
                # bare numbered patterns can false-positive on line fragments
                if item["kind"] in ("numbered", "paren") and len(text) > 160:
                    continue
                # word/short headers are short lines ("Question 13 (6 marks)")
                if item["kind"] in ("word", "short") and len(text) > 80:
                    continue
                return {"number": number, "kind": item["kind"]}
        return None

    def _match_section(self, line: TextLine) -> Optional[str]:
        text = line.text.strip()
        for pat in self.section_headers:
            m = pat.match(text)
            if m:
                return m.group(1)
        return None

    def _maybe_solution_header(self, line: TextLine) -> bool:
        return self._match_solution_header_with_number(line) is not None

    def _match_solution_header_with_number(self, line: TextLine) -> Optional[str]:
        """Return the question number from a 'Solution N' header, '' if the
        header has no number, or None if the line is not a solution header."""
        text = line.text.strip()
        for item in self.solution_headers:
            if len(text) <= item["max_len"]:
                m = item["regex"].match(text)
                if m:
                    return m.group(2) if m.lastindex and m.lastindex >= 2 and m.group(2) else ""
        return None

    def _match_answer_header(self, line: TextLine) -> bool:
        text = line.text.strip().lower()
        return any(pat.match(text) for pat in self.answer_headers)

    def _start_confidence(self, kind: str) -> float:
        if kind == "word":
            return 0.98
        if kind == "short":
            return 0.95
        if kind == "numbered":
            return 0.8
        if kind == "paren":
            return 0.75
        return 0.7

    # ------------------------------------------------------------ finalise
    def _finalise(self, result: DetectionResult, pages: list[PageLayout]) -> None:
        """Post-processing: typing, confidence, review flags."""
        prev_number: Optional[int] = None
        for q in result.questions:
            # question type
            if q.is_mcq:
                q.question_type = "multiple_choice"
            elif q.marks is not None and q.marks >= 5:
                q.question_type = "extended_response"
            else:
                q.question_type = "short_answer"

            # sequential numbering check
            try:
                num = int(q.number)
                if prev_number is not None and num != prev_number + 1:
                    q.flags.append("non-sequential")
                    q.confidence *= 0.92
                prev_number = num
            except ValueError:
                q.flags.append("non-numeric-number")
                q.confidence *= 0.9

            # empty questions
            if len(q.lines) <= 1:
                q.flags.append("no-content")
                q.confidence *= 0.5

            # pages without text
            if any(p in result.pages_without_text for p in range(q.page_start, q.page_end + 1)):
                q.flags.append("no-text-layer")
                q.confidence *= 0.9

            q.confidence = round(min(q.confidence, 1.0), 3)

        # whole-page fallback for pages with content but no layout at all
        if self.config.get("detect", "whole_page_fallback", default=True):
            for layout in pages:
                if not layout.has_text:
                    continue
                covered = any(
                    q.page_start <= layout.page_number <= q.page_end
                    for q in result.questions + result.solution_regions
                )
                if not covered and layout.lines:
                    # if every line got skipped as junk there is nothing to do
                    body = [l for l in layout.lines if not is_junk_line(l, layout, self.junk_patterns)]
                    # only fall back on real content pages, not title/cover pages
                    if len(body) >= 5:
                        q = QuestionRegion(
                            number="?",
                            page_start=layout.page_number,
                            page_end=layout.page_number,
                            y_top=body[0].y0,
                            y_bottom=body[-1].y1,
                            confidence=0.35,
                            flags=["whole-page-fallback"],
                            text="\n".join(l.text for l in body),
                            lines=body,
                        )
                        result.questions.append(q)
                        result.flags.append(f"whole-page-fallback-{layout.page_number}")

        # overall
        if not result.questions:
            result.flags.append("no-questions-detected")
