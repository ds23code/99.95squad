"""Pipeline statistics."""

from __future__ import annotations

from .database import Database


def report(db: Database) -> str:
    s = db.stats()
    lines = [
        "QuestionBank statistics",
        "=" * 40,
        f"Papers:            {s['papers']} (complete: {s['papers_complete']}, error: {s['papers_error']})",
        f"Pages rendered:    {s['pages']}",
        f"Questions:         {s['questions']}",
        f"Needs review:      {s['needs_review']}",
        f"With answers:      {s['with_answers']}",
        f"With solutions:    {s['with_solutions']}",
        f"Avg extraction conf: {s['avg_extraction_confidence']}",
        "",
        "By course:",
    ]
    for row in s["by_course"]:
        lines.append(
            f"  {row['course']:<32} {row['n']:>5}  (extraction conf {row['extraction_conf']})"
        )
    lines.append("")
    lines.append("By type:")
    for row in s["by_type"]:
        lines.append(f"  {row['question_type']:<24} {row['n']:>5}")
    return "\n".join(lines)
