"""Config loading tests."""

from __future__ import annotations

from pipeline.config import Config


def test_load_defaults():
    cfg = Config.load()
    assert cfg.courses(), "no courses found in config/subjects.yaml"
    ids = {c["id"] for c in cfg.courses()}
    assert "mathematics-advanced" in ids
    assert "physics" in ids


def test_course_aliases():
    cfg = Config.load()
    adv = cfg.course_by_id("mathematics-advanced")
    assert adv is not None
    assert "2u" in adv["aliases"]


def test_taxonomy_has_topics():
    cfg = Config.load()
    topics = cfg.topics_for_course("mathematics-advanced")
    names = {t["name"] for t in topics}
    assert "Calculus" in names
    assert "Functions" in names


def test_env_override(monkeypatch):
    monkeypatch.setenv("QB_RENDER_DPI", "300")
    cfg = Config.load()
    assert cfg.get("render", "dpi") == 300


def test_extra_config_file(tmp_path):
    extra = tmp_path / "extra.yaml"
    extra.write_text("detect:\n  padding_points: 20\n")
    cfg = Config.load(extra_files=[str(extra)])
    assert cfg.get("detect", "padding_points") == 20
    # deep merge keeps other keys
    assert cfg.get("detect", "max_question_number") is not None
