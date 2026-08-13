-- 99.95squad: recoverable selected-upload processing lifecycle
-- Apply once in Supabase SQL Editor before using “Approve & queue” or the
-- controlled `python -m pipeline uploads process-remote <uuid>` command.
-- Additive/data-preserving: no tables or submissions are deleted.

begin;

alter table public.upload_submissions add column if not exists paper_id text;
alter table public.upload_submissions add column if not exists processing_error text;
alter table public.upload_submissions add column if not exists processing_attempts integer;
alter table public.upload_submissions add column if not exists processing_claim_id uuid;
alter table public.upload_submissions add column if not exists processing_claim_expires_at timestamptz;
alter table public.upload_submissions add column if not exists processing_started_at timestamptz;
alter table public.upload_submissions add column if not exists processing_finished_at timestamptz;
alter table public.upload_submissions add column if not exists publication_ready_at timestamptz;
alter table public.upload_submissions add column if not exists question_count integer;

update public.upload_submissions set processing_attempts = 0 where processing_attempts is null;
alter table public.upload_submissions alter column processing_attempts set default 0;
alter table public.upload_submissions alter column processing_attempts set not null;

alter table public.upload_submissions
  drop constraint if exists upload_submissions_status_check;
alter table public.upload_submissions
  add constraint upload_submissions_status_check
  check (status in (
    'pending', 'queued', 'processing', 'approved', 'rejected', 'duplicate',
    'needs_review', 'needs_changes'
  ));

create index if not exists idx_upload_submissions_active_quota
  on public.upload_submissions (uploader)
  where status in ('pending', 'queued', 'processing');
create index if not exists idx_upload_submissions_hourly_quota
  on public.upload_submissions (uploader, created_at desc);

-- Reconcile an existing bucket in place; no objects are deleted. This migration
-- must run as a role allowed to manage the storage schema (SQL Editor default).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'paper-uploads', 'paper-uploads', false, 26214400,
  array['application/pdf']
)
on conflict (id) do update set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Remove any partially deployed pre-claim overloads so they cannot remain as
-- alternate completion paths. These signatures were never part of production.
drop function if exists public.claim_upload_for_processing(uuid);
drop function if exists public.complete_upload_processing(uuid, text, integer);
drop function if exists public.fail_upload_processing(uuid, text);

create or replace function public.queue_upload(submission_id uuid)
returns public.upload_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  sub public.upload_submissions;
  prev text;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select * into sub from public.upload_submissions
  where id = submission_id for update;
  if sub is null then raise exception 'submission not found'; end if;
  if sub.status = 'approved' then return sub; end if;
  if sub.status = 'queued' then return sub; end if;
  if sub.status not in ('pending', 'needs_review', 'needs_changes') then
    raise exception 'submission cannot be queued from status %', sub.status;
  end if;
  if sub.storage_path is null or trim(sub.storage_path) = '' then
    raise exception 'submission has no stored PDF';
  end if;

  prev := sub.status;
  update public.upload_submissions
  set status = 'queued', reviewed_at = now(), reviewed_by = auth.uid(),
      processing_error = null, processing_claim_id = null,
      processing_claim_expires_at = null, processing_started_at = null,
      processing_finished_at = null, duplicate_of = null, duplicate_type = null
  where id = submission_id;

  insert into public.audit_events (actor, action, target_id, previous_status, new_status, notes)
  values (auth.uid()::text, 'queue_upload', submission_id::text, prev, 'queued',
          'approved by moderator; awaiting controlled processing');

  select * into sub from public.upload_submissions where id = submission_id;
  return sub;
end;
$$;

-- Backwards-compatible signature. Approval now means authorising processing;
-- it never grants premium or marks content approved before extraction succeeds.
create or replace function public.approve_upload(submission_id uuid)
returns public.upload_submissions
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Keep the compatibility wrapper independently protected as defence in
  -- depth, even though queue_upload performs the same server-side check.
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  return public.queue_upload(submission_id);
end;
$$;

