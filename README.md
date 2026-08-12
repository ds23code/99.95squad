# QuestionBank — image-first question bank for Australian HSC papers

Turn your collection of Year 11/12 PDF exam papers, trial papers, assessments
and worksheets into a **searchable, filterable, practise-able question bank**.

> **IMAGE > OCR.** For every question the system stores a high-resolution image
> of the question as it appeared in the original PDF. That image is the source
> of truth — maths, diagrams, graphs and tables are preserved exactly, even
> when the PDF's embedded fonts make normal text extraction produce garbage
> (`y = 4sin(πx)` → `y = 4sin(px)` or worse). OCR is used only for **search**,
> **topic classification** and **metadata**; it never replaces the question
> image.

---

## Quick start

```bash
# 1. Install (Python 3.10+)
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install        # jsdom — only needed for the frontend smoke tests

# 2. Put your PDFs where the pipeline expects them
mkdir -p data/papers            # <-- drop PDFs here (e.g. TrialMaths_2023_2U_wsols.pdf)
python -m pipeline init         # create the database + seed the taxonomy

# 3. First milestone: process ONE paper
python -m pipeline process data/papers/TrialMaths_2023_2U_wsols.pdf
#   -> data/questions/<course>/<year>/<source>/q01.png, q02.png, ...
#   -> every question in the database with OCR, topic, difficulty, marks, answers

# 4. Inspect what you got
python -m pipeline stats
python -m pipeline review --list          # questions flagged for human review
python -m pipeline export --format json   # full metadata export

# 5. Preview the public website (static site — this is what GitHub Pages serves)
python -m pipeline sample-content         # (re)generate the committed sample content
python scripts/build_site.py              # assemble site/_site (uses sample content)
python scripts/serve_site.py --port 8080  # http://localhost:8080
```

No sample PDFs? Generate a synthetic TrialMaths-style paper to try the whole
pipeline end-to-end (original content, safe to commit):

```bash
python -m pipeline sample
python -m pipeline process data/papers/TrialMaths_2023_2U_wsols_sample.pdf
```

> **Cross-platform fonts.** `python -m pipeline sample` (and the validation
> suite) work on macOS, Linux, Windows and CI with **no font installation**:
> the generators use the DejaVu fonts bundled in `assets/fonts/` (committed,
> permissive licence), falling back to common system-font locations and then
> PyMuPDF built-in fonts. The pipeline itself never needs fonts — it renders
> whatever is inside your PDFs.

---

## Where do my PDFs go?

```
data/
├── papers/          <-- PUT YOUR PDFs HERE (any subfolders work)
│   └── TrialMaths_2023_2U_wsols.pdf
├── questions/       generated question crops   (git-ignored)
├── pages/           generated full-page renders (git-ignored)
├── solutions/       generated answer/solution crops (git-ignored)
└── questionbank.db  SQLite database             (git-ignored)
```

Everything under `data/` is **git-ignored** — your (possibly copyrighted)
source PDFs stay local and private. The repository contains only code,
configuration and the sample-PDF *generator*; it is safe to publish on GitHub.

### Filenames help (but are optional)

The pipeline reads as much as it can from the filename, then refines from the
paper text:

| Example filename | Parsed as |
|---|---|
| `TrialMaths_2023_2U_wsols.pdf` | organisation TrialMaths · 2023 · Mathematics Advanced (`2U`) · with solutions |
| `JRHS_2021_Physics_Trial.pdf` | JRHS · 2021 · Physics · trial examination |
| `HSC_2020_Mathematics_Standard.pdf` | HSC (past paper) · 2020 · Mathematics Standard |
| `Year_11_Prelim_Chemistry_Assessment.pdf` | Year 11 · Chemistry · assessment |

Unknown pieces are stored as `null` and queued for review rather than guessed.

---

## The pipeline

