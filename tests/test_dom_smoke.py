"""Real-browser DOM smoke test for the static frontend.

Builds the site (from the committed sample content), then runs
scripts/dom_smoke.js under node + jsdom, which loads the actual frontend and
exercises search, filters, question pages, practice mode, analytics, the
upload flow and the 404 route.

Three runs:
- stub mode (default): JSON is served from disk via a fetch stub
- live mode: the built site is served over a real local HTTP server and
  jsdom loads *real* JSON and *real* <img> resources — any 404 on a question
  image fails the test.
- live subpath mode: the same, but served under a `/99.95squad/` prefix to
  prove the site works from a GitHub Pages repository subpath.

Requires node + jsdom (npm install). Skipped automatically when unavailable —
GitHub Actions installs them (see .github/workflows/pages.yml).
"""

from __future__ import annotations

import http.server
import shutil
import subprocess
import threading
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None,
    reason="node not available",
)


def _jsdom_available() -> bool:
    if not (REPO_ROOT / "node_modules" / "jsdom").exists():
        return False
    probe = subprocess.run(
        ["node", "-e", "require('jsdom'); console.log('ok')"],
        cwd=REPO_ROOT, capture_output=True, text=True,
    )
    return probe.returncode == 0 and "ok" in probe.stdout


@pytest.fixture(scope="module")
def dom_site(tmp_path_factory):
    from scripts.build_site import build

    out = tmp_path_factory.mktemp("dom") / "_site"
    build(out, force=True)
    return out


class _LoggingHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler that records request log lines instead of
    printing to stderr, so tests can assert there were no 404s."""

    log_lines: list[str] = []

    def log_message(self, fmt, *args):
        self.log_lines.append(fmt % args)


class _SubpathHandler(_LoggingHandler):
    """Serves the site under /99.95squad/ like GitHub Pages does."""

    def translate_path(self, path):
        if path.startswith("/99.95squad/"):
            path = path[len("/99.95squad"):]
        return super().translate_path(path)


def _run_harness(site_dir, extra_args=None):
    jsdom_path = str(REPO_ROOT / "node_modules" / "jsdom")
    args = ["node", str(REPO_ROOT / "scripts" / "dom_smoke.js"), str(site_dir), jsdom_path]
    if extra_args:
        for a in extra_args:
            if a is not None:
                args.append(a)
    return subprocess.run(args, capture_output=True, text=True, cwd=REPO_ROOT, timeout=240)


def _serve(handler_cls, site_dir):
    _LoggingHandler.log_lines = []
    handler = lambda *a, **kw: handler_cls(*a, directory=str(site_dir), **kw)  # noqa: E731
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _assert_no_404s():
    bad = [line for line in _LoggingHandler.log_lines if " 404 " in line]
    assert not bad, f"server logged 404 responses:\n" + "\n".join(bad[:10])


@pytest.mark.skipif(not _jsdom_available(), reason="jsdom not installed (npm install)")
def test_dom_smoke_supabase_mock_mode(dom_site):
    """Full learning-platform flows against an in-memory Supabase mock:
    auth state, server-side XP, dashboard (XP/level/streak/calendar/mastery/
    achievements), leaderboard ranking, comments (post/like/delete/profanity)
    and syllabus stages."""
    result = _run_harness(dom_site, ["", "--mock-supabase"])
    assert result.returncode == 0, result.stdout + result.stderr
    assert "DOM SMOKE PASSED" in result.stdout
    assert "auth: sign-in creates session" in result.stdout
    assert "gamification: attempt recorded server-side" in result.stdout
    assert "dashboard: activity calendar rendered" in result.stdout
    assert "leaderboard: rows ranked by XP" in result.stdout
    assert "comments: profanity filtered" in result.stdout
    # upload → moderation → entitlement lifecycle
    assert "moderation: PDF stored in private bucket" in result.stdout
    assert "moderation: student blocked from admin page" in result.stdout
    assert "moderation: admin sees student submission" in result.stdout
    assert "moderation: PDF preview via signed URL" in result.stdout
    assert "moderation: contributor premium granted only on completion" in result.stdout
    assert "moderation: student entitlement upgraded after approval" in result.stdout


def test_github_pages_direct_route_recovery_smoke():
    result = subprocess.run(
        ["node", str(REPO_ROOT / "scripts" / "route_recovery_smoke.js")],
        capture_output=True, text=True, cwd=REPO_ROOT, timeout=10,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ROUTE RECOVERY SMOKE PASSED" in result.stdout
    assert "query-bearing settings path" in result.stdout


@pytest.mark.skipif(not _jsdom_available(), reason="jsdom not installed (npm install)")
def test_auth_callback_and_session_restoration_smoke():
    result = subprocess.run(
        ["node", str(REPO_ROOT / "scripts" / "auth_smoke.js"), str(REPO_ROOT / "node_modules" / "jsdom")],
        capture_output=True, text=True, cwd=REPO_ROOT, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "AUTH SMOKE PASSED" in result.stdout
    assert "same-browser verifier" in result.stdout
    assert "profiles.is_admin is hydrated" in result.stdout
    assert "persisted session is validated" in result.stdout


@pytest.mark.skipif(not _jsdom_available(), reason="jsdom not installed (npm install)")
def test_dom_smoke_stub_mode(dom_site):
    result = _run_harness(dom_site)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "DOM SMOKE PASSED" in result.stdout


@pytest.mark.skipif(not _jsdom_available(), reason="jsdom not installed (npm install)")
def test_dom_smoke_live_mode(dom_site):
    """Serve the built site over HTTP and verify question images actually load
    (jsdom resource loader + real network) — no 404s."""
    server, thread = _serve(_LoggingHandler, dom_site)
    base = f"http://127.0.0.1:{server.server_port}/"
    try:
        result = _run_harness(dom_site, [base])
    finally:
        server.shutdown()
        thread.join(timeout=5)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "DOM SMOKE PASSED" in result.stdout
    assert "no image failed to load" in result.stdout, result.stdout
    assert "all rendered image URLs fetch HTTP 200" in result.stdout, result.stdout
    _assert_no_404s()


@pytest.mark.skipif(not _jsdom_available(), reason="jsdom not installed (npm install)")
def test_dom_smoke_live_mode_under_pages_subpath(dom_site):
    """The site must work when deployed to https://USER.github.io/99.95squad/
    (served here under a /99.95squad/ prefix) — images, JSON, CSS all load."""
    server, thread = _serve(_SubpathHandler, dom_site)
    base = f"http://127.0.0.1:{server.server_port}/99.95squad/"
    try:
        result = _run_harness(dom_site, [base])
    finally:
        server.shutdown()
        thread.join(timeout=5)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "DOM SMOKE PASSED" in result.stdout
    assert "question image URL is a public content URL" in result.stdout
    assert "all rendered image URLs fetch HTTP 200" in result.stdout, result.stdout
    _assert_no_404s()
