"""Validation-suite and data-quality tests."""

from __future__ import annotations

from pathlib import Path


def test_quality_check_flags_planted_issues(config, sample_pdf):
    from pipeline.process import process_pdf
    from pipeline.validate import quality_check

    process_pdf(config, sample_pdf, force=True)
    result = quality_check(config)
    # the clean sample should have no hard errors
    assert result["summary"]["errors"] == 0, result["issues"]

    # plant problems and re-check
    from pipeline.database import Database

    db = Database(config.paths["database"])
    db.init_schema()
    q = db.questions_for_paper(db.list_papers()[0]["id"])[0]
    db.update_question_fields(q["id"], {"marks": -3, "difficulty": 9, "ocr_clean": ""})
    with db.conn() as c:
        c.execute("UPDATE questions SET page_end = 999 WHERE id = ?", (q["id"],))
        c.execute("UPDATE questions SET image_path = '/nonexistent/q.png' WHERE id = ?", (q["id"],))

    result2 = quality_check(config)
    codes = {i["code"] for i in result2["issues"]}
    assert "impossible_marks" in codes
    assert "impossible_difficulty" in codes
    assert "empty_ocr" in codes
    assert "bad_page_ref" in codes
    assert "missing_image" in codes
    assert result2["summary"]["errors"] >= 3
    db.close()


def test_quality_check_duplicate_images(config, sample_pdf):
    from pipeline.process import process_pdf
    from pipeline.validate import quality_check

    process_pdf(config, sample_pdf, force=True)
    from pipeline.database import Database

    db = Database(config.paths["database"])
    db.init_schema()
    qs = db.questions_for_paper(db.list_papers()[0]["id"])
    # point q2's image at q1's image -> duplicate image warning
    db.update_question_fields(qs[1]["id"], {"image_path": qs[0]["image_path"]})
    result = quality_check(config)
    codes = {i["code"] for i in result["issues"]}
    assert "duplicate_image" in codes
    db.close()


def test_validation_suite_runs(config):
    """The built-in synthetic suite must process all 7 papers and report."""
    from pipeline.validate import run_validation_suite

    suite = run_validation_suite(config, report_path=str(Path(config.paths["exports_dir"]) / "validation-report.md"))
    assert suite["papers_processed"] == 7, suite["papers"]
    assert suite["papers_failed"] == 0
    report = Path(suite["report_path"])
    assert report.exists()
    assert report.read_text(encoding="utf-8").startswith("# 99.95squad")

    # clean digital + chemistry + diagram papers should detect perfectly
    by_name = {p["filename"]: p for p in suite["papers"]}
    assert by_name["DigitalMaths_Clean_2023_2U_wsols.pdf"]["detection_accuracy"] == 1.0
    assert by_name["Chemistry_Trial_2023_wsols.pdf"]["detection_accuracy"] == 1.0
    assert by_name["DiagramHeavy_Maths_2024_3U_wsols.pdf"]["detection_accuracy"] == 1.0
    assert by_name["MultiPage_Maths_2022_2U_wsols.pdf"]["detection_accuracy"] == 1.0

    # multi-page questions detected
    mp = by_name["MultiPage_Maths_2022_2U_wsols.pdf"]["multi_page_questions"]
    assert {"2", "4"} <= set(mp), mp

    # no-solutions paper has no answers/solutions
    no_sol = by_name["NoSolutions_Maths_2021_2U.pdf"]
    assert no_sol["with_answers"] == 0
    assert no_sol["with_solution_images"] == 0

    # broken-font paper: questions detected by position, OCR corrupted
    broken = by_name["BrokenFont_Maths_2023_2U_wsols.pdf"]
    assert broken["detection_accuracy"] == 1.0
    assert broken["needs_review"] >= 3  # corrupted OCR -> flagged for review
    assert broken["avg_ocr_confidence"] <= 0.95

    # scanned paper without OCR engine degrades gracefully (whole-page fallback)
    scanned = by_name["Scanned_Physics_2022.pdf"]
    assert scanned["ok"] is True
    assert scanned["needs_review"] >= 1

    # physics/chemistry classification present
    chem = by_name["Chemistry_Trial_2023_wsols.pdf"]
    assert chem["no_topic"] <= 2  # most questions classified


def test_quality_check_ordering(config):
    from pipeline.validate import _qnum

    assert _qnum("7") == 7
    assert _qnum("abc") is None
