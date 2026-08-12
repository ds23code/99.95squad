"""Internal data models (dataclasses)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class TextLine:
    """A single line of page text with its bounding box (PDF points)."""

    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    font_size: float = 0.0
    bold: bool = False
    font: str = ""
    source: str = "embedded"  # embedded | ocr

    @property
    def height(self) -> float:
        return max(self.y1 - self.y0, 0.0)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<TextLine y={self.y0:.0f} '{self.text[:40]}'>"


@dataclass
class PageLayout:
    """Detected layout of one page."""

    page_number: int  # 1-based
    width: float
    height: float
    lines: list[TextLine] = field(default_factory=list)
    text: str = ""
    has_text: bool = False          # embedded text layer was usable
    used_ocr: bool = False          # layout came from OCR rather than text layer

    @property
    def body_lines(self) -> list[TextLine]:
        return self.lines


@dataclass
class QuestionRegion:
    """A detected question (or solution block) with crop boundaries."""

    number: str
    page_start: int  # 1-based page number
    page_end: int
    y_top: float                    # points, on page_start
    y_bottom: float                 # points, on page_end
    section: Optional[str] = None
    subparts: list[str] = field(default_factory=list)
    marks: Optional[int] = None
    is_mcq: bool = False
    question_type: str = "unknown"  # multiple_choice | short_answer | extended_response | unknown
    text: str = ""
    lines: list[TextLine] = field(default_factory=list)
    confidence: float = 1.0
    flags: list[str] = field(default_factory=list)
    # Inline solution block (same page as the question) if present
    solution_y_top: Optional[float] = None
    is_solution_block: bool = False  # True when this region lives in the answer section

    @property
    def spans_pages(self) -> bool:
        return self.page_end != self.page_start


@dataclass
class DetectionResult:
    questions: list[QuestionRegion]
    solution_regions: list[QuestionRegion] = field(default_factory=list)
    answer_pages: list[int] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    pages_without_text: list[int] = field(default_factory=list)

    @property
    def confidence(self) -> float:
        if not self.questions:
            return 0.0
        return sum(q.confidence for q in self.questions) / len(self.questions)


@dataclass
class PaperRecord:
    """Metadata about a source PDF."""

    id: str
    filename: str
    file_path: str
    sha256: str
    display_name: str = ""
    organisation: Optional[str] = None
    year: Optional[int] = None
    paper_type: Optional[str] = None
    subject_id: Optional[str] = None
    course_id: Optional[str] = None
    year_level: Optional[int] = None
    has_solutions: bool = False
    page_count: Optional[int] = None
    parsed_confidence: float = 1.0


@dataclass
class ClassificationResult:
    subject_id: Optional[str]
    course_id: Optional[str]
    year_level: Optional[int]
    topic_id: Optional[str]
    subtopic_id: Optional[str]
    difficulty: Optional[float]
    difficulty_reasoning: str
    question_type: str
    confidence: float
    notes: list[str] = field(default_factory=list)


@dataclass
class AnswerAttachment:
    question_id: Optional[str]   # None -> paper-level (unmatched)
    answer_text: Optional[str]
    image_path: Optional[str]
    source_page: int
    kind: str = "answer"         # answer | solution
    confidence: float = 1.0
