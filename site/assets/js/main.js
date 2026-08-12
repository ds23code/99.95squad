/* ============================================================================
 * main.js — bootstrap & routes
 * ==========================================================================*/
(function () {
  "use strict";

  var root = window;
  var C = root.QB.core;

  /* ------------------------------------------------------------------
   * Broken-image state (development aid): if any question image fails to
   * load, replace it with a visible placeholder that shows the exact
   * asset URL the browser requested — so a broken link is diagnosed in
   * seconds instead of showing a silent blank.
   * ------------------------------------------------------------------ */
  function installBrokenImageHandler() {
    document.addEventListener("error", function (e) {
      var target = e.target;
      if (!target || target.tagName !== "IMG") return;
      var cls = target.className || "";
      if (!/(qcard-img|qimg-detail)/.test(cls)) return;
      if (target.getAttribute("data-broken-handled")) return;
      target.setAttribute("data-broken-handled", "1");
      var url = target.getAttribute("src") || "(no src)";
      var box = document.createElement("div");
      box.className = "broken-image";
      box.setAttribute("role", "img");
      box.setAttribute("aria-label", "Question image failed to load");
      box.innerHTML =
        '<p class="broken-image-title">Question image could not be loaded</p>' +
        '<p class="broken-image-url">' + C.escapeHtml(url) + "</p>" +
        '<p class="broken-image-hint">Check the pipeline export: ' +
        "the file must exist under <code>content/</code> at this path.</p>";
      target.replaceWith(box);
    }, true);
  }

  function boot() {
    installBrokenImageHandler();
    var yearEl = C.$("#year");
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    /* route table -------------------------------------------------------- */
    C.addRoute("/", function () { root.QB.pages.landing(); });
    C.addRoute("/login", function () { root.QB.pages.auth("login"); });
    C.addRoute("/signup", function () { root.QB.pages.auth("signup"); });
    C.addRoute("/dashboard", function () { root.QB.pages.dashboard(); });
    C.addRoute("/onboarding", function () { root.QB.pages.onboarding(); });
    C.addRoute("/syllabus", function () { root.QB.pages.syllabus(); });
    C.addRoute(/^\/leaderboard(\?.*)?$/, function () { root.QB.pages.leaderboard(); });
    C.addRoute("/analytics", function () { root.QB.pages.analytics(); });
    C.addRoute(/^\/browse(\?.*)?$/, function () { root.QB.pages.browse(); });
    C.addRoute(/^\/question\/([^/?]+)/, function (m) { root.QB.pages.question(decodeURIComponent(m[1])); });
    C.addRoute(/^\/practice(\?.*)?$/, function () { root.QB.pages.practice(); });
    C.addRoute(/^\/saved(\?.*)?$/, function () { root.QB.pages.saved(); });
    C.addRoute("/progress", function () { root.QB.pages.progress(); });
    C.addRoute("/profile", function () { root.QB.pages.profile(); });
    C.addRoute("/upload", function () { root.QB.pages.upload(); });
    C.addRoute("/admin", function () { root.QB.pages.admin(); });
    C.addRoute(/^\/report(\/([^/?]+))?/, function (m) {
      root.QB.pages.report(m[2] ? decodeURIComponent(m[2]) : null);
    });

    /* refresh entitlement from backend when available -------------------- */
    root.QB.auth.refreshEntitlement();

    /* OAuth callback (?code=...) from Google/Apple sign-in ---------------- */
    root.QB.auth.handleOAuthCallback().then(function (handled) {
      if (handled) root.QB.pages.dashboard();
    });

    /* warm the meta cache so name resolvers work instantly ---------------- */
    root.QB.api.metaOnce().catch(function () {
      /* handled per-page with a graceful empty state */
    });

    window.addEventListener("hashchange", C.navigate);
    C.navigate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
