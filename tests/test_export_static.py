"""Static export tests: structure, privacy, index, lookup, images."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def test_structure(exported):
    out, manifest = exported
    assert manifest["counts"]["questions"] >= 13
    assert (out / "manifest.json").exists()
    for name in ("subjects", "courses", "topics", "papers", "facets"):
        assert (out / "meta" / f"{name}.json").exists(), name
    assert (out / "questions" / "lookup.json").exists()
    assert (out / "uploads" / "hashes.json").exists()
    assert (out / "index" / "mathematics-advanced" / "meta.json").exists()
    assert (out / "questions" / "mathematics-advanced" / "shard-0.json").exists()


def test_records_are_compact_and_public(exported):
    out, _ = exported
    records = _read(out / "questions" / "mathematics-advanced" / "shard-0.json")
    assert records
    for rec in records:
        # no OCR text in public records (served lazily from text/)
        assert "ocr_clean" not in rec
        assert rec["image"].endswith(".webp"), rec
        assert rec["image_fallback"].endswith(".jpg")
        assert rec["image_zoom"].endswith(".png")
        assert rec["thumb"].endswith(".webp")
        assert rec["thumb_fallback"].endswith(".jpg")
        assert rec["id"]
        assert rec["pages"] == [rec["pages"][0], rec["pages"][1]]


def test_facet_tokens_present(exported):
    """Filters-only queries must be answerable from the index."""
    out, _ = exported
    idx_c = _read(out / "index" / "mathematics-advanced" / "c.json")
    idx_t = _read(out / "index" / "mathematics-advanced" / "t.json")
    shard = _read(out / "questions" / "mathematics-advanced" / "shard-0.json")
    by_num = {r["qnum"]: r["id"] for r in shard}
    assert by_num["1"] in idx_c.get("c:mathematics-advanced", [])
    assert by_num["3"] in idx_t.get("t:mathematics-advanced:statistics", [])
    # type + year facets
    idx_q = _read(out / "index" / "mathematics-advanced" / "q.json")
    idx_y = _read(out / "index" / "mathematics-advanced" / "y.json")
    assert by_num["1"] in idx_q.get("q:multiple_choice", [])
    assert by_num["1"] in idx_y.get("y:2023", [])
    # difficulty facet (rounded)
    idx_d = _read(out / "index" / "mathematics-advanced" / "d.json")
    q13 = by_num["13"]
    assert q13 in idx_d.get(f"d:{int(round([r for r in shard if r['qnum']=='13'][0]['difficulty']))}", [])


def test_lookup_roundtrip(exported):
    out, _ = exported
    lookup = _read(out / "questions" / "lookup.json")
    shard = _read(out / "questions" / "mathematics-advanced" / "shard-0.json")
    assert len(lookup) >= len(shard)
    for rec in shard:
        ref = lookup[rec["id"]]
        assert ref[0] == "mathematics-advanced"
        assert ref[1] == 0


def test_search_index_has_terms(exported):
    out, _ = exported
    # "distribution" -> index file d.json for mathematics-advanced
    idx = _read(out / "index" / "mathematics-advanced" / "d.json")
    shard = _read(out / "questions" / "mathematics-advanced" / "shard-0.json")
    by_num = {r["qnum"]: r["id"] for r in shard}
    postings = idx.get("distribution", [])
    assert by_num["3"] in postings, "question 3 (normal distribution) must be findable"
    assert by_num["9"] in idx.get("distributed", []), "q9 contains 'distributed'"
    assert by_num["9"] in idx.get("deviation", [])
    # calculus terms present too ("antiderivative" -> a.json)
    idx_a = _read(out / "index" / "mathematics-advanced" / "a.json")
    assert by_num["6"] in idx_a.get("antiderivative", []), "q6 findable via antiderivative"
    idx_s = _read(out / "index" / "mathematics-advanced" / "s.json")
    assert by_num["3"] in idx_s.get("standard", [])
    idx_n = _read(out / "index" / "mathematics-advanced" / "n.json")
    assert by_num["9"] in idx_n.get("normally", []) or by_num["3"] in idx_n.get("normal", [])


def test_papers_metadata_has_no_private_fields(exported):
    out, _ = exported
    papers = _read(out / "meta" / "papers.json")
    assert papers
    for p in papers:
        assert "filename" not in p
        assert "file_path" not in p
        assert "sha256" not in p
        assert p["display_name"]


def test_upload_hashes(exported):
    out, _ = exported
    hashes = _read(out / "uploads" / "hashes.json")
    assert hashes, "known paper hashes must be exported for duplicate detection"


def test_images_compressed_and_originals(exported):
    out, _ = exported
    records = _read(out / "questions" / "mathematics-advanced" / "shard-0.json")
    for rec in records[:3]:
        for key in ("image", "image_fallback", "thumb", "thumb_fallback", "image_zoom"):
            assert (out / rec[key]).exists(), f"{key}: {rec[key]}"
        # original PNG zoom is lossless and larger-or-equal resolution
        zoom = Image.open(out / rec["image_zoom"])
        webp = Image.open(out / rec["image"])
        assert zoom.width >= webp.width


def test_ocr_text_lazy_files(exported):
    out, _ = exported
    text_files = list((out / "text").glob("*.json"))
    assert len(text_files) >= 13
    one = _read(text_files[0])
    assert "ocr_clean" in one
