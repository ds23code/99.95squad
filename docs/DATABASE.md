# Database

SQLite database at `data/questionbank.db` (WAL mode). Schema is created by
`pipeline/database.py::SCHEMA` and managed entirely by the pipeline — no
external migrations needed (schema changes use idempotent `CREATE TABLE IF
NOT EXISTS` + `INSERT OR IGNORE` seeding).

## Entity relationship

```
subjects 1───n courses 1───n topics 1───n subtopics
papers   1───n pages
papers   1───n questions n───1 courses/topics/subtopics
questions 1───n answers          (short answers like "C", "0.025")
questions 1───n solutions        (worked-solution images)
questions 1───n user_marks       (favourite | completed)
questions_fts  (FTS5 index over questions + paper metadata)
```

## Tables

### subjects / courses / topics / subtopics
Seeded from `config/subjects.yaml` + `config/topics.yaml` by
`python -m pipeline init`. Topic ids are namespaced:
`<course_id>:<topic_id>` and `<course_id>:<topic_id>:<subtopic_id>`.

### papers
| column | meaning |
|---|---|
| `id` | stable slug id for new papers: `<org>-<year>-<course>-<sha16>`; existing full-SHA matches retain legacy IDs |
| `sha256` | unique — dedupe & resume key |
| `display_name`, `organisation`, `year`, `paper_type` | parsed from filename |
| `subject_id`, `course_id`, `year_level` | metadata (may be null) |
| `has_solutions` | whether answers/solutions were found |
| `status` | `pending` → `processing` → `complete` \| `error` |
| `error` | last error message (truncated) |

### pages
One row per rendered page: `paper_id`, `page_number`, `image_path`, size.

### questions
| column | meaning |
|---|---|
| `id` | stable: `<paper_id>-q<number>`; repeated printed numbers append `--occurrence-N` |
| `question_number`, `question_occurrence`, `section`, `marks`, `subparts` | extraction results and occurrence identity |
| `page_start`, `page_end` | 1-based pages (multi-page questions: start≠end) |
| `image_path`, `image_width/height` | **the canonical question image** |
| `ocr_raw`, `ocr_clean`, `ocr_engine`, `ocr_confidence` | search text (never authoritative) |
| `answer`, `answer_source` | short answer (`auto` / `review`) |
| `solution_image_path`, `solution_text` | worked solution |
| `subject_id`, `course_id`, `year_level`, `topic_id`, `subtopic_id` | classification |
| `difficulty`, `difficulty_reasoning` | 1–5 + why |
| `question_type` | `multiple_choice` \| `short_answer` \| `extended_response` |
| `extraction_confidence`, `classification_confidence` | 0–1 |
| `status` | `new` \| `needs_review` \| `reviewed` |
| `review_flags` | JSON array of human-readable flags |
| `reviewed`, `reviewed_by`, `review_notes` | human review trail |

Logical identity is `UNIQUE(paper_id, question_number, question_occurrence)`.
Occurrences are assigned in deterministic detector order, so numbering can
restart within a section—even on the same page—without collisions. Reprocessing
updates the same logical rows. A migrated row may retain its historical primary
key; answer, solution, and FTS updates follow the persisted ID.

### answers / solutions
`question_id` may be null when an answer/solution block could not be matched to
a question (kept at paper level rather than lost). `answers.answer_text` holds
short answers ("C"); `solutions.image_path` points at the cropped worked
solution image.

### user_marks
`(question_id, kind)` where kind ∈ `favourite | completed`. No user accounts
yet — single-user marks; ready for a `user_id` column when auth is added.

### questions_fts (FTS5)
External-content-style FTS index over `ocr_clean` **plus** every metadata
field (course, topic, paper name, year, type…). Kept in sync by the DAO on
insert/update. Search queries are tokenized into quoted phrases AND-ed
together (`normal distribution` → `"normal" AND "distribution"`), so partial
OCR matches still work.

## Question ids

Human-readable and stable across reprocesses (as long as the file content is
unchanged):

```
trialmaths-2023-mathematics-advanced-bd1aa3de91f42c07-q6
└────────────────────┬────────────────────────────┘ └─┬─┘
       paper id (org-year-course-sha16)            printed number

trialmaths-2023-mathematics-advanced-bd1aa3de91f42c07-q6--occurrence-2
                                                                  └─────┬─────┘
                                                          repeated number
```

Paper IDs created by older versions can retain an eight-character digest; the
full SHA-256 lookup ensures those IDs stay stable when the same PDF is rerun.

## Reading the data

Use the DAO (`pipeline/database.py`) or plain sqlite3:

```bash
sqlite3 data/questionbank.db \
  "SELECT question_number, course_id, topic_id, difficulty, marks
   FROM questions LIMIT 10;"

sqlite3 data/questionbank.db \
  "SELECT question_id, snippet(questions_fts) FROM questions_fts
   WHERE questions_fts MATCH '\"normal\" AND \"distribution\"' LIMIT 5;"
```
