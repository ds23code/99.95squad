"""Shared test fixtures."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from pipeline.config import Config  # noqa: E402


@pytest.fixture()
def config(tmp_path):
    """A Config whose data paths point into a temp dir."""
    cfg = Config.load()
    data_dir = tmp_path / "data"
    cfg.raw["pipeline"]["paths"]["data_dir"] = str(data_dir)
    for key in ("papers_dir", "questions_dir", "pages_dir", "solutions_dir", "exports_dir"):
        cfg.raw["pipeline"]["paths"][key] = str(data_dir / Path(cfg.raw["pipeline"]["paths"][key]).name)
    cfg.raw["pipeline"]["paths"]["database"] = str(data_dir / "questionbank.db")
    for key in ("papers_dir", "questions_dir", "pages_dir", "solutions_dir", "exports_dir"):
        Path(cfg.raw["pipeline"]["paths"][key]).mkdir(parents=True, exist_ok=True)
    return cfg


@pytest.fixture(scope="session")
def sample_pdf(tmp_path_factory):
    """Generate the synthetic TrialMaths-style PDF once per test session."""
    from scripts.make_sample_pdf import make_sample_pdf

    out = tmp_path_factory.mktemp("papers") / "TrialMaths_2023_2U_wsols_sample.pdf"
    make_sample_pdf(out)
    return out


@pytest.fixture()
def seeded_db(config):
    from pipeline.database import Database

    db = Database(config.paths["database"])
    db.init_schema()
    db.seed_taxonomy(config)
    yield db
    db.close()


@pytest.fixture()
def exported(config, sample_pdf, tmp_path):
    """Process the sample PDF into a temp config and export static content."""
    from pipeline.export_static import export_static
    from pipeline.process import process_pdf

    process_pdf(config, sample_pdf, force=True)
    out = tmp_path / "content"
    manifest = export_static(config, out, source="full")
    return out, manifest
