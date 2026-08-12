"""Human review workflow.

Every question carries extraction/classification confidence.  Questions below
threshold (or flagged) are queued.  The reviewer inspects the rendered
question image and corrects metadata; corrections are stored permanently and
the question is marked ``reviewed``.

Commands::

    python -m pipeline review --list              # print the queue
    python -m pipeline review --id QID            # review one question
    python -m pipeline review --next              # interactive review (default)
"""

from __future__ import annotations

import json
from typing import Optional

from .database import Database


def _int_or_none(value: str) -> Optional[int]:
    value = value.strip()
    return int(value) if value else None


def _float_or_none(value: str) -> Optional[float]:
    value = value.strip()
    return float(value) if value else None


# fields the reviewer may edit, with prompts and value coercion
EDITABLE_FIELDS = [
    ("question_number", "Question number", str),
    ("section", "Section (e.g. I, II or blank)", str),
    ("marks", "Marks (integer or blank)", _int_or_none),
    ("course_id", "Course id (see config/subjects.yaml)", str),
    ("topic_id", "Topic id (see config/topics.yaml)", str),
    ("subtopic_id", "Subtopic id or blank", str),
    ("difficulty", "Difficulty 1-5 or blank", _float_or_none),
    ("question_type", "Type: multiple_choice|short_answer|extended_response", str),
    ("answer", "Answer (e.g. C, 42) or blank", str),
    ("ocr_clean", "Corrected OCR text (one line per paragraph)", str),
]


def review_queue(db: Database, limit: int = 200) -> list[dict]:
    return db.review_queue(limit)


def apply_review(db: Database, question_id: str, fields: dict, reviewed_by: str = "reviewer") -> None:
    """Persist corrected fields and mark the question reviewed."""
    db.update_question_fields(question_id, {**fields, "status": "reviewed"})
    db.set_question_status(question_id, "reviewed", reviewed_by=reviewed_by)


def format_question_for_review(q: dict) -> str:
    flags = ""
    try:
        raw = q.get("review_flags") or "[]"
        flags = ", ".join(json.loads(raw))
    except (ValueError, TypeError):
        pass
    return (
        f"{'=' * 60}\n"
        f"ID:    {q['id']}\n"
        f"Paper: {q.get('paper_name')} ({q.get('paper_filename')})\n"
        f"Q{q['question_number']}  pages {q['page_start']}-{q['page_end']}\n"
        f"Image: {q.get('image_path')}\n"
        f"Course: {q.get('course_id')}  Topic: {q.get('topic_id')}  Type: {q.get('question_type')}\n"
        f"Marks: {q.get('marks')}  Difficulty: {q.get('difficulty')}\n"
        f"Extraction conf: {q.get('extraction_confidence')}  Classification conf: {q.get('classification_confidence')}\n"
        f"Flags: {flags or '-'}\n"
        f"OCR: {(q.get('ocr_clean') or '')[:400]}\n"
    )


def interactive_review(db: Database, question: dict) -> bool:
    """Prompt the reviewer to edit one question. Returns True if saved."""
    print(format_question_for_review(question))
    fields: dict = {}
    for field, label, coerce in EDITABLE_FIELDS:
        current = question.get(field)
        prompt = f"{label} [{current if current is not None else ''}] (blank = keep): "
        value = input(prompt).strip()
        if not value:
            continue
        try:
            fields[field] = coerce(value)
        except (ValueError, TypeError):
            print(f"  invalid value, keeping {current!r}")
    if not fields:
        print("(no changes)")
        return False
    apply_review(db, question["id"], fields)
    print("saved ✓")
    return True
