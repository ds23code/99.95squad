-- ============================================================================
-- 99.95squad — Canonical Supabase schema
-- ============================================================================
-- Idempotent. Safe to run against a fresh project or an existing one.
-- Creates every table, index, helper, client RPC, RLS policy and grant the
-- application depends on, then layers the current security model on top.
--
-- Do not put secrets in this file. The anon key is public by design.
-- ============================================================================


-- ============================================================================
-- TABLES
-- ============================================================================

create table if not exists public.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,
  email                 text,
  display_name          text,
  avatar_url            text,
  access_tier           text not null default 'free',
  premium_until         timestamptz,
  is_admin              boolean not null default false,
  xp                    integer not null default 0,
  level                 integer not null default 1,
  contribution_credits  integer not null default 0,
  daily_goal            integer not null default 10,
  opt_out_leaderboard   boolean not null default false,
  onboarding_completed  boolean not null default false,
  subjects              text[] not null default '{}',
  courses               text[] not null default '{}',
  year_level            integer,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists access_tier text;
alter table public.profiles add column if not exists premium_until timestamptz;
alter table public.profiles add column if not exists is_admin boolean;
alter table public.profiles add column if not exists xp integer;
alter table public.profiles add column if not exists level integer;
alter table public.profiles add column if not exists contribution_credits integer;
alter table public.profiles add column if not exists daily_goal integer;
alter table public.profiles add column if not exists opt_out_leaderboard boolean;
alter table public.profiles add column if not exists onboarding_completed boolean;
alter table public.profiles add column if not exists subjects text[];
alter table public.profiles add column if not exists courses text[];
alter table public.profiles add column if not exists year_level integer;
alter table public.profiles add column if not exists created_at timestamptz;
alter table public.profiles add column if not exists updated_at timestamptz;

alter table public.profiles alter column access_tier set default 'free';
alter table public.profiles alter column is_admin set default false;
alter table public.profiles alter column xp set default 0;
alter table public.profiles alter column level set default 1;
alter table public.profiles alter column contribution_credits set default 0;
alter table public.profiles alter column daily_goal set default 10;
alter table public.profiles alter column opt_out_leaderboard set default false;
alter table public.profiles alter column onboarding_completed set default false;
alter table public.profiles alter column subjects set default '{}';
alter table public.profiles alter column courses set default '{}';


create table if not exists public.attempts (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  question_id  text not null,
  correct      boolean,
  seconds      integer not null default 0,
  mode         text not null default 'practice',
  course_id    text,
  topic_id     text,
  difficulty   numeric,
  created_at   timestamptz not null default now()
);

alter table public.attempts add column if not exists question_id text;
alter table public.attempts add column if not exists correct boolean;
alter table public.attempts add column if not exists seconds integer;
alter table public.attempts add column if not exists mode text;
alter table public.attempts add column if not exists course_id text;
alter table public.attempts add column if not exists topic_id text;
alter table public.attempts add column if not exists difficulty numeric;
alter table public.attempts add column if not exists created_at timestamptz;

-- Skipped / unattempted questions may have correct = NULL.
alter table public.attempts alter column correct drop not null;


create table if not exists public.xp_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  amount      integer not null,
  reason      text,
  attempt_id  bigint references public.attempts(id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table public.xp_events add column if not exists amount integer;
alter table public.xp_events add column if not exists reason text;
alter table public.xp_events add column if not exists attempt_id bigint;
alter table public.xp_events add column if not exists created_at timestamptz;


create table if not exists public.favourites (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  question_id  text not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, question_id)
);


create table if not exists public.comments (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  question_id   text not null,
  parent_id     bigint references public.comments(id) on delete cascade,
  body          text not null,
  status        text not null default 'visible',
  likes         integer not null default 0,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz not null default now()
);

alter table public.comments add column if not exists parent_id bigint;
alter table public.comments add column if not exists status text;
alter table public.comments add column if not exists likes integer;
alter table public.comments add column if not exists display_name text;
alter table public.comments add column if not exists avatar_url text;
alter table public.comments add column if not exists created_at timestamptz;
alter table public.comments alter column status set default 'visible';
alter table public.comments alter column likes set default 0;


create table if not exists public.comment_likes (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  comment_id  bigint not null references public.comments(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, comment_id)
);


