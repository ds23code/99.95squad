/* ============================================================================
 * main.js — ordered bootstrap & routes
 * ==========================================================================*/
(function () {
  "use strict";
  var root = window;
  var C = root.QB.core;

  function installBrokenImageHandler() {
    document.addEventListener("error", function (e) {
      var target = e.target;
      if (!target || target.tagName !== "IMG") return;
      var cls = target.className || "";
      if (!/(qcard-img|qimg-detail)/.test(cls) || target.getAttribute("data-broken-handled")) return;
      target.setAttribute("data-broken-handled", "1");
      var url = target.getAttribute("src") || "(no src)";
      var box = document.createElement("div");
      box.className = "broken-image";
      box.setAttribute("role", "img");
      box.setAttribute("aria-label", "Question image failed to load");
      box.innerHTML = '<p class="broken-image-title">Question image could not be loaded</p>' +
        '<p class="broken-image-url">' + C.escapeHtml(url) + "</p>" +
        '<p class="broken-image-hint">Check the pipeline export: the file must exist under <code>content/</code> at this path.</p>';
      target.replaceWith(box);
    }, true);
  }

  function updateAccountNav() {
    var user = root.QB.auth.currentUser();
    var ent = root.QB.auth.entitlement();
    var account = C.$("#nav-account");
    if (account) {
      account.textContent = user ? "My dashboard" : "Sign in";
      account.href = user ? "#/dashboard" : "#/login";
    }
    var settings = C.$("#nav-settings");
    if (settings) settings.hidden = !user;
    var logout = C.$("#nav-logout");
    if (logout) logout.hidden = !user;
    var menu = C.$("#nav-user-menu");
    if (menu) menu.hidden = !user;
    var admin = C.$("#nav-admin");
    if (admin) admin.hidden = !(user && ent.isAdmin);
  }

  function registerRoutes() {
    C.addRoute("/", function () { root.QB.pages.landing(); });
    C.addRoute("/login", function () { root.QB.pages.auth("login"); });
    C.addRoute("/signup", function () { root.QB.pages.auth("signup"); });
    C.addRoute("/dashboard", function () { root.QB.pages.dashboard(); });
    C.addRoute("/onboarding", function () { root.QB.pages.onboarding(); });
    C.addRoute(/^\/settings(?:\?.*)?$/, function () { root.QB.pages.settings(); });
    C.addRoute("/syllabus", function () { root.QB.pages.syllabus(); });
    C.addRoute(/^\/leaderboard(?:\?.*)?$/, function () { root.QB.pages.leaderboard(); });
    C.addRoute("/analytics", function () { root.QB.pages.analytics(); });
    C.addRoute(/^\/browse(?:\?.*)?$/, function () { root.QB.pages.browse(); });
    C.addRoute(/^\/question\/([^/?]+)(?:\?.*)?$/, function (m) { root.QB.pages.question(decodeURIComponent(m[1])); });
    C.addRoute(/^\/practice(?:\?.*)?$/, function () { root.QB.pages.practice(); });
    C.addRoute(/^\/saved(?:\?.*)?$/, function () { root.QB.pages.saved(); });
    C.addRoute("/progress", function () { root.QB.pages.progress(); });
    C.addRoute("/profile", function () { root.QB.pages.profile(); });
    C.addRoute("/upload", function () { root.QB.pages.upload(); });
    C.addRoute(/^\/admin(?:\?.*)?$/, function () { root.QB.pages.admin(); });
    C.addRoute(/^\/report(?:\/([^/?]+))?(?:\?.*)?$/, function (m) {
      root.QB.pages.report(m[1] ? decodeURIComponent(m[1]) : null);
    });
  }

  function boot() {
    installBrokenImageHandler();
    registerRoutes();
    var yearEl = C.$("#year");
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    var app = C.$("#app");
    if (app) app.innerHTML = C.spinner("Restoring your session…");

    var logoutBtn = C.$("#nav-logout");
    if (logoutBtn) logoutBtn.addEventListener("click", function (e) {
      e.preventDefault();
      root.QB.auth.signOut().then(function () {
        C.toast("Signed out");
        location.hash = "#/";
        C.navigate();
      });
    });

    window.addEventListener("hashchange", C.navigate);
    window.addEventListener("qb:auth-changed", updateAccountNav);

    /* Do not render protected or profile-dependent pages until the persisted
     * session has been refreshed/validated and profiles.is_admin hydrated.
     * Content metadata warms concurrently because it is independent. */
    var authInit = root.QB.auth.initialize().catch(function (err) {
      C.toast(err.message || "Could not restore your session", "error");
      return null;
    });
    var metaInit = root.QB.api.metaOnce().catch(function () { return null; });
    Promise.all([authInit, metaInit]).then(function () {
      updateAccountNav();
      var profileError = root.QB.auth.profileLoadError();
      if (profileError) {
        C.toast("Your session was restored, but your account profile could not be loaded. " +
          "Admin and premium access remain disabled: " + profileError.message, "error");
      }
      C.navigate();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
