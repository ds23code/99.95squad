"""Upload / contributor moderation tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from pipeline.uploads import approve_upload, register_upload, set_upload_status


@pytest.fixture()
def upload_pdf(tmp_path):
    """A genuinely different, tiny PDF for upload testing."""
    import pymupdf

    path = tmp_path / "Student_Trial_2024_Maths_Advanced.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 100), "Student Trial 2024 Mathematics Advanced", fontsize=16)
    page.insert_text((72, 140), "Question 1 (2 marks)", fontsize=12)
    page.insert_text((72, 160), "Differentiate y = x cubed.", fontsize=12)
    doc.save(str(path))
    doc.close()
    return path


def test_register_new_and_duplicate(config, upload_pdf, sample_pdf):
    # put the sample in the library first so duplicate detection has something
    from pipeline.process import process_pdf

    process_pdf(config, sample_pdf, force=True)

    result = register_upload(config, upload_pdf, uploader="student-1")
    assert result["status"] == "new"
    assert result["upload"]["status"] == "pending"
    upload_id = result["upload"]["id"]

    # same file again -> duplicate (already-submitted)
    again = register_upload(config, upload_pdf, uploader="student-1")
    assert again["status"] == "duplicate"
    assert again["reason"] == "already-submitted"

    # a file already in the library -> duplicate (already-in-library)
    lib = register_upload(config, sample_pdf, uploader="student-1")
    assert lib["status"] == "duplicate"
    assert lib["reason"] == "already-in-library"

    # not a pdf (extension + magic bytes)
    bad = upload_pdf.parent / "notapdf.pdf"
    bad.write_bytes(b"MZ\x90\x00 not really a pdf")
    bad_result = register_upload(config, bad, uploader="student-1")
    assert bad_result["status"] == "error"
    assert bad_result["reason"] == "not-a-pdf"


def test_register_size_limit(config, upload_pdf):
    from pipeline.uploads import register_upload

    huge = upload_pdf.parent / "huge.pdf"
    # 30 MB of zeros with a valid PDF header
    huge.write_bytes(b"%PDF-1.4" + b"\x00" * (30 * 1024 * 1024))
    result = register_upload(config, huge, uploader="student-1")
    assert result["status"] == "error"
    assert result["reason"] == "too-large"


def test_approve_grants_premium(config, upload_pdf):
    result = register_upload(config, upload_pdf, uploader="student-7")
    upload_id = result["upload"]["id"]

    approved = approve_upload(config, upload_id, reviewer="moderator")
    assert approved["status"] == "approved"
    assert approved["paper_id"]
    assert approved["premium_until"], "uploader must receive premium access"

    from pipeline.database import Database

    db = Database(config.paths["database"])
    db.init_schema()
    profile = db.get_profile("student-7")
    assert profile["access_tier"] == "contributor"
    assert profile["contribution_credits"] == 1
    assert profile["premium_until"]

    upload = db.get_upload(upload_id)
    assert upload["status"] == "approved"
    assert upload["premium_granted"] == 1
    assert upload["paper_id"] == approved["paper_id"]

    # approving again is rejected
    with pytest.raises(ValueError):
        approve_upload(config, upload_id, reviewer="moderator")
    db.close()


def test_moderation_statuses(config, upload_pdf):
    result = register_upload(config, upload_pdf, uploader="student-9")
    upload_id = result["upload"]["id"]

    r = set_upload_status(config, upload_id, "needs_review", reviewer="mod", notes="scanned poorly")
    assert r["status"] == "needs_review"
    r = set_upload_status(config, upload_id, "duplicate", reviewer="mod")
    assert r["status"] == "duplicate"
    r = set_upload_status(config, upload_id, "rejected", reviewer="mod")
    assert r["status"] == "rejected"

    with pytest.raises(ValueError):
        set_upload_status(config, upload_id, "bogus", reviewer="mod")


def test_exact_sha256_duplicate(config, upload_pdf):
    r1 = register_upload(config, upload_pdf, uploader="student-dup1")
    assert r1["status"] == "new"
    r2 = register_upload(config, upload_pdf, uploader="student-dup2")
    assert r2["status"] == "duplicate"
    assert r2["duplicate_type"] == "exact_sha256"


def test_metadata_duplicate(config, upload_pdf, tmp_path):
    import pymupdf

    r1 = register_upload(config, upload_pdf, uploader="student-meta1")
    assert r1["status"] == "new"

    # Create a different PDF file with the same course/year metadata filename
    path2 = tmp_path / "Student_Trial_2024_Maths_Advanced_v2.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 100), "Different text encoding", fontsize=16)
    doc.save(str(path2))
    doc.close()

    r2 = register_upload(config, path2, uploader="student-meta2")
    assert r2["status"] == "needs_review"
    assert r2["reason"] == "metadata-duplicate"
    assert r2["duplicate_type"] == "metadata"


def test_genuinely_different_papers(config, tmp_path):
    import pymupdf

    path = tmp_path / "Physics_2025_Trial_Paper.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 100), "Physics Trial 2025", fontsize=16)
    doc.save(str(path))
    doc.close()

    r = register_upload(config, path, uploader="student-diff")
    assert r["status"] == "new"
    assert r["upload"]["status"] == "pending"


def test_duplicate_after_approved_and_override(config, upload_pdf):
    from pipeline.uploads import override_duplicate

    r1 = register_upload(config, upload_pdf, uploader="student-app1")
    upload_id = r1["upload"]["id"]
    approve_upload(config, upload_id, reviewer="moderator")

    # Now uploading exact duplicate of approved paper
    r2 = register_upload(config, upload_pdf, uploader="student-app2")
    assert r2["status"] == "duplicate"
    assert r2["reason"] == "already-in-library"

    # Test admin override of duplicate
    dup_id = r2["upload"]["id"]
    overridden = override_duplicate(config, dup_id, new_status="pending", reviewer="admin-lead")
    assert overridden["status"] == "pending"

    from pipeline.database import Database

    db = Database(config.paths["database"])
    db.init_schema()
    events = db.list_audit_events(target_id=dup_id)
    assert any(e["action"] == "duplicate_overridden" for e in events)
    db.close()
