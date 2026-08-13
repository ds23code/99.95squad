"""Data-preserving SQLite schema migration regressions."""

from __future__ import annotations

import sqlite3

from pipeline.database import Database, SCHEMA


def _legacy_schema() -> str:
    return SCHEMA.replace(
        "    question_occurrence INTEGER NOT NULL DEFAULT 1,\n", ""
    ).replace(
        "UNIQUE(paper_id, question_number, question_occurrence)",
        "UNIQUE(paper_id, question_number, page_start)",
    )


def test_legacy_question_identity_migration_preserves_rows_and_foreign_keys(tmp_path):
    db_path = tmp_path / "legacy.db"
    connection = sqlite3.connect(db_path)
    connection.executescript(_legacy_schema())
    connection.execute(
        "INSERT INTO papers (id, filename, sha256) VALUES (?, ?, ?)",
        ("legacy-paper", "legacy.pdf", "ab" * 32),
    )
    connection.execute(
        "INSERT INTO questions "
        "(id, paper_id, question_number, page_start, page_end, ocr_clean) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("legacy-paper-q1", "legacy-paper", "1", 1, 1, "preserve me"),
    )
    connection.execute(
        "INSERT INTO answers (id, question_id, paper_id, answer_text) VALUES (?, ?, ?, ?)",
        ("legacy-answer", "legacy-paper-q1", "legacy-paper", "42"),
    )
    connection.commit()
    connection.close()

    db = Database(db_path)
    db.init_schema()
    migrated = db.get_question("legacy-paper-q1")
    assert migrated is not None
    assert migrated["question_occurrence"] == 1
    assert migrated["ocr_clean"] == "preserve me"
    with db.conn() as connection:
        assert connection.execute(
            "SELECT answer_text FROM answers WHERE id='legacy-answer'"
        ).fetchone()[0] == "42"
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        unique_shapes = {
            tuple(
                column[2]
                for column in connection.execute(
                    f"PRAGMA index_info('{index[1]}')"
                ).fetchall()
            )
            for index in connection.execute("PRAGMA index_list(questions)").fetchall()
            if index[2]
        }
    assert ("paper_id", "question_number", "question_occurrence") in unique_shapes
    assert ("paper_id", "question_number", "page_start") not in unique_shapes

    # Schema initialization is itself idempotent.
    db.init_schema()
    assert db.get_question("legacy-paper-q1")["question_occurrence"] == 1
    db.close()


def test_identity_migration_allows_only_preexisting_normalised_fk_violations(tmp_path):
    """A legacy orphan is preserved, rather than mistaken for migration damage."""
    db_path = tmp_path / "legacy-with-orphan.db"
    connection = sqlite3.connect(db_path)
    connection.executescript(_legacy_schema())
    connection.execute("PRAGMA foreign_keys = OFF")
    connection.execute(
        "INSERT INTO answers (id, question_id, paper_id, answer_text) VALUES (?, ?, ?, ?)",
        ("orphan-answer", "missing-question", None, "legacy orphan"),
    )
    connection.commit()
    before = connection.execute("PRAGMA foreign_key_check").fetchall()
    assert len(before) == 1
    connection.close()

    db = Database(db_path)
    db.init_schema()
    with db.conn() as migrated:
        after = migrated.execute("PRAGMA foreign_key_check").fetchall()
        assert len(after) == 1
        assert tuple(after[0])[0] == "answers"
        assert migrated.execute(
            "SELECT answer_text FROM answers WHERE id='orphan-answer'"
        ).fetchone()[0] == "legacy orphan"
    db.close()
