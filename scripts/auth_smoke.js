#!/usr/bin/env node
"use strict";

/* Focused tests for the real browser auth module. This complements dom_smoke:
 * callback URLs, PKCE request shape, persisted-session restoration and admin
 * profile hydration are awkward to exercise after the main app has booted. */
const fs = require("fs");
const path = require("path");
const jsdomArg = process.argv[2] || "jsdom";
const jsdomPath = jsdomArg.startsWith("/") ? jsdomArg :
  (jsdomArg.startsWith(".") || jsdomArg.startsWith("node_modules") ? path.resolve(jsdomArg) : jsdomArg);
const { JSDOM } = require(jsdomPath);
const authCode = fs.readFileSync(path.join(__dirname, "..", "site", "assets", "js", "auth.js"), "utf8");

let failures = [];
function check(name, condition, detail) {
  if (condition) console.log("  ✓ " + name);
  else {
    failures.push(name);
    console.log("  ✗ " + name + (detail ? " — " + detail : ""));
  }
}
function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(data == null ? "" : JSON.stringify(data)),
  };
}
function session(user, suffix) {
  return {
    access_token: "access-" + suffix,
    refresh_token: "refresh-" + suffix,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user,
  };
}
function browser(url, fetchImpl) {
  const dom = new JSDOM("<!doctype html><title>Auth test</title>", {
    url,
    runScripts: "outside-only",
  });
  const w = dom.window;
  w.QB = { core: {} };
  w.QB_CONFIG = {
    SUPABASE_URL: "https://mock.supabase.co",
    SUPABASE_ANON_KEY: "publishable-test-key",
  };
  w.fetch = fetchImpl;
  w.console.warn = () => {};
  w.eval(authCode);
  return w;
}

async function callbackFlow() {
  const calls = [];
  const user = { id: "admin-1", email: "admin@example.com", user_metadata: { full_name: "Admin" } };
  const w = browser("https://example.com/99.95squad/?code=oauth-code", (url, opts = {}) => {
    calls.push({ url: String(url), opts, body: opts.body ? JSON.parse(opts.body) : null });
    const u = new URL(String(url));
    if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "pkce") {
      return Promise.resolve(response(200, session(user, "oauth")));
    }
    if (u.pathname === "/rest/v1/profiles") {
      return Promise.resolve(response(200, [{
        id: user.id, display_name: "Admin", is_admin: true,
        access_tier: "admin", premium_until: null, contribution_credits: 0,
      }]));
    }
    return Promise.resolve(response(404, { message: "unexpected route" }));
  });
  w.sessionStorage.setItem("qb.pkce.verifier", "verifier-from-original-browser");
  w.sessionStorage.setItem("qb.oauth.return", "#/admin");
  const authEvents = [];
  w.addEventListener("qb:auth-changed", (event) => authEvents.push(event.detail.reason));

  await w.QB.auth.initialize();
  const token = calls.find((c) => c.url.includes("/auth/v1/token"));
  check("oauth: callback exchanges code at the Supabase PKCE endpoint",
    !!token && token.url.includes("grant_type=pkce"));
  check("oauth: exchange uses auth_code and the same-browser verifier",
    token && token.body.auth_code === "oauth-code" &&
    token.body.code_verifier === "verifier-from-original-browser" && !("code" in token.body),
    token && JSON.stringify(token.body));
  check("oauth: verifier is removed after its single use",
    w.sessionStorage.getItem("qb.pkce.verifier") == null);
  check("oauth: session and authenticated user are persisted",
    w.QB.auth.currentUser() && w.QB.auth.currentUser().id === user.id &&
    w.QB.auth.currentSession().refresh_token === "refresh-oauth");
  check("oauth: profiles.is_admin is hydrated before initialization resolves",
    w.QB.auth.entitlement().isAdmin === true);
  check("oauth: profile hydration emits an event so admin navigation refreshes",
    authEvents.includes("profile"), authEvents.join(", "));
  check("oauth: GitHub Pages base path survives callback cleanup",
    w.location.pathname === "/99.95squad/" && w.location.search === "" && w.location.hash === "#/admin",
    w.location.href);
}

async function missingVerifierFlow() {
  let fetched = false;
  const w = browser("https://example.com/99.95squad/?code=orphan-code", () => {
    fetched = true;
    return Promise.resolve(response(500, {}));
  });
  let error = null;
  try { await w.QB.auth.initialize(); } catch (err) { error = err; }
  check("oauth: callback without verifier fails accurately and makes no token request",
    !!error && /verifier is missing/i.test(error.message) && !fetched, error && error.message);
  check("oauth: failed callback returns to login without dropping the base path",
    w.location.pathname === "/99.95squad/" && w.location.hash === "#/login" && w.location.search === "");
}

