"""Data-quality validation & the real-paper validation suite.

Two entry points:

- ``quality_check(db, config)`` — audits the database for data-quality
  problems (duplicates, missing/corrupt images, bad page references, empty
  OCR, impossible metadata, missing answers, broken solution links, question
  ordering). A bad question in a 100,000-question bank is worse than a
  missing question — this gate runs before publishing.

- ``run_validation_suite(config, ...)`` — processes a set of papers (the
  built-in diverse synthetic suite by default, or any directory of real
  PDFs) into an isolated database and produces a report with detection
  accuracy, segmentation confidence, image counts, OCR availability,
  classification confidence, review requirements and failures.

CLI: ``python -m pipeline validate [--input DIR] [--report PATH]``
     ``python -m pipeline quality-check``
"""

from __future__ import annotations

import json
import logging
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional

from .config import Config
from .database import Database

log = logging.getLogger(__name__)


# ============================================================================
# data-quality audit
# ============================================================================
def quality_check(config: Config, db: Optional[Database] = None) -> dict:
    """Audit the database for data-quality issues.

    Returns {"issues": [...], "summary": {...}, "checked_at": ...}
    """
    own_db = db is None
    db = db or Database(config.paths["database"])
    if own_db:
        db.init_schema()

    issues: list[dict] = []
    valid_courses = {c["id"] for c in config.courses()}
    valid_topics = {t["id"] for t in _all_topics(config)}
    valid_subtopics = {st["id"] for st in _all_subtopics(config)}

    with db.conn() as c:
        papers = [dict(r) for r in c.execute("SELECT * FROM papers").fetchall()]
        paper_pages = {
            p["id"]: p["page_count"] for p in papers
        }
        questions = [
            dict(r)
            for r in c.execute(
                """SELECT q.*, p.status AS paper_status, p.year AS paper_year,
                          p.page_count AS paper_page_count
                   FROM questions q JOIN papers p ON p.id = q.paper_id"""
            ).fetchall()
        ]

    def add(qid: str | None, severity: str, code: str, message: str) -> None:
        issues.append(
            {"question_id": qid, "severity": severity, "code": code, "message": message}
        )

    image_hashes: dict[str, list[str]] = {}
    for q in questions:
        qid = q["id"]

        # ---- images ---------------------------------------------------------
        img = q.get("image_path")
        if not img:
            add(qid, "error", "missing_image", "no image_path")
        else:
            if not Path(img).exists():
                add(qid, "error", "missing_image", f"image file not found: {img}")
            elif not _image_ok(img):
                add(qid, "error", "corrupt_image", f"image unreadable/corrupt: {img}")
            else:
                digest = _image_hash(img)
                image_hashes.setdefault(digest, []).append(qid)

        # ---- page references -------------------------------------------------
        ps, pe = q.get("page_start"), q.get("page_end")
        if ps is None or pe is None or ps < 1 or pe < ps:
            add(qid, "error", "bad_page_ref", f"page_start={ps} page_end={pe}")
        elif paper_pages.get(q["paper_id"]) and pe > paper_pages[q["paper_id"]]:
            add(qid, "error", "bad_page_ref",
                f"page_end {pe} exceeds paper page_count {paper_pages[q['paper_id']]}")

        # ---- OCR --------------------------------------------------------------
        ocr = (q.get("ocr_clean") or "").strip()
        if not ocr:
            add(qid, "warn", "empty_ocr", "no OCR text (search-only quality)")
        elif q.get("ocr_confidence") is not None and q["ocr_confidence"] < 0.3:
            add(qid, "warn", "low_ocr", f"low OCR confidence {q['ocr_confidence']}")

        # ---- impossible metadata ------------------------------------------------
        marks = q.get("marks")
        if marks is not None and (marks < 0 or marks > 100):
            add(qid, "error", "impossible_marks", f"marks={marks}")
        diff = q.get("difficulty")
        if diff is not None and not (1.0 <= diff <= 5.0):
            add(qid, "error", "impossible_difficulty", f"difficulty={diff}")
        year = q.get("year_level")
        if year is not None and year not in (11, 12):
            add(qid, "warn", "impossible_year_level", f"year_level={year}")
        course = q.get("course_id")
        if course and course not in valid_courses:
            add(qid, "warn", "unknown_course", f"course_id={course}")
        topic = q.get("topic_id")
        if topic and topic not in valid_topics:
            add(qid, "warn", "unknown_topic", f"topic_id={topic}")
        subtopic = q.get("subtopic_id")
        if subtopic and subtopic not in valid_subtopics:
            add(qid, "warn", "unknown_subtopic", f"subtopic_id={subtopic}")
        if topic and subtopic and not subtopic.startswith(topic + ":"):
            add(qid, "warn", "subtopic_not_under_topic", f"subtopic {subtopic} not under {topic}")

        # ---- answers ------------------------------------------------------------
        if q.get("question_type") == "multiple_choice" and not (q.get("answer") or "").strip():
            add(qid, "warn", "missing_answer", "MCQ without recorded answer")

        # ---- solutions ------------------------------------------------------------
        sol = q.get("solution_image_path")
        if sol and not Path(sol).exists():
            add(qid, "error", "broken_solution", f"solution image not found: {sol}")
        elif sol and not _image_ok(sol):
            add(qid, "error", "broken_solution", f"solution image corrupt: {sol}")

    # ---- duplicate images ----------------------------------------------------
    for digest, qids in image_hashes.items():
        if len(qids) > 1:
            add(None, "warn", "duplicate_image",
                f"identical question image shared by {len(qids)} questions: {', '.join(qids[:4])}")

    # ---- question ordering per paper -------------------------------------------
    from collections import defaultdict

    per_paper: dict[str, list[dict]] = defaultdict(list)
    for q in questions:
        per_paper[q["paper_id"]].append(q)
    for paper_id, qs in per_paper.items():
        ordered = sorted(qs, key=lambda x: (x["page_start"], _qnum(x["question_number"])))
        prev_page, prev_num = None, None
        for q in ordered:
            num = _qnum(q["question_number"])
            page = q["page_start"]
            if prev_num is not None:
                if page < prev_page:
                    add(q["id"], "warn", "out_of_order", "question number order inconsistent with page order")
                if num is not None and prev_num is not None and num != prev_num + 1 and num != prev_num:
                    # allow sections that restart numbering (Section I 1-10, II 11-20 handled by page)
                    if page == prev_page and num > prev_num + 1:
                        add(q["id"], "warn", "question_gap", f"question numbers jump {prev_num} -> {num}")
            prev_page, prev_num = page, num
        # zero-question complete paper
        if not qs:
            add(paper_id, "warn", "empty_paper", "complete paper with zero questions")

    summary = {
        "questions": len(questions),
        "issues": len(issues),
        "errors": sum(1 for i in issues if i["severity"] == "error"),
        "warnings": sum(1 for i in issues if i["severity"] == "warn"),
        "by_code": _count_by(issues, "code"),
        "clean_questions": len(questions) - len({i["question_id"] for i in issues if i["severity"] == "error"}),
    }
    if own_db:
        db.close()
    return {"issues": issues, "summary": summary, "checked_at": datetime.now().isoformat(timespec="seconds")}


