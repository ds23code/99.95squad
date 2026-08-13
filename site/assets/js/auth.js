/* 99.95squad — authentication, sessions, entitlements and submissions
 *
 * Supabase mode uses the public anon/publishable key only.  Authorization is
 * enforced by RLS and SECURITY DEFININER RPCs in backend/supabase.sql.  Local
 * mode remains a development/demo fallback when Supabase is not configured.
 */
(function (root) {
  "use strict";
  root.QB = root.QB || {};
  var C = root.QB.core;
  var SESSION_KEY = "qb.supabase.session";
  var LEGACY_SESSION_KEY = "qb_supabase_session";
  var LOCAL_KEY = "qb.local.user";
  var ENTITLEMENT_KEY = "qb.entitlement";
  var SUBMISSIONS_KEY = "qb.submissions";
  var PKCE_KEY = "qb.pkce.verifier";
  var OAUTH_RETURN_KEY = "qb.oauth.return";
  var EXPIRY_MARGIN_SECONDS = 60;
  var refreshPromise = null;
  var initializePromise = null;
  var refreshTimer = null;
  var profileLoadError = null;

  function cfg() { return root.QB_CONFIG || {}; }
  function uid(prefix) {
    var value;
    if (root.crypto && typeof root.crypto.randomUUID === "function") value = root.crypto.randomUUID();
    else {
      var bytes = new Uint8Array(16);
      root.crypto.getRandomValues(bytes);
      value = Array.from(bytes).map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    }
    return (prefix ? prefix + "-" : "") + value;
  }
  function supabaseConfigured() {
    return /^https:\/\//.test(cfg().SUPABASE_URL || "") && !!cfg().SUPABASE_ANON_KEY;
  }
  function provider() { return cfg().authProvider || (supabaseConfigured() ? "supabase" : "local"); }
  function supabaseReady() { return provider() === "supabase" && supabaseConfigured(); }

  function makeError(message, status, body) {
    var err = new Error(message || "Request failed");
    err.status = status || 0;
    err.body = body;
    return err;
  }

  function responseData(res) {
    return res.text().then(function (text) {
      var data = null;
      if (text) {
        try { data = JSON.parse(text); }
        catch (e) { data = { message: text }; }
      }
      if (!res.ok) {
        var message = data && (data.msg || data.message || data.error_description || data.error || data.hint);
        throw makeError(message || ("Request failed (HTTP " + res.status + ")"), res.status, data);
      }
      return data;
    });
  }

  function anonHeaders(extra) {
    return Object.assign({
      apikey: cfg().SUPABASE_ANON_KEY,
    }, extra || {});
  }

  function authHeaders(token, extra) {
    return anonHeaders(Object.assign({ Authorization: "Bearer " + token }, extra || {}));
  }

  function rawJson(path, options) {
    options = Object.assign({}, options || {});
    options.headers = anonHeaders(Object.assign({ "Content-Type": "application/json" }, options.headers || {}));
    return fetch(cfg().SUPABASE_URL + path, options).then(responseData);
  }

  function decodeJwtExpiry(token) {
    try {
      var part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (part.length % 4) part += "=";
      return Number(JSON.parse(atob(part)).exp) || null;
    } catch (e) { return null; }
  }

  function normalizeSession(data, fallbackUser) {
    data = data && data.session ? data.session : data;
    if (!data || !data.access_token) return null;
    var expiresAt = Number(data.expires_at) || decodeJwtExpiry(data.access_token);
    if (!expiresAt && Number(data.expires_in)) {
      expiresAt = Math.floor(Date.now() / 1000) + Number(data.expires_in);
    }
    /* Legacy/mock sessions did not include expiry.  Give them a bounded
     * lifetime rather than treating them as immortal. */
    if (!expiresAt) expiresAt = Math.floor(Date.now() / 1000) + 3600;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      expires_in: Number(data.expires_in) || Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
      expires_at: expiresAt,
      token_type: data.token_type || "bearer",
      user: data.user || fallbackUser || null,
    };
  }

  function clearAccountCaches() {
    localStorage.removeItem(ENTITLEMENT_KEY);
    localStorage.removeItem("qb_profile_cache");
  }

  function sessionGet() {
    try {
      var stored = localStorage.getItem(SESSION_KEY);
      var fromLegacyKey = !stored && !!localStorage.getItem(LEGACY_SESSION_KEY);
      if (fromLegacyKey) stored = localStorage.getItem(LEGACY_SESSION_KEY);
      var raw = JSON.parse(stored || "null");
      var normalized = normalizeSession(raw);
      if (raw && !normalized) {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(LEGACY_SESSION_KEY);
        clearAccountCaches();
        return null;
      }
      /* Migrate the pre-PKCE storage key and older expires_in-only payloads.
       * Persist one fixed expiry so reading either legacy shape cannot
       * repeatedly extend its apparent lifetime after a deployment. */
      if (normalized && raw && (fromLegacyKey || !Number(raw.expires_at))) {
        try {
          localStorage.setItem(SESSION_KEY, JSON.stringify(normalized));
          if (fromLegacyKey) localStorage.removeItem(LEGACY_SESSION_KEY);
        } catch (_) { /* use the normalized value for this page load */ }
      }
      return normalized;
    } catch (e) {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(LEGACY_SESSION_KEY);
      clearAccountCaches();
      return null;
    }
  }

  function emitAuthChange(reason) {
    try {
      root.dispatchEvent(new CustomEvent("qb:auth-changed", { detail: { reason: reason } }));
    } catch (e) { /* old browsers */ }
  }

  function clearRefreshTimer() {
    if (refreshTimer) root.clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  function scheduleRefresh(session) {
    clearRefreshTimer();
    if (!session || !session.refresh_token) return;
    var delay = Math.max(1000, (session.expires_at - Math.floor(Date.now() / 1000) - EXPIRY_MARGIN_SECONDS) * 1000);
    refreshTimer = root.setTimeout(function () {
      refreshSession(false).catch(function (err) {
        /* Network failures retain the session and are retried on the next
         * authenticated request. Invalid refresh tokens clear it below. */
        if (!err || !err.authCleared) console.warn("Session refresh failed", err);
      });
    }, Math.min(delay, 2147483647));
  }

  function sessionSet(data, fallbackUser, reason) {
    var session = normalizeSession(data, fallbackUser);
    if (!session) {
      sessionClear(reason || "signed-out");
      return null;
    }
    var previous = sessionGet();
    var previousId = previous && previous.user && previous.user.id;
    var nextId = session.user && session.user.id;
    if (!previousId || !nextId || previousId !== nextId) {
      clearAccountCaches();
      profileLoadError = null;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    localStorage.removeItem(LEGACY_SESSION_KEY);
    scheduleRefresh(session);
    emitAuthChange(reason || "session");
    return session;
  }

  function sessionClear(reason) {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(LEGACY_SESSION_KEY);
    clearAccountCaches();
    profileLoadError = null;
    clearRefreshTimer();
    emitAuthChange(reason || "signed-out");
  }

  function expiresSoon(session) {
    return !session || Number(session.expires_at || 0) <= Math.floor(Date.now() / 1000) + EXPIRY_MARGIN_SECONDS;
  }

  function withRefreshLock(fn) {
    if (root.navigator && root.navigator.locks && root.navigator.locks.request) {
      return root.navigator.locks.request("qb-supabase-refresh", fn);
    }
    return Promise.resolve().then(fn);
  }

  function doRefresh(force, observedAccessToken) {
    return withRefreshLock(function () {
      /* Re-read after acquiring the cross-tab lock. Another tab may already
       * have rotated the single-use refresh token. */
      var current = sessionGet();
      if (!current) throw makeError("No active session", 401);
      if (observedAccessToken && current.access_token !== observedAccessToken) return current;
      if (!force && !expiresSoon(current)) return current;
      if (!current.refresh_token) {
        sessionClear("expired");
        var noToken = makeError("Your session expired. Please sign in again.", 401);
        noToken.authCleared = true;
        throw noToken;
      }
      var refreshingAccessToken = current.access_token;
      var refreshingRefreshToken = current.refresh_token;
      return rawJson("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        body: JSON.stringify({ refresh_token: refreshingRefreshToken }),
      }).then(function (data) {
        /* Signing out or switching accounts while refresh is in flight must
         * win. Never resurrect or overwrite that newer browser state with a
         * response obtained using the old account's rotating refresh token. */
        var active = sessionGet();
        if (!active) return null;
        if (active.access_token !== refreshingAccessToken || active.refresh_token !== refreshingRefreshToken) {
          return active;
        }
        var next = sessionSet(data, current.user, "refreshed");
        if (!next || !next.refresh_token) {
          sessionClear("refresh-invalid");
          var invalid = makeError("Supabase returned an invalid refreshed session", 401);
          invalid.authCleared = true;
          throw invalid;
        }
        return next;
      }).catch(function (err) {
        /* A 4xx is authoritative only if this is still the session that made
         * the request. Preserve a replacement account, and preserve cached
         * state on transport/server failures so an outage is not a logout. */
        var active = sessionGet();
        if (err && err.status >= 400 && err.status < 500 && active &&
            active.access_token === refreshingAccessToken && active.refresh_token === refreshingRefreshToken) {
          sessionClear("refresh-rejected");
          err.authCleared = true;
        }
        throw err;
      });
    });
  }

  function refreshSession(force, observedAccessToken) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = doRefresh(!!force, observedAccessToken).finally(function () { refreshPromise = null; });
    return refreshPromise;
  }

  function freshSession() {
    var session = sessionGet();
    if (!session) return Promise.resolve(null);
    if (!expiresSoon(session)) {
      scheduleRefresh(session);
      return Promise.resolve(session);
    }
    return refreshSession(false, session.access_token);
  }

  /* Shared authenticated transport. It refreshes before expiry and retries
   * once after a 401. Backend, moderation, profile and Storage calls all use
   * this path so rotating refresh tokens are handled consistently. */
  function authenticatedFetch(pathOrUrl, options) {
    options = Object.assign({}, options || {});
    var initialToken;
    function send(session) {
      if (!session) throw makeError("Sign in required", 401);
      initialToken = session.access_token;
      var opts = Object.assign({}, options);
      opts.headers = authHeaders(session.access_token, options.headers || {});
      var url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : cfg().SUPABASE_URL + pathOrUrl;
      return fetch(url, opts);
    }
    return freshSession().then(send).then(function (res) {
      if (res.status !== 401) return res;
      return refreshSession(true, initialToken).then(send).then(function (retryResponse) {
        if (retryResponse.status === 401) {
          var current = sessionGet();
          if (current && current.access_token === initialToken) sessionClear("session-rejected");
        }
        return retryResponse;
      });
    });
  }

  function sbFetch(path, options) {
    return authenticatedFetch(path, options).then(responseData);
  }

  function sbProfile() {
    var s = sessionGet();
    if (!s || !s.user) return Promise.resolve(null);
    return sbFetch("/rest/v1/profiles?select=*&id=eq." + encodeURIComponent(s.user.id) + "&limit=1")
      .then(function (rows) { return rows && rows[0] ? rows[0] : null; });
  }

  function entitlementFromProfile(p, userId) {
    var premium = p && p.premium_until ? new Date(p.premium_until) : null;
    return {
      userId: userId || (p && p.id) || null,
      tier: (p && p.access_tier) || "free",
      premium_until: premium ? premium.toISOString() : null,
      isPremium: !!(p && (p.is_admin || (premium && premium > new Date()))),
      isAdmin: !!(p && p.is_admin),
      contributionCredits: (p && p.contribution_credits) || 0,
    };
  }

  function entitlement() {
    var user = currentUser();
    try {
      var cached = JSON.parse(localStorage.getItem(ENTITLEMENT_KEY) || "null");
      /* Old, unscoped cache entries and another account's values are never
       * trusted. In particular, an admin flag must not cross an account
       * transition or survive a rejected session. */
      if (!user || !cached || cached.userId !== user.id) {
        if (cached) localStorage.removeItem(ENTITLEMENT_KEY);
        return entitlementFromProfile(null, user && user.id);
      }
      return cached;
    } catch (e) {
      localStorage.removeItem(ENTITLEMENT_KEY);
      return entitlementFromProfile(null, user && user.id);
    }
  }

  function refreshEntitlement() {
    var session = sessionGet();
    if (!supabaseReady() || !session || !session.user) {
      profileLoadError = null;
      clearAccountCaches();
      var local = entitlementFromProfile(null, currentUser() && currentUser().id);
      emitAuthChange("profile");
      return Promise.resolve(local);
    }
    var expectedUserId = session.user.id;
    /* Privileged state is unavailable while profile hydration is in flight.
     * A previous value for this same account must not mask an outage. */
    clearAccountCaches();
    return sbProfile().then(function (p) {
      var active = currentUser();
      if (!active || active.id !== expectedUserId) {
        throw makeError("The authenticated account changed while its profile was loading.", 409);
      }
      if (!p || p.id !== expectedUserId) {
        throw makeError("Your authenticated account profile could not be loaded.", 404);
      }
      profileLoadError = null;
      var value = entitlementFromProfile(p, expectedUserId);
      localStorage.setItem(ENTITLEMENT_KEY, JSON.stringify(value));
      localStorage.setItem("qb_profile_cache", JSON.stringify(p));
      emitAuthChange("profile");
      return value;
    }).catch(function (err) {
      /* A slower request for an account that has since signed out or been
       * replaced must not erase the new account's profile cache or surface a
       * stale warning. The active account still fails closed on every error. */
      var active = currentUser();
      if (active && active.id === expectedUserId) {
        profileLoadError = err;
        clearAccountCaches();
        emitAuthChange("profile-error");
      }
      throw err;
    });
  }

  function hydrateAuthenticated(result) {
    return refreshEntitlement().then(function () { return result; }).catch(function (err) {
      /* Authentication and profile hydration are separate operations. Keep a
       * valid, persisted session on a profile/RPC outage, while the cache
       * invalidation in refreshEntitlement keeps admin/premium fail-closed. */
      result.profileError = err;
      return result;
    });
  }

  function profileWarning(err) {
    if (!err) return null;
    return "Authentication succeeded, but your account profile could not be loaded. " +
      "Admin and premium access remain disabled until profile sync succeeds. " +
      (err.message || "Profile service unavailable.");
  }

  function sbSignUp(email, password, name) {
    return rawJson("/auth/v1/signup", {
      method: "POST",
      body: JSON.stringify({ email: email, password: password, data: { name: name } }),
    }).then(function (data) {
      var session = normalizeSession(data);
      if (session) {
        sessionSet(session, null, "signed-in");
        return hydrateAuthenticated({
          user: session.user, session: session, requiresEmailConfirmation: false,
        });
      }
      /* With email confirmation enabled Supabase returns a user but no
       * session. Never cache that response as authenticated. */
      sessionClear("signup-pending-confirmation");
      return { user: data && data.user, session: null, requiresEmailConfirmation: true };
    });
  }

  function sbSignIn(email, password) {
    return rawJson("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email: email, password: password }),
    }).then(function (data) {
      var session = sessionSet(data, null, "signed-in");
      if (!session) throw makeError("Supabase did not return a session", 500);
      return hydrateAuthenticated({ user: session.user, session: session });
    });
  }

  function sbSignOut() {
    var s = sessionGet();
    var request = s ? authenticatedFetch("/auth/v1/logout", { method: "POST" }).catch(function () { return null; }) : Promise.resolve();
    return request.finally(function () { sessionClear("signed-out"); });
  }

  /* PKCE OAuth: Supabase social auth returns ?code=... and expects
   * {auth_code, code_verifier} at /token?grant_type=pkce. */
  function randomVerifier() {
    var bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function sha256Base64Url(text) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (buf) {
      var binary = "";
      new Uint8Array(buf).forEach(function (b) { binary += String.fromCharCode(b); });
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    });
  }
  function oauthRedirectUrl() {
    /* Hash routes never reach GitHub Pages. Redirect to the deployed index
     * pathname (including /99.95squad/) and restore the desired hash later. */
    return location.origin + location.pathname;
  }
  function oauthLogin(providerName) {
    if (!supabaseReady()) return Promise.reject(new Error("Supabase is not configured — see docs/AUTH.md"));
    if (providerName !== "google" && providerName !== "apple") {
      return Promise.reject(new Error("Unsupported OAuth provider"));
    }
    var verifier = randomVerifier();
    sessionStorage.setItem(PKCE_KEY, verifier);
    sessionStorage.setItem(OAUTH_RETURN_KEY, "#/dashboard");
    return sha256Base64Url(verifier).then(function (challenge) {
      var q = new URLSearchParams({
        provider: providerName,
        redirect_to: oauthRedirectUrl(),
        code_challenge: challenge,
        code_challenge_method: "s256",
      });
      location.assign(cfg().SUPABASE_URL + "/auth/v1/authorize?" + q.toString());
    });
  }
  function exchangeOAuthCode(code) {
    var verifier = sessionStorage.getItem(PKCE_KEY);
    if (!verifier) return Promise.reject(makeError("OAuth verifier is missing. Start Google sign-in again in this browser.", 400));
    return rawJson("/auth/v1/token?grant_type=pkce", {
      method: "POST",
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
    }).then(function (data) {
      var session = sessionSet(data, null, "signed-in");
      if (!session) throw makeError("Supabase did not return an OAuth session", 500);
      return hydrateAuthenticated({ user: session.user, session: session })
        .then(function (result) { return result.user; });
    }).finally(function () {
      /* A verifier is single-use, including on errors. */
      sessionStorage.removeItem(PKCE_KEY);
    });
  }

  function localUsers() {
    try { return JSON.parse(localStorage.getItem("qb.local.users") || "{}"); }
    catch (e) { return {}; }
  }
  function localSignUp(email, password, name) {
    var users = localUsers();
    if (users[email]) return Promise.reject(new Error("An account with that email already exists"));
    users[email] = { id: uid("usr"), email: email, password: password, name: name || email.split("@")[0] };
    localStorage.setItem("qb.local.users", JSON.stringify(users));
    var safe = Object.assign({}, users[email]); delete safe.password;
    clearAccountCaches();
    localStorage.setItem(LOCAL_KEY, JSON.stringify(safe));
    emitAuthChange("signed-in");
    return Promise.resolve({ user: safe, session: { local: true }, requiresEmailConfirmation: false });
  }
  function localSignIn(email, password) {
    var u = localUsers()[email];
    if (!u || u.password !== password) return Promise.reject(new Error("Invalid email or password"));
    var safe = Object.assign({}, u); delete safe.password;
    clearAccountCaches();
    localStorage.setItem(LOCAL_KEY, JSON.stringify(safe));
    emitAuthChange("signed-in");
    return Promise.resolve(safe);
  }
  function localSignOut() {
    localStorage.removeItem(LOCAL_KEY);
    clearAccountCaches();
    profileLoadError = null;
    emitAuthChange("signed-out");
    return Promise.resolve();
  }

  function currentUser() {
    if (supabaseReady()) {
      var s = sessionGet();
      var u = s && s.user;
      if (!u) return null;
      return { id: u.id, email: u.email, name: (u.user_metadata && (u.user_metadata.name || u.user_metadata.full_name)) || u.email };
    }
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); }
    catch (e) { return null; }
  }

  function validateRemoteUser() {
    var before = sessionGet();
    if (!before) return Promise.resolve(null);
    var observedAccessToken = before.access_token;
    return authenticatedFetch("/auth/v1/user", { method: "GET" }).then(responseData).then(function (user) {
      var current = sessionGet();
      if (!current) return null;
      /* Do not attach a response for account A to account B when storage is
       * replaced while /user is in flight. A refresh can also rotate the
       * token, so validate the newly observed session instead. */
      if (current.access_token !== observedAccessToken) return validateRemoteUser();
      sessionSet(Object.assign({}, current, { user: user }), user, "restored");
      return user;
    });
  }

  function cleanOAuthUrl(returnHash) {
    var path = location.pathname + (returnHash || location.hash || "#/dashboard");
    history.replaceState({}, document.title, path);
  }

  function initialize() {
    if (initializePromise) return initializePromise;
    initializePromise = Promise.resolve().then(function () {
      if (!supabaseReady()) return currentUser();
      var params = new URLSearchParams(location.search);
      var oauthError = params.get("error_description") || params.get("error");
      var code = params.get("code");
      if (oauthError) {
        sessionStorage.removeItem(PKCE_KEY);
        cleanOAuthUrl("#/login");
        throw makeError("Google sign-in failed: " + oauthError, 400);
      }
      if (code) {
        var returnHash = sessionStorage.getItem(OAUTH_RETURN_KEY) || "#/dashboard";
        sessionStorage.removeItem(OAUTH_RETURN_KEY);
        return exchangeOAuthCode(code).then(function (user) {
          cleanOAuthUrl(returnHash);
          return user;
        }).catch(function (err) {
          cleanOAuthUrl("#/login");
          throw err;
        });
      }
      if (!sessionGet()) return null;
      /* A persisted token is only a candidate session. Refresh if needed,
       * validate it against /user, then hydrate the profile/admin flag before
       * protected routes are rendered. */
      return freshSession().then(validateRemoteUser).then(function (user) {
        if (!user) return null;
        return hydrateAuthenticated({ user: user }).then(function (result) { return result.user; });
      });
    });
    return initializePromise;
  }

  function cachedProfile() {
    var user = currentUser();
    try {
      var cached = JSON.parse(localStorage.getItem("qb_profile_cache") || "null");
      if (!user || !cached || cached.id !== user.id) {
        if (cached) localStorage.removeItem("qb_profile_cache");
        return null;
      }
      return cached;
    } catch (e) {
      localStorage.removeItem("qb_profile_cache");
      return null;
    }
  }

  function needsOnboarding() {
    var user = currentUser();
    if (!user) return false;
    var local = root.QB.store ? root.QB.store.load().profile : null;
    if (local && local.onboarded) return false;
    var cached = cachedProfile();
    return !!(cached && cached.id === user.id && !cached.onboarding_completed);
  }

  function updateProfile(fields) {
    fields = fields || {};
    if (root.QB.store) {
      var state = root.QB.store.load();
      state.profile = Object.assign({}, state.profile, {
        name: fields.display_name != null ? fields.display_name : state.profile.name,
        goal: fields.daily_goal != null ? fields.daily_goal : state.profile.goal,
        courses: fields.courses != null ? fields.courses : state.profile.courses,
        subjects: fields.subjects != null ? fields.subjects : state.profile.subjects,
        yearLevel: fields.year_level != null ? fields.year_level : state.profile.yearLevel,
        onboarded: fields.onboarding_completed != null ? !!fields.onboarding_completed : state.profile.onboarded,
      });
      root.QB.store.save();
    }
    if (!supabaseReady() || !currentUser()) {
      return Promise.resolve(root.QB.store ? root.QB.store.load().profile : fields);
    }
    return adminRpc("update_my_profile", {
      new_display_name: fields.display_name != null ? fields.display_name : null,
      new_avatar_url: fields.avatar_url != null ? fields.avatar_url : null,
      new_daily_goal: fields.daily_goal != null ? fields.daily_goal : null,
      new_opt_out_leaderboard: fields.opt_out_leaderboard != null ? fields.opt_out_leaderboard : null,
      new_subjects: fields.subjects != null ? fields.subjects : null,
      new_courses: fields.courses != null ? fields.courses : null,
      new_year_level: fields.year_level != null ? fields.year_level : null,
      new_onboarding_completed: fields.onboarding_completed != null ? fields.onboarding_completed : null,
    }).then(function (row) {
      if (row) localStorage.setItem("qb_profile_cache", JSON.stringify(row));
      return refreshEntitlement().then(function () { return row; });
    });
  }

  /* ---------------------------------------------------------------- uploads */
  function submissions() {
    if (root.QB.store) return root.QB.store.load().submissions || [];
    try { return JSON.parse(localStorage.getItem(SUBMISSIONS_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function saveSubmissions(rows) {
    if (root.QB.store) {
      var state = root.QB.store.load();
      state.submissions = rows;
      root.QB.store.save();
      return;
    }
    localStorage.setItem(SUBMISSIONS_KEY, JSON.stringify(rows));
  }

  function uploadStorageObject(file, path) {
    return authenticatedFetch("/storage/v1/object/paper-uploads/" + path.split("/").map(encodeURIComponent).join("/"), {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "x-upsert": "false" },
      body: file,
    }).then(responseData);
  }

  function submitPaper(file, meta) {
    var user = currentUser();
    if (!user) return Promise.reject(new Error("Sign in before uploading a paper"));
    if (!supabaseReady()) {
      var local = root.QB.store && root.QB.store.addSubmission
        ? root.QB.store.addSubmission(meta)
        : Object.assign({}, meta, { id: uid("up"), uploader: user.id, created_at: new Date().toISOString() });
      if (!(root.QB.store && root.QB.store.addSubmission)) {
        var rows = submissions(); rows.unshift(local); saveSubmissions(rows);
      }
      return Promise.resolve({ id: local.id, remote: false, sub: local });
    }
    var objectName = uid("paper") + ".pdf";
    var storagePath = user.id + "/" + objectName;
    return uploadStorageObject(file, storagePath).then(function () {
      var row = Object.assign({}, meta, { uploader: user.id, storage_path: storagePath });
      return sbFetch("/rest/v1/upload_submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify(row),
      });
    }).then(function (created) {
      var result = created && created[0] ? created[0] : created;
      return Object.assign({ remote: true }, result || {});
    }).catch(function (err) {
      /* If row creation fails after object upload, best-effort cleanup avoids
       * private orphan objects. RLS permits deleting only the user's object. */
      return authenticatedFetch("/storage/v1/object/paper-uploads/" + storagePath.split("/").map(encodeURIComponent).join("/"), {
        method: "DELETE",
      }).catch(function () { return null; }).then(function () { throw err; });
    });
  }

  function listSubmissions() {
    var u = currentUser();
    if (!u) return Promise.resolve([]);
    if (!supabaseReady()) return Promise.resolve(submissions().filter(function (s) { return s.uploader === u.id; }));
    return sbFetch("/rest/v1/upload_submissions?select=*&uploader=eq." + encodeURIComponent(u.id) + "&order=created_at.desc");
  }

  function adminRpc(name, body) {
    return sbFetch("/rest/v1/rpc/" + name, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }
  function listAdminSubmissions() {
    if (!supabaseReady()) return Promise.resolve(submissions());
    return adminRpc("admin_list_submissions", {});
  }
  function updateLocalSubmission(id, patch) {
    if (root.QB.store && root.QB.store.updateSubmission) {
      root.QB.store.updateSubmission(id, patch);
      return Promise.resolve(patch);
    }
    var rows = submissions();
    var row = rows.find(function (item) { return String(item.id) === String(id); });
    if (row) Object.assign(row, patch);
    saveSubmissions(rows);
    return Promise.resolve(row || patch);
  }
  function queueUpload(id) {
    return supabaseReady() ? adminRpc("queue_upload", { submission_id: id }) : updateLocalSubmission(id, { status: "queued" });
  }
  function moderateUpload(id, status, note, duplicateOf, duplicateType) {
    if (!supabaseReady()) return updateLocalSubmission(id, { status: status, note: note || null });
    return adminRpc("moderate_upload", {
      submission_id: id, new_status: status, p_notes: note || null,
      p_duplicate_of: duplicateOf || null, p_duplicate_type: duplicateType || null,
    });
  }
  function listAuditEvents(targetId) {
    if (!supabaseReady()) return Promise.resolve([]);
    return sbFetch("/rest/v1/audit_events?select=*&target_id=eq." + encodeURIComponent(targetId) + "&order=created_at.asc");
  }
  function listProblemReports() {
    if (!supabaseReady()) return Promise.resolve(root.QB.store ? root.QB.store.load().reports || [] : []);
    return sbFetch("/rest/v1/problem_reports?select=*&order=created_at.desc&limit=200");
  }
  function signedUploadUrl(storagePath) {
    if (!storagePath) return Promise.reject(new Error("Submission has no stored PDF"));
    return sbFetch("/storage/v1/object/sign/paper-uploads/" + storagePath.split("/").map(encodeURIComponent).join("/"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 3600 }),
    }).then(function (d) {
      if (!d || !d.signedURL) throw new Error("Storage did not return a signed URL");
      return cfg().SUPABASE_URL + "/storage/v1" + d.signedURL;
    });
  }

  function isAdmin() {
    if (!supabaseReady()) return Promise.resolve(!!cfg().localAdmin);
    if (!currentUser()) return Promise.resolve(false);
    return refreshEntitlement().then(function (e) { return !!e.isAdmin; });
  }

  function publicSignUp(email, password, name) {
    var op = supabaseReady() ? sbSignUp(email, password, name) : localSignUp(email, password, name);
    return op.then(function (result) {
      return {
        ok: true,
        user: result.user,
        requiresEmailConfirmation: !!result.requiresEmailConfirmation,
        warning: profileWarning(result.profileError),
      };
    }).catch(function (err) { return { ok: false, error: err.message || "Sign-up failed" }; });
  }
  function publicSignIn(email, password) {
    var op = supabaseReady() ? sbSignIn(email, password) : localSignIn(email, password);
    return op.then(function (result) {
      var wrapped = result && result.user ? result : { user: result };
      return { ok: true, user: wrapped.user, warning: profileWarning(wrapped.profileError) };
    }).catch(function (err) { return { ok: false, error: err.message || "Sign-in failed" }; });
  }
  function addSubmission(sub) {
    if (supabaseReady()) {
      var u = currentUser();
      if (!u) return Promise.reject(new Error("Sign in required"));
      return sbFetch("/rest/v1/upload_submissions", {
        method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify(Object.assign({ uploader: u.id }, sub)),
      }).then(function (rows) {
        var row = rows && rows[0] ? rows[0] : rows;
        return { id: row && row.id, remote: true, sub: row };
      });
    }
    var local = root.QB.store.addSubmission(sub);
    return Promise.resolve({ id: local.id, remote: false, sub: local });
  }

  root.QB.auth = {
    provider: provider,
    supabaseReady: supabaseReady,
    supabaseConfigured: supabaseConfigured,
    initialize: initialize,
    currentUser: currentUser,
    currentSession: sessionGet,
    signUp: publicSignUp,
    signIn: publicSignIn,
    oauthLogin: oauthLogin,
    signInGoogle: function () { return oauthLogin("google"); },
    signOut: function () { return supabaseReady() ? sbSignOut() : localSignOut(); },
    refreshSession: refreshSession,
    authenticatedFetch: authenticatedFetch,
    entitlement: entitlement,
    refreshEntitlement: refreshEntitlement,
    profileLoadError: function () { return profileLoadError; },
    cachedProfile: cachedProfile,
    needsOnboarding: needsOnboarding,
    updateProfile: updateProfile,
    isAdmin: isAdmin,
    submitPaper: submitPaper,
    addSubmission: addSubmission,
    updateSubmission: updateLocalSubmission,
    listSubmissions: listSubmissions,
    listAdminSubmissions: listAdminSubmissions,
    adminListSubmissions: listAdminSubmissions,
    approveUpload: queueUpload, /* backwards-compatible name: approval now queues processing */
    queueUpload: queueUpload,
    moderateUpload: moderateUpload,
    listAuditEvents: listAuditEvents,
    listProblemReports: listProblemReports,
    signedUploadUrl: signedUploadUrl,
    signUrl: signedUploadUrl,
    STORAGE_BUCKET: "paper-uploads",
    addReport: function (report) {
      var u = currentUser();
      if (!u) return Promise.reject(new Error("Sign in to submit a report"));
      if (!supabaseReady()) {
        if (root.QB.store && root.QB.store.addReport) root.QB.store.addReport(report);
        return Promise.resolve(report);
      }
      return sbFetch("/rest/v1/problem_reports", {
        method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify(Object.assign({}, report, { reporter: u.id })),
      });
    },
  };

  root.addEventListener("storage", function (event) {
    if (event.key !== SESSION_KEY && event.key !== LEGACY_SESSION_KEY) return;
    var oldUserId = null;
    var newUserId = null;
    try {
      var oldValue = JSON.parse(event.oldValue || "null");
      var newValue = JSON.parse(event.newValue || "null");
      oldUserId = oldValue && oldValue.user && oldValue.user.id;
      newUserId = newValue && newValue.user && newValue.user.id;
    } catch (_) { /* malformed session is handled by sessionGet */ }
    if (!newUserId || oldUserId !== newUserId) clearAccountCaches();
    var session = sessionGet();
    scheduleRefresh(session);
    if (!session) clearAccountCaches();
    emitAuthChange("cross-tab");
  });
  root.addEventListener("online", function () {
    var session = sessionGet();
    if (session && expiresSoon(session)) refreshSession(false, session.access_token).catch(function () {});
  });
})(window);
