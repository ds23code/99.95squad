"""Controlled Supabase-to-local ingestion lifecycle regressions."""

from __future__ import annotations

import base64
import json
import time
import uuid
from pathlib import Path

import pytest

import pipeline.uploads as uploads
from pipeline.uploads import RemoteUploadError, SupabaseAdminClient, process_remote_upload


class FakeRemote:
    def __init__(self, pdf: Path):
        self.pdf = pdf
        self.events = []

    def claim_upload(self, submission_id: str, claim_id: str) -> dict:
        self.events.append(("claim", submission_id, claim_id))
        return {
            "id": submission_id,
            "status": "processing",
            "processing_claim_id": claim_id,
            "filename": self.pdf.name,
            "storage_path": f"student/{self.pdf.name}",
            "size_bytes": self.pdf.stat().st_size,
        }

    def download_upload(self, row: dict, destination: Path, max_bytes: int) -> Path:
        self.events.append(("download", row["id"]))
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(self.pdf.read_bytes())
        return destination

    def complete_upload(self, submission_id: str, claim_id: str, paper_id: str, count: int):
        self.events.append(("complete", submission_id, claim_id, paper_id, count))
        return {
            "id": submission_id,
            "status": "approved",
            "paper_id": paper_id,
            "processing_claim_id": claim_id,
        }

    def fail_upload(self, submission_id: str, claim_id: str, message: str):
        self.events.append(("fail", submission_id, claim_id, message))
        return {"id": submission_id, "status": "needs_review"}


def test_selected_remote_upload_completes_only_after_validation_and_export(
    config, sample_pdf, monkeypatch, tmp_path
):
    submission_id = str(uuid.uuid4())
    remote = FakeRemote(sample_pdf)
    qids = ["paper-q1", "paper-q1--occurrence-2"]

    monkeypatch.setattr(
        uploads,
        "process_pdf",
        lambda *args, **kwargs: {"paper_id": "paper", "skipped": False, "questions": 2},
    )
    monkeypatch.setattr(
        uploads,
        "_validate_processed_paper",
        lambda *args, **kwargs: (2, qids),
    )

    def fake_export(config, out, **kwargs):
        out = Path(out)
        (out / "questions").mkdir(parents=True)
        (out / "questions" / "lookup.json").write_text(
            json.dumps({qid: ["maths", 0] for qid in qids}), encoding="utf-8"
        )
        return {"counts": {"questions": 2}}

    monkeypatch.setattr("pipeline.export_static.export_static", fake_export)
    result = process_remote_upload(
        config, submission_id, remote, export_out=tmp_path / "content"
    )

    assert result["status"] == "approved"
    assert result["questions"] == 2
    assert [event[0] for event in remote.events] == ["claim", "download", "complete"]
    assert remote.events[0][2] == remote.events[-1][2], "one claim token owns the lifecycle"


def test_selected_remote_upload_reports_processing_failure(config, sample_pdf, monkeypatch, tmp_path):
    submission_id = str(uuid.uuid4())
    remote = FakeRemote(sample_pdf)

    def fail_process(*args, **kwargs):
        raise uploads.PipelineError("detector failed")

    monkeypatch.setattr(uploads, "process_pdf", fail_process)
    with pytest.raises(uploads.PipelineError, match="detector failed"):
        process_remote_upload(
            config, submission_id, remote, export_out=tmp_path / "content"
        )

    assert [event[0] for event in remote.events] == ["claim", "download", "fail"]
    assert "detector failed" in remote.events[-1][-1]
    assert not any(event[0] == "complete" for event in remote.events)


def test_remote_upload_rejects_non_uuid_before_claim(config, sample_pdf):
    remote = FakeRemote(sample_pdf)
    with pytest.raises(RemoteUploadError, match="must be a UUID"):
        process_remote_upload(config, "all", remote)
    assert remote.events == []


