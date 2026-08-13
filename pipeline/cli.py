"""Command-line interface.

Commands::

    python -m pipeline init                    # create DB + seed taxonomy
    python -m pipeline process FILE_OR_DIR     # run the pipeline
    python -m pipeline review [--list|--id]    # human review workflow
    python -m pipeline export --format json|csv
    python -m pipeline stats
    python -m pipeline serve [--port N]        # run the website
    python -m pipeline sample                  # generate a synthetic test PDF
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .config import Config


def _setup_logging(level: int) -> None:
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def cmd_init(args: argparse.Namespace, config: Config) -> int:
    from .database import Database

    db = Database(config.paths["database"])
    db.init_schema()
    db.seed_taxonomy(config)
    # ensure data directories exist
    for key in ("papers_dir", "questions_dir", "pages_dir", "solutions_dir", "exports_dir"):
        Path(config.paths[key]).mkdir(parents=True, exist_ok=True)
    print(f"Initialised database at {config.paths['database']}")
    print("Seed taxonomy loaded from config/. Put your PDFs in "
          f"{config.paths['papers_dir']}")
    return 0


def cmd_process(args: argparse.Namespace, config: Config) -> int:
    from .process import PipelineError, process_directory, process_pdf

    target = Path(args.input)
    if not target.exists():
        print(f"error: {target} does not exist", file=sys.stderr)
        return 2
    if target.is_file():
        try:
            result = process_pdf(config, target, force=args.force)
            if result.get("skipped"):
                print(f"skipped (already processed): {target.name}")
            else:
                print(
                    f"processed {target.name}: {result['questions']} questions, "
                    f"{result['answers']} answers, {result['solutions']} solutions"
                )
        except PipelineError as exc:
            print(f"FAILED: {exc}", file=sys.stderr)
            return 1
        return 0

    result = process_directory(
        config,
        target,
        force=args.force,
        resume=not args.no_resume,
        limit=args.limit,
        pattern=args.pattern,
    )
    print(f"\nBatch complete: {len(result['ok'])} ok, "
          f"{len(result['skipped'])} skipped, {len(result['failed'])} failed")
    for fail in result["failed"]:
        print(f"  FAILED {Path(fail['file']).name}: {fail['error']}", file=sys.stderr)
    return 0 if not result["failed"] else 1


def cmd_import_dir(args: argparse.Namespace, config: Config) -> int:
    from .process import import_directory

    target = Path(args.directory)
    if not target.exists():
        print(f"error: {target} does not exist", file=sys.stderr)
        return 2

    counts = import_directory(
        config,
        target,
        force=args.force,
        resume=not args.no_resume,
        limit=args.limit,
        pattern=args.pattern,
        retry_failed=args.retry_failed,
    )
    print("Import directory summary:")
    print(f"  discovered:   {counts['discovered']}")
    print(f"  duplicates:   {counts['duplicates']}")
    print(f"  queued:       {counts['queued']}")
    print(f"  processing:   {counts['processing']}")
    print(f"  completed:    {counts['completed']}")
    print(f"  failed:       {counts['failed']}")
    print(f"  needs_review: {counts['needs_review']}")
    return 1 if counts["failed"] > 0 and counts["completed"] == 0 else 0


def cmd_review(args: argparse.Namespace, config: Config) -> int:
    from .database import Database
    from .review import apply_review, interactive_review, review_queue

    db = Database(config.paths["database"])
    db.init_schema()

    if args.list:
        queue = review_queue(db, limit=args.limit or 200)
        print(f"{len(queue)} question(s) awaiting review")
        for q in queue:
            print(
                f"{q['id']}  conf={q['extraction_confidence']:.2f}/"
                f"{q['classification_confidence']:.2f}  {q['image_path']}"
            )
        return 0

    if args.id:
        q = db.get_question(args.id)
        if not q:
            print(f"question not found: {args.id}", file=sys.stderr)
            return 1
        if q["reviewed"]:
            print(f"note: {args.id} already reviewed")
        if args.set:
            fields = {}
            for pair in args.set:
                if "=" not in pair:
                    print(f"invalid --set pair: {pair}", file=sys.stderr)
                    return 2
                key, value = pair.split("=", 1)
                fields[key] = value
            apply_review(db, args.id, fields, reviewed_by=args.reviewer)
            print(f"updated {args.id}")
        else:
            interactive_review(db, q)
        return 0

    # interactive queue
    queue = review_queue(db, limit=args.limit or 100)
    if not queue:
        print("review queue is empty 🎉")
        return 0
    print(f"{len(queue)} question(s) in the queue. Ctrl-C to stop.\n")
    saved = 0
    try:
        for q in queue:
            if interactive_review(db, q):
                saved += 1
    except KeyboardInterrupt:
        print("\ninterrupted")
    print(f"reviewed {saved} question(s)")
    return 0


def cmd_export(args: argparse.Namespace, config: Config) -> int:
    from .database import Database
    from .export import export_csv, export_json

    db = Database(config.paths["database"])
    db.init_schema()
    out_dir = Path(config.paths["exports_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    fmt = args.format or "json"
    if fmt == "json":
        out = export_json(db, args.out or out_dir / "questions.json")
    elif fmt == "csv":
        out = export_csv(db, args.out or out_dir / "questions.csv")
    else:
        print(f"unknown format {fmt}", file=sys.stderr)
        return 2
    print(f"exported to {out}")
    return 0


def cmd_stats(args: argparse.Namespace, config: Config) -> int:
    from .database import Database
    from .stats import report

    db = Database(config.paths["database"])
    db.init_schema()
    print(report(db))
    return 0


def cmd_serve(args: argparse.Namespace, config: Config) -> int:
    import os

    from web.app import create_app

    app = create_app(config)
    port = args.port or int(os.environ.get("PORT", 8000))
    print(f"QuestionBank website on http://0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=args.debug, threaded=True)
    return 0


def cmd_export_static(args: argparse.Namespace, config: Config) -> int:
    from .export_static import export_static

    out = Path(args.out)
    manifest = export_static(config, out, source=args.source, include_ocr=not args.no_ocr)
    print(
        f"static export written to {out}\n"
        f"  questions: {manifest['counts']['questions']}  papers: {manifest['counts']['papers']}\n"
        f"  topics: {manifest['counts']['topics']}  images: {manifest['counts']['images']}\n"
        f"  run `python scripts/build_site.py` to assemble the deployable site"
    )
    return 0


def cmd_sample_content(args: argparse.Namespace, config: Config) -> int:
    """Build the committed sample content (synthetic paper only) into a
    *separate* database so private papers never leak into the sample."""
    import tempfile
    import shutil

    from .config import Config as Cfg
    from .export_static import export_static
    from .process import process_pdf
    from scripts.make_sample_pdf import make_sample_pdf

    tmp = Path(tempfile.mkdtemp(prefix="qb-sample-"))
    try:
        # isolated config: separate data dir + database
        cfg = Config.load()
        data_dir = tmp / "data"
        cfg.raw["pipeline"]["paths"]["data_dir"] = str(data_dir)
        for key in ("papers_dir", "questions_dir", "pages_dir", "solutions_dir", "exports_dir"):
            cfg.raw["pipeline"]["paths"][key] = str(data_dir / Path(cfg.raw["pipeline"]["paths"][key]).name)
        cfg.raw["pipeline"]["paths"]["database"] = str(data_dir / "questionbank.db")
        for key in ("papers_dir", "questions_dir", "pages_dir", "solutions_dir", "exports_dir"):
            Path(cfg.raw["pipeline"]["paths"][key]).mkdir(parents=True, exist_ok=True)

        pdf = Path(cfg.raw["pipeline"]["paths"]["papers_dir"]) / "TrialMaths_2023_2U_wsols_sample.pdf"
        make_sample_pdf(pdf)
        result = process_pdf(cfg, pdf, force=True)
        out_dir = tmp / "content"
        export_static(cfg, out_dir, source="sample")
        # wipe the DB so only static content remains in the sample dir
        shutil.rmtree(data_dir / "questionbank.db", ignore_errors=True)
        for suffix in ("-wal", "-shm"):
            (Path(f"{cfg.raw['pipeline']['paths']['database']}{suffix}")).unlink(missing_ok=True)
        dest = Path(args.out)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(out_dir, dest)
        print(f"sample content written to {dest} ({result['questions']} questions)")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def cmd_uploads(args: argparse.Namespace, config: Config) -> int:
    from .uploads import (
        RemoteUploadError,
        SupabaseAdminClient,
        approve_upload,
        process_remote_upload,
        register_upload,
        set_upload_status,
    )

    action = args.action
    if action == "process-remote":
        if len(args.ids) != 1:
            print("process-remote requires exactly one submission UUID", file=sys.stderr)
            return 2
        try:
            client = SupabaseAdminClient.from_environment(session_file=args.session_file)
            if client.session_file is None:
                raise RemoteUploadError(
                    "--session-file or SUPABASE_SESSION_FILE is required so rotated credentials survive restarts"
                )
            if not client.refresh_token:
                raise RemoteUploadError(
                    "the Supabase session file must contain a refresh token"
                )
            result = process_remote_upload(
                config,
                args.ids[0],
                client,
                export_out=args.export_out,
                max_bytes=args.max_bytes,
            )
        except Exception as exc:
            print(f"remote processing failed: {exc}", file=sys.stderr)
            return 1
        print(
            f"approved {result['submission_id']} -> paper {result['paper_id']} "
            f"({result['questions']} questions); validated export at {result['export_out']}"
        )
        return 0

    from .database import Database

    db = Database(config.paths["database"])
    db.init_schema()

    if action == "register":
        files = args.files if args.files is not None else args.ids
        for path in files:
            result = register_upload(config, path, uploader=args.uploader, db=db)
            if result["status"] == "new":
                print(f"queued {path} -> {result['upload']['id']} (pending)")
            elif result["status"] == "duplicate":
                kind = result.get("reason")
                detail = result.get("paper") or result.get("upload") or {}
                print(f"duplicate {path}: {kind} ({detail.get('id')})")
            else:
                print(f"error {path}: {result.get('reason')}")
        return 0

    if action == "approve":
        for upload_id in args.ids:
            try:
                result = approve_upload(config, upload_id, reviewer=args.reviewer, db=db)
                if result["status"] == "approved":
                    extra = f" premium until {result['premium_until']}" if result.get("premium_until") else ""
                    print(f"approved {upload_id} -> paper {result['paper_id']}{extra}")
                else:
                    print(f"{upload_id} -> {result['status']}: {result.get('reason')}")
            except ValueError as exc:
                print(f"{upload_id}: {exc}")
        return 0

    if action in ("reject", "duplicate", "needs_review", "pending", "processing"):
        for upload_id in args.ids:
            result = set_upload_status(
                config, upload_id, action, reviewer=args.reviewer, notes=args.notes
            )
            if "error" in result:
                print(f"{upload_id}: {result['error']}")
            else:
                print(f"{upload_id} -> {result['status']}")
        return 0

    if action == "list":
        status = args.status
        uploads = db.list_uploads(status=status)
        if not uploads:
            print("no uploads" + (f" with status {status}" if status else ""))
        for u in uploads:
            print(
                f"{u['id']:16} {u['status']:<10} {u['filename']:<40} "
                f"uploader={u['uploader']} premium={u['premium_granted']}"
            )
        return 0

    print(f"unknown action {action}", file=sys.stderr)
    return 2


def cmd_sample(args: argparse.Namespace, config: Config) -> int:
    from scripts.make_sample_pdf import make_sample_pdf

    out = Path(args.out)
    make_sample_pdf(out)
    print(f"sample PDF written to {out}")
    print(f"try: python -m pipeline process {out}")
    return 0


def cmd_validate(args: argparse.Namespace, config: Config) -> int:
    from .validate import run_validation_suite

    suite = run_validation_suite(
        config,
        papers_dir=args.input,
        report_path=args.report,
        force=True,
    )
    print(f"validation suite: {suite['papers_processed']} ok, {suite['papers_failed']} failed")
    for p in suite["papers"]:
        if p["ok"]:
            acc = f"{p['detection_accuracy']:.0%}" if p.get("detection_accuracy") is not None else "—"
            print(
                f"  {p['filename']:<42} q={p['detected_questions']:>2} "
                f"acc={acc:>4} ext={p['avg_extraction_confidence']} "
                f"cls={p['avg_classification_confidence']} review={p['needs_review']}"
            )
        else:
            print(f"  {p['filename']:<42} FAILED: {p.get('error', '')[:80]}")
    qc = suite["quality_check"]["summary"]
    print(
        f"\nquality: {qc['questions']} questions, {qc['errors']} errors, "
        f"{qc['warnings']} warnings"
    )
    print(f"report: {suite['report_path']}")
    return 0 if suite["papers_failed"] == 0 else 1


def cmd_quality_check(args: argparse.Namespace, config: Config) -> int:
    import json

    from .validate import quality_check

    result = quality_check(config)
    summary = result["summary"]
    print(f"quality check: {summary['questions']} questions, "
          f"{summary['errors']} errors, {summary['warnings']} warnings")
    if args.out:
        Path(args.out).write_text(
            json.dumps(result, indent=2, default=str), encoding="utf-8"
        )
        print(f"written to {args.out}")
    for issue in result["issues"][: args.limit or 40]:
        print(f"  [{issue['severity']:>5}] {issue['code']:<22} {issue['message'][:110]}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m pipeline",
        description="QuestionBank — image-first question bank for HSC papers",
    )
    parser.add_argument("--config", default=None, help="extra pipeline YAML config (deep-merged)")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init", help="create the database and seed taxonomy")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("process", help="process a PDF or a directory of PDFs")
    p.add_argument("input", help="path to a PDF file or a directory")
    p.add_argument("--force", action="store_true", help="reprocess even if already done")
    p.add_argument("--no-resume", action="store_true", help="do not skip complete papers")
    p.add_argument("--limit", type=int, default=None, help="process at most N PDFs")
    p.add_argument("--pattern", default=None, help="only files matching this glob")
    p.set_defaults(func=cmd_process)

    p = sub.add_parser("import-dir", help="robust batch import for existing PDFs")
    p.add_argument("directory", help="path to directory of PDFs")
    p.add_argument("--force", action="store_true", help="reprocess even if already done")
    p.add_argument("--no-resume", action="store_true", help="do not skip complete papers")
    p.add_argument("--limit", type=int, default=None, help="process at most N PDFs")
    p.add_argument("--pattern", default=None, help="only files matching this glob")
    p.add_argument("--retry-failed", action="store_true", help="retry previously failed papers")
    p.set_defaults(func=cmd_import_dir)

    p = sub.add_parser("review", help="human review workflow")
    p.add_argument("--list", action="store_true", help="print the review queue")
    p.add_argument("--id", default=None, help="review a specific question id")
    p.add_argument("--set", action="append", default=None, metavar="FIELD=VALUE",
                   help="non-interactively set fields (repeatable)")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--reviewer", default="cli", help="name to record as reviewer")
    p.set_defaults(func=cmd_review)

    p = sub.add_parser("export", help="export questions to JSON/CSV")
    p.add_argument("--format", choices=["json", "csv"], default="json")
    p.add_argument("--out", default=None, help="output file path")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("stats", help="pipeline statistics")
    p.set_defaults(func=cmd_stats)

    p = sub.add_parser("serve", help="run the website")
    p.add_argument("--port", type=int, default=None)
    p.add_argument("--debug", action="store_true")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("sample", help="generate a synthetic TrialMaths-style PDF")
    p.add_argument("--out", default=str(Path("data/papers/TrialMaths_2023_2U_wsols_sample.pdf")))
    p.set_defaults(func=cmd_sample)

    p = sub.add_parser("export-static", help="export the DB to a static content tree")
    p.add_argument("--out", default="site/content", help="output directory")
    p.add_argument("--source", default="full", choices=["full", "sample"])
    p.add_argument("--no-ocr", action="store_true", help="omit per-question OCR text files")
    p.set_defaults(func=cmd_export_static)

    p = sub.add_parser("sample-content", help="regenerate site/content_sample (synthetic paper only)")
    p.add_argument("--out", default="site/content_sample")
    p.set_defaults(func=cmd_sample_content)

    p = sub.add_parser("uploads", help="student upload moderation")
    p.add_argument(
        "action",
        choices=[
            "register", "list", "approve", "reject", "duplicate",
            "needs_review", "pending", "processing", "process-remote",
        ],
    )
    p.add_argument("ids", nargs="*", help="upload ids (for register: PDF paths)")
    p.add_argument("--files", nargs="*", default=None, help="PDF paths for register")
    p.add_argument("--uploader", default="local", help="uploader id (register)")
    p.add_argument("--reviewer", default="admin", help="reviewer name")
    p.add_argument("--status", default=None, help="filter for list")
    p.add_argument("--notes", default=None, help="review notes")
    p.add_argument(
        "--export-out", default="site/content",
        help="full static export destination after selected remote processing",
    )
    p.add_argument(
        "--max-bytes", type=int, default=None,
        help="override the configured private-PDF download limit",
    )
    p.add_argument(
        "--session-file", default=None,
        help=(
            "absolute mode-0600 JSON path for the rotating admin session "
            "(or set SUPABASE_SESSION_FILE)"
        ),
    )
    p.set_defaults(func=cmd_uploads)

    p = sub.add_parser("validate", help="run the validation suite (diverse papers -> report)")
    p.add_argument("--input", default=None, help="directory of real PDFs (default: built-in synthetic suite)")
    p.add_argument("--report", default=None, help="report path (default: data/exports/validation-report.md)")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("quality-check", help="audit the database for data-quality issues")
    p.add_argument("--out", default=None, help="write JSON report to this path")
    p.add_argument("--limit", type=int, default=40, help="max issues printed")
    p.set_defaults(func=cmd_quality_check)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _setup_logging(logging.DEBUG if args.verbose else logging.INFO)
    config = Config.load(extra_files=[args.config] if args.config else None)
    try:
        return args.func(args, config)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