```
PDF ──► ingest ──► render pages @200dpi ──► detect question boundaries
   ──► crop question images ──► OCR each crop ──► classify metadata
   ──► extract answers/solutions ──► SQLite (FTS5 search index) ──► website
```

Each stage is a module in `pipeline/`:

| Module | Responsibility |
|---|---|
| `ingest.py` | discovery, sha256 dedup, filename metadata |
| `render.py` | high-DPI page rendering (PyMuPDF) — visual source of truth |
| `layout.py` | embedded-text/OCR line layout + column detection |
| `detect.py` | question boundary detection (regex + layout + continuation across pages) |
| `crop.py` | question crops, multi-page stitching |
| `ocr/` | pluggable OCR (tesseract / embedded-text fallback) |
| `classify.py` | subject/course/topic/subtopic/type classification |
| `difficulty.py` | 1–5 difficulty model with reasoning |
| `solutions.py` | answer-section parsing, solution crops |
| `database.py` | SQLite schema, DAO, FTS5 full-text search |
| `process.py` | batch orchestration, resume, per-file error isolation |
| `cli.py` | `process` / `review` / `export` / `stats` / `serve` / `sample` |
| `web/` | Flask website (search, filters, practice mode) |

### Key behaviours

- **Multi-page questions** are detected and stitched into one tall image with a
  separator line.
- **Two-column papers** are split into reading-order columns before scanning.
- **MCQs, subparts, marks** are detected from the layout/text.
- **Answer sections** ("Answers", "Worked Solutions") are recognised; short
  answers like `1. C` are attached to their question, worked solutions are
  cropped to `qNN_solution.png`.
- **Uncertainty is stored, never hidden.** Every question carries
  `extraction_confidence` and `classification_confidence`; low-confidence or
  flagged questions land in the review queue (`pipeline review`).
- **Resume & dedupe.** Papers are keyed by sha256; a re-run skips completed
  papers unless `--force`. One bad PDF never stops the batch.

---

## Command-line tools

```bash
python -m pipeline init                              # create DB + seed taxonomy
python -m pipeline process FILE.pdf                  # one paper
python -m pipeline process data/papers/              # whole batch
python -m pipeline process data/papers/ --force      # redo everything
python -m pipeline process data/papers/ --limit 10 --pattern "*trial*"
python -m pipeline review --list                     # review queue
python -m pipeline review                            # interactive review
python -m pipeline review --id <question-id> --set topic_id=... --set marks=3
python -m pipeline export --format json|csv
python -m pipeline export-static --out site/content  # static content tree (full library)
python -m pipeline sample-content                    # regenerate site/content_sample
python -m pipeline validate                          # validation suite (7 diverse papers → report)
python -m pipeline validate --input /path/to/pdfs    # …or your real papers
python -m pipeline quality-check                     # data-quality audit (before publishing)
python -m pipeline uploads list                      # student upload moderation
python -m pipeline uploads register paper.pdf --uploader student-1
python -m pipeline uploads approve <upload-id>
python -m pipeline uploads reject|duplicate <upload-id>
python -m pipeline stats
python -m pipeline sample                            # generate test PDF
```

Frontend commands:

```bash
python scripts/build_site.py                        # assemble + validate site/_site
python scripts/serve_site.py --port 8080            # serve the static site locally
node scripts/dom_smoke.js site/_site node_modules/jsdom   # DOM smoke test
```

---

## Public website (GitHub Pages)

The student-facing product is a **static site** (`site/`) deployed to GitHub
Pages by `.github/workflows/pages.yml` on every push to `main`. No server, no
database, no API keys required to serve it. See `docs/DEPLOY.md`.

The site is fully **relative-path based**, so it works both from a domain
root and from a GitHub Pages repository subpath
(`https://USERNAME.github.io/99.95squad/`). Question images are emitted as
public content URLs (`content/images/…`) resolved from the JSON shards — the
same files that are copied into `_site` and served by GitHub Pages; OCR text
is never substituted for a missing image. If an image ever fails to load,
the site shows the exact asset URL it requested so the break is
self-diagnosing.

