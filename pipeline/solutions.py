"""Answers & solutions extraction.

Handles two common layouts:

1. Answer section at the end of the paper ("Answers", "Worked Solutions", ...).
   The detector already emitted *solution regions* (per-question-number blocks)
   for those pages.  Here we crop each block to a PNG, parse short answers
   ("1. C" / "1) 42") and attach them to the matching question.
2. Inline solutions ("Solution 1:" right after a question).  The detector
   records ``solution_y_top``; here we split the question crop into a
   question image and a solution image.

Unmatched answer blocks are stored at paper level (question_id NULL) and
reported, so nothing is silently lost.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Optional

from .crop import crop_page_region
from .models import AnswerAttachment, DetectionResult, QuestionRegion
from .ocr.base import BaseOCREngine
from .ocr.clean import clean_ocr
from .render import render_page_pil

log = logging.getLogger(__name__)

_ANSWER_LINE = re.compile(r"^\s*(\d{1,3})\s*[.)\s:]*\s*([A-E]\s*[.)\s-]*)?\s*(.+?)\s*$")


def split_inline_solution_crop(
    question_image, region: QuestionRegion, page_image, dpi: int, padding_points: float = 8.0
):
    """Split a question crop image at the inline solution boundary.

    Returns (question_image, solution_image_or_None).
    """
    if region.solution_y_top is None:
        return question_image, None
    page_width, page_height = page_image.size
    pad = int(round(padding_points * dpi / 72.0))
    split_y = min(page_height, max(0, int(round(region.solution_y_top * dpi / 72.0)) - pad))
    if split_y >= page_height - 2:
        return question_image, None
    q_img = question_image.crop((0, 0, page_width, min(split_y, question_image.height)))
    s_img = question_image.crop((0, max(0, split_y), page_width, question_image.height))
    return q_img, s_img


def parse_short_answer(text: str) -> Optional[str]:
    """Best-effort parse of a short answer line like "1. C" or "12) 42".

    Returns just the answer part ("C", "42", "√3/2", ...) or None when the
    line does not look like a short answer (i.e. it is a worked solution).
    """
    m = _ANSWER_LINE.match(text)
    if not m:
        return None
    answer = m.group(3).strip()
    if re.fullmatch(r"[A-E]", answer):
        return answer
    if re.fullmatch(r"[-+]?\d{1,4}(\.\d+)?", answer):
        return answer
    # short answer-like expression: no '=', ':' or whitespace, short length
    if len(answer) <= 12 and not re.search(r"[=:]", answer) and " " not in answer:
        return answer
    return None


def _slug(value: str) -> str:
    import re as _re

    return _re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "x"


def extract_solutions(
    result: DetectionResult,
    questions_by_number: dict[str, list[QuestionRegion]],
    paper_id: str,
    doc,
    out_dir: Path,
    dpi: int,
    ocr_engine: Optional[BaseOCREngine] = None,
    padding_points: float = 8.0,
) -> tuple[list[AnswerAttachment], list[AnswerAttachment]]:
    """Crop answer/solution regions and attach them to questions.

    Repeated question numbers are paired in document order.  Answer and worked
    solution blocks have independent counters because a paper may contain both
    for the same question.  Extra blocks remain paper-level attachments rather
    than being silently linked to the wrong occurrence.

    Returns (answers, solutions) lists of AnswerAttachment.
    """
    answers: list[AnswerAttachment] = []
    solutions: list[AnswerAttachment] = []
    attachment_occurrences: dict[tuple[str, str], int] = {}

    for region in result.solution_regions:
        page = doc.load_page(region.page_start - 1)
        img = render_page_pil(page, dpi)
        crop = crop_page_region(img, region.y_top, region.y_bottom, dpi, padding_points)
        text = clean_ocr(region.text or "")
        answer_text = parse_short_answer(text)
        kind = "answer" if answer_text is not None else "solution"

        candidates = questions_by_number.get(region.number, [])
        counter_key = (region.number, kind)
        occurrence = attachment_occurrences.get(counter_key, 0) + 1
        attachment_occurrences[counter_key] = occurrence
        question = candidates[occurrence - 1] if occurrence <= len(candidates) else None

        if question is not None:
            number = _file_number(region.number)
            filename = f"q{number}{occurrence_suffix(occurrence)}_{kind}.png"
        else:
            filename = f"page{region.page_start:03d}_block{_slug(region.number)}.png"

        out_path = out_dir / filename
        out_path.parent.mkdir(parents=True, exist_ok=True)
        crop.save(out_path, format="PNG")

        att = AnswerAttachment(
            question_id=(
                question_id(paper_id, region.number, occurrence)
                if question is not None
                else None
            ),
            answer_text=answer_text,
            image_path=str(out_path),
            source_page=region.page_start,
            kind=kind,
            confidence=0.9 if question is not None else 0.4,
        )
        (answers if kind == "answer" else solutions).append(att)

    return answers, solutions


def _file_number(number: str) -> str:
    """Filesystem-safe question number while preserving legacy numeric names."""
    try:
        return f"{int(number):02d}"
    except (TypeError, ValueError):
        return _slug(str(number))


def occurrence_suffix(occurrence: int) -> str:
    """Stable discriminator used by IDs and files for repeated numbers."""
    if occurrence < 1:
        raise ValueError("question occurrence must be at least 1")
    return "" if occurrence == 1 else f"--occurrence-{occurrence}"


def question_id(paper_id: str, number: str, occurrence: int = 1) -> str:
    """Return a deterministic globally unique question ID.

    The first occurrence deliberately retains the historic ``<paper>-qN`` ID.
    Only repeated numbers gain an explicit occurrence suffix.
    """
    return f"{paper_id}-q{number}{occurrence_suffix(occurrence)}"
