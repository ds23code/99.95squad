"""Student uploads & contributor moderation.

A student uploads a PDF:

    register_upload(pdf_path, uploader) -> status
        new          queued for review (status=pending)
        duplicate    sha256 already known (papers or submissions)

A reviewer (admin) then:

    approve_upload(id, reviewer)
        runs the PDF through the normal pipeline,
        links paper_id, grants the uploader 14 days of premium access
    reject_upload / mark_duplicate / needs_review

Statuses: pending, queued, processing, approved, rejected, duplicate,
needs_review, needs_changes. Remote moderation queues exactly one selected
submission; the admin-authenticated CLI below claims, downloads, processes,
validates, exports, and reports completion or failure.

Nothing uploaded is ever public before approval — moderation is a real gate,
not a client-side illusion.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import stat
from contextlib import contextmanager
import re
import time
import uuid
from pathlib import Path
from typing import Optional
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

from .config import Config
from .database import Database
from .ingest import sha256_of_file
from .process import PipelineError, process_pdf

log = logging.getLogger(__name__)

STATUSES = ("pending", "queued", "processing", "approved", "rejected", "duplicate", "needs_review", "needs_changes")
PREMIUM_GRANT_DAYS = 14
DEFAULT_REMOTE_MAX_BYTES = 25 * 1024 * 1024


class RemoteUploadError(RuntimeError):
    """A controlled remote-submission operation failed."""


class SupabaseRequestError(RemoteUploadError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def register_upload(
    config: Config,
    pdf_path: str | Path,
    uploader: str = "local",
    db: Optional[Database] = None,
) -> dict:
    """Register a student upload. Returns {status, upload, reason}.

    status: "new" | "duplicate" | "error"
    """
    pdf_path = Path(pdf_path)
    own_db = db is None
    db = db or Database(config.paths["database"])
    if own_db:
        db.init_schema()

    if not pdf_path.exists() or pdf_path.suffix.lower() != ".pdf":
        return {"status": "error", "reason": "not-a-pdf"}

    # abuse protection: size + magic bytes (mirrors the backend triggers)
    max_bytes = int(config.get("uploads", "max_bytes", default=25 * 1024 * 1024))
    if pdf_path.stat().st_size > max_bytes:
        return {"status": "error", "reason": "too-large"}
    with open(pdf_path, "rb") as fh:
        magic = fh.read(5)
    if not magic.startswith(b"%PDF-"):
        return {"status": "error", "reason": "not-a-pdf"}

    digest = sha256_of_file(pdf_path)

    # 1. already a processed paper?
    existing_paper = db.get_paper_by_sha256(digest)
    if existing_paper:
        upload_id = f"up-{uuid.uuid4().hex[:12]}"
        db.upsert_upload(
            {
                "id": upload_id,
                "sha256": digest,
                "filename": pdf_path.name,
                "file_path": str(pdf_path),
                "size_bytes": pdf_path.stat().st_size,
                "uploader": uploader,
                "status": "duplicate",
                "paper_id": existing_paper["id"],
                "premium_granted": 0,
                "review_notes": f"Exact SHA256 duplicate of approved paper {existing_paper['id']}",
                "duplicate_of": existing_paper["id"],
                "duplicate_type": "exact_sha256",
            }
        )
        row = db.get_upload_by_sha256(digest)
        db.record_audit_event(
            actor=uploader,
            action="duplicate_detected",
            target_id=row["id"] if row else upload_id,
            new_status="duplicate",
            notes="exact sha256 match with approved paper",
        )
        result = {
            "status": "duplicate",
            "reason": "already-in-library",
            "duplicate_type": "exact_sha256",
            "paper": existing_paper,
            "upload": row,
        }
    else:
        # 2. already submitted?
        existing_upload = db.get_upload_by_sha256(digest)
        if existing_upload:
            db.record_audit_event(
                actor=uploader,
                action="duplicate_detected",
                target_id=existing_upload["id"],
                new_status="duplicate",
                notes="exact sha256 match with existing upload",
            )
            result = {
                "status": "duplicate",
                "reason": "already-submitted",
                "duplicate_type": "exact_sha256",
                "upload": existing_upload,
            }
        else:
            from .ingest import FilenameParser

            parser = FilenameParser(config)
            meta = parser.parse(pdf_path.name)
            matching_ids = []
            if meta.get("course_id") and meta.get("year"):
                matching_papers = db.find_papers_by_metadata(
                    course_id=meta.get("course_id"),
                    year=meta.get("year"),
                    organisation=meta.get("organisation"),
                    paper_type=meta.get("paper_type"),
                )
                if matching_papers:
                    matching_ids.append(matching_papers[0]["id"])
                else:
                    for u in db.list_uploads():
                        umeta = parser.parse(u["filename"])
                        if (
                            umeta.get("course_id") == meta.get("course_id")
                            and umeta.get("year") == meta.get("year")
                        ):
                            matching_ids.append(u["id"])
                            break

            upload_id = f"up-{uuid.uuid4().hex[:12]}"
            if matching_ids:
                db.upsert_upload(
                    {
                        "id": upload_id,
                        "sha256": digest,
                        "filename": pdf_path.name,
                        "file_path": str(pdf_path),
                        "size_bytes": pdf_path.stat().st_size,
                        "uploader": uploader,
                        "status": "needs_review",
                        "paper_id": None,
                        "premium_granted": 0,
                        "review_notes": f"Potential metadata duplicate of {matching_ids[0]} ({pdf_path.name})",
                        "duplicate_of": matching_ids[0],
                        "duplicate_type": "metadata",
                    }
                )
                db.record_audit_event(
                    actor=uploader,
                    action="metadata_duplicate_detected",
                    target_id=upload_id,
                    new_status="needs_review",
                    notes="matching metadata with existing paper",
                )
                result = {
                    "status": "needs_review",
                    "reason": "metadata-duplicate",
                    "duplicate_type": "metadata",
                    "duplicate_of": matching_ids[0],
                    "upload": db.get_upload(upload_id),
                }
            else:
                db.upsert_upload(
                    {
                        "id": upload_id,
                        "sha256": digest,
                        "filename": pdf_path.name,
                        "file_path": str(pdf_path),
                        "size_bytes": pdf_path.stat().st_size,
                        "uploader": uploader,
                        "status": "pending",
                        "paper_id": None,
                        "premium_granted": 0,
                        "review_notes": None,
                        "duplicate_of": None,
                        "duplicate_type": None,
                    }
                )
                db.record_audit_event(
                    actor=uploader,
                    action="submission_created",
                    target_id=upload_id,
                    new_status="pending",
                )
                result = {
                    "status": "new",
                    "reason": "queued",
                    "upload": db.get_upload(upload_id),
                }
    if own_db:
        db.close()
    return result


def approve_upload(
    config: Config,
    upload_id: str,
    reviewer: str = "admin",
    db: Optional[Database] = None,
    *,
    grant_premium: bool = True,
) -> dict:
    """Approve a submission: process the PDF, link the paper, grant premium.

    Returns {status, paper_id, upload}.
    """
    own_db = db is None
    db = db or Database(config.paths["database"])
    if own_db:
        db.init_schema()

    upload = db.get_upload(upload_id)
    if upload is None:
        raise ValueError(f"unknown upload {upload_id}")
    if upload["status"] in ("approved", "processing"):
        raise ValueError(f"upload already {upload['status']}")

    pdf_path = Path(upload["file_path"])
    if not pdf_path.exists():
        db.set_upload_status(upload_id, "needs_review", reviewer, "file missing")
        return {"status": "needs_review", "reason": "file-missing", "upload": db.get_upload(upload_id)}

    db.set_upload_status(upload_id, "processing", reviewer)
    try:
        result = process_pdf(config, pdf_path, force=False, db=db)
        paper_id = result["paper_id"]
    except PipelineError as exc:
        log.exception("upload %s failed to process", upload_id)
        db.set_upload_status(upload_id, "needs_review", reviewer, f"processing failed: {exc}")
        return {"status": "needs_review", "reason": "processing-failed", "upload": db.get_upload(upload_id)}

    db.set_upload_status(upload_id, "approved", reviewer, paper_id=paper_id)
    db.exec("UPDATE upload_submissions SET premium_granted=? WHERE id=?", (1 if grant_premium else 0, upload_id))

    premium_until = None
    if grant_premium and upload["uploader"]:
        profile = db.get_profile(upload["uploader"]) or {
            "id": upload["uploader"],
            "email": None,
            "display_name": None,
            "access_tier": "free",
            "premium_until": None,
            "contribution_credits": 0,
        }
        db.upsert_profile(profile)
        updated = db.grant_premium(upload["uploader"], PREMIUM_GRANT_DAYS)
        premium_until = updated["premium_until"] if updated else None

    db.record_audit_event(
        actor=reviewer,
        action="submission_approved",
        target_id=upload_id,
        previous_status=upload["status"],
        new_status="approved",
        notes="submission approved and premium granted",
    )

    return {
        "status": "approved",
        "paper_id": paper_id,
        "premium_until": premium_until,
        "upload": db.get_upload(upload_id),
    }


def set_upload_status(
    config: Config,
    upload_id: str,
    status: str,
    reviewer: str = "admin",
    notes: str | None = None,
) -> dict:
    if status not in STATUSES:
        raise ValueError(f"invalid status {status!r}; expected one of {STATUSES}")
    db = Database(config.paths["database"])
    db.init_schema()
    old = db.get_upload(upload_id)
    old_status = old["status"] if old else None
    db.set_upload_status(upload_id, status, reviewer, notes)
    db.record_audit_event(
        actor=reviewer,
        action=f"status_changed_{status}",
        target_id=upload_id,
        previous_status=old_status,
        new_status=status,
        notes=notes,
    )
    result = db.get_upload(upload_id)
    db.close()
    return result or {"error": "unknown upload"}


def override_duplicate(
    config: Config,
    upload_id: str,
    new_status: str = "pending",
    reviewer: str = "admin",
    db: Optional[Database] = None,
) -> dict:
    """Override a duplicate detection decision."""
    if new_status not in STATUSES:
        raise ValueError(f"invalid status {new_status!r}; expected one of {STATUSES}")
    own_db = db is None
    db = db or Database(config.paths["database"])
    if own_db:
        db.init_schema()
    upload = db.get_upload(upload_id)
    if upload is None:
        if own_db:
            db.close()
        raise ValueError(f"unknown upload {upload_id}")
    old_status = upload["status"]
    db.set_upload_status(upload_id, new_status, reviewer, "duplicate overridden by admin")
    db.record_audit_event(
        actor=reviewer,
        action="duplicate_overridden",
        target_id=upload_id,
        previous_status=old_status,
        new_status=new_status,
        notes="duplicate decision overridden by admin",
    )
    result = db.get_upload(upload_id)
    if own_db:
        db.close()
    return result or {"error": "unknown upload"}


# ---------------------------------------------------------------------------
# Selected Supabase submission processing
# ---------------------------------------------------------------------------
def _jwt_payload(token: str) -> dict:
    """Decode JWT claims for local safety checks (not signature validation)."""
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part.encode("ascii")))
    except (IndexError, ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise RemoteUploadError("Supabase access token is not a valid session JWT") from exc


def _reject_service_role(token: str, label: str) -> None:
    """Prevent accidentally using a browser-forbidden service-role credential."""
    if token.strip().lower().startswith("sb_secret_"):
        raise RemoteUploadError(f"{label} must not be a Supabase secret/service-role key")
    if token.count(".") != 2:
        return  # modern publishable keys are opaque, not JWTs
    role = _jwt_payload(token).get("role")
    if role == "service_role":
        raise RemoteUploadError(f"{label} must not be a Supabase service-role key")


class SupabaseAdminClient:
    """Small REST client using an admin user's rotating Supabase session.

    The publishable/anon key identifies the project. Authorization is always
    the user's ``authenticated`` access token; SQL RPCs independently verify
    ``profiles.is_admin``. No service-role credential is accepted or needed.
    """

    def __init__(
        self,
        url: str,
        anon_key: str,
        access_token: str,
        refresh_token: str | None = None,
        *,
        timeout: int = 60,
        session_file: str | Path | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self.anon_key = anon_key.strip()
        self.access_token = access_token.strip()
        self.refresh_token = (refresh_token or "").strip() or None
        self.timeout = timeout
        self.session_file = self._session_path(session_file) if session_file else None
        parsed = urlparse.urlparse(self.url)
        if parsed.scheme != "https" or not parsed.netloc:
            raise RemoteUploadError("Supabase URL must be an https:// project URL")
        if not self.anon_key or not self.access_token:
            raise RemoteUploadError("Supabase publishable key and admin session are required")
        _reject_service_role(self.anon_key, "Publishable key")
        _reject_service_role(self.access_token, "Access token")
        if _jwt_payload(self.access_token).get("role") != "authenticated":
            raise RemoteUploadError("access token is not an authenticated user session")

    @staticmethod
    def _session_path(value: str | Path) -> Path:
        path = Path(value).expanduser()
        if not path.is_absolute():
            raise RemoteUploadError("Supabase session file must be an absolute path")
        if path.is_symlink():
            raise RemoteUploadError("Supabase session file must not be a symbolic link")
        if path.exists():
            details = path.stat()
            if not stat.S_ISREG(details.st_mode):
                raise RemoteUploadError("Supabase session file must be a regular file")
            if details.st_mode & 0o077:
                raise RemoteUploadError(
                    "Supabase session file permissions are too broad; run chmod 600 on it"
                )
            if hasattr(os, "geteuid") and details.st_uid != os.geteuid():
                raise RemoteUploadError("Supabase session file must be owned by the current user")
        return path

    @classmethod
    def _read_session_file(cls, path: Path) -> tuple[str, str]:
        path = cls._session_path(path)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            access = str(payload.get("access_token") or "").strip()
            refresh = str(payload.get("refresh_token") or "").strip()
        except (OSError, UnicodeError, json.JSONDecodeError, AttributeError) as exc:
            raise RemoteUploadError(f"could not read Supabase session file: {path}") from exc
        if not access or not refresh:
            raise RemoteUploadError(
                "Supabase session file must contain access_token and refresh_token"
            )
        return access, refresh

    def _persist_session(self) -> None:
        """Atomically persist the current rotating token pair with mode 0600."""
        if self.session_file is None:
            return
        path = self._session_path(self.session_file)
        parent = path.parent
        if not parent.is_dir():
            raise RemoteUploadError(f"Supabase session-file directory does not exist: {parent}")
        payload = json.dumps(
            {
                "access_token": self.access_token,
                "refresh_token": self.refresh_token,
                "updated_at": int(time.time()),
            },
            sort_keys=True,
        ) + "\n"
        temporary = parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            os.chmod(path, 0o600)
            try:
                directory_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # The file itself is already fsynced and atomically replaced;
                # directory fsync is not supported by every platform/filesystem.
                pass
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            raise RemoteUploadError(f"could not persist Supabase session file: {path}") from exc

    @classmethod
    def from_environment(
        cls, *, session_file: str | Path | None = None, **kwargs
    ) -> "SupabaseAdminClient":
        project_key = os.environ.get("SUPABASE_ANON_KEY") or os.environ.get(
            "SUPABASE_PUBLISHABLE_KEY"
        )
        missing = []
        if not os.environ.get("SUPABASE_URL"):
            missing.append("SUPABASE_URL")
        if not project_key:
            missing.append("SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY")

        selected = session_file or os.environ.get("SUPABASE_SESSION_FILE")
        selected_path = cls._session_path(selected) if selected else None
        if selected_path is not None and selected_path.exists():
            access_token, refresh_token = cls._read_session_file(selected_path)
        else:
            access_token = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
            refresh_token = os.environ.get("SUPABASE_REFRESH_TOKEN", "")
            if not access_token:
                missing.append("SUPABASE_ACCESS_TOKEN or an existing SUPABASE_SESSION_FILE")
            if selected_path is not None and not refresh_token:
                missing.append("SUPABASE_REFRESH_TOKEN to initialise SUPABASE_SESSION_FILE")

        if missing:
            raise RemoteUploadError("missing environment variable(s): " + ", ".join(missing))
        client = cls(
            os.environ["SUPABASE_URL"],
            project_key,
            access_token,
            refresh_token,
            session_file=selected_path,
            **kwargs,
        )
        if selected_path is not None and not selected_path.exists():
            client._persist_session()
        return client

    def _refresh_session(self) -> None:
        if not self.refresh_token:
            raise RemoteUploadError(
                "admin session expired; a refresh token is required for a recoverable long-running job"
            )
        req = urlrequest.Request(
            self.url + "/auth/v1/token?grant_type=refresh_token",
            data=json.dumps({"refresh_token": self.refresh_token}).encode("utf-8"),
            headers={
                "apikey": self.anon_key,
                "Content-Type": "application/json",
                "User-Agent": "99.95squad-controlled-ingestion/1",
            },
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urlerror.HTTPError as exc:
            message = _http_error_message(exc)
            raise SupabaseRequestError(f"could not refresh admin session: {message}", exc.code) from exc
        except (urlerror.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise SupabaseRequestError(f"could not refresh admin session: {exc}") from exc
        token = str(payload.get("access_token") or "")
        refresh = str(payload.get("refresh_token") or "")
        _reject_service_role(token, "Refreshed access token")
        if not token or _jwt_payload(token).get("role") != "authenticated" or not refresh:
            raise RemoteUploadError("Supabase returned an invalid refreshed session")
        self.access_token = token
        self.refresh_token = refresh
        # Supabase refresh tokens rotate and are single-use. Persist the pair
        # before issuing any further request so a later process restart never
        # falls back to the consumed token.
        self._persist_session()

    def _ensure_session(self) -> None:
        payload = _jwt_payload(self.access_token)
        expires = int(payload.get("exp") or 0)
        if expires <= int(time.time()) + 300:
            self._refresh_session()

    def _request(
        self,
        path: str,
        body: dict | None = None,
        *,
        method: str = "POST",
        retry_auth: bool = True,
        retry_network: bool = False,
    ):
        self._ensure_session()
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urlrequest.Request(
            self.url + path,
            data=data,
            headers={
                "apikey": self.anon_key,
                "Authorization": "Bearer " + self.access_token,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "99.95squad-controlled-ingestion/1",
            },
            method=method,
        )
        try:
            with urlrequest.urlopen(req, timeout=self.timeout) as response:
                raw = response.read()
                return json.loads(raw.decode("utf-8")) if raw else None
        except urlerror.HTTPError as exc:
            if exc.code == 401 and retry_auth and self.refresh_token:
                self._refresh_session()
                return self._request(
                    path, body, method=method, retry_auth=False, retry_network=retry_network
                )
            raise SupabaseRequestError(_http_error_message(exc), exc.code) from exc
        except (urlerror.URLError, TimeoutError) as exc:
            if retry_network:
                return self._request(
                    path, body, method=method, retry_auth=retry_auth, retry_network=False
                )
            raise SupabaseRequestError(f"Supabase request failed: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise SupabaseRequestError("Supabase returned invalid JSON") from exc

    def rpc(self, name: str, body: dict, *, retry_network: bool = False):
        return self._request(
            "/rest/v1/rpc/" + urlparse.quote(name, safe=""),
            body,
            retry_network=retry_network,
        )

    def claim_upload(self, submission_id: str, claim_id: str) -> dict:
        row = self.rpc(
            "claim_upload_for_processing",
            {"submission_id": submission_id, "p_claim_id": claim_id},
            retry_network=True,
        )
        if isinstance(row, list):
            row = row[0] if row else None
        if not isinstance(row, dict):
            raise RemoteUploadError("claim RPC did not return a submission")
        return row

    def complete_upload(self, submission_id: str, claim_id: str, paper_id: str, count: int) -> dict:
        row = self.rpc(
            "complete_upload_processing",
            {
                "submission_id": submission_id,
                "p_claim_id": claim_id,
                "p_paper_id": paper_id,
                "p_question_count": count,
            },
            retry_network=True,
        )
        return row[0] if isinstance(row, list) and row else row

    def fail_upload(self, submission_id: str, claim_id: str, message: str) -> dict:
        row = self.rpc(
            "fail_upload_processing",
            {"submission_id": submission_id, "p_claim_id": claim_id, "p_error": message[:4000]},
            retry_network=True,
        )
        return row[0] if isinstance(row, list) and row else row

    def download_upload(self, row: dict, destination: Path, max_bytes: int) -> Path:
        storage_path = str(row.get("storage_path") or "").strip()
        if not storage_path:
            raise RemoteUploadError("claimed submission has no storage_path")
        quoted = "/".join(urlparse.quote(part, safe="") for part in storage_path.split("/"))
        signed = self._request(
            "/storage/v1/object/sign/paper-uploads/" + quoted,
            {"expiresIn": 600},
        )
        signed_path = signed.get("signedURL") if isinstance(signed, dict) else None
        if not signed_path:
            raise RemoteUploadError("Storage did not return a signed download URL")
        download_url = self._trusted_signed_url(str(signed_path))
        destination.parent.mkdir(parents=True, exist_ok=True)

        expected_hash = str(row.get("sha256") or "").lower()
        expected_size = int(row["size_bytes"]) if row.get("size_bytes") is not None else None
        if destination.exists() and _download_matches(destination, expected_hash, expected_size, max_bytes):
            return destination

        part = destination.with_name(destination.name + ".part-" + uuid.uuid4().hex[:8])
        req = urlrequest.Request(
            download_url,
            headers={"User-Agent": "99.95squad-controlled-ingestion/1"},
        )
        size = 0
        try:
            with urlrequest.urlopen(req, timeout=self.timeout) as response, open(part, "wb") as fh:
                declared = response.headers.get("Content-Length")
                if declared and int(declared) > max_bytes:
                    raise RemoteUploadError("remote PDF exceeds configured size limit")
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise RemoteUploadError("remote PDF exceeds configured size limit")
                    fh.write(chunk)
            if not _download_matches(part, expected_hash, expected_size, max_bytes):
                raise RemoteUploadError("downloaded PDF failed size, signature, or SHA-256 validation")
            part.replace(destination)
            return destination
        except urlerror.HTTPError as exc:
            raise SupabaseRequestError("private PDF download failed: " + _http_error_message(exc), exc.code) from exc
        except (urlerror.URLError, TimeoutError) as exc:
            raise SupabaseRequestError(f"private PDF download failed: {exc}") from exc
        finally:
            part.unlink(missing_ok=True)

    def _trusted_signed_url(self, value: str) -> str:
        if value.startswith("/"):
            if not value.startswith("/storage/v1/"):
                value = "/storage/v1" + value
            return self.url + value
        parsed = urlparse.urlparse(value)
        base = urlparse.urlparse(self.url)
        if parsed.scheme != "https" or parsed.netloc != base.netloc:
            raise RemoteUploadError("Storage returned an untrusted signed URL")
        return value


def _http_error_message(exc: urlerror.HTTPError) -> str:
    try:
        payload = json.loads(exc.read().decode("utf-8"))
        return str(payload.get("message") or payload.get("msg") or payload.get("error_description") or payload.get("error") or f"HTTP {exc.code}")
    except (OSError, UnicodeError, json.JSONDecodeError):
        return f"HTTP {exc.code}"


def _download_matches(path: Path, expected_hash: str, expected_size: int | None, max_bytes: int) -> bool:
    try:
        size = path.stat().st_size
        if size <= 5 or size > max_bytes or (expected_size is not None and size != expected_size):
            return False
        with open(path, "rb") as fh:
            if not fh.read(5).startswith(b"%PDF-"):
                return False
        return not expected_hash or sha256_of_file(path).lower() == expected_hash
    except OSError:
        return False


def _safe_remote_filename(row: dict) -> str:
    original = Path(str(row.get("filename") or row.get("name") or "submission.pdf")).name
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", original).strip(" .")[:180]
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name or "submission.pdf"


def _validate_processed_paper(config: Config, db: Database, paper_id: str) -> tuple[int, list[str]]:
    paper = db.get_paper(paper_id)
    if not paper or paper.get("status") != "complete":
        raise RemoteUploadError("pipeline did not persist a complete paper")
    with db.conn() as conn:
        rows = [
            dict(row)
            for row in conn.execute(
                "SELECT id FROM questions WHERE paper_id=? ORDER BY page_start, question_number, question_occurrence",
                (paper_id,),
            ).fetchall()
        ]
    if not rows:
        raise RemoteUploadError("pipeline produced no questions")
    question_ids = [row["id"] for row in rows]

    from .validate import quality_check

    selected = set(question_ids)
    errors = [
        issue
        for issue in quality_check(config, db=db)["issues"]
        if issue["severity"] == "error" and issue.get("question_id") in selected
    ]
    if errors:
        detail = "; ".join(f"{i['code']}: {i['message']}" for i in errors[:5])
        raise RemoteUploadError("selected paper failed quality validation: " + detail)
    return len(question_ids), question_ids


def _claim_state(path: Path, submission_id: str) -> tuple[str, Path]:
    """Load or atomically create the durable token for one selected job.

    Retaining the token lets a rerun recover after a worker dies while a
    completion response is in flight. Supabase keeps that token on the
    approved row specifically so the retry can prove it owns the lifecycle.
    """
    path.mkdir(parents=True, exist_ok=True)
    state_path = path / ".processing-claim.json"
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
        if data.get("submission_id") != submission_id:
            raise RemoteUploadError("local processing claim belongs to another submission")
        claim_id = str(uuid.UUID(str(data.get("claim_id"))))
        return claim_id, state_path
    except FileNotFoundError:
        pass
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        if isinstance(exc, RemoteUploadError):
            raise
        raise RemoteUploadError(f"invalid local processing claim state: {state_path}") from exc

    claim_id = str(uuid.uuid4())
    payload = json.dumps(
        {"submission_id": submission_id, "claim_id": claim_id, "created_at": int(time.time())},
        sort_keys=True,
    )
    try:
        fd = os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return _claim_state(path, submission_id)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
    except BaseException:
        state_path.unlink(missing_ok=True)
        raise
    return claim_id, state_path


@contextmanager
def _remote_submission_lock(path: Path):
    """Prevent two local workers from sharing the same durable claim token."""
    path.mkdir(parents=True, exist_ok=True)
    lock_path = path / ".processing.lock"
    handle = open(lock_path, "a+", encoding="utf-8")
    try:
        try:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RemoteUploadError("this submission is already processing on this machine") from exc
        yield
    finally:
        try:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except (ImportError, OSError):
            pass
        handle.close()


def process_remote_upload(
    config: Config,
    submission_id: str,
    client: SupabaseAdminClient,
    *,
    export_out: str | Path = "site/content",
    max_bytes: int | None = None,
) -> dict:
    """Process exactly one admin-queued private Supabase submission.

    A per-submission claim token is stored beside the private local PDF. This
    makes a killed worker rerunnable with the same token, including when the
    completion transaction committed but its response was lost. A local file
    lock prevents concurrent commands from sharing that token.
    """
    try:
        submission_id = str(uuid.UUID(str(submission_id)))
    except ValueError as exc:
        raise RemoteUploadError("submission id must be a UUID") from exc

    local_dir = Path(config.paths["papers_dir"]) / "student-uploads" / submission_id
    with _remote_submission_lock(local_dir):
        claim_id, claim_path = _claim_state(local_dir, submission_id)
        return _process_remote_upload_locked(
            config,
            submission_id,
            claim_id,
            claim_path,
            local_dir,
            client,
            export_out=export_out,
            max_bytes=max_bytes,
        )


def _process_remote_upload_locked(
    config: Config,
    submission_id: str,
    claim_id: str,
    claim_path: Path,
    local_dir: Path,
    client: SupabaseAdminClient,
    *,
    export_out: str | Path,
    max_bytes: int | None,
) -> dict:
    claimed = False
    failure_reported = False
    db: Database | None = None
    try:
        row = client.claim_upload(submission_id, claim_id)
        claimed = True
        if str(row.get("id")) != submission_id:
            raise RemoteUploadError("claim RPC returned an unexpected submission")

        # A previous completion may have committed immediately before the
        # worker lost its response. The SQL claim RPC returns an approved row
        # only to the same retained claim token.
        if row.get("status") == "approved":
            paper_id = str(row.get("paper_id") or "").strip()
            question_count = row.get("question_count")
            if str(row.get("processing_claim_id") or "") != claim_id:
                raise RemoteUploadError("approved recovery row does not retain this worker's claim")
            try:
                question_count = int(question_count)
            except (TypeError, ValueError) as exc:
                raise RemoteUploadError(
                    "approved recovery row lacks valid publication metadata"
                ) from exc
            if not paper_id or question_count <= 0:
                raise RemoteUploadError("approved recovery row lacks valid publication metadata")
            claim_path.unlink(missing_ok=True)
            return {
                "status": "approved",
                "submission_id": submission_id,
                "paper_id": paper_id,
                "questions": int(question_count),
                "skipped": True,
                "export_out": str(Path(export_out)),
                "export_questions": int(question_count),
                "remote": row,
                "recovered_completion": True,
            }
        if row.get("status") != "processing":
            raise RemoteUploadError("claim RPC returned an unexpected submission")
        if str(row.get("processing_claim_id") or "") != claim_id:
            raise RemoteUploadError("claim RPC returned a different processing owner")

        limit = int(max_bytes or config.get("uploads", "max_bytes", default=DEFAULT_REMOTE_MAX_BYTES))
        pdf_path = client.download_upload(row, local_dir / _safe_remote_filename(row), limit)

        db = Database(config.paths["database"])
        db.init_schema()
        result = process_pdf(config, pdf_path, force=False, db=db)
        paper_id = str(result["paper_id"])
        question_count, question_ids = _validate_processed_paper(config, db, paper_id)
        if not isinstance(question_count, int) or isinstance(question_count, bool) or question_count <= 0:
            raise RemoteUploadError("processing validation returned a non-positive question count")
        if len(question_ids) != question_count:
            raise RemoteUploadError("processing validation returned an inconsistent question count")

        from .export_static import export_static

        export_path = Path(export_out)
        manifest = export_static(config, export_path, db=db, source="full")
        lookup_path = export_path / "questions" / "lookup.json"
        try:
            lookup = json.loads(lookup_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RemoteUploadError("static export did not produce a valid question lookup") from exc
        missing = [qid for qid in question_ids if qid not in lookup]
        if missing:
            raise RemoteUploadError(f"static export omitted {len(missing)} selected-paper question(s)")

        remote = client.complete_upload(submission_id, claim_id, paper_id, question_count)
        if not isinstance(remote, dict) or str(remote.get("id")) != submission_id:
            raise RemoteUploadError("completion RPC returned an unexpected submission")
        if remote.get("status") != "approved" or str(remote.get("paper_id") or "") != paper_id:
            raise RemoteUploadError("completion RPC did not confirm publication")
        if str(remote.get("processing_claim_id") or "") != claim_id:
            raise RemoteUploadError("completion RPC did not retain this worker's claim")
        claim_path.unlink(missing_ok=True)
        return {
            "status": "approved",
            "submission_id": submission_id,
            "paper_id": paper_id,
            "questions": question_count,
            "skipped": bool(result.get("skipped")),
            "export_out": str(export_path),
            "export_questions": manifest["counts"]["questions"],
            "remote": remote,
            "recovered_completion": False,
        }
    except BaseException as exc:
        if claimed:
            try:
                client.fail_upload(submission_id, claim_id, f"{type(exc).__name__}: {exc}")
                failure_reported = True
            except Exception as report_exc:
                # Keep the durable token. A rerun can reclaim an active lease
                # or recognize an approved same-token completion.
                raise RemoteUploadError(
                    f"processing failed ({exc}); failure reporting also failed ({report_exc}). "
                    "Rerun the same submission; its durable claim token was retained."
                ) from exc
        if failure_reported:
            claim_path.unlink(missing_ok=True)
        raise
    finally:
        if db is not None:
            db.close()
