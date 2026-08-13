/* ============================================================================
 * auth.js — pluggable accounts & access control
 *
 * Two providers:
 *  - "local"   (default): device-local profile. NOT secure — clearly labelled.
 *  - "supabase": real accounts via the Supabase REST API when
 *    QB_CONFIG.SUPABASE_URL / ANON_KEY are set (see config.js, docs/AUTH.md).
 *
 * Access control (free / premium / contributor / admin) reads the `profiles`
 * table through the backend. On the static site this gates the UI; hard
 * enforcement happens server-side once the backend API serves question data
 * (see docs/AUTH.md "Enforcement").
 * ==========================================================================*/
(function () {
  "use strict";

  var root = window;
  var SESSION_KEY = "qb_supabase_session";

  function cfg() { return root.QB_CONFIG || {}; }
  function supabaseConfigured() {
    return !!(cfg().SUPABASE_URL && cfg().SUPABASE_ANON_KEY);
  }

  function headers(anonOnly) {
    var h = {
      "apikey": cfg().SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    };
    if (!anonOnly) {
      var session = sessionGet();
      if (session && session.access_token) h["Authorization"] = "Bearer " + session.access_token;
    }
    return h;
  }

  function sessionGet() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch (e) { return null; }
  }
  function sessionSet(s) {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  }

  /* ------------------------------------------------------------- Supabase */
  function sbSignUp(email, password, name) {
    return fetch(cfg().SUPABASE_URL + "/auth/v1/signup", {
      method: "POST", headers: headers(true),
      body: JSON.stringify({ email: email, password: password, data: { name: name } }),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error(j.error_description || j.msg || "Sign-up failed"); });
      return res.json();
    });
  }
  function sbSignIn(email, password) {
    return fetch(cfg().SUPABASE_URL + "/auth/v1/token?grant_type=password", {
      method: "POST", headers: headers(true),
      body: JSON.stringify({ email: email, password: password }),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error(j.error_description || j.msg || "Sign-in failed"); });
      return res.json();
    }).then(function (data) {
      sessionSet({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
      return data.user;
    });
  }
  function sbUser() {
    var s = sessionGet();
    if (!s) return Promise.resolve(null);
    return fetch(cfg().SUPABASE_URL + "/auth/v1/user", { headers: headers() })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return s.user || null; });
  }
  function sbSignOut() {
    var s = sessionGet();
    var token = s && s.access_token;
    var h = {
      "apikey": cfg().SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    };
    if (token) h["Authorization"] = "Bearer " + token;
    sessionSet(null);
    try { localStorage.removeItem("qb_profile_cache"); } catch (e) {}
    if (!s) return Promise.resolve();
    return fetch(cfg().SUPABASE_URL + "/auth/v1/logout", { method: "POST", headers: h }).catch(function () {});
  }
  function sbProfile(userId) {
    if (!userId) return Promise.resolve(null);
    return fetch(cfg().SUPABASE_URL + "/rest/v1/profiles?select=*&id=eq." + encodeURIComponent(userId), {
      headers: headers(),
    }).then(function (res) { return res.ok ? res.json() : []; })
      .then(function (rows) { return rows[0] || null; })
      .catch(function () { return null; });
  }
  function sbUpsertProfile(profile) {
    return fetch(cfg().SUPABASE_URL + "/rest/v1/profiles", {
      method: "POST",
      headers: Object.assign(headers(), { "Prefer": "resolution=merge-duplicates,return=representation" }),
      body: JSON.stringify(profile),
    }).then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; });
  }
  function sbInsertSubmission(sub) {
    return fetch(cfg().SUPABASE_URL + "/rest/v1/upload_submissions", {
      method: "POST",
      headers: Object.assign(headers(), { "Prefer": "return=representation" }),
      body: JSON.stringify(sub),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) {
        throw new Error(j.message || j.msg || "submission failed (HTTP " + res.status + ")");
      });
      return res.json();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Uploaded paper PDFs (private Supabase Storage bucket "paper-uploads") */
  /* ------------------------------------------------------------------ */

  var STORAGE_BUCKET = "paper-uploads";

  function storagePathEncode(path) {
    /* encode each segment, keep "/" separators: {uid}/{file}.pdf */
    return String(path || "").split("/").map(function (seg) {
      return encodeURIComponent(seg);
    }).join("/");
  }

  /* Upload the raw PDF bytes to the private bucket. The storage RLS policy
   * only allows writes under the caller's own {uid}/ folder, so a client can
   * never plant a file into another user's path. */
  function uploadPdf(file, storagePath) {
    return fetch(cfg().SUPABASE_URL + "/storage/v1/object/" + STORAGE_BUCKET + "/" + storagePathEncode(storagePath), {
      method: "POST",
      headers: Object.assign(headers(), { "Content-Type": "application/pdf", "x-upsert": "false" }),
      body: file,
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) {
        throw new Error((j && (j.message || j.error)) || "PDF upload failed (HTTP " + res.status + ")");
      });
      return res.json();
    });
  }

  /* Short-lived signed URL for a stored PDF. The Storage API only signs
   * objects the caller may SELECT — owner or admin — so a student can never
   * mint a link to someone else's file. Returns the absolute URL or null
   * when the object does not exist / is not readable. */
  function signUrl(storagePath, expiresSeconds) {
    if (!storagePath) return Promise.resolve(null);
    return fetch(cfg().SUPABASE_URL + "/storage/v1/object/sign/" + STORAGE_BUCKET + "/" + storagePathEncode(storagePath), {
      method: "POST", headers: headers(),
      body: JSON.stringify({ expiresIn: expiresSeconds || 3600 }),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) {
        throw new Error((j && (j.message || j.error)) || "could not sign file (HTTP " + res.status + ")");
      });
      return res.json();
    }).then(function (d) {
      var u = d && d.signedURL;
      if (!u) return null;
      if (u.indexOf("http") === 0) return u;
      return cfg().SUPABASE_URL + u;
    }).catch(function (err) { throw err; });
  }

  /* Server-verified admin flag (never trust the localStorage cache alone). */
  function isAdmin() {
    if (provider() !== "supabase" || !currentUser()) return Promise.resolve(false);
    return rpc("is_admin", {}).then(function (v) { return v === true; })
      .catch(function () { return false; });
  }

  /* Enriched submission feed for the moderation UI (admins only). */
  function adminListSubmissions() {
    if (provider() !== "supabase" || !currentUser()) return Promise.resolve([]);
    return rpc("admin_list_submissions").catch(function () {
      /* older backend without the RPC: RLS still lets admins select all rows */
      return sbListSubmissions();
    });
  }
  function sbListSubmissions() {
    return fetch(cfg().SUPABASE_URL + "/rest/v1/upload_submissions?select=*&order=created_at.desc", {
      headers: headers(),
    }).then(function (res) { return res.ok ? res.json() : []; })
      .catch(function () { return []; });
  }
  /* NOTE: there is deliberately no REST PATCH for upload_submissions —
   * status changes only ever happen through the SECURITY DEFINER RPCs
   * (approve_upload / moderate_upload), which is_admin() gates server-side. */
  function sbInsertReport(report) {
    return fetch(cfg().SUPABASE_URL + "/rest/v1/problem_reports", {
      method: "POST",
      headers: Object.assign(headers(), { "Prefer": "return=representation" }),
      body: JSON.stringify(report),
    }).then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; });
  }

  /* ---------------------------------------------------------------- local */
  function localProfile() {
    var s = root.QB.store.load();
    return s.user ? Object.assign({ id: s.user.id, email: s.user.email, name: s.user.name }, s.profile) : null;
  }
  function localSetUser(user) {
    var s = root.QB.store.load();
    s.user = user ? { id: user.id, email: user.email, name: user.name || "" } : null;
    root.QB.store.save();
  }

  /* --------------------------------------------------------------- public */
  function provider() { return supabaseConfigured() ? "supabase" : "local"; }

  function currentUser() {
    if (provider() === "supabase") {
      var s = sessionGet();
      var u = s && s.user;
      if (!u) return null;
      return { id: u.id, email: u.email, name: (u.user_metadata && u.user_metadata.name) || "" };
    }
    return localProfile();
  }

  /* entitlement: {tier, premium_until, isPremium, isAdmin} */
  function entitlement() {
    var user = currentUser();
    var plan = { tier: "free", premium_until: null, isPremium: false, isAdmin: false };
    if (!user) return plan;
    if (provider() === "supabase") {
      /* async profile — read cached copy if we have one */
      var cached = null;
      try { cached = JSON.parse(localStorage.getItem("qb_profile_cache")) || null; } catch (e) {}
      if (cached && cached.id === user.id) {
        plan.tier = cached.access_tier || "free";
        plan.premium_until = cached.premium_until;
        plan.isAdmin = !!cached.is_admin;
      }
    } else {
      var st = root.QB.store.load();
      plan.tier = (st.plan && st.plan.tier) || "free";
      plan.premium_until = (st.plan && st.plan.premium_until) || null;
    }
    plan.isPremium = plan.tier !== "free" && (!plan.premium_until || new Date(plan.premium_until) > new Date());
    plan.isContributor = plan.tier === "contributor";
    return plan;
  }

  /* refresh entitlement from the backend (call after login/profile changes) */
  function refreshEntitlement() {
    var user = currentUser();
    if (provider() !== "supabase" || !user) return Promise.resolve(entitlement());
    return sbProfile(user.id).then(function (profile) {
      if (profile) localStorage.setItem("qb_profile_cache", JSON.stringify(profile));
      return entitlement();
    });
  }

  function signUp(email, password, name) {
    if (provider() === "supabase") {
      return sbSignUp(email, password, name).then(function (data) {
        var user = data.user || data;
        sessionSet({ access_token: data.access_token, refresh_token: data.refresh_token, user: user });
        var profile = { id: user.id, email: user.email, display_name: name, access_tier: "free" };
        return sbUpsertProfile(profile).then(function () {
          refreshEntitlement();
          return { ok: true, user: user };
        });
      }).catch(function (err) { return { ok: false, error: err.message }; });
    }
    var id = "local-" + Date.now().toString(36);
    localSetUser({ id: id, email: email, name: name });
    return Promise.resolve({ ok: true, user: { id: id, email: email, name: name } });
  }

  function signIn(email, password) {
    if (provider() === "supabase") {
      return sbSignIn(email, password).then(function (user) {
        refreshEntitlement();
        return { ok: true, user: user };
      }).catch(function (err) { return { ok: false, error: err.message }; });
    }
    var existing = localProfile();
    if (existing && existing.email && existing.email !== email) {
      return Promise.resolve({ ok: false, error: "Device-local mode keeps one profile. Use the same email, or sign out first." });
    }
    var id = existing ? existing.id : "local-" + Date.now().toString(36);
    localSetUser({ id: id, email: email, name: existing && existing.name });
    return Promise.resolve({ ok: true, user: { id: id, email: email, name: existing && existing.name } });
  }

  function signOut() {
    try { localStorage.removeItem("qb_profile_cache"); } catch (e) {}
    if (provider() === "supabase") return sbSignOut();
    localSetUser(null);
    return Promise.resolve();
  }

  function cachedProfile() {
    try { return JSON.parse(localStorage.getItem("qb_profile_cache")) || null; } catch (e) { return null; }
  }

  function needsOnboarding() {
    var user = currentUser();
    if (!user) return false;
    var local = root.QB.store ? root.QB.store.load().profile : null;
    if (local && local.onboarded) return false;
    var cached = cachedProfile();
    if (cached && cached.id === user.id) return !cached.onboarding_completed;
    return false;
  }

  function rpc(fn, body) {
    return fetch(cfg().SUPABASE_URL + "/rest/v1/rpc/" + fn, {
      method: "POST", headers: headers(),
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error(j.message || j.msg || "HTTP " + res.status); });
      return res.json();
    });
  }

  function approveUpload(id) {
    if (provider() !== "supabase" || !currentUser()) {
      return updateSubmission(id, { status: "approved" });
    }
    return rpc("approve_upload", { submission_id: id });
  }

  function moderateUpload(id, status, notes, duplicateOf, duplicateType) {
    if (provider() !== "supabase" || !currentUser()) {
      return updateSubmission(id, { status: status, note: notes || null });
    }
    return rpc("moderate_upload", {
      submission_id: id,
      new_status: status,
      p_notes: notes || null,
      p_duplicate_of: duplicateOf || null,
      p_duplicate_type: duplicateType || null,
    });
  }

  function listAuditEvents(targetId) {
    if (provider() !== "supabase" || !currentUser()) return Promise.resolve([]);
    var q = "/rest/v1/audit_events?select=*&order=created_at.desc";
    if (targetId) q += "&target_id=eq." + encodeURIComponent(targetId);
    return fetch(cfg().SUPABASE_URL + q, { headers: headers() })
      .then(function (res) { return res.ok ? res.json() : []; })
      .catch(function () { return []; });
  }

  function listProblemReports() {
    if (provider() !== "supabase" || !currentUser()) {
      return Promise.resolve(root.QB.store.load().reports || []);
    }
    return fetch(cfg().SUPABASE_URL + "/rest/v1/problem_reports?select=*&order=created_at.desc", {
      headers: headers(),
    }).then(function (res) { return res.ok ? res.json() : []; }).catch(function () { return []; });
  }

  /* submissions bridge: local queue or backend table */
  function listSubmissions() {
    if (provider() === "supabase" && currentUser()) return sbListSubmissions();
    return Promise.resolve(root.QB.store.load().submissions);
  }
  function addSubmission(sub) {
    if (provider() === "supabase" && currentUser()) {
      return sbInsertSubmission(Object.assign({ uploader: currentUser().id }, sub)).then(function (row) {
        return { id: row && row.id, remote: true, sub: row };
      });
    }
    var local = root.QB.store.addSubmission(sub);
    return Promise.resolve({ id: local.id, remote: false, sub: local });
  }

  /* Full upload lifecycle: store the PDF bytes in the private bucket, then
   * register the submission row (the server forces status='pending' and
   * validates the storage path). In device-local mode there is nowhere to
   * store the bytes — the row is queued as before, clearly labelled. */
  function submitPaper(file, sub) {
    if (provider() === "supabase" && currentUser()) {
      var uid = currentUser().id;
      var suffix = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : ("sub-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
      var storagePath = uid + "/" + suffix + ".pdf";
      return uploadPdf(file, storagePath).then(function () {
        return sbInsertSubmission(Object.assign({ uploader: uid, storage_path: storagePath }, sub));
      }).then(function (row) {
        return { id: row && row.id, remote: true, sub: row };
      });
    }
    var local = root.QB.store.addSubmission(sub);
    return Promise.resolve({ id: local.id, remote: false, sub: local });
  }
  function updateSubmission(id, patch) {
    /* Device-local mode only. In Supabase mode, status changes MUST go
     * through the SECURITY DEFINER RPCs (approve_upload / moderate_upload);
     * there is no direct UPDATE grant or policy on upload_submissions, so a
     * REST PATCH would fail anyway — we never attempt it. */
    if (provider() === "supabase" && currentUser()) {
      return Promise.reject(new Error("submission status changes go through server RPCs only"));
    }
    root.QB.store.updateSubmission(id, patch);
    return Promise.resolve(patch);
  }
  function addReport(report) {
    if (provider() === "supabase" && currentUser()) {
      return sbInsertReport(Object.assign({ reporter: currentUser().id }, report)).then(function () { return { remote: true }; });
    }
    root.QB.store.addReport(report);
    return Promise.resolve({ remote: false });
  }

  /* ------------------------------------------------------------------ OAuth */
  /* Google / Apple sign-in via Supabase's PKCE authorize flow.
   * We implement the REST flow directly (no client library): generate a code
   * verifier, redirect to {SUPABASE_URL}/auth/v1/authorize, then exchange the
   * returned ?code= for a session on this page. */
  var VERIFIER_KEY = "qb_oauth_verifier";
  function _b64url(buf) {
    var s = "";
    new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function _pkceChallenge(verifier) {
    var bytes = new TextEncoder().encode(verifier);
    return crypto.subtle.digest("SHA-256", bytes).then(function (buf) {
      return _b64url(buf);
    });
  }
  function _randomVerifier() {
    var bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    return _b64url(bytes.buffer).slice(0, 64);
  }

  function oauthLogin(providerName) {
    if (!supabaseConfigured()) {
      return Promise.reject(new Error("Supabase is not configured — see docs/AUTH.md"));
    }
    var verifier = _randomVerifier();
    return _pkceChallenge(verifier).then(function (challenge) {
      try { sessionStorage.setItem(VERIFIER_KEY, verifier); } catch (e) { /* private mode */ }
      var redirectTo = window.location.origin + window.location.pathname;
      var params = new URLSearchParams({
        provider: providerName,
        redirect_to: redirectTo,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      window.location.href = cfg().SUPABASE_URL + "/auth/v1/authorize?" + params.toString();
      return null;
    });
  }

  /* Call after the OAuth provider redirects back with ?code=... */
  function handleOAuthCallback() {
    if (!supabaseConfigured()) return Promise.resolve(false);
    var params = new URLSearchParams(window.location.search);
    var code = params.get("code");
    if (!code) return Promise.resolve(false);
    var verifier = null;
    try { verifier = sessionStorage.getItem(VERIFIER_KEY); } catch (e) {}
    return fetch(cfg().SUPABASE_URL + "/auth/v1/token?grant_type=authorization_code", {
      method: "POST", headers: headers(true),
      body: JSON.stringify({ code: code, code_verifier: verifier || "" }),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error(j.error_description || "OAuth callback failed"); });
      return res.json();
    }).then(function (data) {
      sessionSet({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
      try { sessionStorage.removeItem(VERIFIER_KEY); } catch (e) {}
      // clean the ?code= from the URL without reloading
      var clean = window.location.pathname + window.location.hash;
      history.replaceState(null, "", clean);
      refreshEntitlement();
      return true;
    });
  }

  /* Settings update — routed through update_my_profile (server-side) so users
   * can never touch xp/level/premium/admin columns. */
  function updateProfile(fields) {
    fields = fields || {};
    var local = root.QB.store.load();
    local.profile = Object.assign({}, local.profile, {
      name: fields.display_name != null ? fields.display_name : local.profile.name,
      goal: fields.daily_goal != null ? fields.daily_goal : local.profile.goal,
      courses: fields.courses != null ? fields.courses : local.profile.courses,
      subjects: fields.subjects != null ? fields.subjects : local.profile.subjects,
      yearLevel: fields.year_level != null ? fields.year_level : local.profile.yearLevel,
      onboarded: fields.onboarding_completed != null ? !!fields.onboarding_completed : local.profile.onboarded,
    });
    root.QB.store.save();

    if (provider() !== "supabase" || !currentUser()) {
      return Promise.resolve(local.profile);
    }
    return fetch(cfg().SUPABASE_URL + "/rest/v1/rpc/update_my_profile", {
      method: "POST", headers: headers(),
      body: JSON.stringify({
        new_display_name: fields.display_name || null,
        new_avatar_url: fields.avatar_url || null,
        new_daily_goal: fields.daily_goal != null ? fields.daily_goal : null,
        new_opt_out_leaderboard: fields.opt_out_leaderboard != null ? fields.opt_out_leaderboard : null,
        new_subjects: fields.subjects || null,
        new_courses: fields.courses || null,
        new_year_level: fields.year_level != null ? fields.year_level : null,
        new_onboarding_completed: fields.onboarding_completed != null ? fields.onboarding_completed : null,
      }),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error(j.message || "update failed"); });
      return res.json();
    }).then(function (row) {
      if (row) localStorage.setItem("qb_profile_cache", JSON.stringify(row));
      return row;
    });
  }

  root.QB = root.QB || {};
  root.QB.auth = {
    provider: provider, supabaseConfigured: supabaseConfigured,
    currentUser: currentUser, entitlement: entitlement, refreshEntitlement: refreshEntitlement,
    signUp: signUp, signIn: signIn, signOut: signOut,
    oauthLogin: oauthLogin, handleOAuthCallback: handleOAuthCallback,
    updateProfile: updateProfile, needsOnboarding: needsOnboarding, cachedProfile: cachedProfile,
    approveUpload: approveUpload, moderateUpload: moderateUpload,
    listAuditEvents: listAuditEvents, listProblemReports: listProblemReports,
    listSubmissions: listSubmissions, addSubmission: addSubmission,
    submitPaper: submitPaper, updateSubmission: updateSubmission, addReport: addReport,
    uploadPdf: uploadPdf, signUrl: signUrl, isAdmin: isAdmin,
    adminListSubmissions: adminListSubmissions, STORAGE_BUCKET: STORAGE_BUCKET,
  };
})();
