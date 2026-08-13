# Deploying to GitHub Pages

The public site is a **static site** (`site/`) that runs entirely in the
browser. No Mac, no Flask server, no database is needed to serve it — GitHub
Pages hosts the files, and the browser fetches JSON data + images from the
same origin.

```
pipeline (local, private)          static export (local)          GitHub Pages (public)
data/papers/*.pdf        ──►      site/content/       ──►        site/_site/  ──►  https://<user>.github.io/<repo>/
 (your PDFs, git-ignored)         (git-ignored)                   (built by Actions, deployed)
                                  site/content_sample/ (committed, synthetic)
```

## The workflow

`.github/workflows/pages.yml` runs on every push to `main`:

1. `pytest -q` — the full test suite (pipeline, export, uploads, site build,
   and the jsdom DOM smoke test which drives the real frontend).
2. `python scripts/build_site.py --out _site` — assembles the deployable site
   from `site/` + content, validates it, and generates `sitemap.xml` +
   `robots.txt`.
3. Uploads the artifact and deploys it to GitHub Pages.

**GitHub Actions never runs the pipeline** — it has no PDFs and no access to
your private database. It packages the committed sample content
(`site/content_sample/`), so the public site always has content and the build
is fast and deterministic.

The Pages workflow also never migrates Supabase. Existing projects must apply
`site/backend/migrations/20260813_upload_processing_lifecycle.sql` manually,
once, before using queue/processing RPCs. This is a separate release action;
see `docs/AUTH.md`. Never add an admin access token, refresh token,
service-role key, or `sb_secret_...` key to GitHub Pages/Actions.

## Enabling Pages for your repo

1. Merge a reviewed feature-branch pull request into `main`; do not push
   application changes directly to `main` merely to trigger a deployment.
2. Go to **Settings → Pages** and set *Source* to **GitHub Actions**
   (the workflow uploads its own artifact; no branch-based Pages config).
3. The merge to `main` runs the workflow and deploys if all checks pass.
4. The site is live at `https://<user>.github.io/<repo>/`. Assets and recovery
   routing preserve the `/repo/` subpath.

## Publishing your real question library (optional, deliberate)

The committed `site/content_sample/` is a synthetic demo (13 questions). To
publish your actual library:

```bash
# 1. export the full library to site/content (git-ignored)
python -m pipeline export-static --out site/content --source full

# 2. build + preview locally
python scripts/build_site.py --out site/_site
python scripts/serve_site.py --port 8080      # http://localhost:8080

# 3. publish deliberately: copy the reviewed export (or a reviewed subset)
#    into the tracked site/content_sample source, inspect the full diff, and
#    ship it in a separate PR. Do not commit site/_site; Actions rebuilds it.
#    Commit ONLY material you are legally allowed to publish.
```

> **Copyright & privacy.** Only publish question images and metadata you are
> legally allowed to share. The exporter already strips source PDFs, original
> filenames and raw OCR dumps; it cannot judge copyright for you. If your
> papers are private, keep `site/content/` local — the site simply shows the
> sample set until you publish an export.

## What the static site can and cannot do

| Feature | Static site | Backend API (future) |
|---|---|---|
| Search, filters, pagination | ✅ client-side (sharded + facet index) | ✅ same UI |
| Practice, saved, progress, streaks | ✅ device-local | syncs to account |
| Accounts / cross-device progress | ✅ with Supabase (docs/AUTH.md) | ✅ |
| Upload submissions + moderation | ✅ with Supabase RLS/RPCs + private Storage | ✅ alternative architecture |
| Contributor/admin entitlement | ✅ server-side in Supabase; static content itself remains public | ✅ can gate content responses |
| Search at 100k+ questions | ⚠️ browser-heavy; not the recommended production target | ✅ recommended |

### Search: static → backend swap

The search layer (`site/assets/js/search.js`) is an adapter. The static engine
serves smaller datasets efficiently: sharded records (2000/shard) are fetched
lazily per page, and filter-only queries run as **index intersections over
facet tokens** (`c:<course>`, `t:<topic>`, `y:<year>`, `q:<type>`,
`d:<difficulty>`, `m:<marks>`, `p:<paper_type>`, `s:<subject>`), so the
browser never downloads the whole library.

Past ~100k questions, point the UI at a search API without touching any page
code:

```js
// site/config.js
window.QB_CONFIG.search = {
  engine: "backend",
  backend: "https://api.example.com/search",   // your API
  pageSize: 20,
};
```

The backend endpoint contract: `GET {backend}?q=...&course=...&topic=...&
difficulty_min=...&page=1&per_page=20&sort=...` →
`{ total, items: [question records] }` (same record shape as the static
shards). `search.js` already implements the call; add auth headers/signing in
`queryBackend()` as needed. Data access for images stays static (GitHub
Pages), so only the JSON search moves.

### Image URLs: how question images reach the browser

```
PDF → render → crop qNN.png (canonical, full-res)
   → export_static: qNN.webp (+.jpg fallback, +.thumb.*, original .png kept)
   → site/content/images/questions/<course>/<year>/<org>/…
   → build_site copies content/ into _site
   → shard JSON stores content-relative refs: "images/questions/…"
   → frontend api.imageUrl() resolves them to public URLs: "content/images/…"
   → <img src> relative to the site root → works at / and /99.95squad/
```

JSON never contains local filesystem paths — only content-relative public
URLs. `tests/test_static_images.py` verifies every referenced image exists
in `_site` and serves HTTP 200, and `tests/test_dom_smoke.py` (live mode)
opens a real question page in jsdom with network resource loading and fails
on any 404.

### Deploy hardening

- **Cache busting** — `scripts/build_site.py` stamps a content-derived
  `?v=<sha>` onto every frontend asset URL, so deployed assets never serve
  stale cached copies after a content update.
- **Quality gate** — the export runs the data-quality audit and records the
  summary in `manifest.json`; the build **fails** on quality errors
  (`--allow-quality-errors` to override, not recommended).
- **Relative paths** — every asset reference is relative, so the site works
  under `https://<user>.github.io/<repo>/` with no base-URL config.
- **Direct navigation/404 recovery** — `404.html` converts a Pages request
  such as `/99.95squad/admin?view=queued` to the equivalent hash route while
  preserving `/99.95squad/` and its query. Hash navigation then works on
  refresh as well as through in-app links.
- **Works without a local server** — the built site is plain static files;
  `scripts/serve_site.py` is only a local preview.

## Sitemap & SEO

`sitemap.xml` and `robots.txt` are generated during the build from the
published question ids. Hash-routed question pages are listed for search
engines; each page sets its own `<title>` and meta description in JS.
