"""End-to-end pipeline test on the synthetic TrialMaths-style PDF.

This is the first-milestone acceptance test: one real(istic) PDF in,
question images + OCR + metadata + answers out.
"""

from __future__ import annotations

from pathlib import Path

from pipeline.process import process_pdf


def test_full_pipeline_on_sample_pdf(config, sample_pdf):
    result = process_pdf(config, sample_pdf, force=True)
    assert result["skipped"] is False
    assert result["questions"] >= 13, result

    # ---- database ----------------------------------------------------------
    from pipeline.database import Database

    db = Database(config.paths["database"])
    db.init_schema()
    papers = db.list_papers()
    assert len(papers) == 1
    paper = papers[0]
    assert paper["status"] == "complete"
    assert paper["year"] == 2023
    assert paper["course_id"] == "mathematics-advanced"
    assert paper["has_solutions"] == 1
    assert paper["page_count"] == 5

    qs = db.questions_for_paper(paper["id"])
    assert len(qs) >= 13

    by_number = {q["question_number"]: q for q in qs}

    # MCQs detected (questions 1-4 are multiple choice in the sample)
    assert by_number["1"]["question_type"] == "multiple_choice"

    # marks parsed
    assert by_number["6"]["marks"] == 4
    assert by_number["13"]["marks"] == 6

    # subparts
    assert by_number["6"]["subparts"] == 3
    assert by_number["13"]["subparts"] == 4

    # multi-page question 8: starts page 2, continues page 3
    q8 = by_number["8"]
    assert q8["page_start"] == 2 and q8["page_end"] == 3, q8

    # answers attached from the answer section
    assert by_number["1"]["answer"] == "B", by_number["1"]
    assert by_number["3"]["answer"] == "B", by_number["3"]
    assert by_number["4"]["answer"] == "A", by_number["4"]

    # solution image exists for worked solutions
    assert by_number["9"]["solution_image_path"] and Path(by_number["9"]["solution_image_path"]).exists()

    # ---- images ------------------------------------------------------------
    for q in qs:
        assert q["image_path"] and Path(q["image_path"]).exists(), q["image_path"]

    # ---- OCR ---------------------------------------------------------------
    # embedded text layer -> every question has searchable OCR
    missing_ocr = [q["id"] for q in qs if not (q["ocr_clean"] or "").strip()]
    assert not missing_ocr, missing_ocr

    # ---- classification ----------------------------------------------------
    assert by_number["6"]["topic_id"] == "mathematics-advanced:calculus"
    assert by_number["3"]["topic_id"] == "mathematics-advanced:statistics"

    # difficulty in range
    for q in qs:
        assert q["difficulty"] is not None and 1.0 <= q["difficulty"] <= 5.0

    # ---- FTS search --------------------------------------------------------
    results, total = db.search_questions("normal distribution", limit=10)
    assert total >= 1
    assert any("3" == r["question_number"] for r in results)

    db.close()


def test_skip_and_force(config, sample_pdf):
    from pipeline.database import Database

    first = process_pdf(config, sample_pdf, force=True)
    assert first["questions"] > 0

    # second run without force -> skipped (resume)
    second = process_pdf(config, sample_pdf, force=False)
    assert second["skipped"] is True

    # force -> reprocessed
    third = process_pdf(config, sample_pdf, force=True)
    assert third["skipped"] is False

    db = Database(config.paths["database"])
    db.init_schema()
    assert len(db.list_papers()) == 1  # no duplicates
    db.close()
