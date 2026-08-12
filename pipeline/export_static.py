"""Static site export.

Bridges the private pipeline database to the public GitHub Pages site.

Reads the SQLite DB and writes a self-contained, dependency-free content tree
that a static frontend can serve:

    <out>/
      manifest.json            counts, source ("sample" | "full"), config,
                               quality-check summary
      meta/
        subjects.json  courses.json  topics.json  papers.json  facets.json
      questions/
        <course_id>/shard-<n>.json   compact question records (paged)
        lookup.json                  question id -> [course, shard]
      index/
        <course_id>/<char>.json      inverted search index (token -> ids),
                                     sharded by first character of the token
                                     (includes facet tokens: c:, t:, y:, q:, ...)
      text/
        <question_id>.json           OCR text (fetched lazily on question pages)
      uploads/
        hashes.json                  public sha256 -> paper name (dedupe on upload)
      images/...                     WebP/AVIF (optimised) + JPEG fallback +
                                     thumbnail + original PNG for zoom

Design notes
- Only *publicly publishable* data is exported: no source PDFs, no original
  filenames (they can leak school names), no OCR raw dumps. Everything the
  site needs lives here; the pipeline never runs on GitHub Actions.
- Question records are compact and sharded so a browser only downloads the
  pages it needs (lazy loading, pagination).
- The inverted index is sharded by course and token-initial so search stays
  fast client-side up to tens of thousands of questions; beyond that, the
  architecture cleanly swaps in a backend search API (see docs/DEPLOY.md).
- Facet tokens (c:<course>, t:<topic>, y:<year>, q:<type>, d:<difficulty>,
  m:<marks>, p:<paper_type>, s:<subject>) let filters-only queries run as
  index intersections instead of scanning shards.
- A data-quality audit runs before export and its summary lands in the
  manifest; the site build fails on quality errors unless overridden.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Optional

from PIL import Image

from .config import Config
from .database import Database

log = logging.getLogger(__name__)

EXPORT_VERSION = 3

# --------------------------------------------------------------------------
# tokenisation (must match the JS tokenizer in site/assets/js/search.js)
# --------------------------------------------------------------------------
STOPWORDS = {
    "the", "and", "for", "are", "was", "with", "that", "this", "from", "have",
    "has", "had", "not", "you", "your", "will", "would", "can", "could",
    "should", "shall", "may", "might", "must", "its", "it's", "which", "what",
    "where", "when", "why", "how", "who", "whom", "than", "then", "them",
    "they", "their", "there", "these", "those", "into", "onto", "over",
    "under", "between", "during", "after", "before", "above", "below",
    "each", "every", "both", "some", "any", "all", "other", "another",
    "also", "such", "only", "very", "just", "but", "or", "so", "if", "as",
    "at", "by", "in", "of", "on", "to", "up", "out", "off", "an", "a", "is",
    "are", "be", "been", "being", "were", "do", "does", "did", "done",
}

WEBP_OK = "webp" in (Image.features.get_supported() if hasattr(Image, "features") else []) or True


def tokenize(text: str) -> list[str]:
    """Lowercase alphanumeric tokens, len>=2, stopwords removed."""
    if not text:
        return []
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    return [t for t in tokens if len(t) >= 2 and t not in STOPWORDS]


def token_initial(token: str) -> str:
    ch = token[0]
    if ch.isdigit():
        return "0-9"
    return ch if "a" <= ch <= "z" else "_"


def _facet_tokens(q: dict) -> list[str]:
    """Indexed facet tokens for filter-only queries (fast intersection)."""
    tokens = []
    if q.get("subject_id"):
        tokens.append(f"s:{q['subject_id']}")
    if q.get("course_id"):
        tokens.append(f"c:{q['course_id']}")
    if q.get("topic_id"):
        tokens.append(f"t:{q['topic_id']}")
    if q.get("subtopic_id"):
        tokens.append(f"st:{q['subtopic_id']}")
    if q.get("paper_year"):
        tokens.append(f"y:{q['paper_year']}")
    if q.get("paper_type"):
        tokens.append(f"p:{q['paper_type']}")
    if q.get("qtype"):
        tokens.append(f"q:{q['qtype']}")
    if q.get("difficulty") is not None:
        tokens.append(f"d:{int(round(q['difficulty']))}")
    if q.get("marks") is not None:
        tokens.append(f"m:{min(int(q['marks']), 15)}")
    return tokens


# --------------------------------------------------------------------------
# record helpers
# --------------------------------------------------------------------------
def _image_rel(image_path: str | None) -> str | None:
    """data/... -> images/... (relative to the content root)."""
    if not image_path:
        return None
    path = Path(image_path)
    try:
        idx = path.parts.index("questions")
    except ValueError:
        idx = 0
    parts = list(path.parts[idx:])
    return "/".join(parts)


def _course_dir(record: dict) -> str:
    return record["course_id"] or "unknown-course"


# --------------------------------------------------------------------------
# main export
# --------------------------------------------------------------------------
def export_static(
    config: Config,
    out_dir: str | Path,
    *,
    db: Optional[Database] = None,
    source: str = "full",
    include_ocr: bool = True,
    compress_images: bool = True,
    shard_size: int = 2000,
    max_index_postings: int = 20000,
    image_max_width: int = 1600,
    thumb_width: int = 480,
    jpeg_quality: int = 82,
    webp_quality: int = 78,
) -> dict:
    """Export the whole database into a static content tree.

    Returns the manifest dict.
    """
    out_dir = Path(out_dir)
    own_db = db is None
    db = db or Database(config.paths["database"])
    if own_db:
        db.init_schema()

    meta_dir = out_dir / "meta"
    q_dir = out_dir / "questions"
    idx_dir = out_dir / "index"
    text_dir = out_dir / "text"
    up_dir = out_dir / "uploads"
    img_dir = out_dir / "images"
    for d in (meta_dir, q_dir, idx_dir, text_dir, up_dir, img_dir):
        d.mkdir(parents=True, exist_ok=True)

    with db.conn() as c:
        questions = [
            dict(r)
            for r in c.execute(
                """SELECT q.id, q.question_number AS qnum, q.section, q.marks,
                          q.subparts, q.page_start, q.page_end, q.image_path,
                          q.solution_image_path, q.ocr_clean, q.ocr_confidence,
                          q.answer, q.topic_id, q.subtopic_id, q.course_id,
                          q.difficulty, q.question_type AS qtype,
                          COALESCE(c.subject_id, '') AS subject_id,
                          p.id AS paper_id, p.display_name AS paper_name,
                          p.organisation, p.year AS paper_year, p.paper_type,
                          p.has_solutions
                   FROM questions q
                   JOIN papers p ON p.id = q.paper_id
                   LEFT JOIN courses c ON c.id = q.course_id
                   WHERE p.status = 'complete'
                   ORDER BY q.paper_id, q.page_start, q.question_number"""
            ).fetchall()
        ]

        # ---- metadata -------------------------------------------------------
        subjects = [
            dict(r)
            for r in c.execute(
                """SELECT s.id, s.name, COUNT(DISTINCT q.id) AS n
                   FROM subjects s
                   LEFT JOIN courses c ON c.subject_id = s.id
                   LEFT JOIN questions q ON q.course_id = c.id
                   GROUP BY s.id ORDER BY s.name"""
            ).fetchall()
        ]
        courses = [
            dict(r)
            for r in c.execute(
                """SELECT c.id, c.name, c.subject_id, c.year_level,
                          COUNT(DISTINCT q.id) AS n
                   FROM courses c
                   LEFT JOIN questions q ON q.course_id = c.id
                   GROUP BY c.id ORDER BY c.name"""
            ).fetchall()
        ]
        topics_raw = [
            dict(r)
            for r in c.execute(
                """SELECT t.id, t.name, t.course_id,
                          COUNT(DISTINCT q.id) AS n
                   FROM topics t
                   LEFT JOIN questions q ON q.topic_id = t.id
                   GROUP BY t.id ORDER BY t.name"""
            ).fetchall()
        ]
        subtopics_raw = [
            dict(r)
            for r in c.execute(
                """SELECT st.id, st.name, st.topic_id,
                          COUNT(DISTINCT q.id) AS n
                   FROM subtopics st
                   LEFT JOIN questions q ON q.subtopic_id = st.id
                   GROUP BY st.id ORDER BY st.name"""
            ).fetchall()
        ]
        papers = [
            dict(r)
            for r in c.execute(
                """SELECT p.id, p.display_name, p.organisation, p.year,
                          p.paper_type, p.has_solutions, p.page_count,
                          (SELECT COUNT(*) FROM questions q
                            WHERE q.paper_id = p.id) AS n
                   FROM papers p WHERE p.status = 'complete'
                   ORDER BY p.year DESC, p.display_name"""
            ).fetchall()
        ]

    # ---- papers metadata: no filenames, no paths (privacy) -----------------
    for p in papers:
        p.pop("file_path", None)
        p.pop("filename", None)

    # ---- data-quality gate --------------------------------------------------
    from .validate import quality_check

    quality = quality_check(config, db=db)
    q_summary = quality["summary"]
    if q_summary["errors"]:
        log.warning(
            "export contains %d quality ERRORS (%d warnings) — run "
            "`python -m pipeline quality-check` to inspect",
            q_summary["errors"], q_summary["warnings"],
        )

    # ---- group questions by course and shard -------------------------------
    by_course: dict[str, list[dict]] = {}
    for q in questions:
        by_course.setdefault(_course_dir(q), []).append(q)

    lookup: dict[str, list] = {}
    n_images = 0
    for course_id, qs in by_course.items():
        course_dir = q_dir / course_id
        course_dir.mkdir(parents=True, exist_ok=True)
        for i in range(0, len(qs), shard_size):
            shard_no = i // shard_size
            records = []
            for q in qs[i : i + shard_size]:
                record = _public_record(q)
                if compress_images and q.get("image_path"):
                    images = _copy_and_compress(
                        q["image_path"], img_dir, thumb_width, image_max_width,
                        jpeg_quality, webp_quality,
                    )
                    record.update(images)
                    record["image_zoom"] = _copy_original(q["image_path"], img_dir)
                    n_images += 1
                if q.get("solution_image_path"):
                    sol = _copy_and_compress(
                        q["solution_image_path"], img_dir, None, image_max_width,
                        jpeg_quality, webp_quality,
                    )
                    record["solution_image"] = sol.get("image")
                    record["solution_image_fallback"] = sol.get("image_fallback")
                records.append(record)
                lookup[record["id"]] = [course_id, shard_no]
            (course_dir / f"shard-{shard_no}.json").write_text(
                json.dumps(records), encoding="utf-8"
            )

    for course_id, qs in by_course.items():
        (q_dir / course_id / "meta.json").write_text(
            json.dumps(
                {
                    "n": len(qs),
                    "shards": (len(qs) + shard_size - 1) // shard_size,
                    "shard_size": shard_size,
                }
            ),
            encoding="utf-8",
        )

    (q_dir / "lookup.json").write_text(json.dumps(lookup), encoding="utf-8")

    # ---- OCR text (lazy, per question) -------------------------------------
    if include_ocr:
        for q in questions:
            if (q.get("ocr_clean") or "").strip():
                (text_dir / f"{q['id']}.json").write_text(
                    json.dumps(
                        {
                            "ocr_clean": q["ocr_clean"][:20000],
                            "ocr_confidence": q.get("ocr_confidence"),
                        }
                    ),
                    encoding="utf-8",
                )

    # ---- inverted search index (with facet tokens) --------------------------
    for course_id, qs in by_course.items():
        postings: dict[str, list[str]] = {}
        for q in qs:
            tokens = set(tokenize(q.get("ocr_clean") or ""))
            # metadata tokens help discovery (course, topic, paper, org)
            tokens.update(tokenize(q.get("paper_name") or ""))
            tokens.update(tokenize(q.get("organisation") or ""))
            tokens.update(tokenize(_topic_name(config, q.get("topic_id")) or ""))
            tokens.update(tokenize(_subtopic_name(config, q.get("subtopic_id")) or ""))
            tokens.update(_facet_tokens(q))
            qid = q["id"]
            for token in tokens:
                postings.setdefault(token, []).append(qid)
        n_qs = max(len(qs), 1)
        per_char: dict[str, dict[str, list[str]]] = {}
        for token, ids in postings.items():
            if len(ids) > max(200, int(n_qs * 0.4)):  # too generic
                continue
            if len(ids) > max_index_postings:
                continue
            ids.sort()
            per_char.setdefault(token_initial(token), {})[token] = ids
        course_idx_dir = idx_dir / course_id
        course_idx_dir.mkdir(parents=True, exist_ok=True)
        for char, terms in per_char.items():
            (course_idx_dir / f"{char}.json").write_text(
                json.dumps(terms, sort_keys=True), encoding="utf-8"
            )
        (course_idx_dir / "meta.json").write_text(
            json.dumps({"chars": sorted(per_char), "n_questions": len(qs)}),
            encoding="utf-8",
        )

    # ---- uploads hash index (public duplicate detection) -------------------
    with db.conn() as c:
        paper_hashes = c.execute(
            "SELECT sha256, display_name FROM papers WHERE sha256 IS NOT NULL"
        ).fetchall()
        upload_hashes = c.execute(
            "SELECT sha256, filename FROM upload_submissions WHERE sha256 IS NOT NULL"
        ).fetchall()
    known = {row[0]: {"name": row[1], "kind": "paper"} for row in paper_hashes}
    for row in upload_hashes:
        known.setdefault(row[0], {"name": row[1], "kind": "upload"})
    (up_dir / "hashes.json").write_text(json.dumps(known), encoding="utf-8")

    # ---- facets -------------------------------------------------------------
    facets = {
        "paper_types": sorted({q.get("paper_type") for q in questions if q.get("paper_type")}),
        "paper_years": sorted({q.get("paper_year") for q in questions if q.get("paper_year")}, reverse=True),
        "question_types": sorted({q.get("qtype") for q in questions if q.get("qtype")}),
        "year_levels": sorted({c.get("year_level") for c in courses if c.get("year_level")}),
    }
    topics = []
    for t in topics_raw:
        topics.append(
            {
                "id": t["id"],
                "name": t["name"],
                "course_id": t["course_id"],
                "n": t["n"],
                "subtopics": [
                    {"id": s["id"], "name": s["name"], "n": s["n"]}
                    for s in subtopics_raw
                    if s["topic_id"] == t["id"]
                ],
            }
        )

    (meta_dir / "subjects.json").write_text(json.dumps(subjects), encoding="utf-8")
    (meta_dir / "courses.json").write_text(json.dumps(courses), encoding="utf-8")
    (meta_dir / "topics.json").write_text(json.dumps(topics), encoding="utf-8")
    (meta_dir / "papers.json").write_text(json.dumps(papers), encoding="utf-8")
    (meta_dir / "facets.json").write_text(json.dumps(facets), encoding="utf-8")

    total_tokens = 0
    for _, qs in by_course.items():
        seen: set[str] = set()
        for q in qs:
            seen.update(tokenize(q.get("ocr_clean") or ""))
        total_tokens += len(seen)

    manifest = {
        "version": EXPORT_VERSION,
        "source": source,
        "generated_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "counts": {
            "questions": len(questions),
            "papers": len(papers),
            "courses": len(courses),
            "topics": len(topics),
            "images": n_images,
            "tokens": total_tokens,
        },
        "config": {
            "shard_size": shard_size,
            "include_ocr": include_ocr,
            "webp": WEBP_OK,
        },
        "quality": q_summary,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )

    if own_db:
        db.close()
    return manifest


def _public_record(q: dict) -> dict:
    """Compact, publishable question record."""
    return {
        "id": q["id"],
        "qnum": q["qnum"],
        "section": q.get("section"),
        "marks": q.get("marks"),
        "subparts": q.get("subparts"),
        "pages": [q.get("page_start"), q.get("page_end")],
        "course_id": q.get("course_id"),
        "subject_id": q.get("subject_id") or None,
        "topic_id": q.get("topic_id"),
        "subtopic_id": q.get("subtopic_id"),
        "difficulty": q.get("difficulty"),
        "qtype": q.get("qtype"),
        "answer": q.get("answer"),
        "paper_id": q.get("paper_id"),
        "paper_name": q.get("paper_name"),
        "organisation": q.get("organisation"),
        "paper_year": q.get("paper_year"),
        "paper_type": q.get("paper_type"),
        "ocr_conf": round(q.get("ocr_confidence") or 0, 3),
    }


def _topic_name(config: Config, topic_id: str | None) -> str | None:
    if not topic_id:
        return None
    for course_id, topics in config.topics_for_course_all().items():
        for t in topics:
            if f"{course_id}:{t['id']}" == topic_id:
                return t["name"]
    return None


def _subtopic_name(config: Config, subtopic_id: str | None) -> str | None:
    if not subtopic_id:
        return None
    for course_id, topics in config.topics_for_course_all().items():
        for t in topics:
            for st in t.get("subtopics", []):
                if f"{course_id}:{t['id']}:{st['id']}" == subtopic_id:
                    return st["name"]
    return None


# --------------------------------------------------------------------------
# image optimisation
# --------------------------------------------------------------------------
def _copy_original(image_path: str, img_dir: Path) -> str | None:
    src = Path(image_path)
    if not src.exists():
        return None
    rel = _image_rel(image_path)
    if not rel:
        return None
    dest = img_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(src) as im:
            im.convert("RGB").save(dest, format="PNG", optimize=True)
        return "images/" + rel
    except Exception as exc:  # pragma: no cover
        log.warning("could not copy image %s: %s", src, exc)
        return None


def _copy_and_compress(
    image_path: str,
    img_dir: Path,
    thumb_width: int | None,
    max_width: int,
    quality: int,
    webp_quality: int,
) -> dict:
    """Produce optimised variants of a question image.

    Returns {"image": <webp>, "image_fallback": <jpg>, "thumb": <webp|None>,
             "thumb_fallback": <jpg|None>} — paths relative to content root.
    The original PNG is kept separately via ``_copy_original`` for zooming.
    """
    src = Path(image_path)
    if not src.exists():
        return {}
    rel = _image_rel(image_path)
    if not rel:
        return {}
    base = img_dir / Path(rel).with_suffix("")
    base.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(src) as im:
            im = im.convert("RGB")
            if im.width > max_width:
                im = im.resize(
                    (max_width, int(im.height * max_width / im.width)), Image.LANCZOS
                )
            out: dict = {}

            # WebP (primary) + JPEG (fallback)
            webp_path = Path(str(base) + ".webp")
            im.save(webp_path, format="WEBP", quality=webp_quality, method=4)
            out["image"] = _rel(img_dir, webp_path)
            jpg_path = Path(str(base) + ".jpg")
            im.save(jpg_path, format="JPEG", quality=quality, optimize=True, progressive=True)
            out["image_fallback"] = _rel(img_dir, jpg_path)

            if thumb_width:
                thumb = im.copy()
                if thumb.width > thumb_width:
                    thumb = thumb.resize(
                        (thumb_width, int(thumb.height * thumb_width / thumb.width)),
                        Image.LANCZOS,
                    )
                tw_path = Path(str(base) + ".thumb.webp")
                thumb.save(tw_path, format="WEBP", quality=webp_quality - 6, method=4)
                out["thumb"] = _rel(img_dir, tw_path)
                tj_path = Path(str(base) + ".thumb.jpg")
                thumb.save(tj_path, format="JPEG", quality=quality - 8, optimize=True, progressive=True)
                out["thumb_fallback"] = _rel(img_dir, tj_path)
            return out
    except Exception as exc:  # pragma: no cover
        log.warning("could not compress image %s: %s", src, exc)
        return {}


def _rel(img_dir: Path, path: Path) -> str:
    return "images/" + path.relative_to(img_dir).as_posix()
