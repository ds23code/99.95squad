# Data quality & validation

A bad question in a 100,000-question bank is worse than a missing question.
Two gates protect published content:

## 1. Pipeline validation suite (`python -m pipeline validate`)

Processes a set of papers into an *isolated* database and produces a report
(`data/exports/validation-report.md` + `.json`) covering, per paper:

- questions detected vs expected (accuracy)
- segmentation (extraction) confidence
- images generated
- OCR availability + engine + confidence
- classification confidence + topic coverage
- multi-page questions detected
- questions requiring review
- failures (a paper failure never aborts the suite)

The built-in suite ships 7 diverse *synthetic* papers that exercise the
real-world failure modes:

| Paper | Tests |
|---|---|
| DigitalMaths_Clean | clean embedded text layer |
| BrokenFont_Maths | Symbol-font math: renders π/θ correctly, extracts garbage — proves detection uses positions and the image stays canonical |
| Scanned_Physics | image-only pages (no text layer) — graceful whole-page fallback, flagged for review; segmented properly once tesseract is installed |
| Chemistry_Trial | chemistry topics + classification |
| DiagramHeavy_Maths | diagrams on every question |
| MultiPage_Maths | two questions spanning pages |
| NoSolutions_Maths | paper with no answers section |

Run the same command against your real papers:

```bash
python -m pipeline validate                        # built-in suite
python -m pipeline validate --input /path/to/real/pdfs --report data/exports/my-report.md
```

Current built-in suite result: **7/7 papers, 100% detection accuracy on all
text-layer papers, 0 quality errors, 7 questions flagged for review** (5
broken-font OCR + 2 scanned pages) — exactly the honest behaviour expected.

## 2. Data-quality audit (`python -m pipeline quality-check`)

Audits the database for:

- **duplicate questions** — identical question images shared by multiple ids
- **missing / corrupt images** — file absent or unreadable
- **incorrect page references** — page_end < page_start or beyond paper length
- **empty / low-confidence OCR**
- **impossible metadata** — marks < 0 or > 100, difficulty outside 1–5,
  unknown course/topic/subtopic ids, subtopic not under its topic
- **missing answers** — MCQ without a recorded answer
- **broken solution links** — solution image missing/corrupt
- **question ordering** — numbers out of order with pages, gaps

Each issue is `error` or `warn` with the question id. The audit runs
automatically at the start of every static export and its summary lands in
`content/manifest.json`; `scripts/build_site.py` **fails the build** when
quality errors exist (override with `--allow-quality-errors` only when you
know what you're doing).

```bash
python -m pipeline quality-check --out data/exports/quality.json
```

## Review workflow (fixing what automation flagged)

Three surfaces, same persisted corrections:

1. **Flask admin UI (fastest)** — `python -m pipeline serve`, then
   `http://localhost:8000/admin/review`. One screen shows the question image
   next to editable metadata (number, marks, difficulty, type, answer,
   section, course, topic, subtopic, year level), OCR text and classification
   summary. Keyboard shortcuts: `n`/`p` next/prev, `a` approve & next,
   `s` save, `1`–`5` difficulty, `q` number, `e` answer, `m` marks, `d`
   difficulty focus.
2. **CLI** — `python -m pipeline review [--list|--id <id>]`; non-interactive:
   `python -m pipeline review --id <id> --set difficulty=3 --set marks=2`.
3. **Static site** — `#/admin` is the moderator view for student uploads;
   question review stays operator-side (or moves to the backend API later).

Corrections are permanent: `reviewed=1`, `reviewed_by`, `review_notes` are
recorded, and the FTS/search index is refreshed from the corrected fields.
