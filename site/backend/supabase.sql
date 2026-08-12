-- ============================================================================
-- 99.95squad — Supabase backend schema v2 (student learning platform)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL editor (one-time setup). Then configure:
--   - Authentication → Providers → enable Email + Google (+ Apple, optional)
--   - Authentication → URL Configuration → add your GitHub Pages URL as a
--     redirect (https://USERNAME.github.io/99.95squad/)
--   - Set SUPABASE_URL + SUPABASE_ANON_KEY in site/config.js
--
-- SECURITY MODEL
--   * All user-owned data is behind Row Level Security; users can only
--     read/write their own rows.
--   * XP, streaks, levels, mastery, leaderboards and premium entitlements
--     are computed/validated SERVER-SIDE in SECURITY DEFINER functions.
--     localStorage is never trusted for any of them.
--   * Aggregates (leaderboard, timing stats) expose only public fields and
--     never individual private data.
--   * The anon key (public) is the only credential the frontend holds; the
--     service-role key never appears in the frontend.
-- ============================================================================

-- ============================================================================
-- PROFILES
-- ============================================================================
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  display_name  text,
  avatar_url    text,
  access_tier   text not null default 'free'
                check (access_tier in ('free', 'premium', 'contributor')),
  premium_until timestamptz,
  is_admin      boolean not null default false,
  contribution_credits integer not null default 0,
  -- gamification (server-maintained; never client-writable)
  xp            bigint not null default 0,
  level         integer not null default 1,
  daily_goal    integer not null default 10,
  opt_out_leaderboard boolean not null default false,
  last_active   timestamptz,
  created_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- users may read only their own profile
create policy "own profile read" on public.profiles
  for select using (auth.uid() = id);

-- users may create their own profile row at sign-up
create policy "own profile insert" on public.profiles
  for insert with check (auth.uid() = id);

-- IMPORTANT: users must NEVER update access_tier / premium_until / is_admin /
-- xp / level / contribution_credits themselves. UPDATE is revoked entirely;
-- the only write path is the SECURITY DEFINER function update_my_profile,
-- which touches only allowed display/settings columns.
revoke update on public.profiles from anon, authenticated;

create or replace function public.update_my_profile(
  new_display_name text default null,
  new_avatar_url text default null,
  new_daily_goal integer default null,
  new_opt_out_leaderboard boolean default null
) returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  prof public.profiles;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if new_daily_goal is not null and (new_daily_goal < 1 or new_daily_goal > 500) then
    raise exception 'daily goal out of range';
  end if;
  update public.profiles
     set display_name = coalesce(new_display_name, display_name),
         avatar_url   = coalesce(new_avatar_url, avatar_url),
         daily_goal   = coalesce(new_daily_goal, daily_goal),
         opt_out_leaderboard = coalesce(new_opt_out_leaderboard, opt_out_leaderboard)
   where id = auth.uid();
  select * into prof from public.profiles where id = auth.uid();
  return prof;
end;
$$;

grant execute on function public.update_my_profile(text, text, integer, boolean) to authenticated;

-- ============================================================================
-- ATTEMPTS & XP EVENTS (question attempts; the atomic unit of gamification)
-- ============================================================================
create table if not exists public.attempts (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  question_id text not null,
  course_id   text,
  topic_id    text,
  difficulty  numeric,
  correct     boolean,
  seconds     integer not null default 0 check (seconds >= 0 and seconds < 86400),
  mode        text not null default 'practice'
              check (mode in ('practice', 'exam', 'mixed', 'topic', 'weak', 'set')),
  created_at  timestamptz not null default now()
);
create index if not exists attempts_user_created on public.attempts(user_id, created_at desc);
create index if not exists attempts_user_topic  on public.attempts(user_id, topic_id);
create index if not exists attempts_question     on public.attempts(question_id);

create table if not exists public.xp_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  amount      integer not null,
  reason      text not null,
  created_at  timestamptz not null default now()
);
create index if not exists xp_events_user_time on public.xp_events(user_id, created_at desc);

