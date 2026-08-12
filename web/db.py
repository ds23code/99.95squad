"""Read-side database access for the website.

Each request gets its own SQLite connection (WAL mode allows concurrent
reads while the pipeline writes).
"""

from __future__ import annotations

from pathlib import Path

from pipeline.config import Config
from pipeline.database import Database


def get_db(config: Config | None = None) -> Database:
    from pipeline.config import default_config

    cfg = config or default_config()
    db = Database(cfg.paths["database"])
    db.init_schema()
    return db


def image_url(config: Config, path: str | None) -> str | None:
    """Convert a stored absolute image path to a web URL relative to /images."""
    if not path:
        return None
    data_dir = Path(config.paths["data_dir"]).resolve()
    try:
        rel = Path(path).resolve().relative_to(data_dir)
        return "/images/" + rel.as_posix()
    except ValueError:
        return None


def filter_options(db: Database) -> dict:
    """Populate the filter dropdowns."""
    with db.conn() as c:
        subjects = [dict(r) for r in c.execute(
            """SELECT s.id, s.name, COUNT(DISTINCT q.id) AS n
               FROM subjects s
               LEFT JOIN courses c ON c.subject_id = s.id
               LEFT JOIN questions q ON q.course_id = c.id
               GROUP BY s.id ORDER BY s.name"""
        ).fetchall()]
        courses = [dict(r) for r in c.execute(
            """SELECT c.id, c.name, c.subject_id, COUNT(DISTINCT q.id) AS n
               FROM courses c
               LEFT JOIN questions q ON q.course_id = c.id
               GROUP BY c.id ORDER BY c.name"""
        ).fetchall()]
        topics = [dict(r) for r in c.execute(
            """SELECT t.id, t.name, t.course_id, COUNT(DISTINCT q.id) AS n
               FROM topics t
               LEFT JOIN questions q ON q.topic_id = t.id
               GROUP BY t.id ORDER BY t.name"""
        ).fetchall()]
        paper_types = [r[0] for r in c.execute(
            "SELECT DISTINCT paper_type FROM papers WHERE paper_type IS NOT NULL ORDER BY 1"
        ).fetchall()]
        paper_years = [r[0] for r in c.execute(
            "SELECT DISTINCT year FROM papers WHERE year IS NOT NULL ORDER BY year DESC"
        ).fetchall()]
        question_types = [r[0] for r in c.execute(
            "SELECT DISTINCT question_type FROM questions WHERE question_type IS NOT NULL ORDER BY 1"
        ).fetchall()]
    return {
        "subjects": subjects,
        "courses": courses,
        "topics": topics,
        "paper_types": paper_types,
        "paper_years": paper_years,
        "question_types": question_types,
    }
