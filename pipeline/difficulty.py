"""Difficulty estimation (1 = very easy .. 5 = very hard).

Difficulty is NOT marks alone.  The model combines:

- question type (MCQ easier, extended response harder)
- marks (weakly, capped)
- number of subparts (more parts -> more steps)
- trigger keywords ("hence", "prove", "show that", "justify", "otherwise")
- response length (proxy for reasoning volume)

Weights live in ``config/pipeline.yaml`` under ``difficulty``.  The reasoning
string explains the score so a human reviewer can spot bad calls.
"""

from __future__ import annotations

import re
from typing import Optional

from .config import Config
from .models import QuestionRegion

_TRIGGER_WORDS = [
    "prove", "hence", "show that", "justify", "otherwise", "deduce",
    "explain why", "derive", "generalise", "discuss",
]


def estimate_difficulty(region: QuestionRegion, config: Config) -> tuple[float, str]:
    cfg = config.get("difficulty", default={})
    score = 2.5
    reasons: list[str] = []

    # type
    if region.is_mcq or region.question_type == "multiple_choice":
        score -= float(cfg.get("type_penalty_mcq", 0.7))
        reasons.append("MCQ")
    elif region.question_type == "extended_response":
        score += float(cfg.get("type_bonus_extended", 0.8))
        reasons.append("extended response")

    # marks (weakly, capped at 10)
    if region.marks is not None:
        marks_component = min(region.marks, 10) / 10.0 * float(cfg.get("marks_weight", 1.5))
        score += marks_component
        reasons.append(f"{region.marks} marks")

    # subparts
    n_sub = len(region.subparts)
    if n_sub > 1:
        sub_component = (n_sub - 1) * float(cfg.get("subpart_weight", 0.25))
        score += min(sub_component, 0.8)
        reasons.append(f"{n_sub} subparts")

    # trigger keywords
    lowered = region.text.lower()
    hits = [w for w in _TRIGGER_WORDS if w in lowered]
    if hits:
        bonus = min(len(hits), 3) * float(cfg.get("keyword_bonus", 0.4))
        score += bonus
        reasons.append("keywords: " + ", ".join(hits))

    # length
    words = len(re.findall(r"[a-z0-9]+", lowered))
    length_bonus = float(cfg.get("length_bonus", 0.4))
    threshold = int(cfg.get("length_bonus_words", 120))
    if words > threshold:
        score += length_bonus
        reasons.append(f"{words} words")

    score = max(1.0, min(5.0, round(score, 1)))
    reasoning = "; ".join(reasons) if reasons else "no signals"
    return score, reasoning
