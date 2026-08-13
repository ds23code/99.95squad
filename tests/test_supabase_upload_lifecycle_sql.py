"""Static contracts for the Supabase moderation state machine migration."""

from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
CANONICAL = ROOT / "site/backend/supabase.sql"
MIGRATION = ROOT / "site/backend/migrations/20260813_upload_processing_lifecycle.sql"


def _function(sql: str, name: str, next_name: str | None = None) -> str:
    start = sql.index(f"create or replace function public.{name}")
    if next_name:
        end = sql.index(f"create or replace function public.{next_name}", start)
    else:
        end = len(sql)
    return sql[start:end]


@pytest.mark.parametrize("path", [CANONICAL, MIGRATION])
def test_queue_does_not_grant_entitlement_before_processing(path):
    sql = path.read_text(encoding="utf-8")
    queue = _function(sql, "queue_upload", "approve_upload")
    complete = _function(sql, "complete_upload_processing", "fail_upload_processing")

    assert "status = 'queued'" in queue
    assert "premium_granted = true" not in queue
    assert "grant_premium" not in queue
    assert "status = 'approved'" in complete
    assert "premium_granted = true" in complete
    assert "contribution_credits = contribution_credits + 1" in complete


@pytest.mark.parametrize("path", [CANONICAL, MIGRATION])
def test_processing_claim_is_atomic_idempotent_and_leased(path):
    sql = path.read_text(encoding="utf-8")
    claim = _function(sql, "claim_upload_for_processing", "complete_upload_processing")
    complete = _function(sql, "complete_upload_processing", "fail_upload_processing")
    fail = _function(sql, "fail_upload_processing", "moderate_upload")

    assert "for update" in claim.lower()
    assert "processing_claim_id = p_claim_id" in claim
    assert "sub.status in ('processing', 'approved')" in claim
    assert "processing_claim_expires_at = now() + interval '6 hours'" in claim
    assert "processing_claim_expires_at <= now()" in claim
    assert "processing_attempts = processing_attempts + 1" in claim
    assert "sub.processing_claim_id = p_claim_id" in complete
    assert "processing_claim_id is distinct from p_claim_id" in complete
    assert "processing_claim_id = p_claim_id, processing_claim_expires_at = null" in complete
    assert "processing_claim_id = null" not in complete
    assert "processing_claim_id is distinct from p_claim_id" in fail
    assert "processing_error" in fail


@pytest.mark.parametrize("path", [CANONICAL, MIGRATION])
def test_lifecycle_rpcs_are_admin_checked_and_not_public(path):
    sql = path.read_text(encoding="utf-8")
    for name, next_name in (
        ("queue_upload", "approve_upload"),
        ("claim_upload_for_processing", "complete_upload_processing"),
        ("complete_upload_processing", "fail_upload_processing"),
        ("fail_upload_processing", "moderate_upload"),
    ):
        assert "public.is_admin()" in _function(sql, name, next_name)
    assert "revoke all on function public.queue_upload(uuid) from public, anon" in sql
    assert "grant execute on function public.complete_upload_processing(uuid, uuid, text, integer)" in sql
    assert "service_role" not in sql.lower()


@pytest.mark.parametrize("path", [CANONICAL, MIGRATION])
def test_queued_jobs_count_toward_upload_quota(path):
    sql = path.read_text(encoding="utf-8")
    quota = _function(sql, "limit_pending_uploads", "rate_limit_uploads")
    rate = _function(sql, "rate_limit_uploads")
    assert "status in ('pending', 'queued', 'processing')" in quota
    assert "pg_advisory_xact_lock" in quota
    assert "pg_advisory_xact_lock" in rate
    assert "idx_upload_submissions_active_quota" in sql
    assert "idx_upload_submissions_hourly_quota" in sql


@pytest.mark.parametrize("path", [CANONICAL, MIGRATION])
def test_completion_requires_questions_and_bucket_is_reconciled(path):
    sql = path.read_text(encoding="utf-8")
    complete = _function(sql, "complete_upload_processing", "fail_upload_processing")
    assert "p_question_count is null or p_question_count <= 0" in complete
    assert "on conflict (id) do update set" in sql
    assert "public = excluded.public" in sql
    assert "file_size_limit = excluded.file_size_limit" in sql
    assert "allowed_mime_types = excluded.allowed_mime_types" in sql
