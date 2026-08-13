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
2. For a **new project only**, open the SQL editor and run
   [`site/backend/supabase.sql`](../site/backend/supabase.sql). It creates the
   tables, RLS policies, SECURITY DEFINER functions, and private
   `paper-uploads` bucket. For an existing 99.95squad project, do **not** rerun
   or reset the schema: apply the additive migration in
   [`site/backend/migrations/20260813_upload_processing_lifecycle.sql`](../site/backend/migrations/20260813_upload_processing_lifecycle.sql)
   once in the SQL editor. The migration preserves rows and adds the queued →
   processing → approved lifecycle.
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
   window.QB_CONFIG.SUPABASE_ANON_KEY = "sb_publishable_..."; // public key; legacy anon JWT also works
   ```

6. (Optional) make yourself a moderator/admin. There is no separate moderator
   login — sign in through the normal page, then promote the account in SQL:
   ```sql
   update profiles set is_admin = true where id = '<your-user-uuid>';
   ```
   The Admin link then appears in the header. Review uploads at `#/admin`.
   “Approve & queue” calls `queue_upload()`; rejection, duplicate and
   request-changes decisions call `moderate_upload()`. Both are SECURITY
   DEFINER and verify `profiles.is_admin` server-side. Students cannot set
   `is_admin`, select another user's object, or change submission status.
7. Rebuild the site (`python scripts/build_site.py --out site/_site`), run the
   test suite, and deploy through a reviewed PR.

The publishable/legacy anon key is public by design — it only sees rows the
RLS policies allow. **Never put a service-role JWT or modern `sb_secret_...`
key in the frontend.**

## What changes when Supabase is connected

- **Sign-in**: email/password, **Google**, and **Apple** (if enabled) via the
  Supabase PKCE authorize flow; expiry-aware sessions persist in
  `qb.supabase.session` and survive reloads. On first load after this release,
  the previously deployed `qb_supabase_session` value is migrated once without
  extending its original expiry; logout clears both keys. Startup refreshes
  when needed, validates `/auth/v1/user`, and loads `profiles.is_admin` before
  routing.
  `#/profile` edits display name/avatar/daily-goal/leaderboard
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
- **Contributions**: PDF bytes are stored in the private `paper-uploads`
  bucket under the uploader's UUID; the row is forced to `status='pending'`.
  At `#/admin`, a moderator opens a submission, previews its short-lived
  signed URL, and clicks **Approve & queue**, **Reject**, **Duplicate**,
  **Needs review**, or **Request changes**. Queueing does not publish or grant
  premium. The controlled CLI must claim, process, validate and export that
  one submission; only `complete_upload_processing()` sets `approved` and
  grants the 14-day entitlement.
- The **admin page** (`#/admin`, visible only after an authenticated
  `profiles.is_admin` check) moderates uploads and problem reports.

## Controlled processing of a selected upload

This is deliberately a one-submission command; there is no “process all”
mode. Before the first controlled run on an existing project:

1. Apply `site/backend/migrations/20260813_upload_processing_lifecycle.sql`
   once in the Supabase SQL editor. Do not reset tables or Storage.
2. Sign in as an existing user whose `profiles.is_admin` is true and obtain a
   **dedicated user session** for the processor. Do not reuse a browser session:
   Supabase refresh tokens rotate, so two clients refreshing the same session
   can invalidate each other. Do not use or export a service-role key.
3. Choose an absolute, operator-owned session-file path outside the repository.
   The CLI refuses relative paths, symlinks, non-regular files, files owned by
   another user, and group/world-readable files. Bootstrap it once from the
   matching token pair (never put these values in `site/config.js`, Git, CI
   logs, shell history, or chat):

   ```bash
   umask 077
   mkdir -p "$HOME/.config/99.95squad"
   chmod 700 "$HOME/.config/99.95squad"
   export SUPABASE_URL='https://ykmdjcsuhpwujaqnufhe.supabase.co'
   export SUPABASE_PUBLISHABLE_KEY='<public-project-key>'
   # Legacy/alternate variable: SUPABASE_ANON_KEY is also accepted.
   export SUPABASE_SESSION_FILE="$HOME/.config/99.95squad/admin-session.json"
   export SUPABASE_ACCESS_TOKEN='<dedicated-admin-user-access-token>'
   export SUPABASE_REFRESH_TOKEN='<matching-admin-user-refresh-token>'
   ```

   On the first command the missing session file is atomically created with
   mode `0600`. Every successful token rotation atomically replaces it with the
   new access/refresh pair before another request is sent. Existing session-file
   credentials take precedence over stale token environment variables, making
   later process restarts safe.

   The session file is a live bearer credential: exclude it from Git, backups,
   logs, and chat; keep its parent directory private; delete/revoke it when the
   dedicated processor session is retired. The client rejects service-role
   JWTs and modern `sb_secret_...` keys.
