# Architecture

## Design principle

**The rendered question image is the canonical representation of a question.**
PDF text extraction is used only where it is *reliable* (positions, font
sizes, layout) and for things that benefit from being searchable (OCR text,
metadata). Corrupted mathematical glyph text is never displayed to students.

## Two layers

```
┌────────────────────────────── LOCAL (private) ──────────────────────────────┐
│  data/papers/*.pdf                                                          │
│      │ sha256 dedupe, filename metadata                                     │
│      ▼                                                                      │
│  pipeline/  ingest → render(200dpi) → detect → crop → OCR → classify →      │
│             answers/solutions → SQLite + FTS5                               │
│      │                                                                      │
│      ▼  pipeline/export_static.py  (strips private data, compresses images) │
│  site/content/   ← git-ignored full export                                 │
└────────────────────────────── PUBLIC (GitHub Pages) ────────────────────────┘
  site/content_sample/ (committed synthetic demo)
      │  scripts/build_site.py (validates, generates sitemap/robots)
      ▼
  site/_site/ ──► GitHub Actions ──► https://<user>.github.io/<repo>/
      │
      ▼  browser-side (site/assets/js/*)
  api.js (lazy JSON shards) ─ search.js (inverted index) ─ pages (SPA)
  store.js (device progress) ─ auth.js (local | Supabase REST)
```

## Pipeline layer (unchanged core)

| Module | Responsibility |
|---|---|
| `ingest.py` | discovery, sha256 dedup, filename metadata |
| `render.py` | high-DPI page rendering (PyMuPDF) — visual source of truth |
| `layout.py` + `detect.py` | line layout, columns, question boundaries, sections, subparts, marks, MCQs, multi-page continuation, answer-section detection |
| `crop.py` | question crops, multi-page stitching |
| `ocr/` | pluggable OCR (tesseract / embedded-text fallback) |
| `classify.py` + `difficulty.py` | course/topic/subtopic/type classification; 1–5 difficulty with reasoning |
| `solutions.py` | answer-section parsing, solution crops |
| `database.py` | SQLite schema, DAO, FTS5 search, uploads/profiles/reports tables |
| `uploads.py` | student uploads: register → dedupe → moderate → process → grant premium |
| `process.py` | batch orchestration, resume, per-file error isolation |
| `export_static.py` | static content export (below) |

## Static export (`pipeline/export_static.py`)

Reads the SQLite DB and writes a dependency-free content tree:

```
content/
  manifest.json             counts, source, config
  meta/                     subjects, courses, topics, papers, facets
  questions/<course>/shard-N.json   compact records, 2000/shard
  questions/lookup.json     id → [course, shard] (O(1) record lookup)
  index/<course>/<char>.json  inverted search index sharded by token initial
  text/<id>.json            OCR text (fetched lazily on question pages)
  uploads/hashes.json       public sha256s → client-side duplicate check
  images/...                web JPEG + thumbnail + original PNG (zoom)
```

Properties that make it scale:

- **Lazy loading** — the browser only downloads the shards/index files it
  needs for the current page of results.
- **Pagination** — filter-only browsing fetches shards incrementally until a
  page is full (no full-library download).
- **Stable IDs** — new paper IDs use
  `<org>-<year>-<course>-<sha16>` (existing full-SHA matches retain their old
  IDs). Question identity adds the printed number and occurrence; repeats use
  `--occurrence-N`. Reprocessing does not change saved/favourited IDs.
- **Compressed images** — cards use thumbnails (~3–7 KB), detail uses JPEG
  (~10–120 KB), zoom uses the original PNG; all lazy-loaded.
- **Privacy by construction** — no PDFs, no original filenames, no raw OCR
  dumps, no DB file.
- **Deterministic builds** — GitHub Actions never runs the pipeline; it
  packages the committed sample content, so deploys are fast and private.

## Static frontend (`site/`)

Vanilla-JS SPA with hash routing (`#/browse`, `#/question/<id>`, …). No
bundler, no build step — files are served as-is (fast, no lock-in).

| File | Role |
|---|---|
| `assets/js/api.js` | lazy JSON loading + name resolution + cache |
| `assets/js/search.js` | tokenizer (mirrors Python), inverted-index query, filters, sort, pagination |
| `assets/js/store.js` | device-local state: favourites, history, sets, submissions |
| `assets/js/auth.js` | pluggable accounts: device-local or Supabase REST |
| `assets/js/practice.js` | session engine: MCQ answering, self-marking, timer, summary |
| `assets/js/pages.js` | page renderers (landing → admin) |
| `scripts/build_site.py` | assemble + validate `_site/`, generate sitemap |
| `scripts/dom_smoke.js` | jsdom end-to-end test of the real frontend |

### Search at scale

The inverted index is sharded per course and per token-initial, so a query
only downloads the files it needs. Postings are sorted id arrays and
intersected with a merge. Metadata tokens (topic names, paper names,
organisations) are indexed alongside OCR so `normal distribution` finds the
question even with imperfect OCR. Beyond ~100k questions, swap
`api.js`/`search.js` fetches for a backend search API — the interface stays
the same (documented in docs/DEPLOY.md).

## Accounts & access

See `docs/AUTH.md`. Two modes:

- **Device-local** — everything in `localStorage`, honestly labelled.
- **Supabase** — real auth via REST (`auth/v1`), profiles, RLS-protected
  `upload_submissions` and `problem_reports`, moderator SQL functions that
  grant the 14-day premium atomically. Schema in `site/backend/supabase.sql`.

Premium is a **database entitlement**, never a localStorage flag.

## Failure model

- A single PDF failure is logged and the batch continues.
- Papers are idempotent by sha256; questions by
  `UNIQUE(paper_id, question_number, page_start)`.
- Anything the system cannot decide confidently is `null`/`unknown` + review
  flag — never invented.
- The SPA guards async callbacks against stale DOM (navigation races) and
  renders explicit loading / empty / error states.

## Security & privacy

- Source PDFs and the full export live under `data/` and `site/content/`,
  both git-ignored. Only the synthetic sample (`site/content_sample/`) is
  committed.
- The exporter strips private fields; the build validates that referenced
  images exist before deploying.
- No API keys in the repo; Supabase anon key (public) goes in `config.js`.
