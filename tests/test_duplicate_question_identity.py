"""Regression coverage for repeated question numbers and recoverable reruns."""

from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest

from pipeline.database import Database
from pipeline.models import DetectionResult, QuestionRegion
from pipeline.process import PipelineError, process_pdf


def _write_two_page_pdf(path: Path, label: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open()
    question_page = doc.new_page(width=595, height=600)
    question_page.insert_text((50, 55), f"{label} Section A", fontsize=14)
    question_page.insert_text((50, 85), "Question 1 Find the first value. (2 marks)", fontsize=11)
    question_page.insert_text((50, 235), f"{label} Section B", fontsize=14)
    question_page.insert_text((50, 265), "Question 1 Find the second value. (3 marks)", fontsize=11)
    answer_page = doc.new_page(width=595, height=600)
    answer_page.insert_text((50, 55), "Answers", fontsize=14)
    answer_page.insert_text((50, 90), "1. 42", fontsize=11)
    answer_page.insert_text((50, 190), "1. 84", fontsize=11)
    doc.save(path)
    doc.close()
    return path


def _duplicate_detection() -> DetectionResult:
    return DetectionResult(
        questions=[
            QuestionRegion(
                number="1", section="A", page_start=1, page_end=1,
                y_top=60, y_bottom=190, marks=2,
                text="Question 1 Find the first value. (2 marks)",
            ),
            QuestionRegion(
                number="1", section="B", page_start=1, page_end=1,
                y_top=220, y_bottom=360, marks=3,
                text="Question 1 Find the second value. (3 marks)",
            ),
        ],
        solution_regions=[
            QuestionRegion(
                number="1", page_start=2, page_end=2,
                y_top=65, y_bottom=125, text="1. 42", is_solution_block=True,
            ),
            QuestionRegion(
                number="1", page_start=2, page_end=2,
                y_top=165, y_bottom=225, text="1. 84", is_solution_block=True,
            ),
        ],
        answer_pages=[2],
    )


def test_duplicate_numbers_recover_rerun_and_do_not_overwrite_other_papers(
    config, tmp_path, monkeypatch
):
    """The reported PK collision is recoverable and all identities stay stable."""
    from pipeline.detect import QuestionDetector

    monkeypatch.setattr(QuestionDetector, "detect", lambda self, doc: _duplicate_detection())
    first_pdf = _write_two_page_pdf(
        tmp_path / "first" / "SharedSchool_2024_2U_Test.pdf", "First paper"
    )
    second_pdf = _write_two_page_pdf(
        tmp_path / "second" / "SharedSchool_2024_2U_Test.pdf", "Second paper"
    )

    # Simulate the original approval failing after the first row committed.
    original_upsert = Database.upsert_question
    failed_once = False

    def fail_on_second_occurrence(self, question):
        nonlocal failed_once
        if question.get("question_occurrence") == 2 and not failed_once:
            failed_once = True
            raise RuntimeError("simulated interrupted extraction")
        return original_upsert(self, question)

    monkeypatch.setattr(Database, "upsert_question", fail_on_second_occurrence)
    with pytest.raises(PipelineError, match="simulated interrupted extraction"):
        process_pdf(config, first_pdf)

    monkeypatch.setattr(Database, "upsert_question", original_upsert)
    recovered = process_pdf(config, first_pdf)
    assert recovered["questions"] == 2

    db = Database(config.paths["database"])
    db.init_schema()
    first_rows = db.questions_for_paper(recovered["paper_id"])
    assert [row["question_occurrence"] for row in first_rows] == [1, 2]
    assert {row["id"] for row in first_rows} == {
        f"{recovered['paper_id']}-q1",
        f"{recovered['paper_id']}-q1--occurrence-2",
    }
    assert len({row["image_path"] for row in first_rows}) == 2
    assert all(Path(row["image_path"]).is_file() for row in first_rows)
    assert all(Path(row["image_path"]).parent.name == recovered["paper_id"] for row in first_rows)
    assert [row["answer"] for row in first_rows] == ["42", "84"]

    with db.conn() as connection:
        first_answer_ids = {
            row[0]
            for row in connection.execute(
                "SELECT question_id FROM answers WHERE paper_id=?", (recovered["paper_id"],)
            ).fetchall()
        }
    assert first_answer_ids == {row["id"] for row in first_rows}

    # A forced rerun is idempotent: no extra rows, IDs, or paths are created.
    rerun = process_pdf(config, first_pdf, force=True, db=db)
    rerun_rows = db.questions_for_paper(rerun["paper_id"])
    assert [(row["id"], row["image_path"]) for row in rerun_rows] == [
        (row["id"], row["image_path"]) for row in first_rows
    ]
    with db.conn() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM answers WHERE paper_id=?", (rerun["paper_id"],)
        ).fetchone()[0] == 2

    # A different PDF with the same metadata and numbers gets distinct IDs and
    # a paper-specific image directory instead of overwriting the first paper.
    second = process_pdf(config, second_pdf, db=db)
    second_rows = db.questions_for_paper(second["paper_id"])
    assert second["paper_id"] != recovered["paper_id"]
    assert len(second_rows) == 2
    assert {row["id"] for row in first_rows}.isdisjoint({row["id"] for row in second_rows})
    assert {row["image_path"] for row in first_rows}.isdisjoint(
        {row["image_path"] for row in second_rows}
    )
    assert all(Path(row["image_path"]).parent.name == second["paper_id"] for row in second_rows)
    db.close()