The static site includes:

- **Landing page** with live stats and search.
- **Onboarding** — new students pick their year, courses and daily goal; the
  dashboard adapts.
- **Dashboard** — greeting, XP + level progress, streak, daily-goal bar,
  activity calendar (week/month/year), topic mastery, recommended practice,
  recent activity and achievements.
- **Syllabus** — a Duolingo-style topic path (Unseen → Learning → Practising
  → Strong → Mastered) computed from accuracy, difficulty, recency and
  attempts; each node links to a focused practice session.
- **Leaderboard** — weekly and all-time XP rankings with rank/level/XP,
  opt-out in settings, and your position via `my_rank`.
- **Time analytics** — your average/median time per question vs community
  aggregates (never individual data), with correct/incorrect splits.
- **Gamification** — XP by difficulty, day streaks (with a weekly bonus),
  levels and achievements; all computed **server-side** in Supabase, never
  trusted from localStorage.
- **Comments** — per-question discussion with replies, likes, reporting,
  own-comment deletion, rate limiting and server-side profanity filtering.
- **Auth** — email/password + Google (+ Apple when enabled) via Supabase
  PKCE; persistent sessions; settings edits through `update_my_profile`
  (entitlement columns are not client-writable).
- **Question browser** — keyword search (client-side inverted index), filters
  for subject / course / topic / subtopic / difficulty / marks / type /
  paper type / paper year, sorting, pagination, random question, "practise
  this filter set". Filter-only queries run as index intersections (facet
  tokens), so they stay fast without loading the whole library; the search
  layer is backend-swappable (`config.js` → `QB_CONFIG.search`).
- **Question pages** — the canonical high-res image (WebP by default, JPEG
  fallback, click to zoom the original PNG), lazy thumbnails, answer reveal,
  worked solutions, a per-question timer, mark-correct/incorrect (server XP
  feedback), similar questions, "practice another like this", favourites,
  report-a-problem and the comment discussion.
- **Practice mode** — timed sessions, MCQ answering with instant feedback,
  self-marking for written answers, custom question sets, weak-topic
  practice, per-question attempt recording (each attempt is recorded
  server-side for XP and analytics when the backend is on).
- **Progress** — attempted/correct/accuracy, day streak, practice time,
  14-day activity chart, topic accuracy, weak topics, recent activity.
- **Accounts** — device-local by default (clearly labelled demo); real
  accounts + moderated uploads + premium entitlements via Supabase when
  configured (`docs/AUTH.md`). Premium is a database entitlement — users
  cannot grant it to themselves.
- **Contribute a paper** — size + magic-byte + SHA-256 checks, copyright
  acknowledgement, upload quota, pending → approved moderation statuses,
  14-day premium for approved uploads (server-side).
- **Admin moderation page** — approve / reject / duplicate / needs-review
  for reviewers.

The pipeline layer also ships a smaller Flask app (`python -m pipeline
serve`) that reads the database directly — useful as a local admin view and
as the reference for a future backend API.

### The two-layer flow

```
PDFs (local, private) → pipeline → SQLite → export-static → site/content/ (private)
                                                        └─ site/content_sample/ (committed)
site/_site ← build_site.py  →  GitHub Actions → GitHub Pages (public)
```

Only what you deliberately publish leaves your machine. The pipeline and the
frontend are fully decoupled — GitHub Actions never touches PDFs or the
database.

---

## Configuration (no code changes needed)

All of this lives in `config/` and is re-read on every run:

| File | What it controls |
|---|---|
| `subjects.yaml` | subjects, courses, and filename aliases (`2U` → Mathematics Advanced) |
| `topics.yaml` | per-course topic/subtopic taxonomy + classification keywords |
| `patterns.yaml` | question-start / section / subpart / answer-section regexes |
| `pipeline.yaml` | DPI, padding, OCR engine, difficulty weights, paths |

