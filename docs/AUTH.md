# Accounts, premium access & uploads

## Design principle

GitHub Pages is static. The site therefore **never pretends** to enforce
security in the browser:

- **Device-local mode** (default): accounts, progress, favourites, sets and
  submissions are stored in `localStorage`. Clearly labelled as device-local.
  Fine for a single student's practice data; NOT accounts.
- **Supabase mode** (one-time setup): real email/password accounts, profiles,
  moderated uploads and premium entitlements, enforced by database
  row-level security. The frontend talks to Supabase's REST API directly.

Even in Supabase mode, *content access* (which questions a free user may see)
can only be truly enforced by a backend API that serves the question payloads.
The static site gates **UI features** from the entitlement (plan badge,
daily-question counter, analytics depth) and documents the enforcement point.

## One-time setup (optional, ~15 minutes)

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. Open the SQL editor and run [`site/backend/supabase.sql`](../site/backend/supabase.sql)
   — creates `profiles`, `attempts`, `xp_events`, `favourites`, `comments`,
   `upload_submissions`, `problem_reports`, RLS policies and all SECURITY
   DEFINER functions (record_attempt, get_dashboard, topic_mastery,
   daily_activity, time_stats, leaderboard, add_comment, …).
3. **Authentication → Providers**: enable **Email** (required) and **Google**
   (set the Client ID + Client Secret from the Google Cloud console). Apple
   is optional and needs a paid Apple Developer account (Sign in with Apple
   keys) — the frontend already has the button; it activates once the
   provider is enabled.
4. **Authentication → URL Configuration → Redirect URLs**: add your Pages URL,
   e.g. `https://ds23code.github.io/99.95squad/` (OAuth returns here with
   `?code=` and the app exchanges it automatically).
5. Copy your project URL and anon key into `site/config.js`:

   ```js
   window.QB_CONFIG.SUPABASE_URL = "https://xxxx.supabase.co";
   window.QB_CONFIG.SUPABASE_ANON_KEY = "eyJ...";   // public anon key — safe to embed
   ```

6. (Optional) make yourself a moderator/admin. There is no separate moderator
   login — sign in through the normal page, then promote the account in SQL:
   ```sql
   update profiles set is_admin = true where id = '<your-user-uuid>';
   ```
   The Admin link then appears in the header. Review uploads at `#/admin`.
   Approve / reject / request-changes call `approve_upload()` and
   `moderate_upload()` (SECURITY DEFINER + `is_admin()`). Students cannot
   set `is_admin` or change submission status themselves.
7. Rebuild the site (`python scripts/build_site.py`) and deploy.

The anon key is public by design — it only ever sees rows the RLS policies
allow. **Never put the service-role key in the frontend.**

## What changes when Supabase is connected

- **Sign-in**: email/password, **Google**, and **Apple** (if enabled) via the
  Supabase PKCE authorize flow; sessions persist (`qb_supabase_session`) and
  survive reloads. `#/profile` edits display name/avatar/daily-goal/leaderboard
  opt-out through `update_my_profile` (server-side only).
- **Gamification** (server-side truth): every attempt goes through
  `record_attempt()`, which validates and computes XP (by difficulty),
  streak, level and daily totals — never trusted from localStorage.
- **Mastery**: `topic_mastery()` returns per-topic stages
  (Unseen → Learning → Practising → Strong → Mastered) from accuracy,
  difficulty, recency and attempts; `#/syllabus` visualises the path.
- **Activity calendar**: `daily_activity()` powers the GitHub-style heatmap on
  the dashboard (week/month/year).
- **Time analytics**: `time_stats()` returns *aggregates only* — your average
  vs community average/median; individual students' data is never exposed.
- **Leaderboards**: `leaderboard(week|all)` ranks by XP, honours
  `opt_out_leaderboard`, and `my_rank()` shows your position.
- **Comments**: `add_comment()` enforces rate limits (10/hour) and a profanity
  filter; likes/reports/deletes go through SECURITY DEFINER functions; users
  can only delete their own comments.
- **Contributions**: uploads insert with `status='pending'`; the admin page /
  `approve_upload()` grants the 14-day premium entitlement server-side.
- The **admin page** (`#/admin`, visible to `is_admin` users) moderates
  uploads and comments.

## Processing approved uploads

Approving a submission in the UI marks it approved and grants premium, but
the PDF itself must still be turned into questions. Two options:

1. **Local pipeline (recommended for you as the operator):**
   the upload page tells students to email you / you download the file, then:
   ```bash
   python -m pipeline uploads register submitted.pdf --uploader <student-id>
   python -m pipeline uploads approve <upload-id> --reviewer admin
   ```
   This runs the normal pipeline (render → detect → crop → OCR → classify),
   links the paper, and grants the student premium.
2. **Backend job:** a scheduled function watches for `approved` submissions
   and invokes the same pipeline on a worker. Schema is ready for this; the
   processing glue is the same `pipeline/uploads.py` code.

## Contributor incentive

On approval, the uploader's profile becomes:

```
access_tier          = 'contributor'
premium_until        = now() + 14 days   (stacking on any existing premium)
contribution_credits = contribution_credits + 1
```

This happens inside `public.approve_upload()` (Supabase) or
`pipeline/uploads.py::approve_upload` (local) — never by editing
`localStorage`, so entitlements can't be forged in the browser.

## Free vs premium (client gating, server enforcement later)

| | Free | Premium / Contributor |
|---|---|---|
| Daily questions | `free.dailyQuestions` (20) | unlimited |
| Search & filters | basic | advanced + full history |
| Analytics | current session | detailed, weak topics, streaks |
| Custom sets | — | yes |

The static site reads the entitlement from the backend profile; a future
backend API that serves question payloads enforces the same limits
server-side (same `access_tier` field, same rules). The UI never blocks
anything it cannot verify — it labels device-local mode honestly.

## Security hardening (Supabase)

- **Users cannot edit their own entitlement.** `UPDATE` on `profiles` is
  revoked from `anon`/`authenticated`; the only write path is the
  `SECURITY DEFINER` function `update_my_profile(...)` which touches only
  display fields. `access_tier`, `premium_until`, `is_admin` and
  `contribution_credits` are server-only.
- **Contributor rewards are server-side.** `approve_upload()` computes
  `premium_until = greatest(coalesce(premium_until, now()), now() + 14 days)`
  inside the database and increments `contribution_credits` in the same
  transaction as the status change. The browser cannot influence it.
- **Uploads cannot bypass moderation.** Students insert rows with
  `status='pending'` only (RLS + the update policy restricts status changes
  to moderators). The `limit_pending_uploads` trigger caps pending
  submissions at 10 and rejects files over 25 MB; the `rate_limit_uploads`
  trigger additionally caps submissions at 5 per user per rolling hour.
  The local pipeline mirrors the size + magic-byte checks, and the client
  enforces the same limits for UX — but the database triggers are the
  enforcement point.
- **Admins are server-side.** `is_admin` is set by you in the database;
  moderator SQL functions check it with `SECURITY DEFINER`.
- **Magic-byte + size checks** are mirrored in the local pipeline
  (`pipeline/uploads.py`) and the frontend, but the database trigger is the
  enforcement point.

## Frequently asked

- **Can someone edit localStorage to get premium?** In device-local mode there
  is nothing to protect (it's their own device data). In Supabase mode the
  plan comes from the database, so editing localStorage changes nothing.
- **Is the anon key a secret?** No — it's designed to be public. The
  service-role key is the secret and must stay server-side.
- **I don't want accounts at all.** Leave `config.js` empty; everything works
  device-locally.
