"""Configuration loading (YAML + env overrides)."""

from __future__ import annotations

import copy
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_DIR = REPO_ROOT / "config"


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge ``override`` into a copy of ``base``."""
    out = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _load_yaml(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    return data


def _apply_env_overrides(cfg: dict) -> dict:
    """Apply QB_<SECTION>_<KEY> environment overrides (e.g. QB_RENDER_DPI=300)."""
    for env_key, env_value in os.environ.items():
        if not env_key.startswith("QB_"):
            continue
        parts = env_key[3:].lower().split("_")
        node = cfg
        for part in parts[:-1]:
            if part not in node or not isinstance(node[part], dict):
                break
            node = node[part]
        else:
            node[parts[-1]] = _coerce(env_value)
    return cfg


def _coerce(value: str) -> Any:
    value = value.strip()
    low = value.lower()
    if low in ("true", "yes", "on"):
        return True
    if low in ("false", "no", "off"):
        return False
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    return value


def _normalise_paths(cfg: dict) -> dict:
    """Make data paths absolute relative to the repo root unless already absolute."""
    pipeline = cfg["pipeline"]
    data_dir = Path(pipeline["paths"]["data_dir"]).expanduser()
    if not data_dir.is_absolute():
        data_dir = REPO_ROOT / data_dir
    pipeline["paths"]["data_dir"] = str(data_dir)
    for key in (
        "papers_dir",
        "questions_dir",
        "pages_dir",
        "solutions_dir",
        "exports_dir",
        "database",
    ):
        val = Path(pipeline["paths"].get(key, key)).expanduser()
        if not val.is_absolute():
            val = data_dir / val.name
        pipeline["paths"][key] = str(val)
    return cfg


class Config:
    """Loaded pipeline configuration with typed accessors."""

    def __init__(self, raw: dict):
        self.raw = raw

    # -- factories -----------------------------------------------------------
    @classmethod
    def load(cls, config_dir: str | Path | None = None, extra_files: list[str] | None = None) -> "Config":
        config_dir = Path(config_dir) if config_dir else DEFAULT_CONFIG_DIR
        cfg: dict = {}
        for name in ("pipeline.yaml", "subjects.yaml", "topics.yaml", "patterns.yaml"):
            path = config_dir / name
            if path.exists():
                cfg[name.split(".")[0]] = _load_yaml(path)
        # layered pipeline config: default config then any --config overrides
        merged = _deep_merge(cfg, {})
        pipeline = cfg.get("pipeline", {})
        for extra in extra_files or []:
            if Path(extra).exists():
                pipeline = _deep_merge(pipeline, _load_yaml(Path(extra)))
        cfg["pipeline"] = pipeline
        # env overrides (QB_*) target the pipeline settings
        cfg["pipeline"] = _apply_env_overrides(cfg["pipeline"])
        cfg = _normalise_paths(cfg)
        return cls(cfg)

    # -- accessors -----------------------------------------------------------
    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, *path: str, default: Any = None) -> Any:
        """Look up a pipeline setting (e.g. ``cfg.get('render', 'dpi')``)."""
        node: Any = self.raw.get("pipeline", {})
        for part in path:
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node

    @property
    def paths(self) -> dict:
        return self.raw["pipeline"]["paths"]

    @property
    def pipeline(self) -> dict:
        return self.raw["pipeline"]

    @property
    def subjects(self) -> dict:
        return self.raw.get("subjects", {})

    @property
    def topics(self) -> dict:
        return self.raw.get("topics", {})

    @property
    def patterns(self) -> dict:
        return self.raw.get("patterns", {})

    # -- helpers -------------------------------------------------------------
    def courses(self) -> list[dict]:
        out = []
        for subj in self.subjects.get("subjects", []):
            for course in subj.get("courses", []):
                out.append(
                    {
                        "id": course["id"],
                        "name": course["name"],
                        "subject_id": subj["id"],
                        "subject_name": subj["name"],
                        "aliases": course.get("aliases", []),
                        "year_level": course.get("year_level"),
                    }
                )
        return out

    def course_by_id(self, course_id: str) -> dict | None:
        for course in self.courses():
            if course["id"] == course_id:
                return course
        return None

    def topics_for_course(self, course_id: str) -> list[dict]:
        return self.topics.get("courses", {}).get(course_id, [])

    def topics_for_course_all(self) -> dict[str, list[dict]]:
        """All topics keyed by course id (used to seed the DB)."""
        return self.topics.get("courses", {})

    def course_data_dir(self, course_id: str, year: int | None, org: str | None) -> Path:
        """Directory where question images for a course live:
        <questions_dir>/<course_id>/<year>/<org>/"""
        base = Path(self.paths["questions_dir"])
        parts = [course_id or "unknown"]
        parts.append(str(year) if year else "unknown-year")
        parts.append(_slug(org) if org else "unknown-source")
        return base.joinpath(*parts)

    def paper_data_dir(self, paper_id: str) -> Path:
        return Path(self.paths["pages_dir"]) / paper_id


def _slug(value: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "unknown"


@lru_cache(maxsize=1)
def default_config() -> Config:
    return Config.load()
