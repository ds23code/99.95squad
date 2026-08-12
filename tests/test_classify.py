"""Classification tests."""

from __future__ import annotations

from pipeline.classify import Classifier
from pipeline.config import Config
from pipeline.difficulty import estimate_difficulty
from pipeline.models import PaperRecord, QuestionRegion


def _classify(text, course_id="mathematics-advanced", **paper_kwargs):
    cfg = Config.load()
    classifier = Classifier(cfg)
    paper = PaperRecord(
        id="p-1", filename="TrialMaths_2023_2U.pdf", file_path="/tmp/x.pdf",
        sha256="d" * 64, course_id=course_id, **paper_kwargs
    )
    region = QuestionRegion(number="1", page_start=1, page_end=1, y_top=0, y_bottom=50, text=text)
    return classifier.classify(region, paper), cfg


def test_calculus_classification():
    result, _ = _classify("Differentiate y = x^2 and find the gradient of the tangent at x = 1.")
    assert result.topic_id == "mathematics-advanced:calculus"
    assert result.subtopic_id == "mathematics-advanced:calculus:differentiation"
    assert result.course_id == "mathematics-advanced"
    assert result.confidence > 0.4


def test_trig_classification():
    result, _ = _classify("Solve 2sin(x) = 1 for 0 ≤ x ≤ 2π.")
    assert result.topic_id == "mathematics-advanced:trigonometry"


def test_statistics_classification():
    result, _ = _classify(
        "The heights are normally distributed with mean 170 and standard deviation 8. Find the z-score."
    )
    assert result.topic_id == "mathematics-advanced:statistics"


def test_unknown_topic_stays_null():
    result, _ = _classify("Write an essay about your summer holidays and the beach.")
    assert result.topic_id is None
    assert result.subtopic_id is None


def test_difficulty_range_and_reasoning():
    cfg = Config.load()
    easy = QuestionRegion(
        number="1", page_start=1, page_end=1, y_top=0, y_bottom=50,
        text="What is 1 + 1?", is_mcq=True, question_type="multiple_choice", marks=1,
    )
    hard = QuestionRegion(
        number="2", page_start=1, page_end=1, y_top=0, y_bottom=50,
        text="Prove that the limit exists. Hence deduce the general result and justify your answer.",
        marks=8, subparts=["a", "b", "c", "d"],
    )
    d1, r1 = estimate_difficulty(easy, cfg)
    d2, r2 = estimate_difficulty(hard, cfg)
    assert 1.0 <= d1 <= 5.0 and 1.0 <= d2 <= 5.0
    assert d1 < d2
    assert r1 and r2  # reasoning strings populated


def test_filename_metadata_parsing(config):
    from pipeline.ingest import FilenameParser

    parser = FilenameParser(config)
    meta = parser.parse("TrialMaths_2023_2U_wsols.pdf")
    assert meta["year"] == 2023
    assert meta["course_id"] == "mathematics-advanced"
    assert meta["organisation"] == "TrialMaths"
    assert meta["has_solutions"] is True
    assert meta["paper_type"] == "trial"


def test_filename_metadata_physics():
    from pipeline.config import Config
    from pipeline.ingest import FilenameParser

    parser = FilenameParser(Config.load())
    meta = parser.parse("JRHS_2021_Physics_Trial.pdf")
    assert meta["course_id"] == "physics"
    assert meta["year"] == 2021