Overrides: `python -m pipeline process ... --config my_overrides.yaml`
(deep-merged), or environment variables `QB_RENDER_DPI=300`, `QB_OCR_ENGINE=tesseract`, etc.

Run `python -m pipeline init` after editing the taxonomy.

---

## OCR: what's needed, what's optional

OCR is **pluggable** (`pipeline/ocr/`). No API keys are required for anything
in this project.

| Engine | When it's used | Install |
|---|---|---|
| **Tesseract** (recommended) | real OCR of question crops; provides word positions for detection | `sudo apt install tesseract-ocr` (Debian/Ubuntu), `brew install tesseract` (macOS), or the [UB-Mannheim installer](https://github.com/UB-Mannheim/tesseract/wiki) (Windows) |
| **Embedded text layer** (built-in fallback) | used automatically when tesseract isn't installed, or for papers whose fonts embed correct unicode | none |
| Custom engine | implement `pipeline/ocr/base.py::BaseOCREngine`, register in `pipeline/ocr/__init__.py` | — |

The pipeline auto-selects: tesseract if available, otherwise the embedded-text
fallback. Force with `QB_OCR_ENGINE=tesseract` or `...=embedded`.

> **Important:** if a paper's embedded text layer is corrupt (custom math
> fonts), the pipeline still detects questions correctly (it uses *positions*,
> not glyph text) and the question images are perfect — but OCR text for those
> papers will be noisy. That's expected and acceptable: **the image is the
> question**. Such papers are flagged for review so you can correct the search
> text manually if you want.

### Where do API keys go?

Nowhere — there are none. If you later plug in a hosted OCR/LLM classifier,
keep the key in an environment variable (e.g. `OPENAI_API_KEY`) or a
git-ignored `.env`; the repo contains no secrets.

---

## Human review workflow

Extraction and classification are automatic but not perfect. The system never
pretends otherwise:

1. Every question records `extraction_confidence` and `classification_confidence`.
2. Questions below threshold, or flagged (multi-page continuation, no text
   layer, non-sequential numbering, unknown topic, whole-page fallback), go to
   the review queue.
3. **Fastest: the admin review UI** — `python -m pipeline serve` then open
   `http://localhost:8000/admin/review`. One screen shows the question image
   beside editable metadata, OCR and classification, with keyboard shortcuts
   (`n`/`p` next/prev, `a` approve & next, `s` save, `1`–`5` difficulty,
   `q` number, `e` answer).
4. **CLI alternative** — `python -m pipeline review --list` shows the queue;
   `python -m pipeline review` walks it interactively. Non-interactive batch
   correction: `python -m pipeline review --id <id> --set difficulty=3 --set
   "review_notes=checked against source"`.
5. Corrections are written back permanently (`reviewed=1`, `reviewed_by`,
   `review_notes`), and the search index is updated.

## Validation & data quality

Before content is published it passes two gates (details in `docs/QUALITY.md`):

- `python -m pipeline validate` — the validation suite processes a diverse
  set of papers (7 built-in synthetic papers covering clean, broken-font,
  scanned, physics/chemistry, diagram-heavy, multi-page and no-solutions
  PDFs — or any directory of your real PDFs with `--input`) into an isolated
  database and writes `data/exports/validation-report.md` reporting detection
  accuracy, segmentation confidence, images, OCR availability, classification
  confidence, review requirements and failures.
- `python -m pipeline quality-check` — audits the database for duplicate
  questions, missing/corrupt images, bad page references, empty OCR,
  impossible metadata, missing answers, broken solution links and question
  ordering. It runs automatically at the start of every static export, and
  `scripts/build_site.py` refuses to build content that has quality errors.

---

## Database

SQLite at `data/questionbank.db` (WAL mode), schema in `pipeline/database.py`.

Core tables: `subjects`, `courses`, `topics`, `subtopics`, `papers`, `pages`,
`questions`, `answers`, `solutions`, `user_marks`, plus the FTS5 table
`questions_fts` backing search.

