"""Student uploads & contributor moderation.

A student uploads a PDF:

    register_upload(pdf_path, uploader) -> status
        new          queued for review (status=pending)
        duplicate    sha256 already known (papers or submissions)

A reviewer (admin) then:

    approve_upload(id, reviewer)
        runs the PDF through the normal pipeline,
        links paper_id, grants the uploader 14 days of premium access
    reject_upload / mark_duplicate / needs_review

Statuses: pending, processing, approved, rejected, duplicate, needs_review.

Nothing uploaded is ever public before approval — moderation is a real gate,
not a client-side illusion.
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import Optional

from .config import Config
from .database import Database
from .ingest import sha256_of_file
from .process import PipelineError, process_pdf

log = logging.getLogger(__name__)

STATUSES = ("pending", "processing", "approved", "rejected", "duplicate", "needs_review", "needs_changes")
PREMIUM_GRANT_DAYS = 14


def register_upload(
    config: Config,
    pdf_path: str | Path,
    uploader: str = "local",
    db: Optional[Database] = None,
) -> dict:
    """Register a student upload. Returns {status, upload, reason}.

    status: "new" | "duplicate" | "error"
    """
    pdf_path = Path(pdf_path)
    own_db = db is None
    db = db or Database(config.paths["database"])
    if own_db:
        db.init_schema()

    if not pdf_path.exists() or pdf_path.suffix.lower() != ".pdf":
        return {"status": "error", "reason": "not-a-pdf"}

    # abuse protection: size + magic bytes (mirrors the backend triggers)
    max_bytes = int(config.get("uploads", "max_bytes", default=25 * 1024 * 1024))
    if pdf_path.stat().st_size > max_bytes:
        return {"status": "error", "reason": "too-large"}
    with open(pdf_path, "rb") as fh:
        magic = fh.read(5)
    if not magic.startswith(b"%PDF-"):
        return {"status": "error", "reason": "not-a-pdf"}

    digest = sha256_of_file(pdf_path)

    # 1. already a processed paper?
    existing_paper = db.get_paper_by_sha256(digest)
    if existing_paper:
        upload_id = f"up-{uuid.uuid4().hex[:12]}"
        db.upsert_upload(
            {
                "id": upload_id,
                "sha256": digest,
                "filename": pdf_path.name,
                "file_path": str(pdf_path),
                "size_bytes": pdf_path.stat().st_size,
                "uploader": uploader,
                "status": "duplicate",
                "paper_id": existing_paper["id"],
                "premium_granted": 0,
                "review_notes": f"Exact SHA256 duplicate of approved paper {existing_paper['id']}",
                "duplicate_of": existing_paper["id"],
                "duplicate_type": "exact_sha256",
            }
        )
        row = db.get_upload_by_sha256(digest)
        db.record_audit_event(
            actor=uploader,
            action="duplicate_detected",
            target_id=row["id"] if row else upload_id,
            new_status="duplicate",
            notes="exact sha256 match with approved paper",
        )
        result = {
            "status": "duplicate",
            "reason": "already-in-library",
            "duplicate_type": "exact_sha256",
            "paper": existing_paper,
            "upload": row,
        }
    else:
        # 2. already submitted?
        existing_upload = db.get_upload_by_sha256(digest)
        if existing_upload:
            db.record_audit_event(
                actor=uploader,
                action="duplicate_detected",
                target_id=existing_upload["id"],
                new_status="duplicate",
                notes="exact sha256 match with existing upload",
            )
            result = {
                "status": "duplicate",
                "reason": "already-submitted",
                "duplicate_type": "exact_sha256",
                "upload": existing_upload,
            }
        else:
            from .ingest import FilenameParser

            parser = FilenameParser(config)
            meta = parser.parse(pdf_path.name)
            matching_ids = []
            if meta.get("course_id") and meta.get("year"):
                matching_papers = db.find_papers_by_metadata(
                    course_id=meta.get("course_id"),
                    year=meta.get("year"),
                    organisation=meta.get("organisation"),
                    paper_type=meta.get("paper_type"),
                )
                if matching_papers:
                    matching_ids.append(matching_papers[0]["id"])
                else:
                    for u in db.list_uploads():
                        umeta = parser.parse(u["filename"])
                        if (
                            umeta.get("course_id") == meta.get("course_id")
                            and umeta.get("year") == meta.get("year")
                        ):
                            matching_ids.append(u["id"])
                            break

            upload_id = f"up-{uuid.uuid4().hex[:12]}"
            if matching_ids:
                db.upsert_upload(
                    {
                        "id": upload_id,
                        "sha256": digest,
                        "filename": pdf_path.name,
                        "file_path": str(pdf_path),
                        "size_bytes": pdf_path.stat().st_size,
                        "uploader": uploader,
                        "status": "needs_review",
                        "paper_id": None,
                        "premium_granted": 0,
                        "review_notes": f"Potential metadata duplicate of {matching_ids[0]} ({pdf_path.name})",
                        "duplicate_of": matching_ids[0],
                        "duplicate_type": "metadata",
                    }
                )
                db.record_audit_event(
                    actor=uploader,
                    action="metadata_duplicate_detected",
                    target_id=upload_id,
                    new_status="needs_review",
                    notes="matching metadata with existing paper",
                )
                result = {
                    "status": "needs_review",
                    "reason": "metadata-duplicate",
                    "duplicate_type": "metadata",
                    "duplicate_of": matching_ids[0],
                    "upload": db.get_upload(upload_id),
                }
            else:
                db.upsert_upload(
                    {
                        "id": upload_id,
                        "sha256": digest,
                        "filename": pdf_path.name,
                        "file_path": str(pdf_path),
                        "size_bytes": pdf_path.stat().st_size,
                        "uploader": uploader,
                        "status": "pending",
                        "paper_id": None,
                        "premium_granted": 0,
                        "review_notes": None,
                        "duplicate_of": None,
                        "duplicate_type": None,
                    }
                )
                db.record_audit_event(
                    actor=uploader,
                    action="submission_created",
                    target_id=upload_id,
                    new_status="pending",
                )
                result = {
                    "status": "new",
                    "reason": "queued",
                    "upload": db.get_upload(upload_id),
                }
    if own_db:
        db.close()
    return result


def approve_upload(
    config: Config,
    upload_id: str,
    reviewer: str = "admin",
    db: Optional[Database] = None,
    *,
    grant_premium: bool = True,
) -> dict:
    """Approve a submission: process the PDF, link the paper, grant premium.

    Returns {status, paper_id, upload}.
    """
    own_db = db is None
    db = db or Database(config.paths["database"])
    if own_db:
        db.init_schema()

    upload = db.get_upload(upload_id)
    if upload is None:
        raise ValueError(f"unknown upload {upload_id}")
    if upload["status"] in ("approved", "processing"):
        raise ValueError(f"upload already {upload['status']}")

    pdf_path = Path(upload["file_path"])
    if not pdf_path.exists():
        db.set_upload_status(upload_id, "needs_review", reviewer, "file missing")
        return {"status": "needs_review", "reason": "file-missing", "upload": db.get_upload(upload_id)}

    db.set_upload_status(upload_id, "processing", reviewer)
    try:
        result = process_pdf(config, pdf_path, force=False, db=db)
        paper_id = result["paper_id"]
    except PipelineError as exc:
        log.exception("upload %s failed to process", upload_id)
        db.set_upload_status(upload_id, "needs_review", reviewer, f"processing failed: {exc}")
        return {"status": "needs_review", "reason": "processing-failed", "upload": db.get_upload(upload_id)}

    db.set_upload_status(upload_id, "approved", reviewer, paper_id=paper_id)
    db.exec("UPDATE upload_submissions SET premium_granted=? WHERE id=?", (1 if grant_premium else 0, upload_id))

    premium_until = None
    if grant_premium and upload["uploader"]:
        profile = db.get_profile(upload["uploader"]) or {
            "id": upload["uploader"],
            "email": None,
            "display_name": None,
            "access_tier": "free",
            "premium_until": None,
            "contribution_credits": 0,
        }
        db.upsert_profile(profile)
        updated = db.grant_premium(upload["uploader"], PREMIUM_GRANT_DAYS)
        premium_until = updated["premium_until"] if updated else None

    db.record_audit_event(
        actor=reviewer,
        action="submission_approved",
        target_id=upload_id,
        previous_status=upload["status"],
        new_status="approved",
        notes="submission approved and premium granted",
    )

    return {
        "status": "approved",
        "paper_id": paper_id,
        "premium_until": premium_until,
        "upload": db.get_upload(upload_id),
    }


def set_upload_status(
    config: Config,
    upload_id: str,
    status: str,
    reviewer: str = "admin",
    notes: str | None = None,
) -> dict:
    if status not in STATUSES:
        raise ValueError(f"invalid status {status!r}; expected one of {STATUSES}")
    db = Database(config.paths["database"])
    db.init_schema()
    old = db.get_upload(upload_id)
    old_status = old["status"] if old else None
    db.set_upload_status(upload_id, status, reviewer, notes)
    db.record_audit_event(
        actor=reviewer,
        action=f"status_changed_{status}",
        target_id=upload_id,
        previous_status=old_status,
        new_status=status,
        notes=notes,
    )
    result = db.get_upload(upload_id)
    db.close()
    return result or {"error": "unknown upload"}


def override_duplicate(
    config: Config,
    upload_id: str,
    new_status: str = "pending",
    reviewer: str = "admin",
    db: Optional[Database] = None,
) -> dict:
    """Override a duplicate detection decision."""
    if new_status not in STATUSES:
        raise ValueError(f"invalid status {new_status!r}; expected one of {STATUSES}")
    own_db = db is None
    db = db or Database(config.paths["database"])
    if own_db:
        db.init_schema()
    upload = db.get_upload(upload_id)
    if upload is None:
        if own_db:
            db.close()
        raise ValueError(f"unknown upload {upload_id}")
    old_status = upload["status"]
    db.set_upload_status(upload_id, new_status, reviewer, "duplicate overridden by admin")
    db.record_audit_event(
        actor=reviewer,
        action="duplicate_overridden",
        target_id=upload_id,
        previous_status=old_status,
        new_status=new_status,
        notes="duplicate decision overridden by admin",
    )
    result = db.get_upload(upload_id)
    if own_db:
        db.close()
    return result or {"error": "unknown upload"}
