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


def test_cli_remote_requires_exactly_one_submission(capsys):
    assert main(["uploads", "process-remote"]) == 2
    assert "exactly one submission UUID" in capsys.readouterr().err
    assert main(["uploads", "process-remote", "one", "two"]) == 2


def test_cli_remote_reports_missing_environment(monkeypatch, capsys):
    for name in (
        "SUPABASE_URL",
        "SUPABASE_ANON_KEY",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_ACCESS_TOKEN",
        "SUPABASE_REFRESH_TOKEN",
        "SUPABASE_SESSION_FILE",
    ):
        monkeypatch.delenv(name, raising=False)
    rc = main(["uploads", "process-remote", "0c72bf8a-dd6b-4762-b969-26ed601bd89a"])
    assert rc == 1
    assert "missing environment variable" in capsys.readouterr().err


def test_cli_remote_requires_restart_safe_session_file(monkeypatch, capsys):
    import pipeline.uploads as uploads

    class Client:
        refresh_token = "refresh"
        session_file = None

    monkeypatch.setattr(
        uploads.SupabaseAdminClient,
        "from_environment",
        classmethod(lambda cls, **kwargs: Client()),
    )
    rc = main(["uploads", "process-remote", "0c72bf8a-dd6b-4762-b969-26ed601bd89a"])
    assert rc == 1
    assert "SUPABASE_SESSION_FILE is required" in capsys.readouterr().err


def test_cli_remote_requires_refresh_token(monkeypatch, capsys, tmp_path):
    import pipeline.uploads as uploads

    class Client:
        refresh_token = None
        session_file = tmp_path / "session.json"

    monkeypatch.setattr(
        uploads.SupabaseAdminClient,
        "from_environment",
        classmethod(lambda cls, **kwargs: Client()),
    )
    rc = main(["uploads", "process-remote", "0c72bf8a-dd6b-4762-b969-26ed601bd89a"])
    assert rc == 1
    assert "session file must contain a refresh token" in capsys.readouterr().err


def test_cli_remote_passes_one_id_and_limits_to_processor(monkeypatch, capsys, tmp_path):
    import pipeline.uploads as uploads

    submission_id = "0c72bf8a-dd6b-4762-b969-26ed601bd89a"

    class Client:
        refresh_token = "refresh"
        session_file = tmp_path / "session.json"

    client = Client()
    monkeypatch.setattr(
        uploads.SupabaseAdminClient,
        "from_environment",
        classmethod(lambda cls, **kwargs: client),
    )
    seen = {}

    def fake_process(config, selected, actual_client, **kwargs):
        seen.update(selected=selected, client=actual_client, kwargs=kwargs)
        return {
            "submission_id": selected,
            "paper_id": "paper-id",
            "questions": 7,
            "export_out": kwargs["export_out"],
        }

    monkeypatch.setattr(uploads, "process_remote_upload", fake_process)
    export_out = tmp_path / "published-content"
    rc = main([
        "uploads", "process-remote", submission_id,
        "--export-out", str(export_out), "--max-bytes", "123456",
    ])
    assert rc == 0
    assert seen == {
        "selected": submission_id,
        "client": client,
        "kwargs": {"export_out": str(export_out), "max_bytes": 123456},
    }
    assert "approved" in capsys.readouterr().out