async function legacySessionExpiryFlow() {
  const user = { id: "legacy-1", email: "legacy@example.com" };
  const saved = session(user, "legacy");
  delete saved.expires_at;
  const w = browser("https://example.com/99.95squad/#/dashboard", () =>
    Promise.resolve(response(500, {})));
  w.localStorage.setItem("qb_supabase_session", JSON.stringify(saved));

  const first = w.QB.auth.currentSession();
  const persisted = JSON.parse(w.localStorage.getItem("qb.supabase.session"));
  const second = w.QB.auth.currentSession();
  check("auth restore: the deployed legacy storage key is migrated without logout",
    first && first.user.id === user.id &&
    w.localStorage.getItem("qb_supabase_session") == null && !!persisted);
  check("auth restore: a legacy relative expiry is converted to one fixed expiry",
    Number.isFinite(first.expires_at) && persisted.expires_at === first.expires_at &&
    second.expires_at === first.expires_at);
}

async function persistedSessionFlow() {
  const calls = [];
  const user = { id: "student-1", email: "student@example.com", user_metadata: { name: "Student" } };
  const saved = session(user, "persisted");
  const w = browser("https://example.com/99.95squad/#/dashboard", (url, opts = {}) => {
    calls.push({ url: String(url), auth: (opts.headers || {}).Authorization });
    const u = new URL(String(url));
    if (u.pathname === "/auth/v1/user") return Promise.resolve(response(200, user));
    if (u.pathname === "/rest/v1/profiles") {
      return Promise.resolve(response(200, [{ id: user.id, is_admin: false, access_tier: "free" }]));
    }
    return Promise.resolve(response(404, { message: "unexpected route" }));
  });
  w.localStorage.setItem("qb.supabase.session", JSON.stringify(saved));

  await w.QB.auth.initialize();
  check("auth restore: persisted session is validated with /auth/v1/user",
    calls.some((c) => c.url.includes("/auth/v1/user")));
  check("auth restore: profile hydration uses the persisted bearer token",
    calls.some((c) => c.url.includes("/rest/v1/profiles") && c.auth === "Bearer access-persisted"));
  check("auth restore: validated user remains signed in",
    w.QB.auth.currentUser() && w.QB.auth.currentUser().email === user.email);
  check("auth restore: non-admin profile fails closed for admin access",
    w.QB.auth.entitlement().isAdmin === false);
}

async function profileOutageFlow() {
  const user = { id: "outage-1", email: "outage@example.com" };
  const w = browser("https://example.com/99.95squad/#/login", (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "password") {
      return Promise.resolve(response(200, session(user, "outage")));
    }
    if (u.pathname === "/rest/v1/profiles") {
      return Promise.resolve(response(503, { message: "profile service unavailable" }));
    }
    return Promise.resolve(response(404, { message: "unexpected route" }));
  });
  /* A stale same-browser admin cache must also be invalidated when hydration
   * fails; successful authentication is not permission to retain it. */
  w.localStorage.setItem("qb.entitlement", JSON.stringify({
    userId: user.id, tier: "admin", isPremium: true, isAdmin: true,
  }));
  w.localStorage.setItem("qb_profile_cache", JSON.stringify({ id: user.id, is_admin: true }));

  const result = await w.QB.auth.signIn(user.email, "password123");
  check("profile outage: valid password authentication remains successful",
    result.ok === true && w.QB.auth.currentUser().id === user.id);
  check("profile outage: the valid rotating session remains persisted",
    w.QB.auth.currentSession() && w.QB.auth.currentSession().refresh_token === "refresh-outage");
  check("profile outage: an accurate partial-success warning is returned",
    /Authentication succeeded/.test(result.warning || "") &&
    /profile service unavailable/.test(result.warning || ""), result.warning);
  check("profile outage: underlying profile error remains inspectable",
    w.QB.auth.profileLoadError() && w.QB.auth.profileLoadError().status === 503);
  check("profile outage: cached admin/premium access fails closed",
    w.QB.auth.entitlement().isAdmin === false && w.QB.auth.entitlement().isPremium === false &&
    w.localStorage.getItem("qb_profile_cache") == null);
}

async function restoredProfileOutageFlow() {
  const user = { id: "restore-outage-1", email: "restore-outage@example.com" };
  const w = browser("https://example.com/99.95squad/#/dashboard", (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/auth/v1/user") return Promise.resolve(response(200, user));
    if (u.pathname === "/rest/v1/profiles") {
      return Promise.resolve(response(503, { message: "profile database maintenance" }));
    }
    return Promise.resolve(response(404, { message: "unexpected route" }));
  });
  w.localStorage.setItem("qb.supabase.session", JSON.stringify(session(user, "restore-outage")));

  const restored = await w.QB.auth.initialize();
  check("auth restore outage: initialization resolves with the validated user",
    restored && restored.id === user.id && w.QB.auth.currentUser().id === user.id);
  check("auth restore outage: profile failure is exposed without logging the user out",
    w.QB.auth.profileLoadError() && /profile database maintenance/.test(w.QB.auth.profileLoadError().message) &&
    w.QB.auth.entitlement().isAdmin === false);
}