create table if not exists public.comment_reports (
  id          bigint generated always as identity primary key,
  comment_id  bigint not null references public.comments(id) on delete cascade,
  reporter    uuid not null references public.profiles(id) on delete cascade,
  reason      text,
  created_at  timestamptz not null default now(),
  unique (comment_id, reporter)
);


create table if not exists public.moderation_words (
  word text primary key
);

insert into public.moderation_words (word) values
  ('fuck'), ('shit'), ('dick'), ('cunt'), ('nigger'), ('faggot'),
  ('bitch'), ('asshole'), ('bastard'), ('whore')
on conflict do nothing;


create table if not exists public.upload_submissions (
  id               uuid primary key default gen_random_uuid(),
  uploader         uuid references public.profiles(id) on delete set null,
  filename         text,
  name             text,
  sha256           text,
  size_bytes       bigint,
  status           text not null default 'pending',
  note             text,
  premium_granted  boolean not null default false,
  reviewed_at      timestamptz,
  reviewed_by      uuid references public.profiles(id),
  duplicate_of     text,
  duplicate_type   text,
  subject          text,
  course           text,
  year             integer,
  paper_type       text,
  storage_path     text,
  created_at       timestamptz not null default now()
);

alter table public.upload_submissions add column if not exists filename text;
alter table public.upload_submissions add column if not exists name text;
alter table public.upload_submissions add column if not exists sha256 text;
alter table public.upload_submissions add column if not exists size_bytes bigint;
alter table public.upload_submissions add column if not exists status text;
alter table public.upload_submissions add column if not exists note text;
alter table public.upload_submissions add column if not exists premium_granted boolean;
alter table public.upload_submissions add column if not exists reviewed_at timestamptz;
alter table public.upload_submissions add column if not exists reviewed_by uuid;
alter table public.upload_submissions add column if not exists duplicate_of text;
alter table public.upload_submissions add column if not exists duplicate_type text;
alter table public.upload_submissions add column if not exists subject text;
alter table public.upload_submissions add column if not exists course text;
alter table public.upload_submissions add column if not exists year integer;
alter table public.upload_submissions add column if not exists paper_type text;
alter table public.upload_submissions add column if not exists storage_path text;
alter table public.upload_submissions add column if not exists created_at timestamptz;
alter table public.upload_submissions alter column status set default 'pending';
alter table public.upload_submissions alter column premium_granted set default false;

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


create table if not exists public.problem_reports (
  id           bigint generated always as identity primary key,
  reporter     uuid references public.profiles(id) on delete set null,
  question_id  text,
  qid          text,
  reason       text,
  details      text,
  created_at   timestamptz not null default now()
);

alter table public.problem_reports add column if not exists question_id text;
alter table public.problem_reports add column if not exists qid text;
alter table public.problem_reports add column if not exists reason text;
alter table public.problem_reports add column if not exists details text;
alter table public.problem_reports add column if not exists created_at timestamptz;


create table if not exists public.user_marks (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  question_id  text not null,
  kind         text not null
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
  created_at   timestamptz not null default now(),
  unique (user_id, question_id, kind)
);


create table if not exists public.audit_events (
  id               uuid primary key default gen_random_uuid(),
  actor            text not null,
  action           text not null,
  target_id        text not null,
  previous_status  text,
  new_status       text,
  notes            text,
  created_at       timestamptz not null default now()
);


create table if not exists public.curriculum_topics (
  id          text primary key,
  course_id   text not null,
  year_level  integer default 12,
  module      text,
  name        text not null
);


create table if not exists public.curriculum_outcomes (
  id             text primary key,
  topic_id       text not null references public.curriculum_topics(id) on delete cascade,
  code           text not null,
  description    text not null,
  skill_concept  text
);


-- ============================================================================
-- INDEXES
-- ============================================================================

create index if not exists attempts_user_created
  on public.attempts (user_id, created_at desc);

create index if not exists attempts_user_topic
  on public.attempts (user_id, topic_id);

create index if not exists attempts_question
  on public.attempts (question_id);

create index if not exists xp_events_user_time
  on public.xp_events (user_id, created_at desc);

create index if not exists comments_question
  on public.comments (question_id, created_at);

create index if not exists comment_likes_comment
  on public.comment_likes (comment_id);

create index if not exists idx_user_marks_user
  on public.user_marks (user_id, kind);

create index if not exists idx_audit_events_target
  on public.audit_events (target_id, created_at desc);

create index if not exists idx_curriculum_topics_course
  on public.curriculum_topics (course_id);