create or replace function public.claim_upload_for_processing(
  submission_id uuid,
  p_claim_id uuid
)
returns public.upload_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  sub public.upload_submissions;
  prev text;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if p_claim_id is null then raise exception 'claim id required'; end if;

  select * into sub from public.upload_submissions
  where id = submission_id for update;
  if sub is null then raise exception 'submission not found'; end if;

  -- Retrying the same request after a network timeout is safe. Returning an
  -- approved row is limited to the retained owner token so a killed worker
  -- can recognize that its completion transaction committed.
  if sub.processing_claim_id = p_claim_id
     and sub.status in ('processing', 'approved') then
    return sub;
  end if;
  if sub.status <> 'queued' and not (
    sub.status = 'processing'
    and sub.processing_claim_expires_at is not null
    and sub.processing_claim_expires_at <= now()
  ) then
    raise exception 'submission is not queued or its processing lease is active';
  end if;

  prev := sub.status;
  update public.upload_submissions
  set status = 'processing',
      processing_attempts = processing_attempts + 1,
      processing_claim_id = p_claim_id,
      processing_claim_expires_at = now() + interval '6 hours',
      processing_started_at = now(), processing_finished_at = null,
      processing_error = null
  where id = submission_id
  returning * into sub;

  insert into public.audit_events (actor, action, target_id, previous_status, new_status, notes)
  values (auth.uid()::text, 'claim_upload_for_processing', submission_id::text,
          prev, 'processing', case when prev = 'processing'
            then 'reclaimed expired processing lease'
            else 'controlled processor claimed selected submission' end);
  return sub;
end;
$$;

create or replace function public.complete_upload_processing(
  submission_id uuid,
  p_claim_id uuid,
  p_paper_id text,
  p_question_count integer default null
)
returns public.upload_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  sub public.upload_submissions;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if nullif(trim(p_paper_id), '') is null then raise exception 'paper id required'; end if;
  if p_question_count is null or p_question_count <= 0 then
    raise exception 'positive question count required';
  end if;

  select * into sub from public.upload_submissions
  where id = submission_id for update;
  if sub is null then raise exception 'submission not found'; end if;
  if sub.status = 'approved'
     and sub.paper_id = trim(p_paper_id)
     and sub.processing_claim_id = p_claim_id then
    return sub;
  end if;
  if sub.status <> 'processing' then
    raise exception 'submission is not processing';
  end if;
  if sub.processing_claim_id is distinct from p_claim_id then
    raise exception 'processing claim does not own this submission';
  end if;

  update public.upload_submissions
  set status = 'approved', paper_id = trim(p_paper_id),
      question_count = p_question_count, processing_error = null,
      processing_finished_at = now(), publication_ready_at = now(),
      -- Retain the successful owner token. A worker whose completion response
      -- is lost can then prove that this exact transaction committed; claim
      -- expiry is no longer meaningful once processing is terminal.
      processing_claim_id = p_claim_id, processing_claim_expires_at = null,
      reviewed_at = now(), reviewed_by = auth.uid(), premium_granted = true
  where id = submission_id;

  if sub.uploader is not null and not sub.premium_granted then
    update public.profiles
    set access_tier = 'contributor',
        premium_until = greatest(coalesce(premium_until, now()), now()) + interval '14 days',
        contribution_credits = contribution_credits + 1,
        updated_at = now()
    where id = sub.uploader;
  end if;

  insert into public.audit_events (actor, action, target_id, previous_status, new_status, notes)
  values (auth.uid()::text, 'complete_upload_processing', submission_id::text,
          'processing', 'approved', 'paper_id=' || trim(p_paper_id)
          || coalesce(' questions=' || p_question_count::text, ''));

  select * into sub from public.upload_submissions where id = submission_id;
  return sub;
end;
$$;

