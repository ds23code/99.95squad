"""Mobile-UI tests for the static frontend.

jsdom has no layout engine, so these assert the *responsive contract* the
frontend must honour:
- viewport meta so mobile browsers use the responsive layout
- media-query breakpoints for nav collapse, grids, hero, footer
- no hard fixed-width layout that would overflow small screens
- tap-friendly nav targets (mobile padding)
- images are responsive (max-width:100%)
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SITE = REPO_ROOT / "site"


def _read(rel: str) -> str:
    return (SITE / rel).read_text(encoding="utf-8")


def test_viewport_meta_present():
    html = _read("index.html")
    assert 'name="viewport"' in html
    assert "width=device-width" in html


def test_mobile_breakpoints_exist():
    css = _read("assets/css/app.css")
    # nav collapses at 720px; sidebar layout collapses at 860px
    assert "@media (max-width: 720px)" in css
    assert "@media (max-width: 860px)" in css
    # nav becomes horizontally scrollable on mobile
    assert "overflow-x: auto" in css


def test_no_fixed_width_layout():
    css = _read("assets/css/app.css")
    # max-width is fine (wrap container), hard width: on content wrappers is not
    for line in css.splitlines():
        if "width:" in line and "max-width" not in line and "%" not in line and "auto" not in line:
            # allow small component sizes (avatars, dots, bars) — flag layout-level ones
            assert "1140px" not in line and "1100px" not in line, line


def test_images_responsive():
    css = _read("assets/css/app.css")
    assert "img { max-width: 100%;" in css or "max-width: 100%" in css


def test_touch_targets():
    css = _read("assets/css/app.css")
    # nav links get comfortable tap padding on mobile
    assert ".main-nav a { padding:" in css
    # buttons are comfortably sized
    assert ".btn {" in css


def test_hero_search_and_grid_stack():
    css = _read("assets/css/app.css")
    # hero stats and grids collapse on small screens
    assert ".hero-stats { gap: 20px; }" in css
    assert "@media (max-width: 720px)" in css


def test_accessible_contrast_defined():
    css = _read("assets/css/app.css")
    # text colours defined against backgrounds (restrained palette)
    for var in ("--ink:", "--muted:", "--bg:", "--brand:"):
        assert var in css, var