def _all_topics(config: Config) -> list[dict]:
    out = []
    for course_id, topics in config.topics_for_course_all().items():
        for t in topics:
            out.append({"id": f"{course_id}:{t['id']}"})
    return out


def _all_subtopics(config: Config) -> list[dict]:
    out = []
    for course_id, topics in config.topics_for_course_all().items():
        for t in topics:
            for st in t.get("subtopics", []):
                out.append({"id": f"{course_id}:{t['id']}:{st['id']}"})
    return out


def _qnum(number: str) -> Optional[int]:
    try:
        return int(number)
    except (TypeError, ValueError):
        return None


def _image_ok(path: str) -> bool:
    try:
        from PIL import Image

        with Image.open(path) as im:
            im.verify()
        return True
    except Exception:
        return False


def _image_hash(path: str) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as fh:
        h.update(fh.read(4096))
    return h.hexdigest()


def _count_by(issues: list[dict], key: str) -> dict:
    out: dict[str, int] = {}
    for i in issues:
        out[i[key]] = out.get(i[key], 0) + 1
    return out


# ============================================================================
# validation suite (diverse papers → isolated DB → report)
# ============================================================================
def run_validation_suite(
    config: Config,
    papers_dir: Optional[str | Path] = None,
    report_path: Optional[str | Path] = None,
    *,
    force: bool = True,
) -> dict:
    """Process a set of papers in an isolated database and report on them.

    ``papers_dir=None`` uses the built-in synthetic validation suite.
    """
    from .ingest import discover_pdfs
    from .process import process_pdf
    from .export_static import tokenize

    # isolated temp environment so the main DB is never polluted
    tmp = Path(tempfile.mkdtemp(prefix="qb-validate-"))
    try:
        data_dir = tmp / "data"
        cfg = _isolated_config(config, data_dir)

        if papers_dir is None:
            from scripts.make_validation_papers import make_validation_papers, GROUND_TRUTH

            src = data_dir / "papers"
            make_validation_papers(src)
            ground_truth = {g["filename"]: g for g in GROUND_TRUTH}
        else:
            src = Path(papers_dir)
            ground_truth = {}

        pdfs = discover_pdfs(src)
        if not pdfs:
            raise ValueError(f"no PDFs found in {src}")

        db = Database(cfg.paths["database"])
        db.init_schema()
        results: list[dict] = []
        for pdf in pdfs:
            entry: dict = {
                "filename": pdf.name,
                "file": str(pdf),
                "ground_truth": ground_truth.get(pdf.name),
                "ok": False,
            }
            try:
                r = process_pdf(cfg, pdf, force=force, db=db)
                entry.update(
                    {
                        "ok": True,
                        "questions": r["questions"],
                        "pages": r["pages"],
                        "answers": r.get("answers", 0),
                        "solutions": r.get("solutions", 0),
                        "flags": r.get("flags", []),
                        "elapsed_s": round(r.get("elapsed", 0), 2),
                    }
                )
                entry.update(_paper_metrics(cfg, db, pdf.name, ground_truth.get(pdf.name)))
            except Exception as exc:  # noqa: BLE001 — suite must not crash
                entry["error"] = str(exc)
                log.exception("validation failed for %s", pdf.name)
            results.append(entry)

        quality = quality_check(cfg, db)
        suite = {
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "papers_processed": sum(1 for r in results if r["ok"]),
            "papers_failed": sum(1 for r in results if not r["ok"]),
            "papers": results,
            "quality_check": quality,
        }
        db.close()

        report = render_report(suite)
        out_path = Path(report_path) if report_path else (
            Path(config.paths["exports_dir"]) / "validation-report.md"
        )
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report, encoding="utf-8")
        (out_path.with_suffix(".json")).write_text(
            json.dumps(suite, indent=2, default=str), encoding="utf-8"
        )
        suite["report_path"] = str(out_path)
        return suite
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _isolated_config(config: Config, data_dir: Path) -> Config:
    """A copy of the config whose data paths point at a temp dir."""
    import copy

    cfg = Config(copy.deepcopy(config.raw))
    cfg.raw["pipeline"]["paths"]["data_dir"] = str(data_dir)
    for key in ("papers_dir", "questions_dir", "pages_dir", "solutions_dir", "exports_dir"):
        cfg.raw["pipeline"]["paths"][key] = str(data_dir / Path(cfg.raw["pipeline"]["paths"][key]).name)
    cfg.raw["pipeline"]["paths"]["database"] = str(data_dir / "questionbank.db")
    for key in ("papers_dir", "questions_dir", "pages_dir", "solutions_dir", "exports_dir"):
        Path(cfg.raw["pipeline"]["paths"][key]).mkdir(parents=True, exist_ok=True)
    return cfg


