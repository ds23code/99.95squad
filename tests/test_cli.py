"""CLI smoke tests."""

from __future__ import annotations

from pipeline.cli import main


def test_cli_init(config, capsys):
    rc = main(["init"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Initialised database" in out


def test_cli_stats(config, capsys):
    main(["init"])
    rc = main(["stats"])
    assert rc == 0
    assert "QuestionBank statistics" in capsys.readouterr().out


def test_cli_sample(config, tmp_path):
    out = tmp_path / "sample.pdf"
    rc = main(["sample", "--out", str(out)])
    assert rc == 0
    assert out.exists()


def test_cli_process_missing_file(config, capsys):
    rc = main(["process", "/nonexistent/file.pdf"])
    assert rc == 2


def test_cli_review_list(config, capsys):
    main(["init"])
    rc = main(["review", "--list"])
    assert rc == 0
    assert "awaiting review" in capsys.readouterr().out.lower()


def test_cli_import_dir(config, tmp_path, capsys):
    import pymupdf

    main(["init"])
    p1 = tmp_path / "test1.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 100), "Trial Maths Advanced 2024", fontsize=16)
    page.insert_text((72, 140), "Question 1 (2 marks)", fontsize=12)
    page.insert_text((72, 160), "Solve x = 5.", fontsize=12)
    doc.save(str(p1))
    doc.close()

    rc = main(["import-dir", str(tmp_path)])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Import directory summary:" in out
    assert "discovered:" in out
    assert "completed:" in out