create index if not exists idx_curriculum_outcomes_topic
  on public.curriculum_outcomes (topic_id);

create index if not exists idx_upload_submissions_uploader
  on public.upload_submissions (uploader, created_at desc);

create index if not exists idx_upload_submissions_status
  on public.upload_submissions (status, created_at desc);


-- ============================================================================
-- HELPER FUNCTIONS (not granted to clients)
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


create or replace function public.level_from_xp(xp integer)
returns integer
language sql
immutable
set search_path = public
as $$
  select greatest(
    1,
    floor((1 + sqrt(1 + (4 * greatest(coalesce(xp, 0), 0)::numeric) / 50)) / 2)::integer
  );
$$;


create or replace function public.xp_for_difficulty(d numeric)
returns integer
language sql
immutable
set search_path = public
as $$
  select case
    when d is null or d <= 1 then 5
    when d <= 2 then 10
    when d <= 3 then 15
    when d <= 4 then 25
    else 40
  end;
$$;


create or replace function public.current_streak(p_user uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  streak integer := 0;
  cur date := current_date;
  has_day boolean;
begin
  select exists (
    select 1 from public.attempts
    where user_id = p_user and (created_at at time zone 'utc')::date = current_date
  ) into has_day;

  if not has_day then
    cur := current_date - 1;
  end if;

  loop
    select exists (
      select 1 from public.attempts
      where user_id = p_user and (created_at at time zone 'utc')::date = cur
    ) into has_day;
    exit when not has_day;
    streak := streak + 1;
    cur := cur - 1;
  end loop;

  return streak;
end;
$$;


create or replace function public.mastery_stage(
  p_attempts integer,
  p_accuracy numeric,
  p_avg_difficulty numeric,
  p_days_since_last integer
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce(p_attempts, 0) = 0 then 'unseen'
    when p_attempts < 3 then 'learning'
    when p_attempts >= 5
         and coalesce(p_accuracy, 0) >= 90
         and coalesce(p_avg_difficulty, 0) >= 2.5
         and coalesce(p_days_since_last, 9999) <= 60 then 'mastered'
    when coalesce(p_accuracy, 0) >= 70 then 'strong'
    else 'practising'
  end;
$$;


create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Upload quota/rate-limit triggers are defined at the bottom of this file
-- (STORAGE / SUBMISSION INSERT HARDENING section).


-- ============================================================================
-- CLIENT RPCs
-- ============================================================================

-- The moderation RPC gained duplicate_of/duplicate_type parameters; the old
-- 3-arg signature is removed so only the hardened version remains callable.
drop function if exists public.moderate_upload(uuid, text, text);

create or replace function public.update_my_profile(
  new_display_name text default null,
  new_avatar_url text default null,
  new_daily_goal integer default null,
  new_opt_out_leaderboard boolean default null,
  new_subjects text[] default null,
  new_courses text[] default null,
  new_year_level integer default null,
  new_onboarding_completed boolean default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.profiles;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.profiles (id)
  values (auth.uid())
  on conflict (id) do nothing;

  update public.profiles
  set
    display_name = coalesce(new_display_name, display_name),
    avatar_url = coalesce(new_avatar_url, avatar_url),
    daily_goal = coalesce(new_daily_goal, daily_goal),
    opt_out_leaderboard = coalesce(new_opt_out_leaderboard, opt_out_leaderboard),
    subjects = coalesce(new_subjects, subjects),
    courses = coalesce(new_courses, courses),
    onboarding_completed = coalesce(new_onboarding_completed, onboarding_completed),
    updated_at = now()
  where id = auth.uid();

  if new_year_level is not null then
    update public.profiles
    set year_level = new_year_level
    where id = auth.uid();
  end if;

  select * into rec from public.profiles where id = auth.uid();
  return rec;
end;
$$;


create or replace function public.record_attempt(
  p_question_id text,
  p_correct boolean,
  p_seconds integer,
  p_mode text default 'practice',
  p_course_id text default null,
  p_topic_id text default null,
  p_difficulty numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  new_id bigint;
  base_xp integer := 0;
  bonus integer := 0;
  total_xp integer := 0;
  new_total integer;
  new_level integer;
  streak integer;
  today_xp integer;
  today_q integer;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  insert into public.profiles (id) values (uid) on conflict (id) do nothing;

  insert into public.attempts (
    user_id, question_id, correct, seconds, mode, course_id, topic_id, difficulty
  ) values (
    uid, p_question_id, p_correct, greatest(coalesce(p_seconds, 0), 0),
    coalesce(p_mode, 'practice'), p_course_id, p_topic_id, p_difficulty
  )
  returning id into new_id;

  if p_correct is true then
    base_xp := public.xp_for_difficulty(p_difficulty);
    streak := public.current_streak(uid);
    if streak >= 7 then
      bonus := 15;
    end if;
    total_xp := base_xp + bonus;

    insert into public.xp_events (user_id, amount, reason, attempt_id)
    values (uid, total_xp, 'correct_attempt', new_id);

    update public.profiles
    set
      xp = xp + total_xp,
      level = public.level_from_xp(xp + total_xp),
      updated_at = now()
    where id = uid;
  else
    streak := public.current_streak(uid);
  end if;

  select xp, level into new_total, new_level from public.profiles where id = uid;

  select coalesce(sum(amount), 0) into today_xp
  from public.xp_events
  where user_id = uid and created_at >= date_trunc('day', now());

  select count(*) into today_q
  from public.attempts
  where user_id = uid and created_at >= date_trunc('day', now());

  return jsonb_build_object(
    'xp_earned', total_xp,
    'bonus', bonus,
    'correct', p_correct,
    'level', new_level,
    'xp', new_total,
    'streak', streak,
    'xp_today', today_xp,
    'questions_today', today_q
  );
end;
$$;


create or replace function public.topic_mastery(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  result jsonb;
begin
  if uid is null or (uid is distinct from p_user and not public.is_admin()) then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into result
  from (
    select
      a.topic_id,
      count(*)::integer as attempts,
      count(*) filter (where a.correct is true)::integer as correct,
      round(
        100.0 * count(*) filter (where a.correct is true)
        / nullif(count(*) filter (where a.correct is not null), 0),
        1
      ) as accuracy,
      avg(a.difficulty) as avg_difficulty,
      (current_date - max(a.created_at)::date)::integer as days_since_last,
      public.mastery_stage(
        count(*)::integer,
        100.0 * count(*) filter (where a.correct is true)
          / nullif(count(*) filter (where a.correct is not null), 0),
        avg(a.difficulty),
        (current_date - max(a.created_at)::date)::integer
      ) as stage
    from public.attempts a
    where a.user_id = p_user and a.topic_id is not null
    group by a.topic_id
  ) t;

  return result;
end;
$$;


create or replace function public.daily_activity(p_user uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  span integer := greatest(coalesce(p_days, 30), 1);
  result jsonb;
begin
  if uid is null or (uid is distinct from p_user and not public.is_admin()) then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(row_to_json(d) order by d.date), '[]'::jsonb) into result
  from (
    select
      gs::date as date,
      count(a.id)::integer as questions,
      count(a.id) filter (where a.correct is true)::integer as correct,
      coalesce(sum(a.seconds), 0)::integer as seconds,
      coalesce((
        select sum(e.amount) from public.xp_events e
        where e.user_id = p_user
          and e.created_at >= gs
          and e.created_at < gs + interval '1 day'
      ), 0)::integer as xp,
      coalesce((
        select array_agg(distinct a2.topic_id)
        from public.attempts a2
        where a2.user_id = p_user
          and a2.topic_id is not null
          and a2.created_at >= gs
          and a2.created_at < gs + interval '1 day'
      ), '{}') as topics
    from generate_series(
      current_date - (span - 1),
      current_date,
      interval '1 day'
    ) gs
    left join public.attempts a
      on a.user_id = p_user
     and a.created_at >= gs
     and a.created_at < gs + interval '1 day'
    group by gs
  ) d;

  return result;
end;
$$;


create or replace function public.time_stats(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  u_avg numeric := 0;
  u_med numeric := 0;
  u_n integer := 0;
  u_ok numeric := 0;
  u_bad numeric := 0;
  g_avg numeric := 0;
  g_med numeric := 0;
  g_n integer := 0;
  g_ok numeric := 0;
  g_bad numeric := 0;
  delta numeric := null;
begin
  if uid is null or (uid is distinct from p_user and not public.is_admin()) then
    raise exception 'not authorized';
  end if;

  select
    coalesce(avg(seconds), 0),
    coalesce(percentile_cont(0.5) within group (order by seconds), 0),
    count(*),
    coalesce(avg(seconds) filter (where correct is true), 0),
    coalesce(avg(seconds) filter (where correct is false), 0)
  into u_avg, u_med, u_n, u_ok, u_bad
  from public.attempts
  where user_id = p_user and seconds is not null;

  select
    coalesce(avg(seconds), 0),
    coalesce(percentile_cont(0.5) within group (order by seconds), 0),
    count(*),
    coalesce(avg(seconds) filter (where correct is true), 0),
    coalesce(avg(seconds) filter (where correct is false), 0)
  into g_avg, g_med, g_n, g_ok, g_bad
  from public.attempts
  where seconds is not null;

  if g_avg > 0 then
    delta := round(((g_avg - u_avg) / g_avg) * 100);
  end if;

  return jsonb_build_object(
    'user', jsonb_build_object(
      'avg_seconds', round(u_avg, 1),
      'median_seconds', round(u_med, 1),
      'n', u_n
    ),
    'global', jsonb_build_object(
      'avg_seconds', round(g_avg, 1),
      'median_seconds', round(g_med, 1),
      'n', g_n
    ),
    'user_correct', round(u_ok, 1),
    'user_incorrect', round(u_bad, 1),
    'global_correct', round(g_ok, 1),
    'global_incorrect', round(g_bad, 1),
    'faster_slower_pct', delta
  );
end;
$$;


create or replace function public.leaderboard(
  p_period text default 'week',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  off integer := greatest(coalesce(p_offset, 0), 0);
begin
  if coalesce(p_period, 'week') = 'week' then
    select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) into result
    from (
      select
        row_number() over (order by coalesce(sum(e.amount), 0) desc, p.display_name) as rank,
        p.id as user_id,
        coalesce(p.display_name, 'Student') as display_name,
        p.avatar_url,
        coalesce(sum(e.amount), 0)::integer as xp,
        p.level
      from public.profiles p
      left join public.xp_events e
        on e.user_id = p.id
       and e.created_at >= date_trunc('week', now())
      where p.opt_out_leaderboard = false
      group by p.id, p.display_name, p.avatar_url, p.level
      order by xp desc, p.display_name
      offset off limit lim
    ) r;
  else
    select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) into result
    from (
      select
        row_number() over (order by p.xp desc, p.display_name) as rank,
        p.id as user_id,
        coalesce(p.display_name, 'Student') as display_name,
        p.avatar_url,
        p.xp,
        p.level
      from public.profiles p
      where p.opt_out_leaderboard = false
      order by p.xp desc, p.display_name
      offset off limit lim
    ) r;
  end if;

  return result;
end;
$$;


create or replace function public.my_rank(p_period text default 'week')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  result jsonb;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select row_to_json(r)::jsonb into result
  from (
    select *
    from jsonb_to_recordset(public.leaderboard(p_period, 200, 0))
      as x(rank integer, user_id uuid, display_name text, avatar_url text, xp integer, level integer)
    where user_id = uid
  ) r;

  return result;
end;
$$;


create or replace function public.achievements(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  total integer := 0;
  streak integer := 0;
  mastered integer := 0;
begin
  if uid is null or (uid is distinct from p_user and not public.is_admin()) then
    raise exception 'not authorized';
  end if;

  select count(*) into total from public.attempts where user_id = p_user;
  streak := public.current_streak(p_user);
  select count(*) into mastered
  from jsonb_to_recordset(public.topic_mastery(p_user))
    as m(topic_id text, attempts integer, correct integer, accuracy numeric, stage text)
  where stage = 'mastered';

  return jsonb_build_array(
    jsonb_build_object('code', 'first-question', 'name', 'First steps',
      'desc', 'Answered your first question', 'unlocked', total >= 1),
    jsonb_build_object('code', 'q10', 'name', 'Getting going',
      'desc', 'Answered 10 questions', 'unlocked', total >= 10),
    jsonb_build_object('code', 'q50', 'name', 'On a roll',
      'desc', 'Answered 50 questions', 'unlocked', total >= 50),
    jsonb_build_object('code', 'streak-3', 'name', 'Warming up',
      'desc', '3-day streak', 'unlocked', streak >= 3),
    jsonb_build_object('code', 'streak-7', 'name', 'Week warrior',
      'desc', '7-day streak', 'unlocked', streak >= 7),
    jsonb_build_object('code', 'first-mastery', 'name', 'Topic mastered',
      'desc', 'Mastered a topic', 'unlocked', mastered >= 1)
  );
end;
$$;


create or replace function public.get_dashboard(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  prof public.profiles;
  total integer := 0;
  correct_n integer := 0;
  today_q integer := 0;
  today_ok integer := 0;
  today_xp integer := 0;
  acc integer := 0;
  streak integer := 0;
begin
  if uid is null or (uid is distinct from p_user and not public.is_admin()) then
    raise exception 'not authorized';
  end if;

  select * into prof from public.profiles where id = p_user;
  if prof is null then
    return jsonb_build_object('profile', null);
  end if;

  select count(*), count(*) filter (where correct is true)
  into total, correct_n
  from public.attempts
  where user_id = p_user;

  select count(*), count(*) filter (where correct is true)
  into today_q, today_ok
  from public.attempts
  where user_id = p_user and created_at >= date_trunc('day', now());

  select coalesce(sum(amount), 0) into today_xp
  from public.xp_events
  where user_id = p_user and created_at >= date_trunc('day', now());

  if total > 0 then
    acc := round(100.0 * correct_n / nullif(total, 0));
  end if;

  streak := public.current_streak(p_user);

  return jsonb_build_object(
    'profile', jsonb_build_object(
      'id', prof.id,
      'display_name', prof.display_name,
      'avatar_url', prof.avatar_url,
      'access_tier', prof.access_tier,
      'is_admin', prof.is_admin,
      'daily_goal', prof.daily_goal,
      'opt_out_leaderboard', prof.opt_out_leaderboard,
      'onboarding_completed', prof.onboarding_completed,
      'subjects', prof.subjects,
      'courses', prof.courses,
      'year_level', prof.year_level
    ),
    'xp', prof.xp,
    'level', prof.level,
    'streak', streak,
    'xp_today', today_xp,
    'questions_today', today_q,
    'correct_today', today_ok,
    'total_questions', total,
    'accuracy', acc,
    'mastery', public.topic_mastery(p_user),
    'achievements', public.achievements(p_user),
    'activity', public.daily_activity(p_user, 30)
  );
end;
$$;


create or replace function public.add_comment(
  p_question_id text,
  p_body text,
  p_parent_id bigint default null
)
returns public.comments
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cleaned text;
  recent integer;
  hit integer;
  rec public.comments;
  pname text;
  pavatar text;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  cleaned := trim(coalesce(p_body, ''));
  if cleaned = '' then
    raise exception 'comment cannot be empty';
  end if;
  if char_length(cleaned) > 1000 then
    raise exception 'comment too long';
  end if;

  select count(*) into recent
  from public.comments
  where user_id = uid and created_at > now() - interval '1 hour';
  if recent >= 10 then
    raise exception 'rate limit reached';
  end if;

  select count(*) into hit
  from public.moderation_words w
  where cleaned ~* ('\m' || w.word || '\M');
  if hit > 0 then
    raise exception 'prohibited language';
  end if;

  select display_name, avatar_url into pname, pavatar
  from public.profiles where id = uid;

  insert into public.comments (
    user_id, question_id, parent_id, body, status, likes, display_name, avatar_url
  ) values (
    uid, p_question_id, p_parent_id, cleaned, 'visible', 0, pname, pavatar
  )
  returning * into rec;

  return rec;
end;
$$;


create or replace function public.delete_own_comment(p_comment_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  n integer;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  delete from public.comments
  where id = p_comment_id and user_id = uid;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;


create or replace function public.like_comment(p_comment_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  already boolean;
  n integer;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select exists (
    select 1 from public.comment_likes
    where user_id = uid and comment_id = p_comment_id
  ) into already;

  if already then
    delete from public.comment_likes
    where user_id = uid and comment_id = p_comment_id;
  else
    insert into public.comment_likes (user_id, comment_id)
    values (uid, p_comment_id)
    on conflict do nothing;
  end if;

  select count(*) into n from public.comment_likes where comment_id = p_comment_id;
  update public.comments set likes = n where id = p_comment_id;

  return jsonb_build_object('liked', not already, 'likes', n);
end;
$$;


create or replace function public.report_comment(
  p_comment_id bigint,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  insert into public.comment_reports (comment_id, reporter, reason)
  values (p_comment_id, uid, p_reason)
  on conflict (comment_id, reporter) do update set reason = excluded.reason;

  return true;
end;
$$;


create or replace function public.approve_upload(submission_id uuid)
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

  select * into sub
  from public.upload_submissions
  where id = submission_id;

  if sub is null then
    raise exception 'submission not found';
  end if;

  prev := sub.status;

  if sub.status is distinct from 'approved' then
    update public.upload_submissions
    set
      status = 'approved',
      premium_granted = true,
      reviewed_at = now(),
      reviewed_by = auth.uid(),
      duplicate_of = null,
      duplicate_type = null
    where id = submission_id;

    if sub.uploader is not null then
      update public.profiles
      set
        access_tier = 'contributor',
        premium_until = greatest(
          coalesce(premium_until, now()),
          now() + interval '14 days'
        ),
        contribution_credits = contribution_credits + 1,
        updated_at = now()
      where id = sub.uploader;
    end if;
  end if;

  insert into public.audit_events (actor, action, target_id, previous_status, new_status, notes)
  values (
    coalesce(auth.uid()::text, 'unknown'),
    'approve_upload',
    submission_id::text,
    prev,
    'approved',
    null
  );

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
    'pending',
    'processing'
  ) then
    raise exception 'invalid status';
  end if;

  select * into sub
  from public.upload_submissions
  where id = submission_id;

  if sub is null then
    raise exception 'submission not found';
  end if;

  prev := sub.status;

  if new_status = 'approved' then
    return public.approve_upload(submission_id);
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


-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.attempts enable row level security;
alter table public.xp_events enable row level security;
alter table public.favourites enable row level security;
alter table public.comments enable row level security;
alter table public.comment_likes enable row level security;
alter table public.comment_reports enable row level security;
alter table public.moderation_words enable row level security;
alter table public.upload_submissions enable row level security;
alter table public.problem_reports enable row level security;
alter table public.user_marks enable row level security;
alter table public.audit_events enable row level security;
alter table public.curriculum_topics enable row level security;
alter table public.curriculum_outcomes enable row level security;

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

drop policy if exists "own attempts read" on public.attempts;
create policy "own attempts read"
on public.attempts
for select
using (auth.uid() = user_id);

drop policy if exists "own xp read" on public.xp_events;
create policy "own xp read"
on public.xp_events
for select
using (auth.uid() = user_id);

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

drop policy if exists "comments visible read" on public.comments;
create policy "comments visible read"
on public.comments
for select
using (status = 'visible');

drop policy if exists "none direct" on public.comments;
create policy "none direct" on public.comments for insert with check (false);

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

drop policy if exists "moderation words locked" on public.moderation_words;
create policy "moderation words locked"
on public.moderation_words
for all
using (false);

drop policy if exists "submission status readable" on public.upload_submissions;
create policy "submission status readable"
on public.upload_submissions
for select
using (auth.uid() = uploader or public.is_admin());

drop policy if exists "submission insert" on public.upload_submissions;
create policy "submission insert"
on public.upload_submissions
for insert
with check (auth.uid() = uploader);

drop policy if exists "submission owner update" on public.upload_submissions;

drop policy if exists "report insert" on public.problem_reports;
create policy "report insert"
on public.problem_reports
for insert
with check (auth.uid() = reporter);

drop policy if exists "report select" on public.problem_reports;
create policy "report select"
on public.problem_reports
for select
using (auth.uid() = reporter or public.is_admin());

drop policy if exists "own marks read" on public.user_marks;
create policy "own marks read"
on public.user_marks
for select
using (auth.uid() = user_id);

drop policy if exists "own marks write" on public.user_marks;
create policy "own marks write"
on public.user_marks
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "audit events readable" on public.audit_events;
create policy "audit events readable"
on public.audit_events
for select
using (public.is_admin());

drop policy if exists "curriculum status readable" on public.curriculum_topics;
create policy "curriculum status readable"
on public.curriculum_topics
for select
using (true);

drop policy if exists "outcomes status readable" on public.curriculum_outcomes;
create policy "outcomes status readable"
on public.curriculum_outcomes
for select
using (true);


-- ============================================================================
-- GRANTS
-- ============================================================================

grant usage on schema public to anon, authenticated;

grant select, insert on public.profiles to authenticated;
grant select on public.attempts to authenticated;
grant select on public.xp_events to authenticated;
grant select, insert, delete on public.favourites to authenticated;
grant select on public.comments to anon, authenticated;
grant select, insert on public.upload_submissions to authenticated;
grant select, insert on public.problem_reports to authenticated;
grant select, insert, update, delete on public.user_marks to authenticated;
grant select on public.audit_events to authenticated;
grant select on public.curriculum_topics to anon, authenticated;
grant select on public.curriculum_outcomes to anon, authenticated;

grant execute on function public.update_my_profile(text, text, integer, boolean, text[], text[], integer, boolean)
to authenticated;

grant execute on function public.record_attempt(text, boolean, integer, text, text, text, numeric)
to authenticated;

grant execute on function public.topic_mastery(uuid)
to authenticated;

grant execute on function public.daily_activity(uuid, integer)
to authenticated;

grant execute on function public.time_stats(uuid)
to authenticated;

grant execute on function public.leaderboard(text, integer, integer)
to anon, authenticated;

grant execute on function public.my_rank(text)
to authenticated;

grant execute on function public.achievements(uuid)
to authenticated;

grant execute on function public.get_dashboard(uuid)
to authenticated;

grant execute on function public.add_comment(text, text, bigint)
to authenticated;

grant execute on function public.delete_own_comment(bigint)
to authenticated;

grant execute on function public.like_comment(bigint)
to authenticated;

grant execute on function public.report_comment(bigint, text)
to authenticated;

grant execute on function public.approve_upload(uuid)
to authenticated;

grant execute on function public.moderate_upload(uuid, text, text, text, text)
to authenticated;

grant execute on function public.admin_list_submissions()
to authenticated;

grant execute on function public.is_admin()
to authenticated;


-- ============================================================================
-- STORAGE (uploaded paper PDFs)
-- ============================================================================
-- Student uploads are stored in a PRIVATE Supabase Storage bucket. The PDF
-- bytes are never written to a public path and never served unauthenticated.
-- Admins (and only the owner, for their own files) obtain short-lived signed
-- URLs through the Storage API — see assets/js/auth.js.
--
-- NOTE: this section must run in the SQL editor (or a migration) as a role
-- that can write to the storage schema (postgres / supabase_admin). The
-- frontend never touches storage.buckets.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'paper-uploads',
  'paper-uploads',
  false,
  26214400,                                  -- 25 MB, mirrors QB_CONFIG.upload.maxBytes
  array['application/pdf']
)
on conflict (id) do nothing;

-- uploads: authenticated users may create objects ONLY under their own
-- folder ({auth.uid()}/...) — nobody can write into another user's folder.
drop policy if exists "paper uploads insert own folder" on storage.objects;
create policy "paper uploads insert own folder"
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'paper-uploads'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- reads: the object owner (their own file) or an admin. This is what gates
-- signed-URL creation: the Storage API refuses to sign objects the caller
-- cannot SELECT. Students can never enumerate or read other students' PDFs.
drop policy if exists "paper uploads select own or admin" on storage.objects;
create policy "paper uploads select own or admin"
on storage.objects
for select to authenticated
using (
  bucket_id = 'paper-uploads'
  and (owner = auth.uid() or public.is_admin())
);

-- deletes: owners may remove their own uploads; admins may remove any
-- (copyright takedowns etc.).
drop policy if exists "paper uploads delete own or admin" on storage.objects;
create policy "paper uploads delete own or admin"
on storage.objects
for delete to authenticated
using (
  bucket_id = 'paper-uploads'
  and (owner = auth.uid() or public.is_admin())
);


-- ============================================================================
-- SUBMISSION INSERT HARDENING
-- ============================================================================
-- Clients may insert submission rows, but they must never choose the status,
-- grant themselves premium, pick a reviewed_by, or reference a storage path
-- outside their own folder. All of that is forced here, server-side.

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
  if new.size_bytes is not null and new.size_bytes > 26214400 then
    raise exception 'file too large';
  end if;

  select count(*) into pending_count
  from public.upload_submissions
  where uploader = coalesce(new.uploader, auth.uid())
    and status in ('pending', 'processing');

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


-- ============================================================================
-- ADMIN SUBMISSION FEED (enriched for moderation UI)
-- ============================================================================
-- Admins see every submission joined with the uploader's profile. RLS on
-- upload_submissions already lets admins select all rows, but uploader
-- email/name live in profiles, which ordinary RLS hides from everyone but
-- the owner. This SECURITY DEFINER view is the admin-only escape hatch.

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
      s.created_at,
      p.email         as uploader_email,
      p.display_name  as uploader_name
    from public.upload_submissions s
    left join public.profiles p on p.id = s.uploader
  ) t;

  return result;
end;
$$;


-- ============================================================================
-- DONE
-- ============================================================================
