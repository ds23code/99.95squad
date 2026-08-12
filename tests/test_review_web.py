"""Admin review web UI tests (Flask test client)."""

from __future__ import annotations


def _seed(config, sample_pdf):
    from pipeline.database import Database
    from pipeline.process import process_pdf

    process_pdf(config, sample_pdf, force=True)
    db = Database(config.paths["database"])
    db.init_schema()
    q = db.questions_for_paper(db.list_papers()[0]["id"])[0]
    db.close()
    return q["id"]


def test_review_list_and_one(config, sample_pdf):
    from web.app import create_app

    qid = _seed(config, sample_pdf)
    app = create_app(config)
    app.config["TESTING"] = True
    client = app.test_client()

    resp = client.get("/admin/review")
    assert resp.status_code == 200
    assert b"Review queue" in resp.data

    resp = client.get(f"/admin/review/{qid}")
    assert resp.status_code == 200
    assert b"Metadata" in resp.data
    assert b'id="f-diff"' in resp.data
    assert b"shortcuts" in resp.data.lower() or b"Shortcuts" in resp.data

    resp = client.get("/admin/review/does-not-exist")
    assert resp.status_code == 404


def test_review_save_and_approve(config, sample_pdf):
    from pipeline.database import Database
    from web.app import create_app

    qid = _seed(config, sample_pdf)
    app = create_app(config)
    app.config["TESTING"] = True
    client = app.test_client()

    # save: correct marks + difficulty
    resp = client.post(
        f"/admin/review/{qid}",
        data={"question_number": "1", "marks": "2", "difficulty": "4",
              "question_type": "multiple_choice", "answer": "C",
              "course_id": "mathematics-advanced", "topic_id": "mathematics-advanced:calculus",
              "action": "save", "reviewed_by": "tester"},
        follow_redirects=True,
    )
    assert resp.status_code == 200
    db = Database(config.paths["database"])
    db.init_schema()
    q = db.get_question(qid)
    assert q["marks"] == 2
    assert q["difficulty"] == 4
    assert q["answer"] == "C"
    assert q["reviewed"] == 1
    db.close()

    # approve with next
    resp = client.post(
        f"/admin/review/{qid}",
        data={"action": "approve", "next_id": "", "reviewed_by": "tester"},
        follow_redirects=True,
    )
    assert resp.status_code == 200


def test_review_invalid_input(config, sample_pdf):
    from web.app import create_app

    qid = _seed(config, sample_pdf)
    app = create_app(config)
    app.config["TESTING"] = True
    client = app.test_client()
    resp = client.post(f"/admin/review/{qid}", data={"marks": "not-a-number", "action": "save"})
    assert resp.status_code == 400