@pytest.mark.parametrize("count", [0, -1])
def test_remote_upload_rejects_non_positive_processed_count(
    config, sample_pdf, monkeypatch, tmp_path, count
):
    submission_id = str(uuid.uuid4())
    remote = FakeRemote(sample_pdf)
    monkeypatch.setattr(
        uploads,
        "process_pdf",
        lambda *args, **kwargs: {"paper_id": "paper", "questions": count},
    )
    monkeypatch.setattr(
        uploads, "_validate_processed_paper", lambda *args, **kwargs: (count, [])
    )

    with pytest.raises(RemoteUploadError, match="non-positive question count"):
        process_remote_upload(
            config, submission_id, remote, export_out=tmp_path / "content"
        )
    assert [event[0] for event in remote.events] == ["claim", "download", "fail"]


def _jwt(role: str, exp: int | None = None) -> str:
    def enc(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    expires = int(time.time()) + 3600 if exp is None else exp
    return f"{enc({'alg': 'none'})}.{enc({'role': role, 'exp': expires})}.x"


def test_remote_client_refuses_service_role_credentials():
    with pytest.raises(RemoteUploadError, match="service-role"):
        SupabaseAdminClient(
            "https://example.supabase.co", _jwt("service_role"), _jwt("authenticated")
        )
    with pytest.raises(RemoteUploadError, match="secret/service-role"):
        SupabaseAdminClient(
            "https://example.supabase.co", "sb_secret_do-not-use", _jwt("authenticated")
        )
    with pytest.raises(RemoteUploadError, match="service-role"):
        SupabaseAdminClient(
            "https://example.supabase.co", "sb_publishable_test", _jwt("service_role")
        )


def test_remote_client_accepts_publishable_key_environment_alias(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.delenv("SUPABASE_ANON_KEY", raising=False)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    monkeypatch.setenv("SUPABASE_ACCESS_TOKEN", _jwt("authenticated"))

    client = SupabaseAdminClient.from_environment()
    assert client.anon_key == "sb_publishable_test"


def test_remote_client_requires_authenticated_user_session():
    with pytest.raises(RemoteUploadError, match="authenticated user session"):
        SupabaseAdminClient(
            "https://example.supabase.co", "sb_publishable_test", _jwt("anon")
        )


def test_session_file_bootstrap_is_absolute_private_and_authoritative(monkeypatch, tmp_path):
    path = tmp_path / "processor-session.json"
    initial_access = _jwt("authenticated")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    monkeypatch.setenv("SUPABASE_ACCESS_TOKEN", initial_access)
    monkeypatch.setenv("SUPABASE_REFRESH_TOKEN", "initial-refresh")

    client = SupabaseAdminClient.from_environment(session_file=path)
    assert client.session_file == path
    assert path.stat().st_mode & 0o777 == 0o600
    assert json.loads(path.read_text(encoding="utf-8"))["refresh_token"] == "initial-refresh"

    # Once present, the file—not stale shell variables—is the source of truth.
    monkeypatch.setenv("SUPABASE_ACCESS_TOKEN", _jwt("anon"))
    monkeypatch.setenv("SUPABASE_REFRESH_TOKEN", "stale-refresh")
    restarted = SupabaseAdminClient.from_environment(session_file=path)
    assert restarted.access_token == initial_access
    assert restarted.refresh_token == "initial-refresh"

    with pytest.raises(RemoteUploadError, match="absolute path"):
        SupabaseAdminClient.from_environment(session_file="relative-session.json")


def test_session_file_rejects_broad_permissions(monkeypatch, tmp_path):
    path = tmp_path / "processor-session.json"
    path.write_text(
        json.dumps(
            {"access_token": _jwt("authenticated"), "refresh_token": "refresh"}
        ),
        encoding="utf-8",
    )
    path.chmod(0o644)
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    with pytest.raises(RemoteUploadError, match="chmod 600"):
        SupabaseAdminClient.from_environment(session_file=path)


def test_refresh_atomically_persists_rotated_pair_for_restart(monkeypatch, tmp_path):
    path = tmp_path / "processor-session.json"
    old_access = _jwt("authenticated", exp=int(time.time()) - 1)
    new_access = _jwt("authenticated", exp=int(time.time()) + 7200)
    client = SupabaseAdminClient(
        "https://example.supabase.co",
        "sb_publishable_test",
        old_access,
        "old-refresh",
        session_file=path,
    )
    client._persist_session()
    response = ByteResponse(
        json.dumps(
            {"access_token": new_access, "refresh_token": "rotated-refresh"}
        ).encode("utf-8")
    )
    monkeypatch.setattr(uploads.urlrequest, "urlopen", lambda *args, **kwargs: response)

    client._refresh_session()
    persisted = json.loads(path.read_text(encoding="utf-8"))
    assert persisted["access_token"] == new_access
    assert persisted["refresh_token"] == "rotated-refresh"
    assert path.stat().st_mode & 0o777 == 0o600
    assert list(tmp_path.glob(".*.tmp")) == []

    # Reload through the production factory to model a new process without
    # relying on stale access/refresh environment values.
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    monkeypatch.setenv("SUPABASE_ACCESS_TOKEN", old_access)
    monkeypatch.setenv("SUPABASE_REFRESH_TOKEN", "old-refresh")
    restarted = SupabaseAdminClient.from_environment(session_file=path)
    assert restarted.access_token == new_access
    assert restarted.refresh_token == "rotated-refresh"


class UncertainCompletionRemote(FakeRemote):
    def __init__(self, pdf: Path):
        super().__init__(pdf)
        self.committed = False
        self.owner_token = None

    def claim_upload(self, submission_id: str, claim_id: str) -> dict:
        if self.owner_token is None:
            self.owner_token = claim_id
        assert claim_id == self.owner_token
        self.events.append(("claim", submission_id, claim_id))
        if self.committed:
            return {
                "id": submission_id,
                "status": "approved",
                "paper_id": "paper",
                "question_count": 2,
                "processing_claim_id": claim_id,
            }
        return super().claim_upload(submission_id, claim_id)

    def complete_upload(self, submission_id: str, claim_id: str, paper_id: str, count: int):
        self.events.append(("complete", submission_id, claim_id, paper_id, count))
        self.committed = True
        raise uploads.SupabaseRequestError("connection closed before response")

    def fail_upload(self, submission_id: str, claim_id: str, message: str):
        self.events.append(("fail", submission_id, claim_id, message))
        raise uploads.SupabaseRequestError("row is already approved", 409)


def test_uncertain_completion_rerun_uses_durable_claim_token(
    config, sample_pdf, monkeypatch, tmp_path
):
    submission_id = str(uuid.uuid4())
    remote = UncertainCompletionRemote(sample_pdf)
    qids = ["paper-q1", "paper-q2"]
    process_calls = []

    def fake_process(*args, **kwargs):
        process_calls.append(1)
        return {"paper_id": "paper", "skipped": False, "questions": 2}

    monkeypatch.setattr(uploads, "process_pdf", fake_process)
    monkeypatch.setattr(uploads, "_validate_processed_paper", lambda *args, **kwargs: (2, qids))

    def fake_export(config, out, **kwargs):
        out = Path(out)
        (out / "questions").mkdir(parents=True, exist_ok=True)
        (out / "questions" / "lookup.json").write_text(
            json.dumps({qid: ["maths", 0] for qid in qids}), encoding="utf-8"
        )
        return {"counts": {"questions": 2}}

    monkeypatch.setattr("pipeline.export_static.export_static", fake_export)
    with pytest.raises(RemoteUploadError, match="durable claim token was retained"):
        process_remote_upload(config, submission_id, remote, export_out=tmp_path / "content")

    claim_file = (
        Path(config.paths["papers_dir"])
        / "student-uploads"
        / submission_id
        / ".processing-claim.json"
    )
    assert claim_file.exists()
    first_token = remote.owner_token

    recovered = process_remote_upload(
        config, submission_id, remote, export_out=tmp_path / "content"
    )
    assert recovered["recovered_completion"] is True
    assert recovered["paper_id"] == "paper"
    assert remote.owner_token == first_token
    assert len(process_calls) == 1, "approved recovery must not republish or double-credit"
    assert not claim_file.exists()


class InvalidApprovedRecoveryRemote(FakeRemote):
    def __init__(self, pdf: Path, question_count):
        super().__init__(pdf)
        self.question_count = question_count

    def claim_upload(self, submission_id: str, claim_id: str) -> dict:
        self.events.append(("claim", submission_id, claim_id))
        return {
            "id": submission_id,
            "status": "approved",
            "paper_id": "paper",
            "question_count": self.question_count,
            "processing_claim_id": claim_id,
        }


@pytest.mark.parametrize("count", [None, 0, -1, "invalid"])
def test_approved_recovery_requires_positive_question_count(
    config, sample_pdf, tmp_path, count
):
    remote = InvalidApprovedRecoveryRemote(sample_pdf, count)
    with pytest.raises(RemoteUploadError, match="valid publication metadata"):
        process_remote_upload(
            config,
            str(uuid.uuid4()),
            remote,
            export_out=tmp_path / "content",
        )
    assert [event[0] for event in remote.events] == ["claim", "fail"]


class ByteResponse:
    def __init__(self, payload: bytes, declared: int | None = None):
        self.payload = payload
        self.offset = 0
        self.headers = {}
        if declared is not None:
            self.headers["Content-Length"] = str(declared)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, amount: int = -1):
        if amount < 0:
            amount = len(self.payload)
        data = self.payload[self.offset : self.offset + amount]
        self.offset += len(data)
        return data


@pytest.mark.parametrize(
    ("payload", "row_patch", "max_bytes", "message"),
    [
        (b"not-a-pdf", {}, 100, "size, signature, or SHA-256"),
        (b"%PDF-good", {"size_bytes": 99}, 100, "size, signature, or SHA-256"),
        (b"%PDF-good", {"sha256": "0" * 64}, 100, "size, signature, or SHA-256"),
        (b"%PDF-too-large", {}, 8, "size limit"),
    ],
)
def test_private_download_rejects_invalid_signature_size_hash_and_limit(
    monkeypatch, tmp_path, payload, row_patch, max_bytes, message
):
    client = SupabaseAdminClient(
        "https://example.supabase.co", "sb_publishable_test", _jwt("authenticated")
    )
    monkeypatch.setattr(client, "_request", lambda *args, **kwargs: {"signedURL": "/object/sign/paper-uploads/file.pdf?token=x"})
    monkeypatch.setattr(
        uploads.urlrequest,
        "urlopen",
        lambda *args, **kwargs: ByteResponse(payload, len(payload)),
    )
    row = {"storage_path": "student/file.pdf", "size_bytes": len(payload)}
    row.update(row_patch)
    with pytest.raises(RemoteUploadError, match=message):
        client.download_upload(row, tmp_path / "paper.pdf", max_bytes)
    assert not (tmp_path / "paper.pdf").exists()
    assert not list(tmp_path.glob("*.part-*"))


def test_private_download_rejects_cross_project_signed_url():
    client = SupabaseAdminClient(
        "https://example.supabase.co", "sb_publishable_test", _jwt("authenticated")
    )
    with pytest.raises(RemoteUploadError, match="untrusted signed URL"):
        client._trusted_signed_url("https://attacker.example/file.pdf?token=stolen")


def test_expiring_admin_session_refreshes_and_persists_rotation(monkeypatch):
    old_refresh = "old-refresh"
    next_token = _jwt("authenticated")
    client = SupabaseAdminClient(
        "https://example.supabase.co",
        "sb_publishable_test",
        _jwt("authenticated", int(time.time()) + 30),
        old_refresh,
    )
    seen = []

    def fake_urlopen(req, timeout):
        seen.append(json.loads(req.data.decode("utf-8")))
        return ByteResponse(
            json.dumps({"access_token": next_token, "refresh_token": "rotated-refresh"}).encode()
        )

    monkeypatch.setattr(uploads.urlrequest, "urlopen", fake_urlopen)
    client._ensure_session()
    assert seen == [{"refresh_token": old_refresh}]
    assert client.access_token == next_token
    assert client.refresh_token == "rotated-refresh"