async function accountCacheIsolationFlow() {
  const admin = { id: "admin-old", email: "old-admin@example.com" };
  const student = { id: "student-new", email: "new-student@example.com" };
  const w = browser("https://example.com/99.95squad/#/dashboard", (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "password") {
      return Promise.resolve(response(200, session(student, "student-new")));
    }
    if (u.pathname === "/rest/v1/profiles") {
      return Promise.resolve(response(200, [{ id: student.id, is_admin: false, access_tier: "free" }]));
    }
    if (u.pathname === "/auth/v1/logout") return Promise.resolve(response(204, null));
    return Promise.resolve(response(404, { message: "unexpected route" }));
  });
  w.localStorage.setItem("qb.supabase.session", JSON.stringify(session(admin, "admin-old")));
  w.localStorage.setItem("qb.entitlement", JSON.stringify({
    userId: admin.id, tier: "admin", isPremium: true, isAdmin: true,
  }));
  w.localStorage.setItem("qb_profile_cache", JSON.stringify({ id: admin.id, is_admin: true }));

  const signedIn = await w.QB.auth.signIn(student.email, "password123");
  check("account switch: authenticated identity changes to the new account",
    signedIn.ok && w.QB.auth.currentUser().id === student.id);
  check("account switch: old admin entitlement cannot cross accounts",
    w.QB.auth.entitlement().userId === student.id && w.QB.auth.entitlement().isAdmin === false);
  check("account switch: profile cache is rebound to the new account",
    w.QB.auth.cachedProfile() && w.QB.auth.cachedProfile().id === student.id);

  await w.QB.auth.signOut();
  check("logout: all session, entitlement and profile caches are cleared",
    w.localStorage.getItem("qb.supabase.session") == null &&
    w.localStorage.getItem("qb.entitlement") == null &&
    w.localStorage.getItem("qb_profile_cache") == null);
}

async function validationAccountSwitchRaceFlow() {
  const oldUser = { id: "validation-old", email: "old-validation@example.com" };
  const newUser = { id: "validation-new", email: "new-validation@example.com" };
  let releaseOldValidation = null;
  const w = browser("https://example.com/99.95squad/#/dashboard", (url, opts = {}) => {
    const u = new URL(String(url));
    const auth = (opts.headers || {}).Authorization;
    if (u.pathname === "/auth/v1/user" && auth === "Bearer access-validation-old") {
      return new Promise((resolve) => { releaseOldValidation = () => resolve(response(200, oldUser)); });
    }
    if (u.pathname === "/auth/v1/user" && auth === "Bearer access-validation-new") {
      return Promise.resolve(response(200, newUser));
    }
    if (u.pathname === "/rest/v1/profiles") {
      return Promise.resolve(response(200, [{ id: newUser.id, is_admin: false, access_tier: "free" }]));
    }
    return Promise.resolve(response(404, { message: "unexpected route" }));
  });
  w.localStorage.setItem("qb.supabase.session", JSON.stringify(session(oldUser, "validation-old")));

  const initializing = w.QB.auth.initialize();
  while (!releaseOldValidation) await new Promise((resolve) => setImmediate(resolve));
  w.localStorage.setItem("qb.supabase.session", JSON.stringify(session(newUser, "validation-new")));
  releaseOldValidation();
  const restored = await initializing;

  check("initialization race: an old /user response cannot overwrite a replacement account",
    restored && restored.id === newUser.id && w.QB.auth.currentUser().id === newUser.id);
  check("initialization race: profile and entitlement caches belong to the replacement account",
    w.QB.auth.cachedProfile() && w.QB.auth.cachedProfile().id === newUser.id &&
    w.QB.auth.entitlement().userId === newUser.id);
}