create or replace function public.fail_upload_processing(
  submission_id uuid,
  p_claim_id uuid,
  p_error text
)
returns public.upload_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  sub public.upload_submissions;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  select * into sub from public.upload_submissions
  where id = submission_id for update;
  if sub is null then raise exception 'submission not found'; end if;
  if sub.status = 'needs_review' and sub.processing_claim_id = p_claim_id then return sub; end if;
  if sub.status <> 'processing' then raise exception 'submission is not processing'; end if;
  if sub.processing_claim_id is distinct from p_claim_id then
    raise exception 'processing claim does not own this submission';
  end if;

  update public.upload_submissions
  set status = 'needs_review', processing_error = left(coalesce(p_error, 'processing failed'), 4000),
      processing_finished_at = now(), processing_claim_expires_at = now(),
      publication_ready_at = null
  where id = submission_id;

  insert into public.audit_events (actor, action, target_id, previous_status, new_status, notes)
  values (auth.uid()::text, 'fail_upload_processing', submission_id::text,
          'processing', 'needs_review', left(coalesce(p_error, 'processing failed'), 1000));

  select * into sub from public.upload_submissions where id = submission_id;
  return sub;
end;
$$;

create or replace function public.moderate_upload(
  submission_id uuid,
  new_status text,
  p_notes text default null,
  p_duplicate_of text default null,
  p_duplicate_type text default null
)
returns public.upload_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  sub public.upload_submissions;
  prev text;
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

  select * into sub
  from public.upload_submissions
  where id = submission_id
  for update;

  if sub is null then
    raise exception 'submission not found';
  end if;
  if sub.status = 'processing' then
    raise exception 'active processing must finish through completion/failure RPC';
  end if;
  if sub.status = 'approved' and new_status <> 'approved' then
    raise exception 'approved submission is immutable';
  end if;

  prev := sub.status;

  if new_status = 'approved' then
    return public.queue_upload(submission_id);
  end if;

  if new_status = 'duplicate' then
    -- record what this submission duplicates (paper id / submission id) and
    -- how we know (exact hash, near-duplicate, already published, …)
    update public.upload_submissions
    set
      status = 'duplicate',
      reviewed_at = now(),
      reviewed_by = auth.uid(),
      note = coalesce(p_notes, note),
      duplicate_of = coalesce(nullif(trim(p_duplicate_of), ''), duplicate_of),
      duplicate_type = coalesce(nullif(trim(p_duplicate_type), ''), duplicate_type)
    where id = submission_id;
  else
    -- any non-duplicate decision clears duplicate markers
    update public.upload_submissions
    set
      status = new_status,
      reviewed_at = now(),
      reviewed_by = auth.uid(),
      note = coalesce(p_notes, note),
      duplicate_of = null,
      duplicate_type = null
    where id = submission_id;
  end if;

  insert into public.audit_events (actor, action, target_id, previous_status, new_status, notes)
  values (
    coalesce(auth.uid()::text, 'unknown'),
    'moderate_upload',
    submission_id::text,
    prev,
    new_status,
    coalesce(p_notes, '')
      || case when new_status = 'duplicate' and p_duplicate_of is not null
              then ' [duplicate_of=' || p_duplicate_of
                   || coalesce(' type=' || p_duplicate_type, '') || ']'
              else '' end
  );

  select * into sub from public.upload_submissions where id = submission_id;
  return sub;
end;
$$;


create or replace function public.harden_submission_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.uploader        := auth.uid();
  new.status          := 'pending';
  new.premium_granted := false;
  new.reviewed_at     := null;
  new.reviewed_by     := null;
  new.duplicate_of    := null;
  new.duplicate_type  := null;
  new.paper_id        := null;
  new.processing_error := null;
  new.processing_attempts := 0;
  new.processing_claim_id := null;
  new.processing_claim_expires_at := null;
  new.processing_started_at := null;
  new.processing_finished_at := null;
  new.publication_ready_at := null;
  new.question_count := null;
  if new.note is null then
    new.note := 'Pending review';
  end if;

  if new.storage_path is not null then
    if left(new.storage_path, length(auth.uid()::text) + 1) <> (auth.uid()::text || '/') then
      raise exception 'storage_path must be under your own folder';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_harden_submission_insert on public.upload_submissions;
create trigger trg_harden_submission_insert
  before insert on public.upload_submissions
  for each row execute procedure public.harden_submission_insert();

