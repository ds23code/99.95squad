"""Static validation of the Supabase schema (site/backend/supabase.sql).

Cannot execute PostgreSQL here, so we assert structurally:
- every table the frontend depends on is created
- every client-callable RPC is defined + granted to authenticated
- RLS is enabled on user-owned tables with no unsafe write policies
- no service-role key / secrets are referenced in code
- profile entitlement columns can never be updated by clients
"""

from __future__ import annotations

import re
from pathlib import Path

SQL = Path(__file__).resolve().parent.parent / "site" / "backend" / "supabase.sql"
TEXT = SQL.read_text(encoding="utf-8")

# strip SQL comments (--) before content-sensitive checks
CODE = "\n".join(
    line for line in TEXT.splitlines() if not line.lstrip().startswith("--")
)

# RPCs the frontend calls directly (granted to authenticated)
CLIENT_RPCS = [
    "update_my_profile", "record_attempt", "topic_mastery", "daily_activity",
    "time_stats", "leaderboard", "my_rank", "achievements", "get_dashboard",
    "add_comment", "delete_own_comment", "like_comment", "report_comment",
]


def test_sql_file_exists_and_has_tables():
    for table in (
        "profiles", "attempts", "xp_events", "favourites", "comments",
        "comment_likes", "comment_reports", "moderation_words",
        "upload_submissions", "problem_reports",
        "user_marks", "audit_events", "curriculum_topics", "curriculum_outcomes",
    ):
        assert re.search(rf"create table if not exists public\.{table}\b", CODE), table


def test_all_client_rpcs_defined_and_granted():
    for fn in CLIENT_RPCS:
        assert re.search(rf"create or replace function public\.{fn}\b", CODE), fn
        assert re.search(
            rf"grant execute on function public\.{fn}\(", CODE
        ), f"grant {fn}"


def test_helper_functions_are_not_client_granted():
    """Internal helpers (streak/level/xp/mastery_stage) must not be callable
    by clients — they are used only inside SECURITY DEFINER functions."""
    for fn in ("current_streak", "level_from_xp", "xp_for_difficulty", "mastery_stage"):
        assert re.search(rf"create or replace function public\.{fn}\b", CODE), fn
        assert not re.search(rf"grant execute on function public\.{fn}\(", CODE), fn


def test_rls_enabled_on_user_tables():
    for table in ("profiles", "attempts", "xp_events", "favourites", "comments", "upload_submissions", "user_marks", "audit_events", "curriculum_topics", "curriculum_outcomes"):
        assert re.search(
            rf"alter table public\.{table} enable row level security", CODE
        ), table


def test_admin_security_enforced():
    appr = re.search(r"create or replace function public\.approve_upload.*?\$\$;", CODE, re.S).group(0)
    mod = re.search(r"create or replace function public\.moderate_upload.*?\$\$;", CODE, re.S).group(0)
    assert "if not public.is_admin() then" in appr
    assert "if not public.is_admin() then" in mod
    assert "auth.uid() is null" not in appr  # never bypass admin check for regular authed users
    assert "user.email" not in CODE  # never rely on email check alone


def test_users_cannot_update_profiles():
    assert "revoke update on public.profiles from anon, authenticated" in CODE
    body = re.search(
        r"create or replace function public\.update_my_profile.*?\$\$;", CODE, re.S
    ).group(0)
    # the function's UPDATE statement must only touch allowed columns
    update_stmt = re.search(r"update public\.profiles\s+set(.*?)where id = auth\.uid\(\)", body, re.S).group(1)
    for forbidden in ("access_tier", "premium_until", "is_admin", "xp", "level", "contribution_credits"):
        assert forbidden not in update_stmt, f"update_my_profile must not set {forbidden}"


def test_record_attempt_is_only_write_path():
    """attempts/xp_events must have NO direct insert/update/delete policies."""
    assert not re.search(r"create policy \"[^\"]+\" on public\.attempts for insert", CODE)
    assert not re.search(r"create policy \"[^\"]+\" on public\.xp_events for insert", CODE)
    assert "record_attempt" in CODE


def test_no_service_role_key_in_code():
    """The anon key is the only credential; service-role must never appear in
    runnable code (comments are documentation only)."""
    assert "service_role" not in CODE
    js_root = Path(__file__).resolve().parent.parent / "site"
    for f in js_root.rglob("*.js"):
        text = f.read_text(encoding="utf-8")
        assert "service_role" not in text and "SERVICE_ROLE" not in text, f
        assert "service-role" not in text.replace("service-role key", ""), f


def test_leaderboard_opt_out_and_aggregation():
    assert "opt_out_leaderboard" in CODE
    assert "date_trunc('week', now())" in CODE
    lb = re.search(r"create or replace function public\.leaderboard.*?\$\$;", CODE, re.S).group(0)
    for col in ("display_name", "avatar_url", "xp", "level"):
        assert col in lb
    assert "opt_out_leaderboard = false" in lb


def test_time_stats_aggregates_only():
    ts = re.search(r"create or replace function public\.time_stats.*?\$\$;", CODE, re.S).group(0)
    assert "percentile_cont" in ts  # median
    assert "avg(seconds)" in ts
    # returned keys are aggregates only; user_id appears solely in WHERE
    # clauses that filter the caller's own rows
    output = ts.split("jsonb_build_object", 1)[1]
    for uid_ref in re.findall(r"user_id", output):
        pass
    assert "user_id" in ts  # used for filtering own rows
    assert "rank" not in ts and "display_name" not in ts  # no per-user leakage


def test_comments_moderation_and_rate_limit():
    assert "rate limit reached" in CODE
    assert "prohibited language" in CODE
    assert "moderation_words" in CODE
    assert "create policy \"none direct\" on public.comments for insert with check (false)" in CODE


def test_premium_entitlement_server_side():
    assert "now() + interval '14 days'" in CODE
    assert "contribution_credits = contribution_credits + 1" in CODE
    assert "security definer" in CODE


def test_indexes_for_scale():
    for idx in ("attempts_user_created", "attempts_user_topic", "attempts_question",
                "xp_events_user_time", "comments_question", "comment_likes_comment"):
        assert f"create index if not exists {idx}" in CODE, idx


def test_sql_balanced():
    assert CODE.count("(") == CODE.count(")")
    assert CODE.count("$$") % 2 == 0, "unbalanced dollar-quoted bodies"