async function refreshAccountSwitchRaceFlow() {
  const oldUser = { id: "refresh-old", email: "old-refresh@example.com" };
  const newUser = { id: "refresh-new", email: "new-refresh@example.com" };
  const expired = session(oldUser, "refresh-old");
  expired.expires_at = Math.floor(Date.now() / 1000) - 10;
  let releaseOldRefresh = null;
  const w = browser("https://example.com/99.95squad/#/dashboard", (url, opts = {}) => {
    const u = new URL(String(url));
    const auth = (opts.headers || {}).Authorization;
    if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "refresh_token") {
      return new Promise((resolve) => {
        releaseOldRefresh = () => resolve(response(200, session(oldUser, "rotated-old")));
      });
    }
    if (u.pathname === "/auth/v1/user" && auth === "Bearer access-refresh-new") {
      return Promise.resolve(response(200, newUser));
    }
    if (u.pathname === "/rest/v1/profiles") {
      return Promise.resolve(response(200, [{ id: newUser.id, is_admin: false, access_tier: "free" }]));
    }
    return Promise.resolve(response(404, { message: "unexpected route" }));
  });
  w.localStorage.setItem("qb.supabase.session", JSON.stringify(expired));

  const initializing = w.QB.auth.initialize();
  while (!releaseOldRefresh) await new Promise((resolve) => setImmediate(resolve));
  w.localStorage.setItem("qb.supabase.session", JSON.stringify(session(newUser, "refresh-new")));
  releaseOldRefresh();
  const restored = await initializing;

  check("refresh race: an old rotating-token response cannot resurrect or overwrite its account",
    restored && restored.id === newUser.id && w.QB.auth.currentUser().id === newUser.id &&
    w.QB.auth.currentSession().refresh_token === "refresh-refresh-new");
}

async function staleProfileFailureRaceFlow() {
  const oldUser = { id: "profile-old", email: "old-profile@example.com" };
  const newUser = { id: "profile-new", email: "new-profile@example.com" };
  let releaseOldProfile = null;
  const w = browser("https://example.com/99.95squad/#/login", (url, opts = {}) => {
    const u = new URL(String(url));
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "password") {
      const isOld = body.email === oldUser.email;
      return Promise.resolve(response(200, session(isOld ? oldUser : newUser, isOld ? "profile-old" : "profile-new")));
    }
    if (u.pathname === "/rest/v1/profiles" && u.searchParams.get("id") === "eq." + oldUser.id) {
      return new Promise((resolve) => {
        releaseOldProfile = () => resolve(response(503, { message: "stale old-account failure" }));
      });
    }
    if (u.pathname === "/rest/v1/profiles" && u.searchParams.get("id") === "eq." + newUser.id) {
      return Promise.resolve(response(200, [{ id: newUser.id, is_admin: false, access_tier: "free" }]));
    }
    return Promise.resolve(response(404, { message: "unexpected route" }));
  });

  const oldLogin = w.QB.auth.signIn(oldUser.email, "password123");
  while (!releaseOldProfile) await new Promise((resolve) => setImmediate(resolve));
  const newLogin = await w.QB.auth.signIn(newUser.email, "password123");
  releaseOldProfile();
  await oldLogin;

  check("profile race: a stale old-account failure cannot erase the new account cache",
    newLogin.ok && w.QB.auth.currentUser().id === newUser.id &&
    w.QB.auth.cachedProfile() && w.QB.auth.cachedProfile().id === newUser.id);
  check("profile race: a stale old-account failure is not surfaced for the new account",
    w.QB.auth.profileLoadError() == null && w.QB.auth.entitlement().userId === newUser.id);
}

async function rejectedSessionClearsCachesFlow() {
  const user = { id: "revoked-1", email: "revoked@example.com" };
  const w = browser("https://example.com/99.95squad/#/dashboard", (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/auth/v1/user" ||
        (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "refresh_token")) {
      return Promise.resolve(response(401, { message: "session revoked" }));
    }
    return Promise.resolve(response(404, { message: "unexpected route" }));
  });
  w.localStorage.setItem("qb.supabase.session", JSON.stringify(session(user, "revoked")));
  w.localStorage.setItem("qb.entitlement", JSON.stringify({
    userId: user.id, tier: "admin", isPremium: true, isAdmin: true,
  }));
  w.localStorage.setItem("qb_profile_cache", JSON.stringify({ id: user.id, is_admin: true }));
  let error = null;
  try { await w.QB.auth.initialize(); } catch (err) { error = err; }
  check("rejected session: restoration exposes the authoritative auth failure",
    error && error.status === 401, error && error.message);
  check("rejected session: account-scoped caches are all removed",
    w.QB.auth.currentUser() == null &&
    w.localStorage.getItem("qb.entitlement") == null &&
    w.localStorage.getItem("qb_profile_cache") == null);
}

(async () => {
  await callbackFlow();
  await missingVerifierFlow();
  await legacySessionExpiryFlow();
  await persistedSessionFlow();
  await profileOutageFlow();
  await restoredProfileOutageFlow();
  await accountCacheIsolationFlow();
  await validationAccountSwitchRaceFlow();
  await refreshAccountSwitchRaceFlow();
  await staleProfileFailureRaceFlow();
  await rejectedSessionClearsCachesFlow();
  console.log("");
  if (failures.length) {
    console.log("AUTH SMOKE FAILED: " + failures.length + " check(s)");
    process.exit(1);
  }
  console.log("AUTH SMOKE PASSED — all checks ok");
  process.exit(0);
})().catch((err) => {
  console.error("AUTH SMOKE ERROR:", err);
  process.exit(2);
});
