# Making 99.95squad live on GitHub Pages

Goal: students visit **https://ds23code.github.io/99.95squad/** — no server, no
Mac, nothing to run. GitHub hosts everything.

There are **3 steps total**. Steps 2 and 3 must be done by you (the repo
owner) because the automation token used to build this repo cannot push
workflow files or change repo settings. Each step takes under a minute.

---

## Before you start (verified for this repo)

- Repo `ds23code/99.95squad` is **public** ✓ (GitHub Pages on the free plan
  requires a public repo)
- The site is fully **relative-path based** — it works at
  `https://ds23code.github.io/99.95squad/` (tested under a `/99.95squad/`
  subpath, zero 404s)
- The deploy workflow runs `pytest` + builds `_site` from the committed
  synthetic sample (13 questions) — no private data, no PDFs
- PR **#1** (`arena/019ff39c-99-95squad` → `main`) contains the entire codebase

---

## Step 1 — Merge the code into `main`

Open https://github.com/ds23code/99.95squad/pull/1 and click
**Merge pull request** (then *Confirm merge*). You can delete the branch after.

> This alone does not deploy anything — the workflow file isn't in the PR
> (see below).

## Step 2 — Add the deploy workflow to `main`

The workflow file is ready on disk in this repo (`.github/workflows/pages.yml`)
but cannot be pushed by the automation token. Add it with one of:

**Option A — GitHub web UI (no local git needed):**

1. Go to https://github.com/ds23code/99.95squad/new/main/.github/workflows
2. Name the file `pages.yml`
3. Paste the exact content below
4. Click **Commit changes** (to `main` directly)

**Option B — your machine:**

```bash
git clone git@github.com:ds23code/99.95squad.git
cd 99.95squad
mkdir -p .github/workflows
# create .github/workflows/pages.yml with the content below
git add .github/workflows/pages.yml
git commit -m "Enable GitHub Pages deploy"
git push origin main
```

### Workflow content

```yaml
name: Build & deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  test:
    name: Tests + site build
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: pip

      - name: Install Python dependencies
        run: |
          pip install -r requirements.txt pytest

      - name: Install frontend test dependencies (jsdom)
        run: npm ci

      - name: Run test suite (incl. DOM smoke test)
        run: pytest -q

      - name: Build static site
        env:
          QB_SITE_URL: https://${{ github.repository_owner }}.github.io/${{ github.event.repository.name }}/
        run: python scripts/build_site.py --out _site

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: _site

  deploy:
    name: Deploy to GitHub Pages
    needs: test
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@v4
```

Committing this file to `main` **triggers the workflow immediately** — it
runs the full test suite (77 tests), builds `_site`, and deploys it to Pages.

## Step 3 — Tell GitHub Pages to use the workflow

1. Open repo **Settings → Pages**
   (https://github.com/ds23code/99.95squad/settings/pages)
2. Under **Build and deployment → Source** select **GitHub Actions**
   (not "Deploy from a branch")
3. Done — the site is live once the workflow run finishes.

## Check it worked

1. **Actions tab** → the `Build & deploy to GitHub Pages` run should show
   green (`test` ✓, `deploy` ✓). First run takes ~2–4 minutes.
2. Open **https://ds23code.github.io/99.95squad/** — you should see the
   landing page with 13 sample questions, searchable, images loading.
3. The workflow run's deploy step also prints the live URL.

From now on, **every push to `main`** re-runs tests, rebuilds and redeploys
automatically.

---

## What students see now (sample content)

The deployed site currently contains the **synthetic sample** (13 questions) —
enough to verify everything works, but not a real question bank yet.

### Publishing your real library (only what you're legally allowed to share)

```bash
# on your machine (private): process your PDFs, review, then export
python -m pipeline init
python -m pipeline process data/papers/            # your real papers
python -m pipeline quality-check                  # must be 0 errors
python -m pipeline export-static --out site/content   # full library (git-ignored)

# preview locally first
python scripts/build_site.py --out site/_site
python scripts/serve_site.py --port 8080

# publish: replace the committed sample with your export
rm -rf site/content_sample && cp -r site/content site/content_sample
# IMPORTANT: only if you have the right to publish every paper inside.
git add site/content_sample && git commit -m "Publish question library" && git push origin main
```

Keep `data/papers/`, `data/questionbank.db` and `site/content/` **private**
— they are git-ignored and never leave your machine.

### Custom domain (optional, later)

Buy a domain, point a `CNAME` record at `ds23code.github.io`, then add the
domain in **Settings → Pages → Custom domain**, and set
`QB_SITE_URL: https://yourdomain/` as a repository variable so sitemap/robots
match.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Workflow run fails at `pytest` | Open the Actions log; the failing test names are printed. Most likely a test that needs `npm install` (step runs it) or a transient network issue — re-run the job. |
| Pages shows "Site has no content" | You built from a checkout without `site/content_sample` committed. Merge PR #1 first (it contains it). |
| Images don't load | Verify with the browser console — the site shows the exact requested URL in a broken-image box. `site/content_sample` must be present. |
| Deployment skipped | Check the Actions tab for the workflow file; then Settings → Pages → Source must be **GitHub Actions**. |
