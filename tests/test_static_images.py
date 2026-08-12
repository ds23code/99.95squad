"""Image-integrity tests.

Every image referenced by exported question JSON must:
1. exist inside the built ``_site`` (content/...)
2. map to the public URL the frontend emits (content/<ref>)
3. be served over HTTP with 200 + an image content-type (no 404s)

Covered question kinds: normal, equation-heavy, graph/diagram, multi-page
(stitched) and zoom-original PNG.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SITE = REPO_ROOT / "site"

IMAGE_KEYS = (
    "image", "image_fallback", "thumb", "thumb_fallback", "image_zoom",
    "solution_image", "solution_image_fallback",
)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    from scripts.build_site import build

    out = tmp_path_factory.mktemp("img") / "_site"
    build(out, force=True)
    return out


def _all_image_refs(content_dir: Path) -> list[tuple[str, str, str]]:
    refs: list[tuple[str, str, str]] = []
    for shard in (content_dir / "questions").glob("*/shard-*.json"):
        records = json.loads(shard.read_text(encoding="utf-8"))
        for rec in records:
            for key in IMAGE_KEYS:
                value = rec.get(key)
                if value:
                    refs.append((rec["id"], key, value))
    return refs


def test_every_referenced_image_exists_in_site(built):
    missing = [
        (rid, key, ref)
        for rid, key, ref in _all_image_refs(built / "content")
        if not (built / "content" / ref).exists()
    ]
    assert not missing, f"{len(missing)} referenced images missing from _site: {missing[:5]}"


def test_image_refs_are_public_relative_urls_not_fs_paths(built):
    """JSON must contain public URLs (content-relative), never local paths."""
    for rid, key, ref in _all_image_refs(built / "content"):
        assert ref.startswith("images/"), f"{rid} {key}: {ref!r} not under images/"
        assert not ref.startswith(("/", "C:", "D:")), f"{rid} {key}: absolute path {ref!r}"
        assert "data/" not in ref.split("/", 2)[0], f"{rid} {key}: data/ leak {ref!r}"
        # the frontend resolver prefixes the content base exactly once
        assert "content/" + ref == "content/" + ref
        assert ref.count("..") == 0


def test_no_absolute_fs_paths_in_any_built_json(built):
    import re

    bad = []
    for json_file in (built / "content").rglob("*.json"):
        text = json_file.read_text(encoding="utf-8")
        if re.search(r'"(/home/|/Users/|C:\\|/tmp/|data/(papers|questionbank))', text):
            bad.append(str(json_file.relative_to(built)))
    assert not bad, f"absolute/local paths leaked into built JSON: {bad[:5]}"


def test_specific_question_kinds(built):
    shard = json.loads(
        (built / "content" / "questions" / "mathematics-advanced" / "shard-0.json").read_text()
    )
    by_qnum = {r["qnum"]: r for r in shard}

    # normal MCQ (q1), equation-heavy integration (q6), graph/diagram (q2),
    # multi-page stitched (q8)
    for qnum in ("1", "2", "6", "8"):
        rec = by_qnum[qnum]
        for key in ("image", "image_fallback", "thumb", "thumb_fallback", "image_zoom"):
            ref = rec[key]
            assert (built / "content" / ref).exists(), f"q{qnum} {key} missing: {ref}"

    # zoom originals are lossless PNGs (canonical image, full resolution)
    q1 = by_qnum["1"]
    assert q1["image_zoom"].endswith(".png")
    assert q1["image"].endswith(".webp")
    assert q1["image_fallback"].endswith(".jpg")

    # multi-page question: the zoom PNG is the tall stitched image
    q8 = by_qnum["8"]
    assert q8["pages"][0] != q8["pages"][1], "q8 should span pages"
    from PIL import Image

    with Image.open(built / "content" / q8["image_zoom"]) as im:
        assert im.height > im.width * 1.2, "multi-page image should be stitched/tall"

    # equation-heavy question crop is non-trivial (has ink, not blank)
    q6 = by_qnum["6"]
    with Image.open(built / "content" / q6["image"]) as im:
        assert im.width >= 1000, "question images should be high resolution"


def _serve(built):
    import functools
    import http.server

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(built))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}/"


def test_all_images_serve_over_http_200(built):
    """Real network fetch of every image URL the frontend emits — no 404s."""
    import urllib.error
    import urllib.request

    server, base = _serve(built)
    try:
        refs = _all_image_refs(built / "content")
        assert refs, "no image refs found"
        for rid, key, ref in refs:
            url = base + "content/" + ref
            try:
                with urllib.request.urlopen(url, timeout=15) as resp:
                    assert resp.status == 200, f"{key} {ref} -> {resp.status}"
                    ctype = resp.headers.get_content_type()
                    assert ctype.startswith("image/"), f"{key} {ref} -> {ctype}"
            except urllib.error.HTTPError as exc:
                pytest.fail(f"HTTP {exc.code} for {key} {ref} ({url})")
            except urllib.error.URLError as exc:
                pytest.fail(f"fetch failed for {key} {ref}: {exc}")
    finally:
        server.shutdown()
