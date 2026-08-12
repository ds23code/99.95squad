"""Static site build tests: assembly, validation, JS syntax, search logic."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SITE = REPO_ROOT / "site"

pytestmark = pytest.mark.skipif(not (SITE / "content_sample").exists(),
                                reason="site/content_sample not generated")


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    from scripts.build_site import build

    out = tmp_path_factory.mktemp("site") / "_site"
    # no explicit content dir: uses site/content if present else site/content_sample
    info = build(out, force=True)
    return out, info


def test_build_output_structure(built):
    out, info = built
    assert (out / "index.html").exists()
    assert (out / "404.html").exists()
    assert (out / "config.js").exists()
    assert (out / "assets" / "css" / "app.css").exists()
    assert (out / "content" / "manifest.json").exists()
    assert (out / "sitemap.xml").exists()
    assert (out / "robots.txt").exists()
    assert info["source"] in ("sample", "full")
    assert info["counts"]["questions"] >= 13


def test_build_validation_passes(built):
    out, _ = built
    manifest = json.loads((out / "content" / "manifest.json").read_text(encoding="utf-8"))
    lookup = json.loads((out / "content" / "questions" / "lookup.json").read_text(encoding="utf-8"))
    assert len(lookup) == manifest["counts"]["questions"]


def test_index_html_has_viewport_and_meta(built):
    out, _ = built
    html = (out / "index.html").read_text(encoding="utf-8")
    assert 'name="viewport"' in html
    assert 'name="description"' in html
    assert "assets/css/app.css" in html
    # all asset references are relative (works under a GitHub Pages subpath)
    import re

    refs = re.findall(r'(?:src|href)="([^"]+)"', html)
    for ref in refs:
        if ref.startswith(("http", "#", "mailto:")):
            continue
        assert not ref.startswith("/"), f"absolute path would break on Pages: {ref}"


def test_cache_busting(built):
    out, info = built
    html = (out / "index.html").read_text(encoding="utf-8")
    assert "?v=" in html, "asset URLs must carry a cache-busting version"
    assert info.get("build_id"), "build must return a build id"
    # the version is content-derived: same content -> same id
    from scripts.build_site import build as build_fn

    rebuilt = build_fn(out, force=True)
    assert rebuilt["build_id"] == info["build_id"]


def test_css_has_mobile_media_query(built):
    out, _ = built
    css = (out / "assets" / "css" / "app.css").read_text(encoding="utf-8")
    assert "@media (max-width: 860px)" in css
    assert "@media (max-width: 720px)" in css


def test_no_private_data_in_built_content(built):
    out, _ = built
    papers = json.loads((out / "content" / "meta" / "papers.json").read_text(encoding="utf-8"))
    for p in papers:
        assert "filename" not in p and "file_path" not in p


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_js_syntax(built):
    out, _ = built
    for js in sorted((out / "assets" / "js").glob("*.js")):
        result = subprocess.run(["node", "--check", str(js)], capture_output=True, text=True)
        assert result.returncode == 0, f"node --check failed for {js.name}:\n{result.stderr}"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_search_logic_in_node(built):
    """Exercise the real client search module under node against real content."""
    out, _ = built
    content = out / "content"
    shard = json.loads((content / "questions" / "mathematics-advanced" / "shard-0.json").read_text())
    idx_d = json.loads((content / "index" / "mathematics-advanced" / "d.json").read_text())
    idx_n = json.loads((content / "index" / "mathematics-advanced" / "n.json").read_text())

    script = """
    const search = require(process.argv[1]);
    const shard = JSON.parse(process.argv[2]);
    const idx = JSON.parse(process.argv[3]);
    const idxn = JSON.parse(process.argv[4]);

    // tokenizer mirrors Python
    const toks = search.tokenize("normal distribution curve");
    if (!toks.includes("normal") || !toks.includes("distribution")) throw new Error("tokenize failed: " + toks);

    // intersection over postings from different shard files
    const byNum = {};
    shard.forEach(r => { byNum[r.qnum] = r.id; });
    const ids = search.intersect([idx["distribution"] || [], idxn["normal"] || []]);
    if (!ids.includes(byNum["3"])) throw new Error("q3 not found via intersection: " + ids);

    // filters
    const rec = shard.find(r => r.qnum === "3");
    if (!search.matchesFilters(rec, { difficulty_min: 1, qtype: "multiple_choice" })) throw new Error("filter false negative");
    if (search.matchesFilters(rec, { course: "physics" })) throw new Error("filter false positive");

    // pagination
    const pg = search.page(shard, 2, 5);
    if (pg.items.length !== 5 || pg.total !== shard.length) throw new Error("pagination wrong");

    console.log("search-logic OK");
    """
    result = subprocess.run(
        ["node", "-e", script, str(SITE / "assets" / "js" / "search.js"),
         json.dumps(shard), json.dumps(idx_d), json.dumps(idx_n)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "search-logic OK" in result.stdout


def test_full_export_builds(built, exported):
    """A full (non-sample) export must also assemble cleanly."""
    from scripts.build_site import build

    content_dir, _ = exported
    out = content_dir.parent / "site-out"
    info = build(out, content_dir=content_dir, force=True)
    assert info["counts"]["questions"] >= 13
    assert (out / "sitemap.xml").exists()


def test_build_rejects_missing_content(tmp_path):
    from scripts.build_site import build

    with pytest.raises(FileNotFoundError):
        build(tmp_path / "out", content_dir=tmp_path / "nope")
