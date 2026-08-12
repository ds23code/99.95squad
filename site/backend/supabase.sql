-- ============================================================================
-- 99.95squad — Supabase migration
-- ============================================================================
-- Applies the latest backend/security changes to the existing database.
--
-- Changes:
--   * Enables/fixes RLS
--   * Allows attempts.correct to be NULL for skipped/unattempted questions
--   * Adds user_marks, audit_events, curriculum tables
--   * Adds duplicate/needs_changes upload fields
--   * Secures admin upload RPCs
--   * Adds/updates profile, attempt, comment and upload policies
-- ============================================================================


-- ============================================================================
-- PROFILES
-- ============================================================================

alter table public.profiles enable row level security;

drop policy if exists "own profile read" on public.profiles;
create policy "own profile read"
on public.profiles
for select
using (auth.uid() = id);

drop policy if exists "own profile insert" on public.profiles;
create policy "own profile insert"
on public.profiles
for insert
with check (auth.uid() = id);

-- Users must not directly modify protected profile fields.
revoke update on public.profiles from anon, authenticated;


-- ============================================================================
-- ATTEMPTS
-- ============================================================================

alter table public.attempts enable row level security;

-- Skipped/unattempted questions may have correct = NULL.
alter table public.attempts
  alter column correct drop not null;

drop policy if exists "own attempts read" on public.attempts;

create policy "own attempts read"
on public.attempts
for select
using (auth.uid() = user_id);

-- No direct INSERT/UPDATE/DELETE.
-- Attempts are recorded through record_attempt().


-- ============================================================================
-- XP EVENTS
-- ============================================================================

alter table public.xp_events enable row level security;

drop policy if exists "own xp read" on public.xp_events;

create policy "own xp read"
on public.xp_events
for select
using (auth.uid() = user_id);

-- No direct writes.
-- XP is generated server-side.


-- ============================================================================
-- FAVOURITES
-- ============================================================================

alter table public.favourites enable row level security;

drop policy if exists "own favourites read" on public.favourites;
create policy "own favourites read"
on public.favourites
for select
using (auth.uid() = user_id);

drop policy if exists "own favourites insert" on public.favourites;
create policy "own favourites insert"
on public.favourites
for insert
with check (auth.uid() = user_id);

drop policy if exists "own favourites delete" on public.favourites;
create policy "own favourites delete"
on public.favourites
for delete
using (auth.uid() = user_id);


-- ============================================================================
-- COMMENTS
-- ============================================================================

alter table public.comments enable row level security;
alter table public.comment_likes enable row level security;
alter table public.comment_reports enable row level security;
alter table public.moderation_words enable row level security;

drop policy if exists "comments visible read" on public.comments;

create policy "comments visible read"
on public.comments
for select
using (status = 'visible');

drop policy if exists "none direct" on public.comments;

create policy "none direct"
on public.comments
for insert
with check (false);

drop policy if exists "none direct" on public.comment_likes;

create policy "none direct"
on public.comment_likes
for all
using (false);

drop policy if exists "none direct" on public.comment_reports;

create policy "none direct"
on public.comment_reports
for all
using (false);


-- ============================================================================
-- UPLOAD SUBMISSIONS
-- ============================================================================

-- Add new columns if they don't already exist.

alter table public.upload_submissions
  add column if not exists duplicate_of text;

alter table public.upload_submissions
  add column if not exists duplicate_type text;

-- Replace the status constraint so that needs_changes is allowed.

alter table public.upload_submissions
  drop constraint if exists upload_submissions_status_check;

alter table public.upload_submissions
  add constraint upload_submissions_status_check
  check (
    status in (
      'pending',
      'processing',
      'approved',
      'rejected',
      'duplicate',
      'needs_review',
      'needs_changes'
    )
  );

alter table public.upload_submissions enable row level security;


-- Users can only see their own submissions.
drop policy if exists "submission status readable"
on public.upload_submissions;

create policy "submission status readable"
on public.upload_submissions
for select
using (
  auth.uid() = uploader
  or public.is_admin()
);


-- Users can create their own submissions.
drop policy if exists "submission insert"
on public.upload_submissions;

create policy "submission insert"
on public.upload_submissions
for insert
with check (
  auth.uid() = uploader
);


-- Remove direct user updates.
-- Moderation/status changes happen through SECURITY DEFINER functions.
drop policy if exists "submission owner update"
on public.upload_submissions;


-- ============================================================================
-- PROBLEM REPORTS
-- ============================================================================

alter table public.problem_reports enable row level security;

drop policy if exists "report insert"
on public.problem_reports;

create policy "report insert"
on public.problem_reports
for insert
with check (
  auth.uid() = reporter
);

drop policy if exists "report select"
on public.problem_reports;

