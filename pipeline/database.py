"""SQLite persistence layer.

Schema: subjects, courses, topics, subtopics, papers, pages, questions,
answers, solutions, user_marks + an FTS5 full-text index (questions_fts)
that keeps search working even when OCR is imperfect (search is on
cleaned OCR text *plus* all metadata).
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

from .config import Config

SCHEMA = """
CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL REFERENCES subjects(id),
    name TEXT NOT NULL,
    year_level INTEGER
);

CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id),
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subtopics (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id),
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS curriculum_topics (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id),
    year_level INTEGER,
    module TEXT,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS curriculum_outcomes (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id),
    code TEXT NOT NULL,
    description TEXT NOT NULL,
    skill_concept TEXT
);

CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    file_path TEXT,
    sha256 TEXT UNIQUE,
    display_name TEXT,
    organisation TEXT,
    year INTEGER,
    paper_type TEXT,
    subject_id TEXT,
    course_id TEXT,
    year_level INTEGER,
    has_solutions INTEGER DEFAULT 0,
    page_count INTEGER,
    status TEXT DEFAULT 'pending',          -- pending | processing | complete | error
    error TEXT,
    processed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    image_path TEXT,
    width INTEGER,
    height INTEGER,
    UNIQUE(paper_id, page_number)
);

CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    question_number TEXT NOT NULL,
    section TEXT,
    marks INTEGER,
    subparts INTEGER,
    page_start INTEGER,
    page_end INTEGER,
    image_path TEXT,
    image_width INTEGER,
    image_height INTEGER,
    ocr_raw TEXT,
    ocr_clean TEXT,
    ocr_engine TEXT,
    ocr_confidence REAL,
    answer TEXT,
    answer_source TEXT,
    solution_image_path TEXT,
    solution_text TEXT,
    subject_id TEXT,
    course_id TEXT,
    year_level INTEGER,
    topic_id TEXT,
    subtopic_id TEXT,
    difficulty REAL,
    difficulty_reasoning TEXT,
    question_type TEXT,
    extraction_confidence REAL,
    classification_confidence REAL,
    status TEXT DEFAULT 'new',              -- new | needs_review | reviewed
    review_flags TEXT,
    reviewed INTEGER DEFAULT 0,
    reviewed_by TEXT,
    review_notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(paper_id, question_number, page_start)
);

CREATE INDEX IF NOT EXISTS idx_questions_paper ON questions(paper_id);
CREATE INDEX IF NOT EXISTS idx_questions_course ON questions(course_id);
CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic_id);
CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(question_type);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);

CREATE TABLE IF NOT EXISTS answers (
    id TEXT PRIMARY KEY,
    question_id TEXT REFERENCES questions(id) ON DELETE CASCADE,
    paper_id TEXT REFERENCES papers(id) ON DELETE CASCADE,
    answer_text TEXT,
    answer_type TEXT,
    image_path TEXT,
    source_page INTEGER,
    confidence REAL
);

CREATE TABLE IF NOT EXISTS solutions (
    id TEXT PRIMARY KEY,
    question_id TEXT REFERENCES questions(id) ON DELETE CASCADE,
    paper_id TEXT REFERENCES papers(id) ON DELETE CASCADE,
    image_path TEXT,
    text TEXT,
    source_page INTEGER,
    confidence REAL
);

CREATE TABLE IF NOT EXISTS user_marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                     -- favourite | completed
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(question_id, kind)
);

