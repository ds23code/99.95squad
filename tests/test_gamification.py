"""Runs the node unit tests for the gamification logic module
(site/assets/js/gamification.js) — XP, levels, streaks, mastery, activity
aggregation, timing statistics and leaderboard ranking."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not available")


def test_gamification_logic():
    result = subprocess.run(
        ["node", str(REPO_ROOT / "tests" / "test_gamification.js"),
         str(REPO_ROOT / "site" / "assets" / "js" / "gamification.js")],
        capture_output=True, text=True, cwd=REPO_ROOT, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "GAMIFICATION TESTS PASSED" in result.stdout