create policy "report select"
on public.problem_reports
for select
using (
  auth.uid() = reporter
  or public.is_admin()
);


-- ============================================================================
-- USER MARKS
-- ============================================================================

create table if not exists public.user_marks (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  question_id text not null,
  kind        text not null
              check (
                kind in (
                  'completed',
                  'flagged',
                  'favourite',
                  'correct',
                  'incorrect',
                  'skipped'
                )
              ),
  created_at  timestamptz not null default now(),

  unique(user_id, question_id, kind)
);

create index if not exists idx_user_marks_user
on public.user_marks(user_id, kind);

alter table public.user_marks enable row level security;

drop policy if exists "own marks read"
on public.user_marks;

create policy "own marks read"
on public.user_marks
for select
using (
  auth.uid() = user_id
);

drop policy if exists "own marks write"
on public.user_marks;

create policy "own marks write"
on public.user_marks
for all
using (
  auth.uid() = user_id
)
with check (
  auth.uid() = user_id
);


-- ============================================================================
-- AUDIT EVENTS
-- ============================================================================

create table if not exists public.audit_events (
  id              uuid primary key default gen_random_uuid(),
  actor           text not null,
  action          text not null,
  target_id       text not null,
  previous_status text,
  new_status      text,
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_audit_events_target
on public.audit_events(target_id, created_at desc);

alter table public.audit_events enable row level security;

drop policy if exists "audit events readable"
on public.audit_events;

create policy "audit events readable"
on public.audit_events
for select
using (
  public.is_admin()
);


-- ============================================================================
-- CURRICULUM TOPICS
-- ============================================================================

create table if not exists public.curriculum_topics (
  id          text primary key,
  course_id   text not null,
  year_level  integer default 12,
  module      text,
  name        text not null
);

create index if not exists idx_curriculum_topics_course
on public.curriculum_topics(course_id);

alter table public.curriculum_topics enable row level security;

drop policy if exists "curriculum status readable"
on public.curriculum_topics;

create policy "curriculum status readable"
on public.curriculum_topics
for select
using (true);


-- ============================================================================
-- CURRICULUM OUTCOMES
-- ============================================================================

create table if not exists public.curriculum_outcomes (
  id            text primary key,
  topic_id      text not null
                references public.curriculum_topics(id)
                on delete cascade,
  code          text not null,
  description   text not null,
  skill_concept text
);

create index if not exists idx_curriculum_outcomes_topic
on public.curriculum_outcomes(topic_id);

alter table public.curriculum_outcomes enable row level security;

drop policy if exists "outcomes status readable"
on public.curriculum_outcomes;

create policy "outcomes status readable"
on public.curriculum_outcomes
for select
using (true);


-- ============================================================================
-- ADMIN HELPER
-- ============================================================================

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select is_admin
      from public.profiles
      where id = auth.uid()
    ),
    false
  );
$$;


-- ============================================================================
-- ADMIN: APPROVE UPLOAD
-- ============================================================================

create or replace function public.approve_upload(
  submission_id uuid
)
returns public.upload_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  sub public.upload_submissions;
begin

  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select *
  into sub
  from public.upload_submissions
  where id = submission_id;

  if sub is null then
    raise exception 'submission not found';
  end if;

  update public.upload_submissions
  set
    status = 'approved',
    premium_granted = true,
    reviewed_at = now(),
    reviewed_by = auth.uid()
  where id = submission_id;

  if sub.uploader is not null then

    update public.profiles
    set
      access_tier = 'contributor',
      premium_until = greatest(
        coalesce(premium_until, now()),
        now() + interval '14 days'
      ),
      contribution_credits = contribution_credits + 1
    where id = sub.uploader;

  end if;

  select *
  into sub
  from public.upload_submissions
  where id = submission_id;

  return sub;

end;
$$;


-- ============================================================================
-- ADMIN: MODERATE UPLOAD
-- ============================================================================

create or replace function public.moderate_upload(
  submission_id uuid,
  new_status text
)
returns public.upload_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  sub public.upload_submissions;
begin

  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  if new_status not in (
    'rejected',
    'duplicate',
    'needs_review',
    'needs_changes',
    'approved',
    'pending'
  ) then
    raise exception 'invalid status';
  end if;

  update public.upload_submissions
  set
    status = new_status,
    reviewed_at = now(),
    reviewed_by = auth.uid()
  where id = submission_id;

  select *
  into sub
  from public.upload_submissions
  where id = submission_id;

  if sub is null then
    raise exception 'submission not found';
  end if;

  return sub;

end;
$$;


-- ============================================================================
-- GRANTS
-- ============================================================================

grant execute on function public.approve_upload(uuid)
to authenticated;

grant execute on function public.moderate_upload(uuid, text)
to authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
