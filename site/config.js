/* ============================================================================
 * 99.95squad — site configuration
 * ----------------------------------------------------------------------------
 * This file is committed and safe to publish. It contains NO secrets.
 *
 * To enable real student accounts (optional), create a Supabase project and
 * paste the public URL + anon key below. The site then uses Supabase Auth
 * (REST) and the `profiles` table — see site/backend/supabase.sql for the
 * schema and docs/AUTH.md for the step-by-step.
 *
 * Without these values the site runs in "device-local" mode: accounts and
 * progress are stored in this browser only, clearly labelled as such.
 * ==========================================================================*/
window.QB_CONFIG = window.QB_CONFIG || {};

window.QB_CONFIG.SUPABASE_URL = "https://ykmdjcsuhpwujaqnufhe.supabase.co";        // e.g. "https://xxxx.supabase.co"
window.QB_CONFIG.SUPABASE_ANON_KEY = "sb_publishable_DGc8GnT1bzn9-OIzC3JvNw_s5Ga_dId";   // public anon key (safe to embed)

/* Feature toggles --------------------------------------------------------- */
window.QB_CONFIG.features = {
  accounts: true,          // show sign-in UI
  uploads: true,           // show contribute-a-paper flow
  admin: true,             // show moderation page for reviewers
  analytics: true,         // progress/streak analytics
};

/* Free-tier limits (client-side UX; server-side enforcement comes with the
 * backend API — see docs/AUTH.md) */
window.QB_CONFIG.free = {
  dailyQuestions: 20,      // free questions per day (soft limit)
  premiumGiftDays: 14,     // premium days granted for an approved upload
};

/* Search architecture -----------------------------------------------------
 * engine "static"  — client-side inverted index (site/content), good to
 *                    ~100k questions, zero infrastructure.
 * engine "backend" — a search API implementing:
 *     GET {backend}?q=...&course=...&topic=...&difficulty_min=...
 *         &page=1&per_page=20&sort=...
 *     -> { total: number, items: [question record] }
 *   Set `backend` to its URL and re-implement query() in assets/js/search.js
 *   (the UI is unchanged). See docs/DEPLOY.md. */
window.QB_CONFIG.search = {
  engine: "static",
  backend: "",
  pageSize: 20,
};

/* Upload abuse protection (client-side checks; the backend/database enforces
 * the same limits server-side — see site/backend/supabase.sql & docs/AUTH.md) */
window.QB_CONFIG.upload = {
  maxBytes: 25 * 1024 * 1024,   // 25 MB per file
  maxPending: 10,               // max pending submissions per user
  requireCopyrightAck: true,    // must tick "I own the rights to this paper"
};

/* Gamification (display preferences only — XP/streaks/levels/mastery are
 * always computed server-side in Supabase and never trusted from storage) */
window.QB_CONFIG.gamification = {
  enabled: true,          // show XP/streak/levels UI
  levelCurve: "50*(L-1)*L", // matches supabase.sql level_from_xp
  streakBonusAt: 7,       // weekly-streak bonus threshold (server-side)
  streakBonusXp: 15,
};