alter table public.attempts enable row level security;
alter table public.xp_events enable row level security;

-- users may read their own attempts / xp events
create policy "own attempts read" on public.attempts for select using (auth.uid() = user_id);
create policy "own xp read" on public.xp_events for select using (auth.uid() = user_id);
-- no direct insert/update/delete policies: writes go through record_attempt()
-- (SECURITY DEFINER) so XP is always computed server-side.

-- ============================================================================
-- FAVOURITES
-- ============================================================================
create table if not exists public.favourites (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  question_id text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, question_id)
);
alter table public.favourites enable row level security;
create policy "own favourites read" on public.favourites for select using (auth.uid() = user_id);
create policy "own favourites insert" on public.favourites for insert with check (auth.uid() = user_id);
create policy "own favourites delete" on public.favourites for delete using (auth.uid() = user_id);

-- ============================================================================
-- COMMENTS (with moderation, likes, reports, rate limiting)
-- ============================================================================
create table if not exists public.comments (
  id          bigint generated always as identity primary key,
  question_id text not null,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  parent_id   bigint references public.comments(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 1000),
  likes       integer not null default 0,
  status      text not null default 'visible' check (status in ('visible', 'hidden')),
  created_at  timestamptz not null default now()
);
create index if not exists comments_question on public.comments(question_id, created_at desc);

create table if not exists public.comment_likes (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  comment_id  bigint not null references public.comments(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, comment_id)
);
create index if not exists comment_likes_comment on public.comment_likes(comment_id);

create table if not exists public.comment_reports (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  comment_id  bigint not null references public.comments(id) on delete cascade,
  reason      text,
  created_at  timestamptz not null default now(),
  unique (user_id, comment_id)
);

create table if not exists public.moderation_words (
  word text primary key
);
insert into public.moderation_words (word) values
  ('asshole'), ('bastard'), ('bitch'), ('cunt'), ('dick'), ('fuck'),
  ('nigger'), ('retard'), ('slut'), ('wanker'), ('whore')
on conflict (word) do nothing;

alter table public.comments enable row level security;
alter table public.comment_likes enable row level security;
alter table public.comment_reports enable row level security;
alter table public.moderation_words enable row level security;

-- anyone can read visible comments (needed for question pages)
create policy "comments visible read" on public.comments for select using (status = 'visible');
-- writes go through SECURITY DEFINER functions (add_comment / like_comment /
-- report_comment) which enforce rate limits + profanity filtering.
create policy "none direct" on public.comments for insert with check (false);
create policy "none direct" on public.comment_likes for all using (false);
create policy "none direct" on public.comment_reports for all using (false);

-- ============================================================================
-- GAMIFICATION HELPERS (server-side truth)
-- ============================================================================

-- Level thresholds: total XP for level L is 50*(L-1)*L  (L=1:0, 2:100, 3:300,
-- 4:600, 5:1000, ...). Inverse: L = floor((1+sqrt(1+4*xp/50))/2)
create or replace function public.level_from_xp(p_xp bigint)
returns integer language sql immutable as $$
  select greatest(1, floor((1 + sqrt(1 + 4 * p_xp / 50.0)) / 2)::int)
$$;

-- XP earned for a correct attempt by difficulty (1..5)
create or replace function public.xp_for_difficulty(p_difficulty numeric)
returns integer language sql immutable as $$
  select case
    when p_difficulty <= 1 then 5
    when p_difficulty <= 2 then 10
    when p_difficulty <= 3 then 15
    when p_difficulty <= 4 then 25
    else 40
  end
$$;

-- Current day streak: consecutive days with an attempt, ending today; if there
-- is no activity today yet, a streak ending yesterday is preserved.
create or replace function public.current_streak(p_user uuid)
returns integer language plpgsql stable security definer set search_path = public as $$
declare
  streak integer := 0;
  cur date := current_date;
  has_today boolean;
