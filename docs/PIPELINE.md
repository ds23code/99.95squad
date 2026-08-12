# Pipeline guide

This document explains how to run and tune the pipeline, and what is
automatic versus what expects a human.

## Running

```bash
# single paper (the first milestone)
python -m pipeline process data/papers/TrialMaths_2023_2U_wsols.pdf

# whole directory (recursive), resumable
python -m pipeline process data/papers/

# staged runs
python -m pipeline process data/papers/ --limit 20 --pattern "*2023*"
```

Every PDF goes through: register (sha256) → render → detect → crop → OCR →
classify → answers/solutions → DB. Progress is persisted in `papers.status`;
interrupted batches resume where they stopped. `--force` reprocesses.

## Outputs you should inspect

After processing one paper:

```
data/questions/<course>/<year>/<source>/
    q01.png            canonical question image (200 dpi crop)
    q01_answer.png     answer-section crop (if short answer found)
    q01_solution.png   worked-solution crop (if present)
```

Open a few `qNN.png` files and compare them with the PDF:
- the full question (text + diagram + options) is inside the crop;
- nothing from the neighbouring question leaks in;
- multi-page questions (e.g. `q08.png` here) are a single tall image with a
  separator line.

If crops are off, tune `config/pipeline.yaml`:

| knob | effect |
|---|---|
| `render.dpi` | resolution of question images (higher = crisper, slower) |
| `detect.padding_points` | extra margin around each crop |
| `detect.min_text_chars` | below this, the page is OCR'd for layout |
| `detect.column_gap_fraction` | sensitivity of two-column detection |
| `detect.whole_page_fallback` | whole-page "?" regions when nothing detects |

## What is automatic

- page rendering, boundary detection, cropping, stitching
- OCR + cleanup, FTS indexing
- course detection from filename (aliases in `config/subjects.yaml`)
- topic/subtopic classification (keywords in `config/topics.yaml`)
- difficulty 1–5 with a stored reasoning string
- question type (MCQ / short / extended)
- marks, subparts, sections
- answer-section detection; short answers matched to questions
- solutions cropping; paper-level fallback for unmatched blocks
- dedupe, resume, error isolation, stats, exports

## What expects a human

- **Review queue**: `python -m pipeline review --list` then
  `python -m pipeline review`. Correct boundaries/crops (by re-cropping via
  `page_start`/`y` edits), course/topic/difficulty, answer text, OCR text.
  Corrections are permanent.
- **Papers the detector couldn't parse** (no usable text layer and no OCR
  binary): whole pages become single `?` questions flagged
  `whole-page-fallback` — split them manually or install tesseract and
  reprocess with `--force`.
- **Organisation names** it doesn't recognise stay `null` — set them during
  review or add filename patterns.

## Tuning classification

- Topics are keyword substring matches. Add keywords to
  `config/topics.yaml` (e.g. a subtopic that keeps being missed), then
  `python -m pipeline init` (re-seeds) and `--force` the affected paper.
- Difficulty weights live under `difficulty:` in `config/pipeline.yaml`.
- Everything the classifier is unsure about is stored as `null` — check the
  review queue rather than trusting low-confidence metadata.

## Validation & publishing gates

Before publishing content, run:

```bash
python -m pipeline validate          # 7-paper diversity suite -> data/exports/validation-report.md
python -m pipeline quality-check     # audit current DB (duplicates, images, pages, OCR, metadata,
                                     # answers, solution links, ordering)
python -m pipeline export-static --out site/content   # runs the audit again, records it in the manifest
python scripts/build_site.py         # fails the build on quality errors
```

Details in docs/QUALITY.md. Questions flagged during processing (low
extraction confidence, corrupted OCR, whole-page fallbacks) land in the
review queue; clear them with the admin UI (`python -m pipeline serve` →
`/admin/review`) or the CLI.

## Scaling notes

- Rendering at 200 dpi is the slowest stage; raise/lower per paper with
  `--config` files if needed.
- Each paper runs in its own transaction; the WAL database tolerates
  long-running batches.
- Question images are grouped by `<course>/<year>/<source>/` so the tree stays
  browsable at thousands of questions.