CREATE TABLE IF NOT EXISTS user_profiles (
    id TEXT PRIMARY KEY,
    email TEXT,
    display_name TEXT,
    access_tier TEXT DEFAULT 'free',        -- free | premium | contributor
    premium_until TEXT,
    contribution_credits INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS upload_submissions (
    id TEXT PRIMARY KEY,
    sha256 TEXT UNIQUE,
    filename TEXT,
    file_path TEXT,
    size_bytes INTEGER,
    uploader TEXT,                          -- user id / email
    status TEXT DEFAULT 'pending',          -- pending | processing | approved | rejected | duplicate | needs_review
    paper_id TEXT REFERENCES papers(id),
    premium_granted INTEGER DEFAULT 0,
    review_notes TEXT,
    duplicate_of TEXT,
    duplicate_type TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    reviewed_at TEXT,
    reviewed_by TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT NOT NULL,
    previous_status TEXT,
    new_status TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS problem_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id TEXT,
    reason TEXT,
    details TEXT,
    reporter TEXT,
    status TEXT DEFAULT 'open',             -- open | fixed | wontfix
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(
    question_id UNINDEXED,
    search_text,
    tokenize = 'unicode61 remove_diacritics 2'
);
"""


class Database:
    """Thin DAO over SQLite. One connection per instance (thread-local via
    :meth:`connect` for web requests)."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        self._conn: Optional[sqlite3.Connection] = None

    # ------------------------------------------------------------------ conn
    def connect(self) -> sqlite3.Connection:
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        return conn

    @contextmanager
    def conn(self) -> Iterator[sqlite3.Connection]:
        """Long-lived connection for CLI use (single thread)."""
        if self._conn is None:
            self._conn = self.connect()
        yield self._conn
        self._conn.commit()

    def exec(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        """Execute a statement and commit."""
        with self.conn() as c:
            return c.execute(sql, tuple(params))

    def init_schema(self) -> None:
        with self.conn() as c:
            c.executescript(SCHEMA)

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self) -> "Database":
        self.init_schema()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # --------------------------------------------------------------- seeding
    def seed_taxonomy(self, config: Config) -> None:
        """Populate subjects/courses/topics/subtopics from config (idempotent)."""
        with self.conn() as c:
            for subj in config.subjects.get("subjects", []):
                c.execute(
                    "INSERT OR IGNORE INTO subjects (id, name) VALUES (?, ?)",
                    (subj["id"], subj["name"]),
                )
                for course in subj.get("courses", []):
                    c.execute(
                        "INSERT OR IGNORE INTO courses (id, subject_id, name, year_level)"
                        " VALUES (?, ?, ?, ?)",
                        (course["id"], subj["id"], course["name"], course.get("year_level")),
                    )
            for course_id, topics in config.topics_for_course_all().items():
                for topic in topics:
                    c.execute(
                        "INSERT OR IGNORE INTO topics (id, course_id, name) VALUES (?, ?, ?)",
                        (f"{course_id}:{topic['id']}", course_id, topic["name"]),
                    )
                    c.execute(
                        "INSERT OR IGNORE INTO curriculum_topics (id, course_id, year_level, module, name) VALUES (?, ?, ?, ?, ?)",
                        (f"{course_id}:{topic['id']}", course_id, topic.get("year_level", 12), topic.get("module"), topic["name"]),
                    )
                    for st in topic.get("subtopics", []):
                        c.execute(
                            "INSERT OR IGNORE INTO subtopics (id, topic_id, name) VALUES (?, ?, ?)",
                            (
                                f"{course_id}:{topic['id']}:{st['id']}",
                                f"{course_id}:{topic['id']}",
                                st["name"],
                            ),
                        )
                    for out in topic.get("outcomes", []):
                        if isinstance(out, dict):
                            c.execute(
                                "INSERT OR IGNORE INTO curriculum_outcomes (id, topic_id, code, description, skill_concept) VALUES (?, ?, ?, ?, ?)",
                                (
                                    f"{course_id}:{topic['id']}:{out['code']}",
                                    f"{course_id}:{topic['id']}",
                                    out["code"],
                                    out["description"],
                                    out.get("skill_concept"),
                                ),
                            )

    # ---------------------------------------------------------------- papers
    def insert_paper(self, paper: dict) -> str:
        with self.conn() as c:
            c.execute(
                """INSERT INTO papers (id, filename, file_path, sha256, display_name,
                       organisation, year, paper_type, subject_id, course_id,
                       year_level, has_solutions, page_count, status)
                   VALUES (:id, :filename, :file_path, :sha256, :display_name,
                       :organisation, :year, :paper_type, :subject_id, :course_id,
                       :year_level, :has_solutions, :page_count, :status)
                   ON CONFLICT(sha256) DO UPDATE SET
                       filename=excluded.filename,
                       file_path=excluded.file_path,
                       display_name=excluded.display_name,
                       organisation=excluded.organisation,
                       year=excluded.year,
                       paper_type=excluded.paper_type,
                       subject_id=excluded.subject_id,
                       course_id=excluded.course_id,
                       year_level=excluded.year_level,
                       has_solutions=excluded.has_solutions,
                       page_count=excluded.page_count,
                       status=CASE WHEN papers.status='complete' THEN papers.status
                                   ELSE excluded.status END""",
                paper,
            )
            return paper["id"]

    def get_paper(self, paper_id: str) -> Optional[dict]:
        with self.conn() as c:
            row = c.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()
            return dict(row) if row else None

    def get_paper_by_sha256(self, sha256: str) -> Optional[dict]:
        with self.conn() as c:
            row = c.execute("SELECT * FROM papers WHERE sha256 = ?", (sha256,)).fetchone()
            return dict(row) if row else None

    def find_papers_by_metadata(
        self,
        course_id: str | None,
        year: int | None,
        organisation: str | None = None,
        paper_type: str | None = None,
    ) -> list[dict]:
        if not course_id or not year:
            return []
        with self.conn() as c:
            sql = "SELECT * FROM papers WHERE course_id=? AND year=?"
            params: list[Any] = [course_id, year]
            if organisation:
                sql += " AND lower(organisation)=?"
                params.append(organisation.lower())
            if paper_type:
                sql += " AND paper_type=?"
                params.append(paper_type)
            rows = c.execute(sql, params).fetchall()
            return [dict(r) for r in rows]

    def set_paper_status(self, paper_id: str, status: str, error: str | None = None) -> None:
        with self.conn() as c:
            if error:
                c.execute(
                    "UPDATE papers SET status=?, error=?, processed_at=datetime('now')"
                    " WHERE id=?",
                    (status, error[:2000], paper_id),
                )
            else:
                c.execute(
                    "UPDATE papers SET status=?, error=NULL, processed_at=datetime('now')"
                    " WHERE id=?",
                    (status, paper_id),
                )

    def list_papers(self, status: str | None = None) -> list[dict]:
        with self.conn() as c:
            if status:
                rows = c.execute(
                    "SELECT * FROM papers WHERE status=? ORDER BY created_at DESC", (status,)
                ).fetchall()
            else:
                rows = c.execute("SELECT * FROM papers ORDER BY created_at DESC").fetchall()
            return [dict(r) for r in rows]

    # ---------------------------------------------------------------- pages
    def insert_page(self, page: dict) -> None:
        with self.conn() as c:
            c.execute(
                """INSERT OR REPLACE INTO pages (id, paper_id, page_number, image_path,
                       width, height) VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    page["id"],
                    page["paper_id"],
                    page["page_number"],
                    page.get("image_path"),
                    page.get("width"),
                    page.get("height"),
                ),
            )

    # ------------------------------------------------------------ questions
    def upsert_question(self, q: dict) -> str:
        with self.conn() as c:
            c.execute(
                """INSERT INTO questions (id, paper_id, question_number, section, marks,
                       subparts, page_start, page_end, image_path, image_width,
                       image_height, ocr_raw, ocr_clean, ocr_engine, ocr_confidence,
                       answer, answer_source, solution_image_path, solution_text,
                       subject_id, course_id, year_level, topic_id, subtopic_id,
                       difficulty, difficulty_reasoning, question_type,
                       extraction_confidence, classification_confidence, status,
                       review_flags)
                   VALUES (:id, :paper_id, :question_number, :section, :marks,
                       :subparts, :page_start, :page_end, :image_path, :image_width,
                       :image_height, :ocr_raw, :ocr_clean, :ocr_engine, :ocr_confidence,
                       :answer, :answer_source, :solution_image_path, :solution_text,
                       :subject_id, :course_id, :year_level, :topic_id, :subtopic_id,
                       :difficulty, :difficulty_reasoning, :question_type,
                       :extraction_confidence, :classification_confidence, :status,
                       :review_flags)
                   ON CONFLICT(paper_id, question_number, page_start) DO UPDATE SET
                       section=excluded.section, marks=excluded.marks,
                       subparts=excluded.subparts, page_start=excluded.page_start,
                       page_end=excluded.page_end, image_path=excluded.image_path,
                       image_width=excluded.image_width,
                       image_height=excluded.image_height,
                       ocr_raw=excluded.ocr_raw, ocr_clean=excluded.ocr_clean,
                       ocr_engine=excluded.ocr_engine,
                       ocr_confidence=excluded.ocr_confidence,
                       answer=excluded.answer, answer_source=excluded.answer_source,
                       solution_image_path=excluded.solution_image_path,
                       solution_text=excluded.solution_text,
                       subject_id=excluded.subject_id, course_id=excluded.course_id,
                       year_level=excluded.year_level, topic_id=excluded.topic_id,
                       subtopic_id=excluded.subtopic_id,
                       difficulty=excluded.difficulty,
                       difficulty_reasoning=excluded.difficulty_reasoning,
                       question_type=excluded.question_type,
                       extraction_confidence=excluded.extraction_confidence,
                       classification_confidence=excluded.classification_confidence,
                       status=CASE
                           WHEN questions.reviewed=1 THEN questions.status
                           ELSE excluded.status END,
                       review_flags=excluded.review_flags,
                       updated_at=datetime('now')""",
                q,
            )
            self._sync_fts(c, q["id"])
            return q["id"]

    @staticmethod
    def _sync_fts(c: sqlite3.Connection, question_id: str) -> None:
        row = c.execute(
            """SELECT q.id, q.ocr_clean, q.question_number, q.marks, q.question_type,
                      q.topic_id, q.subtopic_id, q.difficulty, q.year_level, q.section,
                      p.display_name, p.organisation, p.year, p.paper_type,
                      p.course_id, p.subject_id,
                      COALESCE(t.name, '') AS topic_name,
                      COALESCE(s.name, '') AS subtopic_name
               FROM questions q
               JOIN papers p ON p.id = q.paper_id
               LEFT JOIN topics t ON t.id = q.topic_id
               LEFT JOIN subtopics s ON s.id = q.subtopic_id
               WHERE q.id = ?""",
            (question_id,),
        ).fetchone()
        if row is None:
            return
        search_text = " ".join(
            str(x) for x in (
                row["ocr_clean"], row["question_number"], row["section"],
                row["topic_id"], row["subtopic_id"],
                row["topic_name"], row["subtopic_name"],
                row["display_name"], row["organisation"], row["year"],
                row["paper_type"], row["course_id"], row["subject_id"],
                row["question_type"],
            ) if x
        )
        c.execute(
            "INSERT OR REPLACE INTO questions_fts (question_id, search_text) VALUES (?, ?)",
            (question_id, search_text),
        )

    def get_question(self, question_id: str) -> Optional[dict]:
        with self.conn() as c:
            row = c.execute(
                """SELECT q.*, p.display_name AS paper_name, p.organisation,
                          p.year AS paper_year, p.paper_type, p.filename AS paper_filename,
                          COALESCE(t.name,'') AS topic_name,
                          COALESCE(s.name,'') AS subtopic_name,
                          COALESCE(c.name,'') AS course_name,
                          COALESCE(c.subject_id,'') AS subject_id_name,
                          COALESCE(subj.name,'') AS subject_name,
                          (SELECT COUNT(*) FROM user_marks m
                            WHERE m.question_id=q.id AND m.kind='favourite') AS is_favourite,
                          (SELECT COUNT(*) FROM user_marks m
                            WHERE m.question_id=q.id AND m.kind='completed') AS is_completed
                   FROM questions q
                   JOIN papers p ON p.id = q.paper_id
                   LEFT JOIN topics t ON t.id = q.topic_id
                   LEFT JOIN subtopics s ON s.id = q.subtopic_id
                   LEFT JOIN courses c ON c.id = q.course_id
                   LEFT JOIN subjects subj ON subj.id = COALESCE(q.subject_id, c.subject_id)
                   WHERE q.id = ?""",
                (question_id,),
            ).fetchone()
            return dict(row) if row else None

    def questions_for_paper(self, paper_id: str) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT * FROM questions WHERE paper_id=? ORDER BY page_start, question_number",
                (paper_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def set_question_status(self, question_id: str, status: str, notes: str | None = None,
                            reviewed_by: str = "cli") -> None:
        with self.conn() as c:
            c.execute(
                "UPDATE questions SET status=?, reviewed=1, reviewed_by=?, review_notes=COALESCE(?, review_notes),"
                " updated_at=datetime('now') WHERE id=?",
                (status, reviewed_by, notes, question_id),
            )

    def update_question_fields(self, question_id: str, fields: dict) -> None:
        """Persist human corrections. Only the provided fields are updated."""
        allowed = {
            "question_number", "section", "marks", "subparts", "page_start", "page_end",
            "ocr_clean", "ocr_raw", "answer", "answer_source", "solution_text",
            "solution_image_path", "image_path",
            "topic_id", "subtopic_id", "course_id", "subject_id", "year_level",
            "difficulty", "question_type", "status", "review_flags", "review_notes",
        }
        fields = {k: v for k, v in fields.items() if k in allowed}
        if not fields:
            return
        assignments = ", ".join(f"{k}=:{k}" for k in fields)
        with self.conn() as c:
            c.execute(
                f"UPDATE questions SET {assignments}, updated_at=datetime('now') WHERE id=:question_id",
                {**fields, "question_id": question_id},
            )
            if any(k in fields for k in ("ocr_clean", "topic_id", "subtopic_id")):
                self._sync_fts(c, question_id)

    # ---------------------------------------------------------------- search
    @staticmethod
    def build_fts_query(q: str) -> str:
        """Turn a free-text query into an FTS5 MATCH expression.

        Each whitespace-separated token becomes a quoted phrase; tokens are
        AND-ed so a search for `normal distribution` requires both words
        (matching documents containing "normal distribution" or "normal" and
        "distribution" separately).
        """
        tokens = re.findall(r"[\w'-]+", q.lower())
        if not tokens:
            return ""
        return " AND ".join(f'"{t}"' for t in tokens)

    def search_questions(
        self,
        q: str | None = None,
        *,
        filters: Optional[dict] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict], int]:
        filters = filters or {}
        where, params = [], []

        if q:
            match = self.build_fts_query(q)
            if match:
                where.append("questions.id IN (SELECT question_id FROM questions_fts WHERE questions_fts MATCH ?)")
                params.append(match)
            else:
                return [], 0

        def add(cond: str, value: Any) -> None:
            where.append(cond)
            params.append(value)

        if filters.get("course_id"):
            add("questions.course_id = ?", filters["course_id"])
        elif filters.get("subject_id"):
            add("questions.subject_id = ?", filters["subject_id"])
        if filters.get("topic_id"):
            add("questions.topic_id = ?", filters["topic_id"])
        if filters.get("subtopic_id"):
            add("questions.subtopic_id = ?", filters["subtopic_id"])
        if filters.get("year_level"):
            add("questions.year_level = ?", int(filters["year_level"]))
        if filters.get("question_type"):
            add("questions.question_type = ?", filters["question_type"])
        if filters.get("paper_year"):
            add("papers.year = ?", int(filters["paper_year"]))
        if filters.get("paper_type"):
            add("papers.paper_type = ?", filters["paper_type"])
        if filters.get("marks_min"):
            add("questions.marks >= ?", int(filters["marks_min"]))
        if filters.get("difficulty_min"):
            add("questions.difficulty >= ?", float(filters["difficulty_min"]))
        if filters.get("difficulty_max"):
            add("questions.difficulty <= ?", float(filters["difficulty_max"]))
        if filters.get("status"):
            add("questions.status = ?", filters["status"])

        where_sql = f"WHERE {' AND '.join(where)}" if where else ""
        sql = f"""
            SELECT questions.*, papers.display_name AS paper_name, papers.organisation,
                   papers.year AS paper_year, papers.paper_type,
                   COALESCE(t.name,'') AS topic_name,
                   COALESCE(s.name,'') AS subtopic_name,
                   COALESCE(c.name,'') AS course_name,
                   COALESCE(subj.name,'') AS subject_name
            FROM questions
            JOIN papers ON papers.id = questions.paper_id
            LEFT JOIN topics t ON t.id = questions.topic_id
            LEFT JOIN subtopics s ON s.id = questions.subtopic_id
            LEFT JOIN courses c ON c.id = questions.course_id
            LEFT JOIN subjects subj ON subj.id = COALESCE(questions.subject_id, c.subject_id)
            {where_sql}
            ORDER BY questions.paper_id, questions.page_start, questions.question_number
            LIMIT ? OFFSET ?
        """
        with self.conn() as c:
            rows = c.execute(sql, params + [limit, offset]).fetchall()
            count = c.execute(
                f"SELECT COUNT(*) FROM questions JOIN papers ON papers.id=questions.paper_id {where_sql}",
                params,
            ).fetchone()[0]
            return [dict(r) for r in rows], count

    def random_questions(self, filters: Optional[dict] = None, n: int = 1) -> list[dict]:
        filters = dict(filters or {})
        filters.pop("status", None)
        questions, _ = self.search_questions(None, filters=filters, limit=100000)
        if not questions:
            return []
        import random

        random.shuffle(questions)
        return questions[:n]

    # ----------------------------------------------------------- user marks
    def set_user_mark(self, question_id: str, kind: str) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT OR IGNORE INTO user_marks (question_id, kind) VALUES (?, ?)",
                (question_id, kind),
            )

    def unset_user_mark(self, question_id: str, kind: str) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM user_marks WHERE question_id=? AND kind=?", (question_id, kind))

    # ------------------------------------------------------------- solutions
    def upsert_answer(self, answer: dict) -> str:
        answer_id = answer.get("id") or f"{answer['question_id'] or answer['paper_id']}-ans-{answer['source_page']}"
        with self.conn() as c:
            c.execute(
                """INSERT OR REPLACE INTO answers (id, question_id, paper_id, answer_text,
                       answer_type, image_path, source_page, confidence)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    answer_id,
                    answer.get("question_id"),
                    answer.get("paper_id"),
                    answer.get("answer_text"),
                    answer.get("answer_type", "answer"),
                    answer.get("image_path"),
                    answer.get("source_page"),
                    answer.get("confidence", 1.0),
                ),
            )
            return answer_id

    def upsert_solution(self, solution: dict) -> str:
        solution_id = solution.get("id") or f"{solution['question_id'] or solution['paper_id']}-sol-{solution['source_page']}"
        with self.conn() as c:
            c.execute(
                """INSERT OR REPLACE INTO solutions (id, question_id, paper_id, image_path,
                       text, source_page, confidence)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    solution_id,
                    solution.get("question_id"),
                    solution.get("paper_id"),
                    solution.get("image_path"),
                    solution.get("text"),
                    solution.get("source_page"),
                    solution.get("confidence", 1.0),
                ),
            )
            return solution_id

    # ------------------------------------------------------------ uploads
    def upsert_upload(self, upload: dict) -> str:
        upload = dict(upload)
        upload.setdefault("duplicate_of", None)
        upload.setdefault("duplicate_type", None)
        with self.conn() as c:
            c.execute(
                """INSERT INTO upload_submissions (id, sha256, filename, file_path,
                       size_bytes, uploader, status, paper_id, premium_granted, review_notes,
                       duplicate_of, duplicate_type)
                   VALUES (:id, :sha256, :filename, :file_path, :size_bytes, :uploader, :status,
                       :paper_id, :premium_granted, :review_notes, :duplicate_of, :duplicate_type)
                   ON CONFLICT(sha256) DO UPDATE SET
                       filename=excluded.filename, file_path=excluded.file_path,
                       size_bytes=excluded.size_bytes,
                       uploader=excluded.uploader, status=excluded.status,
                       paper_id=excluded.paper_id, review_notes=excluded.review_notes,
                       duplicate_of=excluded.duplicate_of, duplicate_type=excluded.duplicate_type""",
                upload,
            )
            return upload["id"]

    def get_upload(self, upload_id: str) -> Optional[dict]:
        with self.conn() as c:
            row = c.execute(
                "SELECT * FROM upload_submissions WHERE id = ?", (upload_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_upload_by_sha256(self, sha256: str) -> Optional[dict]:
        with self.conn() as c:
            row = c.execute(
                "SELECT * FROM upload_submissions WHERE sha256 = ?", (sha256,)
            ).fetchone()
            return dict(row) if row else None

    def list_uploads(self, status: str | None = None) -> list[dict]:
        with self.conn() as c:
            if status:
                rows = c.execute(
                    "SELECT * FROM upload_submissions WHERE status=? ORDER BY created_at DESC",
                    (status,),
                ).fetchall()
            else:
                rows = c.execute(
                    "SELECT * FROM upload_submissions ORDER BY created_at DESC"
                ).fetchall()
            return [dict(r) for r in rows]

    def set_upload_status(self, upload_id: str, status: str, reviewer: str | None = None,
                          notes: str | None = None, paper_id: str | None = None) -> None:
        with self.conn() as c:
            c.execute(
                """UPDATE upload_submissions
                   SET status=?, reviewed_by=COALESCE(?, reviewed_by),
                       review_notes=COALESCE(?, review_notes),
                       paper_id=COALESCE(?, paper_id),
                       reviewed_at=CASE WHEN ?='pending' THEN reviewed_at
                                        ELSE datetime('now') END
                   WHERE id=?""",
                (status, reviewer, notes, paper_id, status, upload_id),
            )

    # ------------------------------------------------------------ audit events
    def record_audit_event(
        self,
        actor: str,
        action: str,
        target_id: str,
        previous_status: str | None = None,
        new_status: str | None = None,
        notes: str | None = None,
    ) -> str:
        import uuid
        event_id = f"aud-{uuid.uuid4().hex[:12]}"
        with self.conn() as c:
            c.execute(
                """INSERT INTO audit_events (id, actor, action, target_id,
                       previous_status, new_status, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (event_id, actor, action, target_id, previous_status, new_status, notes),
            )
        return event_id

    def list_audit_events(self, limit: int = 100, target_id: str | None = None) -> list[dict]:
        with self.conn() as c:
            if target_id:
                rows = c.execute(
                    "SELECT * FROM audit_events WHERE target_id=? ORDER BY created_at DESC LIMIT ?",
                    (target_id, limit),
                ).fetchall()
            else:
                rows = c.execute(
                    "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [dict(r) for r in rows]

    # ------------------------------------------------------------ profiles
    def upsert_profile(self, profile: dict) -> str:
        with self.conn() as c:
            c.execute(
                """INSERT INTO user_profiles (id, email, display_name, access_tier,
                       premium_until, contribution_credits)
                   VALUES (:id, :email, :display_name, :access_tier, :premium_until,
                       :contribution_credits)
                   ON CONFLICT(id) DO UPDATE SET
                       email=excluded.email, display_name=excluded.display_name,
                       access_tier=excluded.access_tier,
                       premium_until=excluded.premium_until,
                       contribution_credits=excluded.contribution_credits""",
                profile,
            )
            return profile["id"]

    def get_profile(self, profile_id: str) -> Optional[dict]:
        with self.conn() as c:
            row = c.execute(
                "SELECT * FROM user_profiles WHERE id = ?", (profile_id,)
            ).fetchone()
            return dict(row) if row else None

    def grant_premium(self, profile_id: str, days: int = 14) -> Optional[dict]:
        """Grant ``days`` of premium access from now; returns updated profile."""
        with self.conn() as c:
            c.execute(
                """UPDATE user_profiles SET
                       premium_until = datetime('now', '+' || ? || ' days'),
                       access_tier = CASE WHEN access_tier = 'premium' THEN 'premium'
                                          ELSE 'contributor' END,
                       contribution_credits = contribution_credits + 1
                   WHERE id = ?""",
                (days, profile_id),
            )
        return self.get_profile(profile_id)

    # ------------------------------------------------------- problem reports
    def add_problem_report(self, report: dict) -> int:
        with self.conn() as c:
            cur = c.execute(
                """INSERT INTO problem_reports (question_id, reason, details, reporter)
                   VALUES (?, ?, ?, ?)""",
                (report.get("question_id"), report.get("reason"),
                 report.get("details"), report.get("reporter")),
            )
            return cur.lastrowid

    # --------------------------------------------------------------- review
    def review_queue(self, limit: int = 200) -> list[dict]:
        """Questions that need human attention, worst first."""
        with self.conn() as c:
            rows = c.execute(
                """SELECT q.*, p.display_name AS paper_name, p.filename AS paper_filename
                   FROM questions q JOIN papers p ON p.id = q.paper_id
                   WHERE q.reviewed = 0
                   ORDER BY q.extraction_confidence ASC, q.classification_confidence ASC
                   LIMIT ?""",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    # ---------------------------------------------------------------- stats
    def stats(self) -> dict:
        with self.conn() as c:
            def one(sql: str, *args: Any) -> Any:
                return c.execute(sql, args).fetchone()[0]

            total_questions = one("SELECT COUNT(*) FROM questions")
            by_course = [
                dict(r)
                for r in c.execute(
                    """SELECT COALESCE(c.name,'unknown') AS course,
                              COUNT(*) AS n,
                              ROUND(AVG(questions.extraction_confidence),2) AS extraction_conf
                       FROM questions LEFT JOIN courses c ON c.id = questions.course_id
                       GROUP BY course ORDER BY n DESC"""
                ).fetchall()
            ]
            by_type = [
                dict(r)
                for r in c.execute(
                    "SELECT question_type, COUNT(*) AS n FROM questions GROUP BY question_type"
                ).fetchall()
            ]
            return {
                "papers": one("SELECT COUNT(*) FROM papers"),
                "papers_complete": one("SELECT COUNT(*) FROM papers WHERE status='complete'"),
                "papers_error": one("SELECT COUNT(*) FROM papers WHERE status='error'"),
                "pages": one("SELECT COUNT(*) FROM pages"),
                "questions": total_questions,
                "needs_review": one("SELECT COUNT(*) FROM questions WHERE reviewed=0"),
                "with_answers": one(
                    "SELECT COUNT(*) FROM questions WHERE answer IS NOT NULL AND answer != ''"
                ),
                "with_solutions": one(
                    "SELECT COUNT(*) FROM questions WHERE solution_image_path IS NOT NULL OR solution_text IS NOT NULL"
                ),
                "by_course": by_course,
                "by_type": by_type,
                "avg_extraction_confidence": one(
                    "SELECT ROUND(AVG(extraction_confidence),2) FROM questions"
                ),
            }


# Convenience accessor used across modules
def get_db(config: Config | None = None) -> Database:
    from .config import default_config

    cfg = config or default_config()
    return Database(cfg.paths["database"])
