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
    sessionSet(null);
    if (!s) return Promise.resolve();
    return fetch(cfg().SUPABASE_URL + "/auth/v1/logout", { method: "POST", headers: headers() }).catch(function () {});
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
    }).then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; });
  }
  function sbListSubmissions() {
    return fetch(cfg().SUPABASE_URL + "/rest/v1/upload_submissions?select=*&order=created_at.desc", {
      headers: headers(),
    }).then(function (res) { return res.ok ? res.json() : []; })
      .catch(function () { return []; });
  }
  function sbUpdateSubmission(id, patch) {
    return fetch(cfg().SUPABASE_URL + "/rest/v1/upload_submissions?id=eq." + encodeURIComponent(id), {
      method: "PATCH",
      headers: Object.assign(headers(), { "Prefer": "return=representation" }),
      body: JSON.stringify(patch),
    }).then(function (res) { return res.ok ? res.json() : []; })
      .catch(function () { return []; });
  }
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
    if (provider() === "supabase") return sbSignOut();
    localSetUser(null);
    return Promise.resolve();
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
  function updateSubmission(id, patch) {
    if (provider() === "supabase" && currentUser()) {
      return sbUpdateSubmission(id, patch).then(function (rows) { return rows[0] || patch; });
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
    if (provider() !== "supabase" || !currentUser()) {
      return Promise.reject(new Error("Accounts are only editable with the Supabase backend enabled"));
    }
    return fetch(cfg().SUPABASE_URL + "/rest/v1/rpc/update_my_profile", {
      method: "POST", headers: headers(),
      body: JSON.stringify({
        new_display_name: fields.display_name || null,
        new_avatar_url: fields.avatar_url || null,
        new_daily_goal: fields.daily_goal != null ? fields.daily_goal : null,
        new_opt_out_leaderboard: fields.opt_out_leaderboard != null ? fields.opt_out_leaderboard : null,
      }),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error(j.message || "update failed"); });
      return res.json();
    });
  }

  root.QB = root.QB || {};
  root.QB.auth = {
    provider: provider, supabaseConfigured: supabaseConfigured,
    currentUser: currentUser, entitlement: entitlement, refreshEntitlement: refreshEntitlement,
    signUp: signUp, signIn: signIn, signOut: signOut,
    oauthLogin: oauthLogin, handleOAuthCallback: handleOAuthCallback,
    updateProfile: updateProfile,
    listSubmissions: listSubmissions, addSubmission: addSubmission,
    updateSubmission: updateSubmission, addReport: addReport,
  };
})();
