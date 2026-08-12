"""Detector tests."""

from __future__ import annotations

from pipeline.detect import QuestionDetector


def _run(texts, sizes=None):
    from pipeline.config import Config

    cfg = Config.load()
    sizes = sizes or [(595.0, 842.0)] * len(texts)
    det = QuestionDetector(cfg)
    return det.detect_from_text(list(texts), list(sizes))


def test_word_style_headers():
    result = _run(
        [
            "TrialMaths 2023 Mathematics Advanced",
            "Question 1 (1 mark)\nWhat is sin(0)?\nA. 0\nB. 1",
            "Question 2 (2 marks)\nDifferentiate y = x^2.",
        ]
    )
    nums = [q.number for q in result.questions]
    assert nums == ["1", "2"], nums


def test_numbered_and_q_styles():
    result = _run(
        [
            "Instructions",
            "1. Find the area of the circle.",
            "Q2\nWhat is the derivative?",
            "3) Solve for x.",
        ]
    )
    nums = [q.number for q in result.questions]
    assert nums == ["1", "2", "3"], nums


def test_sections_and_subparts():
    result = _run(
        [
            "Section I\nQuestion 1 (1 mark)\nMCQ text",
            "Section II\nQuestion 2 (3 marks)\n(a) part one\n(b) part two\n(c) part three",
        ]
    )
    assert result.questions[0].section == "I"
    q2 = result.questions[1]
    assert q2.section == "II"
    assert sorted(q2.subparts) == ["a", "b", "c"]


def test_marks_and_mcq_detection():
    result = _run(
        [
            "Question 1 (1 mark)\nWhat is 2+2?\nA. 3\nB. 4\nC. 5\nD. 6",
            "Question 2 (4 marks)\nShow your working.",
        ]
    )
    q1, q2 = result.questions
    assert q1.is_mcq and q1.question_type == "multiple_choice"
    assert q1.marks == 1
    assert q2.marks == 4


def test_multipage_continuation():
    result = _run(
        [
            "Question 1 (3 marks)\n(a) First part",
            "(b) Continued on next page",
            "Question 2 (1 mark)\nNext question",
        ]
    )
    q1, q2 = result.questions
    assert q1.page_start == 1 and q1.page_end == 2
    assert "continuation" in q1.flags
    assert q2.page_start == 3


def test_answer_section_excluded():
    result = _run(
        [
            "Question 1 (1 mark)\nWhat is 2+2?",
            "Answers\n1. 4\n2. C",
        ]
    )
    assert [q.number for q in result.questions] == ["1"]
    assert len(result.solution_regions) >= 1
    assert result.answer_pages == [2]


def test_inline_solution_header():
    result = _run(
        [
            "Question 1 (2 marks)\nDifferentiate y = x^2.",
            "Solution 1\n y' = 2x",
            "Question 2 (1 mark)\nWhat is 1+1?",
        ]
    )
    assert result.questions[0].solution_y_top is not None
    assert result.questions[0].solution_y_top > result.questions[0].y_top


def test_confidence_low_for_bare_numbers():
    result = _run(["1. A thing\n2. Another thing\n3. Third thing"])
    assert all(q.confidence < 0.9 for q in result.questions)
