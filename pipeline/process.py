"""Batch processing pipeline.

Orchestrates one PDF (or a directory of PDFs) through:

    ingest -> render -> detect -> crop -> OCR -> classify -> solutions -> DB

Design goals:
- one failing PDF never crashes the batch
- already-processed PDFs are skipped (sha256) unless ``--force``
- progress persists in the DB (paper status) so runs can be resumed
- question ids are stable: ``<paper-id>-q<number>``
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Optional

from .classify import Classifier
from .config import Config
from .crop import crop_question
from .database import Database
from .detect import QuestionDetector
from .difficulty import estimate_difficulty
from .ingest import discover_pdfs, register_paper
from .models import PaperRecord, QuestionRegion
from .ocr import clean_ocr, get_engine
from .render import open_pdf, render_paper_pages, render_page_pil
from .solutions import extract_solutions, question_id, split_inline_solution_crop

log = logging.getLogger(__name__)


class PipelineError(Exception):
    pass


def _slugify(value: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "unknown"


def _q_number(value: str) -> str:
    try:
        return f"{int(value):02d}"
    except ValueError:
        return value


# ---------------------------------------------------------------------------
# single paper
# ---------------------------------------------------------------------------
def process_pdf(
    config: Config,
    pdf_path: str | Path,
    *,
    force: bool = False,
    db: Optional[Database] = None,
    logger: Optional[logging.Logger] = None,
) -> dict:
    """Run the full pipeline on one PDF. Returns a result dict.

    Raises PipelineError on fatal failure (caller decides whether to stop).
    """
    log = logger or logging.getLogger(__name__)
    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        raise PipelineError(f"file not found: {pdf_path}")

    own_db = db is None
    db = db or Database(config.paths["database"])
    if own_db:
        db.init_schema()
    db.seed_taxonomy(config)  # idempotent; ensures courses/topics exist for metadata

    t0 = time.time()
    record, status = register_paper(config, pdf_path)

    if status == "exists-complete" and not force:
        log.info("skip %s (already processed, use --force to redo)", pdf_path.name)
        return {"paper_id": record.id, "skipped": True, "questions": 0}

    db.insert_paper(
        {
            "id": record.id,
            "filename": record.filename,
            "file_path": str(pdf_path),
            "sha256": record.sha256,
            "display_name": record.display_name,
            "organisation": record.organisation,
            "year": record.year,
            "paper_type": record.paper_type,
            "subject_id": record.subject_id,
            "course_id": record.course_id,
            "year_level": record.year_level,
            "has_solutions": 1 if record.has_solutions else 0,
            "page_count": None,
            "status": "processing",
        }
    )

    try:
        result = _process_paper(config, db, record, pdf_path, force=force, log=log)
        db.set_paper_status(record.id, "complete")
        elapsed = time.time() - t0
        log.info(
            "OK %s: %d questions in %.1fs (course=%s, year=%s)",
            pdf_path.name, result["questions"], elapsed,
            record.course_id or "?", record.year or "?",
        )
        result.update({"paper_id": record.id, "skipped": False, "elapsed": elapsed})
        return result
    except Exception as exc:
        log.exception("FAIL %s: %s", pdf_path.name, exc)
        db.set_paper_status(record.id, "error", str(exc))
        if own_db:
            db.close()
        raise PipelineError(f"{pdf_path.name}: {exc}") from exc
    finally:
        if own_db:
            db.close()


def _process_paper(config: Config, db: Database, record: PaperRecord, pdf_path: Path, *, force: bool, log) -> dict:
    cfg = config.pipeline
    dpi = int(cfg["render"]["dpi"])
    detector_dpi = int(cfg["render"]["detector_dpi"])
    padding = float(cfg["detect"]["padding_points"])

    # ---------------- render ------------------------------------------------
    log.debug("rendering %s", pdf_path.name)
    doc = open_pdf(pdf_path)
    try:
        n_pages = len(doc)
        page_images = render_paper_pages(
            doc, record.id, config.paths["pages_dir"], dpi, force=force
        )
        # record pages in DB
        from PIL import Image as PILImage

        for i, img_path in enumerate(page_images, start=1):
            with PILImage.open(img_path) as im:
                w, h = im.size
            db.insert_page(
                {
                    "id": f"{record.id}-p{i:03d}",
                    "paper_id": record.id,
                    "page_number": i,
                    "image_path": str(img_path),
                    "width": w,
                    "height": h,
                }
            )
        db.exec("UPDATE papers SET page_count=? WHERE id=?", (n_pages, record.id))

        # ---------------- detect ---------------------------------------------
        log.debug("detecting questions")
        ocr_engine = get_engine(config)
        detector = QuestionDetector(config, ocr_engine=ocr_engine)
        detection = detector.detect(doc)

        # ---- scanned / no-text-layer safety net ------------------------------
        # When no OCR engine exists and pages have no text layer, we cannot
        # segment — but the *images* are still the questions. Emit whole-page
        # regions (flagged for review) instead of failing the paper outright.
        if not detection.questions:
            detection = _visual_whole_page_fallback(detection, doc, config, dpi)
            if detection.questions:
                log.warning(
                    "%s: no text layer + no OCR engine -> %d whole-page "
                    "questions flagged for review (install tesseract to segment)",
                    pdf_path.name, len(detection.questions),
                )

        if not detection.questions:
            raise PipelineError("no questions detected (check config/patterns.yaml or review the PDF)")

        # ---------------- crop + OCR + classify ------------------------------
        log.debug("cropping %d questions", len(detection.questions))
        out_dir = config.course_data_dir(
            record.course_id or "unknown", record.year, record.organisation
        )
        out_dir.mkdir(parents=True, exist_ok=True)

        # page image lookup for question pages (only those needed)
        needed_pages = {
            p
            for q in detection.questions
            for p in range(q.page_start, min(q.page_end + 1, n_pages + 1))
        }
        pil_pages = {}
        for p in needed_pages:
            pil_pages[p] = render_page_pil(doc.load_page(p - 1), dpi)

        classifier = Classifier(config)
        paper_text = "\n".join(
            l.text for pg in range(n_pages)
            for l in _page_lines(doc, pg)
        )
        paper_text = paper_text[:200_000]

        questions_by_number: dict[str, QuestionRegion] = {}
        stored: list[str] = []
        for region in detection.questions:
            qnum = region.number
            # unique key: if two regions share a number (sections), disambiguate
            key = qnum
            suffix = 2
            while key in questions_by_number:
                key = f"{qnum}-{suffix}"
                suffix += 1
            questions_by_number[key] = region

            img = crop_question(region, pil_pages, dpi, padding)
            q_img, sol_img = split_inline_solution_crop(
                img, region, pil_pages[region.page_start], dpi, padding
            )

            q_file = out_dir / f"q{_q_number(qnum)}.png"
            q_img.save(q_file, format="PNG")

            # OCR (question image) -------------------------------------------
            ocr_text = ""
            ocr_engine_name = "none"
            ocr_conf = 0.0
            if ocr_engine is not None:
                if ocr_engine.name == "embedded":
                    res = ocr_engine.run(None, source_text=region.text)
                else:
                    res = ocr_engine.run(q_file)
                ocr_text = res.text
                ocr_engine_name = res.engine
                ocr_conf = res.confidence

            # classification -------------------------------------------------
            classification = classifier.classify(region, record, paper_text=paper_text)
            difficulty, diff_reasoning = estimate_difficulty(region, config)
            classification.difficulty = difficulty
            classification.difficulty_reasoning = diff_reasoning

            # solution crop for inline solutions ------------------------------
            solution_image_path = None
            if sol_img is not None:
                sol_file = out_dir / f"q{_q_number(qnum)}_solution.png"
                sol_img.save(sol_file, format="PNG")
                solution_image_path = str(sol_file)

            flags = region.flags + classification.notes
            status = "new"
            if region.confidence < 0.6 or not region.text.strip():
                status = "needs_review"
                flags.append("low-extraction-confidence")

            qid = question_id(record.id, qnum)
            db.upsert_question(
                {
                    "id": qid,
                    "paper_id": record.id,
                    "question_number": qnum,
                    "section": region.section,
                    "marks": region.marks,
                    "subparts": len(region.subparts) if region.subparts else None,
                    "page_start": region.page_start,
                    "page_end": region.page_end,
                    "image_path": str(q_file),
                    "image_width": q_img.width,
                    "image_height": q_img.height,
                    "ocr_raw": ocr_text,
                    "ocr_clean": clean_ocr(ocr_text),
                    "ocr_engine": ocr_engine_name,
                    "ocr_confidence": ocr_conf,
                    "answer": None,
                    "answer_source": None,
                    "solution_image_path": solution_image_path,
                    "solution_text": None,
                    "subject_id": classification.subject_id,
                    "course_id": classification.course_id,
                    "year_level": classification.year_level,
                    "topic_id": classification.topic_id,
                    "subtopic_id": classification.subtopic_id,
                    "difficulty": classification.difficulty,
                    "difficulty_reasoning": classification.difficulty_reasoning,
                    "question_type": classification.question_type,
                    "extraction_confidence": region.confidence,
                    "classification_confidence": classification.confidence,
                    "status": status,
                    "review_flags": json.dumps(flags[:20]),
                }
            )
            stored.append(qid)
            log.debug("  q%s -> %s (topic=%s, conf=%.2f)", qnum, q_file, classification.topic_id, region.confidence)

        # ---------------- solutions/answers ----------------------------------
        answers, solutions = extract_solutions(
            detection,
            questions_by_number,
            record.id,
            doc,
            out_dir=out_dir,
            dpi=dpi,
            ocr_engine=ocr_engine,
            padding_points=padding,
        )
        for ans in answers:
            db.upsert_answer(
                {
                    "question_id": ans.question_id,
                    "paper_id": record.id,
                    "answer_text": ans.answer_text,
                    "answer_type": "short",
                    "image_path": ans.image_path,
                    "source_page": ans.source_page,
                    "confidence": ans.confidence,
                }
            )
            if ans.question_id:
                db.update_question_fields(ans.question_id, {"answer": ans.answer_text, "answer_source": "auto"})
        for sol in solutions:
            db.upsert_solution(
                {
                    "question_id": sol.question_id,
                    "paper_id": record.id,
                    "image_path": sol.image_path,
                    "text": None,
                    "source_page": sol.source_page,
                    "confidence": sol.confidence,
                }
            )
            if sol.question_id and not db.get_question(sol.question_id)["solution_image_path"]:
                db.update_question_fields(sol.question_id, {"solution_image_path": sol.image_path})
        if answers or solutions:
            db.exec("UPDATE papers SET has_solutions=1 WHERE id=?", (record.id,))

        return {
            "questions": len(stored),
            "pages": n_pages,
            "answers": len(answers),
            "solutions": len(solutions),
            "flags": detection.flags[:20],
        }
    finally:
        doc.close()


def _page_lines(doc, page_idx: int):
    """Embedded text lines of a page (best effort, for paper-level text)."""
    from .layout import extract_layout

    layout = extract_layout(doc.load_page(page_idx), page_idx + 1, min_chars=0)
    return layout.lines


def _visual_whole_page_fallback(detection, doc, config: Config, dpi: int) -> DetectionResult:
    """For pages with no usable text layer, create whole-page question regions
    for every page that visually contains ink. Each region is flagged
    ``whole-page-fallback`` + ``no-text-layer`` and confidence 0.2 so it lands
    in the review queue."""
    from PIL import Image as PILImage

    from .models import QuestionRegion

    def ink_ratio(img: PILImage.Image) -> float:
        small = img.convert("L").resize((160, 220))
        data = small.tobytes()
        dark = sum(1 for p in data if p < 200)
        return dark / len(data)

    added = []
    for i in range(len(doc)):
        img = render_page_pil(doc.load_page(i), dpi)
        if ink_ratio(img) < 0.01:
            continue  # visually blank page
        # unique per-page number so question ids stay unique ("?p1", "?p2", …)
        region = QuestionRegion(
            number=f"?p{i + 1}",
            page_start=i + 1,
            page_end=i + 1,
            y_top=0.0,
            y_bottom=doc.load_page(i).rect.height,
            confidence=0.2,
            flags=["whole-page-fallback", "no-text-layer"],
        )
        added.append(region)
    if added:
        detection.questions.extend(added)
        detection.flags.append("visual-whole-page-fallback")
    return detection


# ---------------------------------------------------------------------------
# batch
# ---------------------------------------------------------------------------
def process_directory(
    config: Config,
    papers_dir: str | Path,
    *,
    force: bool = False,
    resume: bool = True,
    limit: Optional[int] = None,
    pattern: Optional[str] = None,
) -> dict:
    """Process every PDF in a directory. Never crashes on a single PDF."""
    import fnmatch

    pdfs = discover_pdfs(papers_dir)
    if pattern:
        pdfs = [p for p in pdfs if fnmatch.fnmatch(p.name.lower(), pattern.lower())]
    if limit:
        pdfs = pdfs[:limit]

    log.info("found %d PDF(s) in %s", len(pdfs), papers_dir)
    results = {"ok": [], "failed": [], "skipped": []}
    db = Database(config.paths["database"])
    db.init_schema()

    for pdf in pdfs:
        # resume: skip complete papers unless force
        if resume and not force:
            _, status = register_paper(config, pdf)
            if status == "exists-complete":
                log.info("skip %s (resume)", pdf.name)
                results["skipped"].append(str(pdf))
                continue
        try:
            r = process_pdf(config, pdf, force=force, db=db)
            if r.get("skipped"):
                results["skipped"].append(str(pdf))
            else:
                results["ok"].append({"file": str(pdf), **r})
        except PipelineError as exc:
            results["failed"].append({"file": str(pdf), "error": str(exc)})
        except Exception as exc:  # defensive: never crash the batch
            log.exception("unexpected error for %s", pdf)
            results["failed"].append({"file": str(pdf), "error": f"unexpected: {exc}"})

    db.close()
    return results
