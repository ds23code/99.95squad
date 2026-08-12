"""Admin review routes for the local Flask app.

Review one question per screen: question image (large) | metadata form |
OCR text | classification, with keyboard shortcuts:

    n / p     next / previous question in the queue
    a         approve (save + mark reviewed + next)
    s         save changes (stay)
    d         focus difficulty
    1..5      set difficulty
    q         focus question number
    e         focus answer
    ?         show shortcuts

This is the *operator's* review tool (runs locally against the database).
The static site's #/admin page is the moderator view for student uploads;
real question review happens here or via `python -m pipeline review`.
"""

from __future__ import annotations

import json
from pathlib import Path

from flask import Blueprint, abort, redirect, render_template, request, url_for
from werkzeug.utils import secure_filename

from pipeline.database import Database
from pipeline.review import EDITABLE_FIELDS, apply_review

bp = Blueprint("admin_review", __name__, url_prefix="/admin")

_EDITABLE = {field for field, _, _ in EDITABLE_FIELDS} | {"subtopic_id", "year_level", "subject_id"}


def _db() -> Database:
    from flask import current_app, g

    if "_review_db" not in g:
        db = Database(current_app.config["QB_CONFIG"].paths["database"])
        db.init_schema()
        g._review_db = db
    return g._review_db


def _img_url(path: str | None) -> str | None:
    if not path:
        return None
    data = Path(path)
    try:
        idx = data.parts.index("questions")
    except ValueError:
        return None
    return "/images/" + "/".join(data.parts[idx:])


@bp.route("/review")
def review_list():
    db = _db()
    queue = db.review_queue(limit=500)
    counts = {"total": len(queue)}
    return render_template("admin_review_list.html", queue=queue, counts=counts)


@bp.route("/review/<qid>")
def review_one(qid: str):
    db = _db()
    q = db.get_question(qid)
    if not q:
        abort(404)
    queue = db.review_queue(limit=500)
    ids = [item["id"] for item in queue]
    idx = ids.index(qid) if qid in ids else -1
    prev_id = ids[idx - 1] if idx > 0 else None
    next_id = ids[idx + 1] if 0 <= idx < len(ids) - 1 else None
    from .app import _course_id_list

    return render_template(
        "admin_review.html",
        q=q,
        image=_img_url(q["image_path"]),
        solution=_img_url(q["solution_image_path"]),
        prev_id=prev_id,
        next_id=next_id,
        queue_total=len(ids),
        queue_pos=idx + 1,
        course_options=_course_id_list(),
    )


@bp.route("/review/<qid>", methods=["POST"])
def review_save(qid: str):
    db = _db()
    q = db.get_question(qid)
    if not q:
        abort(404)
    fields: dict = {}
    for key in _EDITABLE:
        if key in request.form:
            value = request.form[key].strip()
            if value == "":
                value = None
            elif key in ("marks", "year_level", "subparts"):
                try:
                    value = int(value)
                except ValueError:
                    abort(400, f"invalid integer for {key}")
            elif key == "difficulty":
                try:
                    value = float(value)
                except ValueError:
                    abort(400, "invalid difficulty")
            fields[key] = value
    fields["review_notes"] = request.form.get("review_notes") or None
    fields["reviewed_by"] = request.form.get("reviewed_by") or "admin"
    action = request.form.get("action", "save")
    if action == "approve":
        fields["status"] = "reviewed"
    apply_review(db, qid, fields, reviewed_by=fields["reviewed_by"])
    if action == "approve":
        nxt = request.form.get("next_id")
        return redirect(url_for("admin_review.review_one", qid=nxt) if nxt else
                        url_for("admin_review.review_list"))
    return redirect(url_for("admin_review.review_one", qid=qid))


@bp.route("/submissions")
def submissions_list():
    db = _db()
    subs = db.list_uploads()
    counts = {
        "total": len(subs),
        "pending": sum(1 for s in subs if s["status"] == "pending"),
        "needs_review": sum(1 for s in subs if s["status"] == "needs_review"),
        "approved": sum(1 for s in subs if s["status"] == "approved"),
        "duplicate": sum(1 for s in subs if s["status"] == "duplicate"),
        "rejected": sum(1 for s in subs if s["status"] == "rejected"),
        "needs_changes": sum(1 for s in subs if s["status"] == "needs_changes"),
    }
    return render_template("admin_submissions.html", subs=subs, counts=counts)


@bp.route("/submissions/<sub_id>")
def submission_detail(sub_id: str):
    db = _db()
    sub = db.get_upload(sub_id)
    if not sub:
        abort(404)
    paper = db.get_paper(sub["paper_id"]) if sub.get("paper_id") else None
    questions = db.questions_for_paper(paper["id"]) if paper else []
    warnings = []
    if sub.get("duplicate_type") == "exact_sha256" or sub.get("status") == "duplicate":
        warnings.append("Duplicate SHA-256 hash detected")
    if sub.get("duplicate_type") == "metadata":
        warnings.append("Duplicate paper metadata detected")
    if paper and len(questions) == 0:
        warnings.append("Zero detected questions")
    if paper and (len(questions) < 3 or len(questions) > 100):
        warnings.append(f"Suspicious question count ({len(questions)})")
    if any((q.get("ocr_confidence") or 0) < 0.5 for q in questions):
        warnings.append("Unusually low OCR confidence on one or more questions")
    if any(not q.get("solution_image_path") and not q.get("solution_text") for q in questions):
        warnings.append("Missing solutions for one or more questions")
    if sub.get("status") == "error" or (sub.get("size_bytes") and sub["size_bytes"] < 1024):
        warnings.append("Malformed or extremely small PDF")
    if paper and not paper.get("course_id"):
        warnings.append("Unsupported course")
    if paper and paper.get("status") == "error":
        warnings.append("Extraction errors reported on paper")
    return render_template(
        "admin_submission_detail.html",
        sub=sub,
        paper=paper,
        questions=questions,
        warnings=warnings,
    )


@bp.route("/submissions/<sub_id>/moderate", methods=["POST"])
def submission_moderate(sub_id: str):
    from pipeline.uploads import approve_upload, set_upload_status
    from flask import current_app

    cfg = current_app.config["QB_CONFIG"]
    act = request.form.get("action")
    reviewer = request.form.get("reviewer") or "admin"
    notes = request.form.get("notes") or None
    if act == "approve":
        approve_upload(cfg, sub_id, reviewer=reviewer)
    elif act in ("reject", "rejected"):
        set_upload_status(cfg, sub_id, "rejected", reviewer=reviewer, notes=notes)
    elif act in ("needs_review", "needs_changes", "duplicate", "pending"):
        set_upload_status(cfg, sub_id, act, reviewer=reviewer, notes=notes)
    else:
        abort(400, "invalid action")
    return redirect(url_for("admin_review.submission_detail", sub_id=sub_id))


def register(app) -> None:
    app.register_blueprint(bp)
