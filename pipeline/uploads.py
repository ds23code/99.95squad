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

STATUSES = ("pending", "processing", "approved", "rejected", "duplicate", "needs_review")
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
        result = {
            "status": "duplicate",
            "reason": "already-in-library",
            "paper": existing_paper,
        }
    else:
        # 2. already submitted?
        existing_upload = db.get_upload_by_sha256(digest)
        if existing_upload:
            result = {
                "status": "duplicate",
                "reason": "already-submitted",
                "upload": existing_upload,
            }
        else:
            upload_id = f"up-{uuid.uuid4().hex[:12]}"
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
                }
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
    db.set_upload_status(upload_id, status, reviewer, notes)
    result = db.get_upload(upload_id)
    db.close()
    return result or {"error": "unknown upload"}