Question IDs are stable and human-readable:
`trialmaths-2023-mathematics-advanced-<sha8>-q6`.

See [docs/DATABASE.md](docs/DATABASE.md) for the full schema and field
documentation.

---

## Development

```bash
pip install -e ".[dev]"     # or: pip install -r requirements.txt pytest
npm install                 # jsdom (frontend smoke tests)
pytest                      # 66 tests: config, DB, detector, OCR, classifier,
                            # uploads, validation, review UI, static export,
                            # site build, DOM smoke
```

The test suite covers:

- pipeline E2E (`tests/test_process.py`) — synthetic TrialMaths-style PDF →
  13 questions, MCQ/subpart/marks metadata, multi-page stitched image,
  answers + solution crops, topic classification, FTS search.
- uploads & moderation (`tests/test_uploads.py`) — hash dedupe, size and
  magic-byte abuse checks, register → approve → premium grant,
  reject/duplicate statuses.
- validation (`tests/test_validate.py`) — quality audit catches planted
  issues (bad marks/difficulty/page refs/missing images/duplicate images),
  and the full 7-paper suite runs with sane metrics.
- review UI (`tests/test_review_web.py`) — Flask admin review pages render,
  saves persist, invalid input is rejected.
- static export (`tests/test_export_static.py`) — structure, privacy
  (no filenames/OCR in public records), WebP/JPEG/PNG image variants,
  facet-token search index, lookup round-trip, upload hash list.
- site build (`tests/test_site_build.py`) — assembly, quality gate, sitemap,
  cache busting, relative-path safety for GitHub Pages subpaths, JS syntax
  (`node --check`), and the **real search module executed under node against
  real content**.
- DOM smoke (`tests/test_dom_smoke.py` + `scripts/dom_smoke.js`) — loads the
  actual frontend in jsdom and drives search, filters, empty states, question
  pages, favourites, practice MCQ answering, progress analytics, onboarding,
  the upload flow (ack → magic bytes → size → hash → dedupe → queue),
  duplicate flagging, login and 404s.

### Project layout

```
config/            taxonomy + patterns + pipeline settings (YAML)
pipeline/          ingestion → render → detect → crop → OCR → classify → DB
                   + uploads (moderation/premium) + export_static (site content)
web/               Flask app (local admin view / future backend API)
site/              static student-facing website (GitHub Pages)
  content_sample/    committed synthetic demo content
  assets/js/         api, search, store, auth, practice, pages (vanilla JS SPA)
  backend/supabase.sql  optional accounts/uploads backend schema
scripts/           sample-PDF generator, build_site, serve_site, dom_smoke, reset
tests/             unit + integration + build + DOM smoke tests
data/              PDFs in, everything generated stays here (git-ignored)
docs/              architecture, database, pipeline, deploy, auth
.github/workflows/ pages.yml — test → build → deploy to GitHub Pages
```

---

## Scaling to ~2,000 PDFs

The batch mode was built for it:

```bash
python -m pipeline process data/papers/
```

- Processes every PDF found recursively; each PDF is isolated (one failure
  doesn't stop the batch, errors are logged to the DB).
- Skips already-processed files (sha256) — kill it any time and re-run to
  resume.
- `--limit N` / `--pattern "*trial*"` for staged runs; `--force` to redo.
- The first milestone is always the same: **one PDF → inspect its question
  images → then scale**. Start with `TrialMaths_2023_2U_wsols.pdf`.

The website side scales because the export is **incremental and lazy**: only
new/changed papers re-export, question records are sharded (2000/shard),
images are compressed to web JPEGs + thumbnails, and the browser downloads
only the shards it needs. See `docs/ARCHITECTURE.md` for the indexing design
and the point where a backend search API would take over at 100k+ questions.

---

## License

MIT (see `LICENSE`). The repository intentionally contains no copyrighted
exam content; your PDFs stay outside version control.
