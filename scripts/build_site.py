#!/usr/bin/env python3
"""99.95squad — static site build.

Assembles the deployable GitHub Pages site into ``site/_site/``:

    python scripts/build_site.py          # uses site/content if present, else site/content_sample
    python scripts/build_site.py --content ../data/site-content
    python scripts/build_site.py --out ../dist

The build does NOT run the pipeline: it packages the already-exported content
tree (site/content or site/content_sample) with the frontend, validates it,
and generates sitemap.xml + robots.txt. Nothing private ever enters this step.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"


def build(out_dir: str | Path, content_dir: str | Path | None = None, force: bool = True,
          allow_quality_errors: bool = False) -> dict:
    out_dir = Path(out_dir)
    source = "custom"
    if content_dir is None:
        content_dir = SITE / "content"
        source = "full"
        if not content_dir.exists():
            content_dir = SITE / "content_sample"
            source = "sample"
    content_dir = Path(content_dir)
    if not content_dir.exists():
        raise FileNotFoundError(f"content directory not found: {content_dir}")

    if out_dir.exists():
        if force:
            shutil.rmtree(out_dir)
        else:
            raise FileExistsError(f"output exists (use --force): {out_dir}")
    out_dir.mkdir(parents=True)

    # --- frontend sources ---------------------------------------------------
    for name in ("index.html", "404.html", "config.js", "assets"):
        src = SITE / name
        if src.exists():
            if src.is_dir():
                shutil.copytree(src, out_dir / name)
            else:
                shutil.copy2(src, out_dir / name)

    # --- content -------------------------------------------------------------
    shutil.copytree(content_dir, out_dir / "content")

    # --- validation ----------------------------------------------------------
    errors: list[str] = []
    manifest_path = out_dir / "content" / "manifest.json"
    if not manifest_path.exists():
        errors.append("content/manifest.json missing")
    else:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        lookup_path = out_dir / "content" / "questions" / "lookup.json"
        if lookup_path.exists():
            lookup = json.loads(lookup_path.read_text(encoding="utf-8"))
            if len(lookup) != manifest.get("counts", {}).get("questions"):
                errors.append(
                    f"lookup count ({len(lookup)}) != manifest questions ({manifest['counts']['questions']})"
                )
            # spot-check that a sample of referenced images exist
            checked = 0
            for course_dir in (out_dir / "content" / "questions").iterdir():
                if not course_dir.is_dir() or course_dir.name == "lookup.json":
                    continue
                for shard in course_dir.glob("shard-*.json"):
                    records = json.loads(shard.read_text(encoding="utf-8"))
                    for rec in records[:5]:
                        for key in ("image", "image_fallback", "thumb", "thumb_fallback",
                                    "solution_image", "solution_image_fallback", "image_zoom"):
                            ref = rec.get(key)
                            if ref and not (out_dir / "content" / ref).exists():
                                errors.append(f"missing image {ref} (referenced by {rec['id']})")
                        checked += 1
                    if checked > 200:
                        break
                if checked > 200:
                    break
        else:
            errors.append("content/questions/lookup.json missing")

        # ---- data-quality gate ---------------------------------------------
        quality = manifest.get("quality") or {}
        if quality.get("errors") and not allow_quality_errors:
            errors.append(
                f"content failed data-quality audit: {quality['errors']} errors, "
                f"{quality.get('warnings', 0)} warnings "
                f"(run `python -m pipeline quality-check` to inspect; "
                f"use --allow-quality-errors to override)"
            )

    # --- cache busting -------------------------------------------------------
    # Stamp a content-derived build id onto frontend asset URLs so deployed
    # assets never serve stale cached copies after a content update.
    import hashlib as _hashlib

    build_id = ""
    try:
        build_id = _hashlib.sha256(manifest_path.read_bytes()).hexdigest()[:10]
    except Exception:  # pragma: no cover
        pass
    for page in ("index.html", "404.html"):
        page_path = out_dir / page
        if not page_path.exists():
            continue
        html = page_path.read_text(encoding="utf-8")
        if build_id:
            html = re.sub(
                r'(src|href)="(assets/[^"]+)"',
                r'\1="\2?v=' + build_id + '"',
                html,
            )
        page_path.write_text(html, encoding="utf-8")

    # --- sitemap & robots ----------------------------------------------------
    # The public site lives under a GitHub Pages subpath
    # (https://USERNAME.github.io/99.95squad/), NOT the domain root. This is
    # only used for sitemap/robots URLs; the app itself is fully relative.
    base_url = (os.environ.get("QB_SITE_URL") or "").strip() or "https://99-95squad.github.io/99.95squad/"
    if not base_url.endswith("/"):
        base_url += "/"
    urls = [
        "", "browse", "practice", "saved", "progress", "upload", "dashboard", "login",
        "onboarding",
    ]
    if lookup_path.exists():
        try:
            lookup = json.loads(lookup_path.read_text(encoding="utf-8"))
            for qid in list(lookup)[:20000]:
                urls.append(f"#/question/{qid}")
        except Exception:  # pragma: no cover
            pass
    sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    for u in urls:
        sitemap += f"  <url><loc>{base_url}{u}</loc></url>\n"
    sitemap += "</urlset>\n"
    (out_dir / "sitemap.xml").write_text(sitemap, encoding="utf-8")
    (out_dir / "robots.txt").write_text(
        "User-agent: *\nAllow: /\nSitemap: " + base_url + "sitemap.xml\n",
        encoding="utf-8",
    )

    if errors:
        raise RuntimeError("site build failed:\n  " + "\n  ".join(errors))

    counts = manifest.get("counts", {})
    return {"out": str(out_dir), "source": source, "counts": counts, "build_id": build_id}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the 99.95squad static site")
    parser.add_argument("--out", default=str(SITE / "_site"))
    parser.add_argument("--content", default=None, help="content tree (default: site/content or site/content_sample)")
    parser.add_argument("--no-force", action="store_true")
    parser.add_argument("--allow-quality-errors", action="store_true",
                        help="publish even if the data-quality audit found errors")
    args = parser.parse_args(argv)
    try:
        info = build(args.out, args.content, force=not args.no_force,
                     allow_quality_errors=args.allow_quality_errors)
    except (FileNotFoundError, FileExistsError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    c = info["counts"]
    print(f"built {info['out']} (source: {info['source']})")
    print(f"  questions: {c.get('questions', 0)}  papers: {c.get('papers', 0)}  topics: {c.get('topics', 0)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