4. From a clean working tree, process exactly the UUID selected in the admin
   UI (the equivalent `--session-file /absolute/path` flag overrides the
   environment path):

   ```bash
   python -m pipeline uploads process-remote <submission-uuid> \
     --export-out site/content
   ```

   After that first command has created the file, remove token variables from
   the shell. Future commands load the latest rotated pair from the file:

   ```bash
   unset SUPABASE_ACCESS_TOKEN SUPABASE_REFRESH_TOKEN
   ```

The command uses the authenticated admin session, while every lifecycle RPC
also checks `public.is_admin()`. It atomically claims the queued row with a
six-hour lease, signs and streams the private PDF, validates project origin,
size, `%PDF-` bytes and SHA-256, then runs the normal idempotent pipeline. It
quality-checks that paper, exports the complete local corpus, verifies every
new ID in `questions/lookup.json`, and only then reports completion.

A durable claim token is stored under the git-ignored
`data/papers/student-uploads/<submission-uuid>/` directory. Rerunning the same
command can resume a same-token lease or recognize a completion whose response
was lost: the approved row retains that successful claim UUID for this
idempotency check while clearing its lease expiry. A local lock rejects
concurrent commands for that submission.
Processing failures move the row to **Needs review** with the error and attempt
count visible at `#/admin`. Correct the cause, use **Approve & queue** again,
and rerun the same one-ID command. A successful static export is a publication
gate, not an automatic GitHub Pages deployment.

Do not bulk-import the paper archive. First process one PDF, rerun it, then
try several PDFs that reuse question numbers and inspect crops, duplicate
behaviour, audit events and publication output before any modest batch.

## Contributor incentive

On successful processing completion (not when an admin queues it), the
uploader's profile becomes:

```
access_tier          = 'contributor'
premium_until        = now() + 14 days   (stacking on any existing premium)
contribution_credits = contribution_credits + 1
```

For Supabase submissions this happens only inside
`public.complete_upload_processing()` after publication validation. The
legacy `approve_upload()` RPC is retained as a compatibility alias that only
queues. The separate device-local workflow still uses
`pipeline/uploads.py::approve_upload`. Neither trusts browser state.

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
- **Contributor rewards are server-side and completion-gated.**
  `complete_upload_processing()` computes the premium extension and increments
  `contribution_credits` in the same transaction that publishes the processed
  paper. Queueing alone never changes entitlement.
- **Uploads cannot bypass moderation.** The `harden_submission_insert`
  trigger forces every new row to `status='pending'`,
  `premium_granted=false`, no review fields, no duplicate markers, and
  validates that `storage_path` (if given) starts with the uploader's own
  folder — a student can never insert a pre-approved row or point the row
  at someone else's file. The `limit_pending_uploads` trigger caps pending
  submissions at 10 and rejects files over 25 MB; the `rate_limit_uploads`
  trigger additionally caps submissions at 5 per user per rolling hour.
  Storage and the database enforce the byte limit; browser checks are only
  UX. The controlled processor independently streams and verifies the actual
  byte count, `%PDF-` signature and SHA-256 before publication.
- **PDFs live in a private storage bucket.** `paper-uploads` is created by
  the schema (private, 25 MB, PDF-only). Storage RLS lets a user write only
  under `{their-uuid}/`, read (and sign) only their own objects, and lets
  admins read/sign/delete anything in the bucket. The moderation UI opens
  PDFs through short-lived signed URLs generated by the Storage API — the
  bucket is never public and students can never enumerate or fetch another
  student's file.
- **Moderation RPCs are the only status path.** `queue_upload()`,
  `moderate_upload()`, `claim_upload_for_processing()`,
  `complete_upload_processing()` and `fail_upload_processing()` are SECURITY
  DEFINER, check `is_admin()`, lock the selected row, and write audit events.
  Active `processing` and published `approved` rows cannot be changed through
  ordinary moderation. The frontend never PATCHes `upload_submissions`
  directly (no UPDATE grant/policy exists).
- **Admins are server-side.** `is_admin` is set by you in the database;
  moderator SQL functions check it with `SECURITY DEFINER`.
- **File validation has layered enforcement.** Private Storage and the insert
  trigger cap size; the frontend rejects obvious mistakes for UX. Before any
  publication, the controlled processor streams the signed object under its
  own limit and verifies the real size, `%PDF-` signature, expected SHA-256,
  and signed-URL project origin.

## Frequently asked

- **Can someone edit localStorage to get premium?** In device-local mode there
  is nothing to protect (it's their own device data). In Supabase mode the
  plan comes from the database, so editing localStorage changes nothing.
- **Is the publishable/anon key a secret?** No — it is designed to be public.
  Service-role JWTs and modern `sb_secret_...` keys are secrets and must never
  enter the browser or controlled CLI.
- **I don't want accounts at all.** Leave `config.js` empty; everything works
  device-locally.