def _paper_metrics(cfg: Config, db: Database, filename: str, truth: Optional[dict]) -> dict:
    """Compute per-paper detection/classification metrics."""
    with db.conn() as c:
        rows = c.execute(
            """SELECT q.*, p.course_id AS paper_course, p.year AS paper_year
               FROM questions q JOIN papers p ON p.id = q.paper_id
               WHERE p.filename = ?""",
            (filename,),
        ).fetchall()
        questions = [dict(r) for r in rows]

    detected_nums = set()
    for q in questions:
        try:
            detected_nums.add(int(q["question_number"]))
        except (TypeError, ValueError):
            pass

    expected = set()
    if truth:
        expected = set(range(1, truth["expected_questions"] + 1))
        detected = len(detected_nums & expected)
        accuracy = detected / len(expected) if expected else 0.0
    else:
        detected = len(detected_nums)
        accuracy = None

    def avg(values):
        values = [v for v in values if v is not None]
        return round(sum(values) / len(values), 3) if values else None

    multi_page = [q["question_number"] for q in questions if q["page_end"] != q["page_start"]]
    needs_review = [q["id"] for q in questions if q["status"] == "needs_review"]
    no_topic = [q["id"] for q in questions if not q["topic_id"]]

    return {
        "detected_questions": len(questions),
        "expected_questions": len(expected) if expected else None,
        "detection_accuracy": accuracy,
        "matched_questions": detected,
        "avg_extraction_confidence": avg([q["extraction_confidence"] for q in questions]),
        "avg_classification_confidence": avg([q["classification_confidence"] for q in questions]),
        "avg_ocr_confidence": avg([q["ocr_confidence"] for q in questions]),
        "ocr_engine": sorted({q["ocr_engine"] for q in questions if q["ocr_engine"]}),
        "multi_page_questions": multi_page,
        "needs_review": len(needs_review),
        "no_topic": len(no_topic),
        "topic_coverage": round((len(questions) - len(no_topic)) / len(questions), 3) if questions else None,
        "with_answers": sum(1 for q in questions if (q.get("answer") or "").strip()),
        "with_solution_images": sum(1 for q in questions if q.get("solution_image_path")),
        "question_types": _count_by(questions, "question_type"),
    }


