"""Metadata classification.

Determines subject/course, topic/subtopic, question type and difficulty from
question text (embedded text layer or OCR) and paper-level hints.

The classifier NEVER hallucinates: when confidence is below the configured
threshold the field is left ``None`` (= "unknown") so it can be set during
human review.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from .config import Config
from .models import ClassificationResult, PaperRecord, QuestionRegion

_WORD = re.compile(r"[a-z0-9]+")


@dataclass
class _TopicScore:
    topic_id: str
    subtopic_id: Optional[str]
    score: float
    hits: list[str]


class Classifier:
    def __init__(self, config: Config):
        self.config = config
        self.courses = config.courses()
        self.min_topic_conf = float(config.get("classify", "min_topic_confidence", default=0.30))
        self.min_course_conf = float(config.get("classify", "min_course_confidence", default=0.40))

    # ------------------------------------------------------------ course
    def course_from_text(self, text: str) -> tuple[Optional[str], float]:
        """Guess the course from paper/question text using course names and
        aliases as substrings. Returns (course_id, confidence)."""
        lowered = text.lower()
        best: tuple[str, float] | None = None
        for course in self.courses:
            name_hits = 0
            for name_frag in (course["name"], course["subject_name"]):
                if name_frag.lower() in lowered:
                    name_hits += 1
            alias_hits = sum(
                1 for a in course["aliases"]
                if len(a) >= 4 and re.sub(r"[^a-z0-9]+", "", a).lower() in _WORD.sub("", lowered)
            )
            score = name_hits * 0.6 + min(alias_hits, 3) * 0.25
            if score > 0 and (best is None or score > best[1]):
                best = (course["id"], score)
        if best is None:
            return None, 0.0
        confidence = min(1.0, best[1])
        return (best[0], confidence) if confidence >= self.min_course_conf else (None, confidence)

    # ------------------------------------------------------------ topics
    def _subtopic_hits(self, text: str, keywords: list[str]) -> list[str]:
        lowered = text.lower()
        hits = []
        for kw in keywords:
            k = str(kw).lower()  # YAML may parse keywords like "68" as ints
            if not k:
                continue
            if len(k) <= 3:
                if re.search(rf"\b{re.escape(k)}\b", lowered):
                    hits.append(kw)
            elif k in lowered:
                hits.append(kw)
        return hits

    def score_topics(self, course_id: str, text: str) -> list[_TopicScore]:
        topics = self.config.topics_for_course(course_id)
        scores: list[_TopicScore] = []
        for topic in topics:
            topic_keywords = topic.get("keywords", []) + [topic["name"]]
            all_hits = self._subtopic_hits(text, topic_keywords)
            best_sub: Optional[dict] = None
            best_sub_hits: list[str] = []
            for st in topic.get("subtopics", []):
                st_keywords = st.get("keywords", []) + [st["name"]]
                hits = self._subtopic_hits(text, st_keywords)
                if len(hits) > len(best_sub_hits):
                    best_sub, best_sub_hits = st, hits
            total = len(all_hits) + len(best_sub_hits)
            if total == 0:
                continue
            # weight: subtopic hits count double (more specific)
            score = len(all_hits) + 2 * len(best_sub_hits)
            scores.append(
                _TopicScore(
                    topic_id=topic["id"],
                    subtopic_id=best_sub["id"] if best_sub else None,
                    score=score,
                    hits=all_hits + best_sub_hits,
                )
            )
        return sorted(scores, key=lambda s: -s.score)

    def classify_topic(self, course_id: str | None, text: str) -> tuple[Optional[str], Optional[str], float]:
        """Return (topic_id, subtopic_id, confidence)."""
        if not course_id:
            return None, None, 0.0
        scores = self.score_topics(course_id, text)
        if not scores:
            return None, None, 0.0
        best = scores[0]
        if len(scores) > 1 and scores[1].score > 0:
            margin = (best.score - scores[1].score) / max(best.score, 1)
        else:
            margin = 1.0
        confidence = min(1.0, 0.4 + margin * 0.6)
        if confidence < self.min_topic_conf:
            return None, None, confidence
        topic_id = f"{course_id}:{best.topic_id}"
        subtopic_id = (
            f"{course_id}:{best.topic_id}:{best.subtopic_id}" if best.subtopic_id else None
        )
        return topic_id, subtopic_id, confidence

    # ------------------------------------------------------ question type
    def classify_type(self, region: QuestionRegion) -> str:
        if region.question_type != "unknown":
            return region.question_type
        if region.marks is not None and region.marks >= 5:
            return "extended_response"
        text = region.text.lower()
        word_count = len(_WORD.findall(text))
        if word_count > 200:
            return "extended_response"
        return "short_answer"

    # ---------------------------------------------------------- aggregate
    def classify(
        self,
        region: QuestionRegion,
        paper: PaperRecord,
        paper_text: str = "",
    ) -> ClassificationResult:
        text = region.text or ""
        notes: list[str] = []

        # course: paper filename hint first, then paper text, then question text
        course_id, course_conf = paper.course_id, paper.parsed_confidence
        if course_id is None:
            guessed, conf = self.course_from_text(paper_text or text)
            course_id, course_conf = guessed, conf
            if course_id is not None:
                notes.append("course-from-text")
        elif paper.parsed_confidence < 0.8:
            notes.append("course-from-filename-low-confidence")
        subject_id = paper.subject_id
        if subject_id is None and course_id is not None:
            subject_id = self.config.course_by_id(course_id)["subject_id"]

        year_level = paper.year_level

        topic_id, subtopic_id, topic_conf = self.classify_topic(course_id, text)
        if topic_id is None:
            notes.append("topic-unknown")

        question_type = self.classify_type(region)

        return ClassificationResult(
            subject_id=subject_id,
            course_id=course_id,
            year_level=year_level,
            topic_id=topic_id,
            subtopic_id=subtopic_id,
            difficulty=None,
            difficulty_reasoning="",
            question_type=question_type,
            confidence=min(course_conf, max(topic_conf, 0.5)) if course_id else course_conf,
            notes=notes,
        )
