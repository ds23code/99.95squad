/* ============================================================================
 * core.js — helpers, router, UI primitives, tiny SVG charts
 * ==========================================================================*/
(function () {
  "use strict";

  var root = window;

  /* ---------------------------------------------------------------- helpers */
  function $(sel, el) { return (el || document).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }
  function fmtTime(secs) {
    secs = Math.max(0, Math.round(secs || 0));
    var m = String(Math.floor(secs / 60)).padStart(2, "0");
    var s = String(secs % 60).padStart(2, "0");
    return m + ":" + s;
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 200);
    };
  }
  /* guard for async callbacks: skip if the captured element left the DOM
     (e.g. the user navigated while data was loading) */
  function alive(el) {
    return !!el && typeof el.isConnected === "boolean" ? el.isConnected : !!el.ownerDocument;
  }
  function todayKey(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function daysBetween(a, b) {
    return Math.round((new Date(b) - new Date(a)) / 86400000);
  }
  function titleCase(s) {
    return String(s || "").replace(/[_-]+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  /* ---------------------------------------------------------------- router */
  var routes = [];
  function addRoute(pattern, handler) { routes.push({ pattern: pattern, handler: handler }); }
  function parseHash() {
    var h = location.hash || "#/";
    if (h === "#" || h === "") h = "#/";
    return h.slice(1);
  }
  function navigate() {
    var path = parseHash();
    var app = $("#app");
    var found = false;
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      if (r.pattern instanceof RegExp) {
        var m = path.match(r.pattern);
        if (m) { found = true; r.handler(m); break; }
      } else if (path === r.pattern) {
        found = true; r.handler([]); break;
      }
    }
    if (!found) { if (path.indexOf("question/") === 0) { show404(); } else { show404(); } }
    if (app) app.scrollTop = 0;
    window.scrollTo({ top: 0 });
    updateNav();
  }
  function show404() {
    var app = $("#app");
    app.innerHTML = renderEmpty({
      title: "Page not found",
      body: "That page doesn't exist or the question id is wrong.",
      action: '<a class="btn" href="#/">Home</a> <a class="btn ghost" href="#/browse">Browse questions</a>'
    });
    setPageMeta("404 — 99.95squad", "Page not found");
  }
  function updateNav() {
    var path = parseHash();
    $$("#main-nav a").forEach(function (a) {
      var nav = a.getAttribute("data-nav");
      a.classList.toggle("active", !!nav && path.indexOf(nav) === 1);
    });
    var user = root.QB && root.QB.auth ? root.QB.auth.currentUser() : null;
    var account = $("#nav-account");
    if (account) {
      if (user) {
        account.textContent = "My dashboard";
        account.href = "#/dashboard";
      } else {
        account.textContent = "Sign in";
        account.href = "#/login";
      }
    }
  }

  /* ---------------------------------------------------------------- meta */
  function setPageMeta(title, description) {
    document.title = title;
    var desc = $('meta[name="description"]');
    if (desc && description) desc.setAttribute("content", description);
  }

  /* ------------------------------------------------------------- UI bits */
  function toast(message, kind) {
    var rootEl = $("#toast-root");
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = message;
    rootEl.appendChild(el);
    setTimeout(function () { el.style.opacity = "0"; setTimeout(function () { el.remove(); }, 250); }, 3200);
  }

  function modal(html) {
    var rootEl = $("#modal-root");
    rootEl.hidden = false;
    rootEl.innerHTML =
      '<div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Image viewer">' +
      '<button class="modal-close" aria-label="Close">✕</button>' +
      '<div class="modal-box">' + html + "</div></div>";
    var backdrop = $(".modal-backdrop", rootEl);
    function close() { rootEl.hidden = true; rootEl.innerHTML = ""; document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    $(".modal-close", rootEl).addEventListener("click", close);
    backdrop.addEventListener("click", function (e) { if (e.target === backdrop) close(); });
    document.addEventListener("keydown", onKey);
    return { close: close };
  }

  function zoomable(imgSrc, alt) {
    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<img class="qimg-detail" src="' + escapeHtml(imgSrc) + '" alt="' + escapeHtml(alt || "Question image") + '" loading="lazy">';
    var img = wrap.querySelector("img");
    img.addEventListener("click", function () {
      modal('<img src="' + escapeHtml(imgSrc) + '" alt="' + escapeHtml(alt || "Question image") + '">');
    });
    return wrap.firstChild;
  }

  function renderEmpty(opts) {
    opts = opts || {};
    return (
      '<div class="empty-state">' +
      (opts.icon ? '<div class="icon" aria-hidden="true">' + opts.icon + "</div>" : "") +
      "<h2>" + escapeHtml(opts.title || "Nothing here yet") + "</h2>" +
      (opts.body ? "<p>" + opts.body + "</p>" : "") +
      (opts.action ? '<div class="actions" style="justify-content:center">' + opts.action + "</div>" : "") +
      "</div>"
    );
  }

  function spinner(label) {
    return '<div class="boot-screen"><div class="logo-mark" aria-hidden="true">' +
      '<svg viewBox="0 0 40 40" width="34" height="34"><use href="assets/img/logo.svg#mark"></use></svg></div>' +
      "<p class='muted'>" + escapeHtml(label || "Loading…") + "</p></div>";
  }

  function skeletonCards(n) {
    var out = "";
    for (var i = 0; i < (n || 4); i++) {
      out += '<div class="card"><div class="skeleton" style="height:18px;width:40%"></div>' +
        '<div class="skeleton" style="height:14px;width:70%;margin-top:10px"></div>' +
        '<div class="skeleton" style="height:140px;width:100%;margin-top:12px"></div></div>';
    }
    return out;
  }

  function badge(text, kind) {
    return '<span class="badge ' + (kind || "") + '">' + escapeHtml(text) + "</span>";
  }
  function diffBadge(d) {
    if (d == null) return "";
    return badge("Difficulty " + Number(d).toFixed(1).replace(/\.0$/, "") + "/5", "diff");
  }
  function marksBadge(m) {
    if (m == null) return "";
    return badge(m + " mark" + (m === 1 ? "" : "s"), "marks");
  }
  function typeBadge(t) { return t ? badge(titleCase(t), "type") : ""; }

  /* ------------------------------------------------------------- images */
  var webpOk = null;
  function webpSupported() {
    if (webpOk === null) {
      try {
        var c = document.createElement("canvas");
        webpOk = c.toDataURL("image/webp").indexOf("data:image/webp") === 0;
      } catch (e) { webpOk = false; }
    }
    return webpOk;
  }
  /* Pick the best image variant for the browser: WebP when supported, JPEG
     fallback otherwise. size: 'image' | 'thumb' | 'solution'.
     Always returns a *site-resolvable* URL (content-relative paths are
     prefixed with the content base via QB.api.imageUrl), so every <img>
     emitted anywhere goes through the same resolver. */
  function pickImg(rec, size) {
    if (!rec) return null;
    var raw;
    if (size === "thumb") {
      raw = webpSupported()
        ? (rec.thumb || rec.thumb_fallback || rec.image || rec.image_fallback)
        : (rec.thumb_fallback || rec.image_fallback || rec.image);
    } else if (size === "solution") {
      raw = webpSupported()
        ? (rec.solution_image || rec.solution_image_fallback)
        : (rec.solution_image_fallback || rec.solution_image);
    } else {
      raw = webpSupported()
        ? (rec.image || rec.image_fallback)
        : (rec.image_fallback || rec.image);
    }
    if (!raw) return null;
    var api = root.QB && root.QB.api;
    return api && api.imageUrl ? api.imageUrl(raw) : raw;
  }

  /* ---------------------------------------------------------------- charts */
  function svgBars(data, opts) {
    /* data: [{label, value}] -> accessible SVG bar chart */
    opts = opts || {};
    var w = opts.width || 560, h = opts.height || 150;
    var pad = 24;
    if (!data || !data.length) return '<p class="muted fine">No data yet.</p>';
    var max = Math.max.apply(null, data.map(function (d) { return d.value; })) || 1;
    var n = data.length;
    var bw = Math.max(6, Math.min(34, (w - pad * 2) / n * 0.62));
    var labels = [];
    var bars = "";
    data.forEach(function (d, i) {
      var x = pad + i * ((w - pad * 2) / n) + ((w - pad * 2) / n - bw) / 2;
      var bh = Math.max(2, (d.value / max) * (h - pad - 12));
      var y = h - pad - bh;
      bars += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw + '" height="' + bh.toFixed(1) + '" rx="3" fill="' + (d.key === true ? "#2f4bf7" : "#b9c4f8") + '">' +
        "<title>" + escapeHtml(d.label) + ": " + d.value + "</title></rect>";
      labels.push('<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle" font-size="9" fill="#8b93a3">' + escapeHtml(d.label) + "</text>");
    });
    return '<svg viewBox="0 0 ' + w + " " + h + '" width="100%" height="' + h + '" role="img" aria-label="' + escapeHtml(opts.aria || "Chart") + '">' +
      bars + labels.join("") + "</svg>";
  }

  function svgBarsH(data, opts) {
    /* horizontal bar list: [{label, value, pct, color}] */
    opts = opts || {};
    if (!data || !data.length) return '<p class="muted fine">No data yet.</p>';
    var rows = "";
    data.forEach(function (d) {
      var pct = d.pct != null ? d.pct : Math.min(100, Math.round((d.value / (opts.max || 1)) * 100));
      var color = d.color || "#2f4bf7";
      rows +=
        '<div style="display:flex;align-items:center;gap:10px;margin:7px 0">' +
        '<span style="width:180px;font-size:13px;color:var(--ink-2);text-align:right;flex-shrink:0">' + escapeHtml(d.label) + "</span>" +
        '<div class="bar" style="flex:1"><span style="width:' + pct + "%;background:" + color + '"></span></div>' +
        '<span class="fine" style="width:44px;text-align:right;font-variant-numeric:tabular-nums">' + d.value + "</span>" +
        "</div>";
    });
    return '<div role="img" aria-label="' + escapeHtml(opts.aria || "Chart") + '">' + rows + "</div>";
  }

  /* ------------------------------------------------------------- exposed */
  root.QB = root.QB || {};
  root.QB.core = {
    $: $, $$: $$, escapeHtml: escapeHtml, fmtDate: fmtDate, fmtTime: fmtTime,
    debounce: debounce, todayKey: todayKey, daysBetween: daysBetween, titleCase: titleCase,
    addRoute: addRoute, navigate: navigate, setPageMeta: setPageMeta,
    toast: toast, modal: modal, zoomable: zoomable, renderEmpty: renderEmpty,
    spinner: spinner, skeletonCards: skeletonCards, alive: alive, badge: badge,
    webpSupported: webpSupported, pickImg: pickImg,
    diffBadge: diffBadge, marksBadge: marksBadge, typeBadge: typeBadge,
    svgBars: svgBars, svgBarsH: svgBarsH,
  };
})();