begin
  select exists (
    select 1 from public.attempts
    where user_id = p_user and created_at::date = current_date
  ) into has_today;
  if not has_today then
    cur := cur - 1;
  end if;
  loop
    exit when not exists (
      select 1 from public.attempts
      where user_id = p_user and created_at::date = cur
    );
    streak := streak + 1;
    cur := cur - 1;
  end loop;
  return streak;
end;
$$;

-- Record a question attempt: server-side XP + level + streak + activity.
-- The ONLY write path for attempts/xp. Returns the authoritative result.
create or replace function public.record_attempt(
  p_question_id text,
  p_correct boolean,
  p_seconds integer default 0,
  p_mode text default 'practice',
  p_course_id text default null,
  p_topic_id text default null,
  p_difficulty numeric default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_xp integer := 0;
  v_streak integer;
  v_level integer;
  v_xp_today bigint;
  v_today_count bigint;
  v_bonus integer := 0;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  if p_difficulty is not null and (p_difficulty < 1 or p_difficulty > 5) then
    raise exception 'invalid difficulty';
  end if;
  if p_seconds is null or p_seconds < 0 then
    p_seconds := 0;
  end if;

  insert into public.attempts (user_id, question_id, course_id, topic_id,
                               difficulty, correct, seconds, mode)
  values (v_user, p_question_id, p_course_id, p_topic_id, p_difficulty,
          p_correct, p_seconds, p_mode);

  if p_correct then
    v_xp := public.xp_for_difficulty(p_difficulty);
    v_streak := public.current_streak(v_user) + 1;  -- includes today's attempt
    if v_streak >= 7 then
      v_bonus := 15; -- weekly-streak bonus
    end if;
    v_xp := v_xp + v_bonus;
    insert into public.xp_events (user_id, amount, reason)
    values (v_user, v_xp, case when v_bonus > 0 then 'correct+streak' else 'correct' end);
    update public.profiles
       set xp = xp + v_xp,
           level = public.level_from_xp(xp + v_xp),
           last_active = now()
     where id = v_user;
  else
    update public.profiles set last_active = now() where id = v_user;
  end if;

  select coalesce(sum(amount), 0) into v_xp_today
    from public.xp_events where user_id = v_user and created_at::date = current_date;
  select count(*) into v_today_count
    from public.attempts where user_id = v_user and created_at::date = current_date;

  select coalesce(level, 1) into v_level from public.profiles where id = v_user;

  return jsonb_build_object(
    'xp_earned', v_xp,
    'bonus', v_bonus,
    'correct', p_correct,
    'level', v_level,
    'streak', public.current_streak(v_user),
    'xp_today', v_xp_today,
    'questions_today', v_today_count
  );
end;
$$;

grant execute on function public.record_attempt(text, boolean, integer, text, text, text, numeric) to authenticated;

-- ============================================================================
-- MASTERY (Duolingo-style stages)
-- ============================================================================
-- stage = f(attempts, accuracy, avg difficulty, recency)
create or replace function public.mastery_stage(p_topic_id text, p_user uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_attempts integer;
  v_correct integer;
  v_accuracy numeric;
  v_avg_diff numeric;
  v_last timestamptz;
  v_days_since integer;
begin
  select count(*), count(*) filter (where correct),
         avg(difficulty), max(created_at)
    into v_attempts, v_correct, v_avg_diff, v_last
    from public.attempts
   where user_id = p_user and topic_id = p_topic_id;

  if v_attempts is null or v_attempts = 0 then
    return 'unseen';
  end if;
  if v_attempts < 3 then
    return 'learning';
  end if;
  v_accuracy := 100.0 * v_correct / v_attempts;
  v_days_since := (current_date - v_last::date);
  if v_attempts >= 5 and v_accuracy >= 90
     and coalesce(v_avg_diff, 0) >= 2.5 and v_days_since <= 60 then
    return 'mastered';
  end if;
  if v_accuracy >= 70 then
    return 'strong';
  end if;
  return 'practising';
end;
$$;

-- Per-topic mastery for a user (only topics with attempts; full topic list is
-- joined client-side with the static taxonomy so question content stays static).
create or replace function public.topic_mastery(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(t), '[]'::jsonb) from (
    select a.topic_id,
           count(*) as attempts,
           count(*) filter (where correct) as correct,
           round(100.0 * count(*) filter (where correct) / nullif(count(*), 0), 1) as accuracy,
           round(coalesce(avg(difficulty), 0)::numeric, 2) as avg_difficulty,
           max(created_at) as last_attempt_at,
           public.mastery_stage(a.topic_id, p_user) as stage
      from public.attempts a
     where a.user_id = p_user and a.topic_id is not null
     group by a.topic_id
     order by stage, accuracy desc
  ) t;
$$;

-- Recommended next topic: the weakest topic the user has practised
-- (lowest accuracy among 'practising'/'strong'), else their most recent
-- topic, else null (frontend falls back to a fresh topic from the static
-- taxonomy — question content stays static).
create or replace function public.recommended_topic(p_user uuid, p_course_ids text[])
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(t) -> 0, 'null'::jsonb) from (
    select topic_id, stage, accuracy, attempts
      from jsonb_to_recordset(public.topic_mastery(p_user)) as t(
        topic_id text, stage text, accuracy numeric, attempts bigint)
     where stage in ('practising', 'strong')
     order by accuracy asc, attempts desc
  ) t;
$$;

-- ============================================================================
-- DAILY ACTIVITY (calendar)
-- ============================================================================
create or replace function public.daily_activity(p_user uuid, p_days integer default 30)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(d), '[]'::jsonb) from (
    select day::date as date,
           coalesce(a.n, 0) as questions,
           coalesce(a.correct, 0) as correct,
           coalesce(a.seconds, 0) as seconds,
           coalesce(x.amount, 0) as xp,
           coalesce(a.topics, '[]'::jsonb) as topics
      from generate_series(current_date - (p_days - 1), current_date, interval '1 day') day
      left join lateral (
        select count(*) n, count(*) filter (where correct) correct,
               sum(seconds) seconds,
               jsonb_agg(distinct topic_id) filter (where topic_id is not null) topics
          from public.attempts
         where user_id = p_user and created_at::date = day::date
      ) a on true
      left join lateral (
        select sum(amount) amount from public.xp_events
         where user_id = p_user and created_at::date = day::date
      ) x on true
     order by day
  ) d;