-- The quota/rate-limit triggers must count against the *authenticated* user
-- even if the client omitted/forged uploader on the new row.
create or replace function public.limit_pending_uploads()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  pending_count integer;
begin
  if coalesce(new.uploader, auth.uid()) is null then
    raise exception 'authenticated uploader required';
  end if;
  -- Shared per-uploader transaction lock makes both count-then-insert quota
  -- checks concurrency-safe.
  perform pg_advisory_xact_lock(
    hashtextextended(
      '99.95squad:upload-quota:' || coalesce(new.uploader, auth.uid())::text,
      0
    )
  );

  if new.size_bytes is not null and new.size_bytes > 26214400 then
    raise exception 'file too large';
  end if;

  select count(*) into pending_count
  from public.upload_submissions
  where uploader = coalesce(new.uploader, auth.uid())
    and status in ('pending', 'queued', 'processing');

  if pending_count >= 10 then
    raise exception 'too many pending uploads';
  end if;

  return new;
end;
$$;

create or replace function public.rate_limit_uploads()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count integer;
begin
  if coalesce(new.uploader, auth.uid()) is null then
    raise exception 'authenticated uploader required';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      '99.95squad:upload-quota:' || coalesce(new.uploader, auth.uid())::text,
      0
    )
  );

  select count(*) into recent_count
  from public.upload_submissions
  where uploader = coalesce(new.uploader, auth.uid())
    and created_at > now() - interval '1 hour';

  if recent_count >= 5 then
    raise exception 'upload rate limit reached';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_limit_pending_uploads on public.upload_submissions;
create trigger trg_limit_pending_uploads
  before insert on public.upload_submissions
  for each row execute procedure public.limit_pending_uploads();

drop trigger if exists trg_rate_limit_uploads on public.upload_submissions;
create trigger trg_rate_limit_uploads
  before insert on public.upload_submissions
  for each row execute procedure public.rate_limit_uploads();


create or replace function public.admin_list_submissions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(row_to_json(t) order by t.created_at desc), '[]'::jsonb)
  into result
  from (
    select
      s.id,
      s.uploader,
      s.filename,
      s.name,
      s.sha256,
      s.size_bytes,
      s.status,
      s.note,
      s.premium_granted,
      s.reviewed_at,
      s.reviewed_by,
      s.duplicate_of,
      s.duplicate_type,
      s.subject,
      s.course,
      s.year,
      s.paper_type,
      s.storage_path,
      s.paper_id,
      s.processing_error,
      s.processing_attempts,
      s.processing_claim_expires_at,
      s.processing_started_at,
      s.processing_finished_at,
      s.publication_ready_at,
      s.question_count,
      s.created_at,
      p.email         as uploader_email,
      p.display_name  as uploader_name
    from public.upload_submissions s
    left join public.profiles p on p.id = s.uploader
  ) t;

  return result;
end;
$$;


-- SECURITY DEFINER functions also check profiles.is_admin internally. Remove
-- PostgreSQL's default PUBLIC execute and expose them only to signed-in users.
revoke all on function public.queue_upload(uuid) from public, anon;
revoke all on function public.approve_upload(uuid) from public, anon;
revoke all on function public.claim_upload_for_processing(uuid, uuid) from public, anon;
revoke all on function public.complete_upload_processing(uuid, uuid, text, integer) from public, anon;
revoke all on function public.fail_upload_processing(uuid, uuid, text) from public, anon;
revoke all on function public.moderate_upload(uuid, text, text, text, text) from public, anon;
revoke all on function public.admin_list_submissions() from public, anon;

grant execute on function public.queue_upload(uuid) to authenticated;
grant execute on function public.approve_upload(uuid) to authenticated;
grant execute on function public.claim_upload_for_processing(uuid, uuid) to authenticated;
grant execute on function public.complete_upload_processing(uuid, uuid, text, integer) to authenticated;
grant execute on function public.fail_upload_processing(uuid, uuid, text) to authenticated;
grant execute on function public.moderate_upload(uuid, text, text, text, text) to authenticated;
grant execute on function public.admin_list_submissions() to authenticated;

commit;
