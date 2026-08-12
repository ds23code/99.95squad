"""Database tests."""

from __future__ import annotations


def _sample_question(paper_id="trialmaths-2023-x-abc123", qnum="1"):
    return {
        "id": f"{paper_id}-q{qnum}",
        "paper_id": paper_id,
        "question_number": qnum,
        "section": "I",
        "marks": 2,
        "subparts": None,
        "page_start": 1,
        "page_end": 1,
        "image_path": "/tmp/q.png",
        "image_width": 100,
        "image_height": 200,
        "ocr_raw": "Find the derivative of y = x squared.",
        "ocr_clean": "Find the derivative of y = x squared.",
        "ocr_engine": "embedded",
        "ocr_confidence": 0.9,
        "answer": None,
        "answer_source": None,
        "solution_image_path": None,
        "solution_text": None,
        "subject_id": "mathematics",
        "course_id": "mathematics-advanced",
        "year_level": 12,
        "topic_id": "mathematics-advanced:calculus",
        "subtopic_id": "mathematics-advanced:calculus:differentiation",
        "difficulty": 2.5,
        "difficulty_reasoning": "2 marks",
        "question_type": "short_answer",
        "extraction_confidence": 0.95,
        "classification_confidence": 0.8,
        "status": "new",
        "review_flags": "[]",
    }


def test_schema_and_taxonomy_seed(seeded_db):
    with seeded_db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM subjects").fetchone()[0] >= 5
        assert c.execute("SELECT COUNT(*) FROM courses").fetchone()[0] >= 15
        assert c.execute("SELECT COUNT(*) FROM topics").fetchone()[0] > 0


def test_paper_upsert_and_dedupe(seeded_db):
    paper = {
        "id": "trialmaths-2023-mathematics-advanced-abc123",
        "filename": "TrialMaths_2023_2U.pdf",
        "file_path": "/tmp/TrialMaths_2023_2U.pdf",
        "sha256": "aa" * 32,
        "display_name": "TrialMaths 2023 Mathematics Advanced",
        "organisation": "TrialMaths",
        "year": 2023,
        "paper_type": "trial",
        "subject_id": "mathematics",
        "course_id": "mathematics-advanced",
        "year_level": 12,
        "has_solutions": 0,
        "page_count": 5,
        "status": "pending",
    }
    seeded_db.insert_paper(paper)
    assert seeded_db.get_paper("trialmaths-2023-mathematics-advanced-abc123")["year"] == 2023
    assert seeded_db.get_paper_by_sha256("aa" * 32)["id"].endswith("abc123")


def test_question_upsert_and_fts(seeded_db):
    seeded_db.insert_paper({
        "id": "trialmaths-2023-x-abc123",
        "filename": "x.pdf", "file_path": "/tmp/x.pdf", "sha256": "bb" * 32,
        "display_name": "TrialMaths 2023", "organisation": "TrialMaths", "year": 2023,
        "paper_type": "trial", "subject_id": "mathematics",
        "course_id": "mathematics-advanced", "year_level": 12,
        "has_solutions": 0, "page_count": 1, "status": "pending",
    })
    q = _sample_question()
    seeded_db.upsert_question(q)

    results, total = seeded_db.search_questions("derivative", limit=10)
    assert total == 1
    assert results[0]["id"] == q["id"]

    # metadata search should work through FTS too (course name etc.)
    results, total = seeded_db.search_questions("TrialMaths", limit=10)
    assert total == 1

    # filters
    results, total = seeded_db.search_questions(
        None, filters={"course_id": "mathematics-advanced", "difficulty_min": 2}, limit=10
    )
    assert total == 1
    results, total = seeded_db.search_questions(
        None, filters={"course_id": "physics"}, limit=10
    )
    assert total == 0


def test_review_queue(seeded_db):
    seeded_db.insert_paper({
        "id": "trialmaths-2023-x-def456",
        "filename": "y.pdf", "file_path": "/tmp/y.pdf", "sha256": "cc" * 32,
        "display_name": "T", "organisation": "T", "year": 2023,
        "paper_type": "trial", "subject_id": "mathematics",
        "course_id": "mathematics-advanced", "year_level": 12,
        "has_solutions": 0, "page_count": 1, "status": "pending",
    })
    q = _sample_question(paper_id="trialmaths-2023-x-def456", qnum="2")
    q["extraction_confidence"] = 0.4
    seeded_db.upsert_question(q)
    queue = seeded_db.review_queue()
    assert len(queue) == 1
    seeded_db.set_question_status(q["id"], "reviewed", reviewed_by="tester")
    assert seeded_db.review_queue() == []