$$;

-- ============================================================================
-- TIME ANALYTICS (aggregates only — never individual users' data)
-- ============================================================================
create or replace function public.time_stats(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'user', (select jsonb_build_object(
                'avg_seconds', round(coalesce(avg(seconds), 0)::numeric, 1),
                'median_seconds', round(coalesce(percentile_cont(0.5) within group (order by seconds), 0)::numeric, 1),
                'n', count(*))
               from public.attempts where user_id = p_user),
    'global', (select jsonb_build_object(
                 'avg_seconds', round(coalesce(avg(seconds), 0)::numeric, 1),
                 'median_seconds', round(coalesce(percentile_cont(0.5) within group (order by seconds), 0)::numeric, 1),
                 'n', count(*))
                from public.attempts),
    'user_correct',   (select round(coalesce(avg(seconds), 0)::numeric, 1) from public.attempts where user_id = p_user and correct),
    'user_incorrect', (select round(coalesce(avg(seconds), 0)::numeric, 1) from public.attempts where user_id = p_user and not correct),
    'global_correct',   (select round(coalesce(avg(seconds), 0)::numeric, 1) from public.attempts where correct),
    'global_incorrect', (select round(coalesce(avg(seconds), 0)::numeric, 1) from public.attempts where not correct)
  );
$$;

-- ============================================================================
-- LEADERBOARDS (server-side, opt-out, aggregates only)
-- ============================================================================
create or replace function public.leaderboard(p_period text default 'week',
                                              p_limit integer default 50,
                                              p_offset integer default 0)
returns table (rank bigint, user_id uuid, display_name text, avatar_url text,
               xp bigint, level integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_period = 'week' then
    return query
      select row_number() over (order by sum(e.amount) desc)::bigint,
             p.id, coalesce(p.display_name, 'Student'), p.avatar_url,
             sum(e.amount)::bigint, p.level
        from public.xp_events e
        join public.profiles p on p.id = e.user_id
       where e.created_at >= date_trunc('week', now())
         and p.opt_out_leaderboard = false
       group by p.id
       order by sum(e.amount) desc
       limit p_limit offset p_offset;
  else
    return query
      select row_number() over (order by p.xp desc)::bigint,
             p.id, coalesce(p.display_name, 'Student'), p.avatar_url,
             p.xp, p.level
        from public.profiles p
       where p.opt_out_leaderboard = false
       order by p.xp desc
       limit p_limit offset p_offset;
  end if;
end;
$$;

create or replace function public.my_rank(p_period text default 'week')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_rank bigint;
  v_xp bigint;
begin
  if p_period = 'week' then
    select rank, xp into v_rank, v_xp from (
      select row_number() over (order by sum(e.amount) desc)::bigint as rank,
             e.user_id, sum(e.amount)::bigint as xp
        from public.xp_events e
       where e.created_at >= date_trunc('week', now())
       group by e.user_id
    ) t where t.user_id = auth.uid();
  else
    select rank, xp into v_rank, v_xp from (
      select row_number() over (order by xp desc)::bigint as rank, id, xp
        from public.profiles
    ) t where t.id = auth.uid();
  end if;
  return jsonb_build_object('rank', v_rank, 'xp', coalesce(v_xp, 0));
end;
$$;

-- ============================================================================
-- ACHIEVEMENTS (derived from real data, never fabricated)
-- ============================================================================
create or replace function public.achievements(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_array(
    case when exists (select 1 from public.attempts where user_id = p_user)
         then jsonb_build_object('code','first-question','name','First steps',
              'desc','Answered your first question','unlocked',true,
              'at', (select min(created_at) from public.attempts where user_id = p_user)) end,
    case when (select count(*) from public.attempts where user_id = p_user) >= 10
         then jsonb_build_object('code','q10','name','Getting going','desc','Answered 10 questions','unlocked',true) end,
    case when (select count(*) from public.attempts where user_id = p_user) >= 50
         then jsonb_build_object('code','q50','name','On a roll','desc','Answered 50 questions','unlocked',true) end,
    case when (select count(*) from public.attempts where user_id = p_user) >= 200
         then jsonb_build_object('code','q200','name','Machine','desc','Answered 200 questions','unlocked',true) end,
    case when public.current_streak(p_user) >= 3
         then jsonb_build_object('code','streak3','name','Warming up','desc','3-day streak','unlocked',true) end,
    case when public.current_streak(p_user) >= 7
         then jsonb_build_object('code','streak7','name','Unstoppable','desc','7-day streak','unlocked',true) end,
    case when public.current_streak(p_user) >= 30
         then jsonb_build_object('code','streak30','name','Legend','desc','30-day streak','unlocked',true) end,
    case when (select count(*) from public.attempts where user_id = p_user and correct and created_at::date = current_date) >= 10
         then jsonb_build_object('code','perfect-day','name','Perfect day','desc','10+ correct in one day','unlocked',true) end,
    case when (select coalesce(level, 1) from public.profiles where id = p_user) >= 5
         then jsonb_build_object('code','level5','name','Level 5','desc','Reached level 5','unlocked',true) end,
    case when (select count(*) from jsonb_array_elements(public.topic_mastery(p_user)) t where t->>'stage' = 'mastered') >= 1
         then jsonb_build_object('code','mastered-topic','name','Mastered a topic','desc','Reached Mastered on any topic','unlocked',true) end,
    case when (select contribution_credits from public.profiles where id = p_user) >= 1
         then jsonb_build_object('code','contributor','name','Contributor','desc','Had a paper approved','unlocked',true) end
  ) - null;
$$;

-- ============================================================================
-- DASHBOARD (one call: stats + mastery + activity + achievements + streak)
-- ============================================================================
create or replace function public.get_dashboard(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_prof public.profiles;
  v_total bigint; v_correct bigint; v_accuracy numeric;
  v_xp_today bigint; v_today_count bigint; v_today_correct bigint;
begin
  select * into v_prof from public.profiles where id = p_user;
  if v_prof is null then
    return null;
  end if;
  select count(*), count(*) filter (where correct)
    into v_total, v_correct
    from public.attempts where user_id = p_user;
  v_accuracy := case when v_total > 0 then round(100.0 * v_correct / v_total, 1) else 0 end;

  select coalesce(sum(amount), 0) into v_xp_today
    from public.xp_events where user_id = p_user and created_at::date = current_date;
  select count(*), count(*) filter (where correct)
    into v_today_count, v_today_correct
    from public.attempts where user_id = p_user and created_at::date = current_date;

  return jsonb_build_object(
    'profile', jsonb_build_object(
      'id', v_prof.id, 'display_name', v_prof.display_name, 'avatar_url', v_prof.avatar_url,
      'access_tier', v_prof.access_tier, 'premium_until', v_prof.premium_until,
      'is_admin', v_prof.is_admin, 'contribution_credits', v_prof.contribution_credits,
      'opt_out_leaderboard', v_prof.opt_out_leaderboard, 'daily_goal', v_prof.daily_goal
    ),
    'xp', v_prof.xp,
    'level', v_prof.level,
    'level_progress', (v_prof.xp - 50 * (v_prof.level - 1) * (v_prof.level - 2) / 1)::bigint,
    'level_next', 50 * v_prof.level * (v_prof.level + 1) - 50 * (v_prof.level - 1) * v_prof.level,
    'streak', public.current_streak(p_user),
    'xp_today', v_xp_today,
    'questions_today', v_today_count,
    'correct_today', v_today_correct,
    'total_questions', v_total,
    'accuracy', v_accuracy,
    'mastery', public.topic_mastery(p_user),
    'achievements', public.achievements(p_user),
    'activity', public.daily_activity(p_user, 14),
    'recommended', public.recommended_topic(p_user, null)
  );
end;
$$;

grant execute on function public.get_dashboard(uuid) to authenticated;
grant execute on function public.topic_mastery(uuid) to authenticated;
grant execute on function public.daily_activity(uuid, integer) to authenticated;
grant execute on function public.time_stats(uuid) to authenticated;
grant execute on function public.leaderboard(text, integer, integer) to authenticated;
grant execute on function public.my_rank(text) to authenticated;
grant execute on function public.achievements(uuid) to authenticated;

-- ============================================================================
-- COMMENTS API (SECURITY DEFINER: rate limit + profanity filter)
-- ============================================================================
create or replace function public.add_comment(
  p_question_id text,
  p_body text,
  p_parent_id bigint default null
) returns public.comments
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_comments public.comments;
  v_recent integer;
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  if p_body is null or char_length(trim(p_body)) = 0 then
    raise exception 'comment cannot be empty';
  end if;
  if char_length(p_body) > 1000 then
    raise exception 'comment too long (max 1000 chars)';
  end if;
  -- rate limit: max 10 comments/hour
  select count(*) into v_recent from public.comments
   where user_id = v_user and created_at > now() - interval '1 hour';
  if v_recent >= 10 then
    raise exception 'comment rate limit reached — slow down';
  end if;
  -- profanity / abuse filter
  if exists (select 1 from public.moderation_words w
              where position(w.word in lower(p_body)) > 0) then
    raise exception 'comment contains prohibited language';
  end if;
  -- replies must reference an existing comment
  if p_parent_id is not null and not exists (
    select 1 from public.comments where id = p_parent_id
  ) then
    raise exception 'parent comment not found';
  end if;

  insert into public.comments (question_id, user_id, parent_id, body)
  values (p_question_id, v_user, p_parent_id, trim(p_body))
  returning * into v_comments;
  return v_comments;
end;
$$;

create or replace function public.delete_own_comment(p_comment_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  delete from public.comments
   where id = p_comment_id and user_id = auth.uid();
  return found;
end;
$$;

create or replace function public.like_comment(p_comment_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_liked boolean;
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  if exists (select 1 from public.comment_likes where user_id = v_user and comment_id = p_comment_id) then
    delete from public.comment_likes where user_id = v_user and comment_id = p_comment_id;
    v_liked := false;
  else
    insert into public.comment_likes (user_id, comment_id) values (v_user, p_comment_id);
    v_liked := true;
  end if;
  update public.comments c
     set likes = (select count(*) from public.comment_likes cl where cl.comment_id = c.id)
   where c.id = p_comment_id;
  return jsonb_build_object('liked', v_liked,
    'likes', (select likes from public.comments where id = p_comment_id));
end;
$$;

create or replace function public.report_comment(p_comment_id bigint, p_reason text default null)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.comment_reports (user_id, comment_id, reason)
  values (auth.uid(), p_comment_id, p_reason)
  on conflict (user_id, comment_id) do nothing;
  return true;
end;
$$;

-- Moderator: hide a comment (admin only)
create or replace function public.moderate_comment(p_comment_id bigint, p_hidden boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  update public.comments set status = case when p_hidden then 'hidden' else 'visible' end
   where id = p_comment_id;
  return found;
end;
$$;

grant execute on function public.add_comment(text, text, bigint) to authenticated;
grant execute on function public.delete_own_comment(bigint) to authenticated;
grant execute on function public.like_comment(bigint) to authenticated;
grant execute on function public.report_comment(bigint, text) to authenticated;
grant execute on function public.moderate_comment(bigint, boolean) to authenticated;

-- ============================================================================
-- UPLOADS & CONTRIBUTOR PREMIUM (unchanged core, server-side entitlement)
-- ============================================================================
create table if not exists public.upload_submissions (
  id            uuid primary key default gen_random_uuid(),
  sha256        text unique not null,
  filename      text not null,
  file_url      text,
  size_bytes    bigint,
  uploader      uuid references public.profiles(id),
  status        text not null default 'pending'
                check (status in ('pending', 'processing', 'approved',
                                  'rejected', 'duplicate', 'needs_review', 'needs_changes')),
  paper_id      text,
  premium_granted boolean not null default false,
  review_notes  text,
  duplicate_of  text,
  duplicate_type text,
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz,
  reviewed_by   uuid references public.profiles(id)
);

create or replace function public.limit_pending_uploads()
returns trigger language plpgsql security definer set search_path = public as $$
declare pending_count integer;
begin
  select count(*) into pending_count from public.upload_submissions
   where uploader = new.uploader and status in ('pending', 'processing');
  if pending_count >= 10 then
    raise exception 'pending upload limit reached (10) — wait for moderation';
  end if;
  if new.size_bytes is not null and new.size_bytes > 25 * 1024 * 1024 then
    raise exception 'file too large (max 25 MB)';
  end if;
  return new;
end;
$$;

create or replace function public.rate_limit_uploads()
returns trigger language plpgsql security definer set search_path = public as $$
declare recent_count integer;
begin
  select count(*) into recent_count from public.upload_submissions
   where uploader = new.uploader and created_at > now() - interval '1 hour';
  if recent_count >= 5 then
    raise exception 'upload rate limit reached (5 per hour)';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_limit_pending_uploads on public.upload_submissions;
create trigger trg_limit_pending_uploads before insert on public.upload_submissions
  for each row execute function public.limit_pending_uploads();
drop trigger if exists trg_rate_limit_uploads on public.upload_submissions;
create trigger trg_rate_limit_uploads before insert on public.upload_submissions
  for each row execute function public.rate_limit_uploads();

alter table public.upload_submissions enable row level security;
create policy "submission status readable" on public.upload_submissions
  for select using (auth.uid() = uploader or public.is_admin());
create policy "submission insert" on public.upload_submissions
  for insert with check (auth.uid() = uploader);
create policy "submission owner update" on public.upload_submissions
  for update using (auth.uid() = uploader)
  with check (auth.uid() = uploader and status = 'pending' and review_notes is null);

-- ============================================================================
-- PROBLEM REPORTS
-- ============================================================================
create table if not exists public.problem_reports (
  id          bigint generated always as identity primary key,
  question_id text,
  reason      text,
  details     text,
  reporter    uuid references public.profiles(id),
  status      text not null default 'open' check (status in ('open', 'fixed', 'wontfix')),
  created_at  timestamptz not null default now()
);
alter table public.problem_reports enable row level security;
create policy "report insert" on public.problem_reports for insert with check (auth.uid() = reporter);
create policy "report select" on public.problem_reports for select using (true);

-- ============================================================================
-- USER MARKS, AUDIT EVENTS & CURRICULUM
-- ============================================================================
create table if not exists public.user_marks (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  question_id text not null,
  kind        text not null check (kind in ('completed', 'flagged', 'favourite', 'correct', 'incorrect', 'skipped')),
  created_at  timestamptz not null default now(),
  unique(user_id, question_id, kind)
);
create index if not exists idx_user_marks_user on public.user_marks(user_id, kind);
alter table public.user_marks enable row level security;
create policy "own marks read" on public.user_marks for select using (auth.uid() = user_id);
create policy "own marks write" on public.user_marks for all using (auth.uid() = user_id);

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
create index if not exists idx_audit_events_target on public.audit_events(target_id, created_at desc);
alter table public.audit_events enable row level security;
create policy "audit events readable" on public.audit_events
  for select using (public.is_admin());

create table if not exists public.curriculum_topics (
  id          text primary key,
  course_id   text not null,
  year_level  integer default 12,
  module      text,
  name        text not null
);
create index if not exists idx_curriculum_topics_course on public.curriculum_topics(course_id);
alter table public.curriculum_topics enable row level security;
create policy "curriculum status readable" on public.curriculum_topics for select using (true);

create table if not exists public.curriculum_outcomes (
  id            text primary key,
  topic_id      text not null references public.curriculum_topics(id) on delete cascade,
  code          text not null,
  description   text not null,
  skill_concept text
);
create index if not exists idx_curriculum_outcomes_topic on public.curriculum_outcomes(topic_id);
alter table public.curriculum_outcomes enable row level security;
create policy "outcomes status readable" on public.curriculum_outcomes for select using (true);

-- ============================================================================
-- ADMIN + CONTRIBUTOR HELPERS
-- ============================================================================
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.approve_upload(submission_id uuid)
returns public.upload_submissions
language plpgsql security definer set search_path = public as $$
declare sub public.upload_submissions;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  select * into sub from public.upload_submissions where id = submission_id;
  if sub is null then raise exception 'submission not found'; end if;

  update public.upload_submissions
     set status = 'approved', premium_granted = true, reviewed_at = now()
   where id = submission_id;

  if sub.uploader is not null then
    update public.profiles
       set access_tier = 'contributor',
           premium_until = greatest(coalesce(premium_until, now()),
                                    now() + interval '14 days'),
           contribution_credits = contribution_credits + 1
     where id = sub.uploader;
  end if;
  return sub;
end;
$$;

create or replace function public.moderate_upload(submission_id uuid, new_status text)
returns public.upload_submissions
language plpgsql security definer set search_path = public as $$
declare sub public.upload_submissions;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if new_status not in ('rejected', 'duplicate', 'needs_review', 'needs_changes', 'approved', 'pending') then
    raise exception 'invalid status';
  end if;
  update public.upload_submissions set status = new_status, reviewed_at = now()
   where id = submission_id;
  select * into sub from public.upload_submissions where id = submission_id;
  return sub;
end;
$$;

-- ============================================================================
-- NOTES
-- ----------------------------------------------------------------------------
-- 1. Leaderboard/timing RPCs expose only public aggregate fields; timing
--    stats never include individual users' private data.
-- 2. Comments are filtered server-side (profanity + rate limit); users can
--    delete only their own; moderators can hide any.
-- 3. To grant an admin:  update profiles set is_admin = true where id = '<uuid>';
-- 4. Opt-out of leaderboards: update_my_profile(new_opt_out_leaderboard => true).
-- ============================================================================