def render_report(suite: dict) -> str:
    lines = [
        "# 99.95squad — pipeline validation report",
        "",
        f"Generated: {suite['generated_at']}",
        f"Papers processed: {suite['papers_processed']} · failed: {suite['papers_failed']}",
        "",
        "## Per-paper results",
        "",
        "| Paper | Q detected | Q expected | Accuracy | Extraction conf | Classification conf | OCR | Multi-page | Needs review | Images |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for p in suite["papers"]:
        if not p["ok"]:
            lines.append(f"| {p['filename']} | **FAILED** | — | — | — | — | — | — | — | {p.get('error', '')[:60]} |")
            continue
        gt = p.get("ground_truth") or {}
        expected = p.get("expected_questions")
        acc = f"{p['detection_accuracy']:.0%}" if p.get("detection_accuracy") is not None else "—"
        lines.append(
            "| {name} | {det} | {exp} | {acc} | {ext} | {cls} | {ocr} | {mp} | {review} | {imgs} |".format(
                name=p["filename"],
                det=p["detected_questions"],
                exp=expected if expected is not None else "—",
                acc=acc,
                ext=p["avg_extraction_confidence"],
                cls=p["avg_classification_confidence"],
                ocr=",".join(p.get("ocr_engine") or ["none"]),
                mp=",".join(map(str, p.get("multi_page_questions") or [])) or "—",
                review=p["needs_review"],
                imgs=p["questions"],
            )
        )
    lines += ["", "## Data-quality audit", ""]
    qc = suite["quality_check"]["summary"]
    lines.append(
        f"- Questions audited: {qc['questions']} · issues: {qc['issues']} "
        f"(errors: {qc['errors']}, warnings: {qc['warnings']})"
    )
    if qc["by_code"]:
        lines.append("- By code: " + ", ".join(f"`{k}`×{v}" for k, v in sorted(qc["by_code"].items())))
    lines.append("")
    lines.append("## Review requirements")
    total_review = sum(p.get("needs_review", 0) for p in suite["papers"] if p.get("ok"))
    lines.append(f"- Questions flagged for human review: {total_review}")
    lines.append("- Review with: `python -m pipeline review` (CLI) or the Flask admin UI (`python -m pipeline serve` → /admin/review)")
    return "\n".join(lines)
