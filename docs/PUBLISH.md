# Publishing 99.95squad to GitHub Pages

The production Pages URL is **https://ds23code.github.io/99.95squad/**.
GitHub serves a static artifact; no local machine, Flask server, PDF, SQLite
database, admin token, or Supabase secret is included in that artifact.

## 1. Ship through a pull request

`.github/workflows/pages.yml` is already tracked. Make changes on a feature
branch, validate them, push that branch, and open a PR to `main`:

```bash
git status --short
git diff --check
pytest -q
python scripts/build_site.py --out site/_site
git push origin <feature-branch>
gh pr create --base main --head <feature-branch> --fill
```

Review the PR's checks and diff, then merge it. Do not bypass review by pushing
application changes directly to `main`. A push/merge to `main` triggers the
Pages workflow automatically.

The workflow installs locked frontend dependencies, runs the full pytest suite
(including DOM/auth smoke tests), builds `_site`, uploads the Pages artifact,
and deploys it. It builds from committed `site/content_sample/`; private local
`site/content/`, `data/`, PDFs, SQLite files, and processor claim files are
ignored and unavailable to Actions.

## 2. Enable GitHub Pages once

In repository **Settings → Pages**, set **Build and deployment → Source** to
**GitHub Actions**. No branch-based `gh-pages` configuration is needed.

After merging, inspect **Actions → Build & deploy to GitHub Pages**. Both the
`test` and `deploy` jobs must be green before treating the release as live.

## 3. Verify the deployed site

Open the production URL and check at least:

- landing page, question search, one question image, and practice mode;
- email/password sign-in and a reload that restores the session;
- a direct/refresh navigation path such as
  `https://ds23code.github.io/99.95squad/admin` — `404.html` must recover it
  to `#/admin` without dropping the repository base path;
- Google sign-in returns to
  `https://ds23code.github.io/99.95squad/?code=...`, exchanges the PKCE code,
  removes the query, and restores the intended hash route;
- a non-admin cannot open `#/admin`; an authenticated profile with
  `profiles.is_admin = true` can see the Admin link and moderation queue.

These are post-deploy checks, not substitutes for automated tests. Record only
checks that were actually performed.

## Supabase migration is a separate release action

The Pages workflow does **not** alter Supabase. Before using **Approve & queue**
or the controlled remote processor on the existing project, apply
`site/backend/migrations/20260813_upload_processing_lifecycle.sql` exactly once
in the Supabase SQL editor. It is additive and data-preserving. Do not reset or
recreate tables, users, profiles, or Storage.

For a brand-new project only, use `site/backend/supabase.sql`. The frontend
must contain only the public publishable/legacy anon key. Never put a
service-role or `sb_secret_...` key in `site/config.js`, GitHub variables,
browser code, docs, logs, or chat.

After applying the migration, use the admin page at `#/admin` to preview a
student PDF and click **Approve & queue**. That does not publish or reward the
student. An operator then processes that one selected UUID with an admin-user
session:

```bash
umask 077
mkdir -p "$HOME/.config/99.95squad" && chmod 700 "$HOME/.config/99.95squad"
export SUPABASE_URL='https://ykmdjcsuhpwujaqnufhe.supabase.co'
export SUPABASE_PUBLISHABLE_KEY='<public-project-key>'  # SUPABASE_ANON_KEY also works
export SUPABASE_SESSION_FILE="$HOME/.config/99.95squad/admin-session.json"
# First-run bootstrap only; use a dedicated admin-user session:
export SUPABASE_ACCESS_TOKEN='<dedicated-admin-user-access-token>'
export SUPABASE_REFRESH_TOKEN='<matching-rotating-refresh-token>'
python -m pipeline uploads process-remote <submission-uuid> \
  --export-out site/content
unset SUPABASE_ACCESS_TOKEN SUPABASE_REFRESH_TOKEN
```

The absolute session file is created mode `0600` and atomically updated after
every rotating-token refresh, so later restarts use the current pair. Treat it
as a live bearer credential: keep it outside Git/backups/logs/chat and never
share that dedicated session with a browser. See `docs/AUTH.md` for bootstrap,
permission, override-flag, and retirement details.

The command claims, downloads, processes, validates, and exports exactly one
submission. Only successful completion changes the row to `approved` and
grants contributor credit. Rerun the same UUID after an uncertain response;
the durable claim token prevents double publication/reward.

## Publishing content deliberately

The deployed repository currently uses the committed synthetic sample. For
real material:

```bash
# Private/local preparation
python -m pipeline process data/papers/one-paper.pdf
python -m pipeline process data/papers/one-paper.pdf  # verify idempotent skip
python -m pipeline quality-check
python -m pipeline export-static --out site/content --source full
python scripts/build_site.py --out site/_site
python scripts/serve_site.py --port 8080
```

Inspect crops, repeated-number IDs, answer/solution attachment, metadata,
copyright, and the local preview. Then copy only content you are legally and
operationally ready to publish into the tracked publication source
`site/content_sample/`, review that potentially large diff, and ship it in a
separate PR. Keep source PDFs, `data/questionbank.db`, and `site/content/`
private.

Do not begin with the entire archive. Validate one PDF, its rerun, several
papers sharing printed question numbers, duplicate handling, and failure
recovery, then use modest batches. A 100,000–300,000 question deployment needs
a backend search/content strategy and storage/cost review before publication;
do not assume one giant GitHub Pages commit is production-ready.

## Troubleshooting

| Symptom | Action |
|---|---|
| PR/Pages test fails | Open the named check and reproduce its exact command locally; do not merge by disabling the check. |
| Pages has sample content only | Expected unless a reviewed export was deliberately committed to `site/content_sample/`. |
| Direct nested URL shows GitHub 404 | Confirm the deployed artifact contains `404.html`, then check its repository-base recovery logic and cache version. |
| Google returns but the user is not signed in | Check the exact Pages root redirect URL, same-browser PKCE verifier, token exchange, `/auth/v1/user`, and profile request; provider success alone is not app success. |
| Admin link is absent | Confirm the restored user matches a `profiles` row whose `is_admin` is true; do not weaken the server-side check. |
| Queue/processor says an RPC or column is missing | Apply the additive lifecycle migration to the existing Supabase project; do not rerun/reset the whole canonical schema. |
| Images fail | Inspect the exact URL shown by the broken-image UI and verify the referenced file exists in the built `content/` tree. |
