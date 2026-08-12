"""Export questions to JSON / CSV (metadata + OCR, no images).

Images stay in the data directory; exports reference them by relative path.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from .database import Database


def _rows(db: Database) -> list[dict]:
    out: list[dict] = []
    with db.conn() as c:
        rows = c.execute(
            """SELECT q.*, p.display_name AS paper_name, p.organisation,
                      p.year AS paper_year, p.paper_type, p.filename AS paper_filename,
                      COALESCE(t.name,'') AS topic_name,
                      COALESCE(s.name,'') AS subtopic_name,
                      COALESCE(c.name,'') AS course_name,
                      COALESCE(subj.name,'') AS subject_name
               FROM questions q
               JOIN papers p ON p.id = q.paper_id
               LEFT JOIN topics t ON t.id = q.topic_id
               LEFT JOIN subtopics s ON s.id = q.subtopic_id
               LEFT JOIN courses c ON c.id = q.course_id
               LEFT JOIN subjects subj ON subj.id = COALESCE(q.subject_id, c.subject_id)
               ORDER BY q.paper_id, q.page_start, q.question_number"""
        ).fetchall()
        for r in rows:
            d = dict(r)
            d.pop("review_flags", None)
            d["image_path"] = _relpath(d.get("image_path"))
            d["solution_image_path"] = _relpath(d.get("solution_image_path"))
            out.append(d)
    return out


def _relpath(path: str | None) -> str | None:
    if not path:
        return None
    try:
        return str(Path(path).relative_to(Path.cwd()))
    except ValueError:
        return path


def export_json(db: Database, out_path: str | Path) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rows = _rows(db)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"questions": rows, "count": len(rows)}, fh, indent=2, default=str)
    return out_path


def export_csv(db: Database, out_path: str | Path) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rows = _rows(db)
    if not rows:
        return out_path
    fieldnames = list(rows[0].keys())
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: (v if v is not None else "") for k, v in row.items()})
    return out_path
