/* ============================================================================
 * pages.js — page renderers (landing, auth, dashboard, browse, question,
 * practice, saved, progress, profile, upload, admin, report)
 * ==========================================================================*/
(function () {
  "use strict";

  var root = window;
  var C = root.QB.core;
  var store = root.QB.store;
  var api = root.QB.api;
  var search = root.QB.search;
  var auth = root.QB.auth;

  /* ---------------------------------------------------------------- helpers */
  function qs() {
    var h = location.hash;
    var q = h.indexOf("?") === -1 ? "" : h.slice(h.indexOf("?") + 1);
    return new URLSearchParams(q);
  }
  function setQ(pairs) {
    var h = location.hash.split("?")[0];
    var params = qs();
    pairs.forEach(function (p) { params.set(p[0], p[1]); });
    var q = params.toString();
    location.hash = h + (q ? "?" + q : "");
  }
  function thumbUrl(rec) {
    return C.pickImg(rec, "thumb");
  }
  function questionLink(rec) { return "#/question/" + encodeURIComponent(rec.id); }

  function renderQCard(rec, opts) {
    opts = opts || {};
    var thumb = opts.thumb ? thumbUrl(rec) : C.pickImg(rec, "image");
    var topic = rec.topic_id ? (api.topicName(rec.topic_id) || rec.topic_id) : "";
    var sub = rec.subtopic_id ? (api.subtopicName(rec.subtopic_id) || "") : "";
    return (
      '<div class="card qcard" data-qid="' + C.escapeHtml(rec.id) + '">' +
      '<div class="qcard-head">' +
      '<span class="qcard-num">Q' + C.escapeHtml(rec.qnum) + "</span>" +
      C.badge(rec.paper_name || "Unknown paper") +
      (topic ? C.badge(topic, "topic") : "") +
      C.diffBadge(rec.difficulty) + C.marksBadge(rec.marks) + C.typeBadge(rec.qtype) +
      "</div>" +
      '<p class="qcard-meta">' + C.escapeHtml(rec.paper_name || "") +
      (rec.paper_year ? " · " + rec.paper_year : "") +
      (rec.paper_type ? " · " + C.titleCase(rec.paper_type) : "") +
      " · page " + rec.pages[0] + (rec.pages[1] !== rec.pages[0] ? "–" + rec.pages[1] : "") + "</p>" +
      (thumb ? '<a href="' + questionLink(rec) + '" aria-label="Open question ' + C.escapeHtml(rec.qnum) + '">' +
        '<img class="qcard-img" src="' + C.escapeHtml(thumb) + '" alt="Question ' + C.escapeHtml(rec.qnum) +
        ' image" loading="lazy"></a>' : "") +
      '<div class="qcard-actions">' +
      '<a class="btn sm" href="' + questionLink(rec) + '">Open</a>' +
      '<button class="btn ghost sm fav-btn" data-qid="' + C.escapeHtml(rec.id) + '">' +
      (store.isFavourite(rec.id) ? "★ Saved" : "☆ Save") + "</button>" +
      '<span class="spacer"></span>' +
      (opts.showAnswer && rec.answer ? '<span class="badge">Answer: ' + C.escapeHtml(rec.answer) + "</span>" : "") +
      "</div></div>"
    );
  }

  function bindFavButtons(scope) {
    C.$$(".fav-btn", scope).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var fav = store.toggleFavourite(btn.dataset.qid);
        btn.textContent = fav ? "★ Saved" : "☆ Save";
        C.toast(fav ? "Saved to your favourites" : "Removed from favourites");
      });
    });
  }

  function withMeta(fn) {
    return api.metaOnce().then(fn).catch(function (err) {
      var app = C.$("#app");
      app.innerHTML =
        '<div class="error-banner">Could not load question data: ' + C.escapeHtml(err.message) + "</div>" +
        C.renderEmpty({ title: "Nothing to show yet", body: "Run the pipeline locally and export static content (see README), or load the sample site.", action: '<a class="btn" href="#/">Reload</a>' });
    });
  }

  function selectOptions(items, valueKey, labelKey, selected) {
    var out = '<option value="">Any</option>';
    items.forEach(function (it) {
      var v = it[valueKey];
      var label = C.escapeHtml(it[labelKey]) + (it.n > 0 ? " (" + it.n + ")" : "");
      out += '<option value="' + C.escapeHtml(v) + '"' + (String(v) === String(selected) ? " selected" : "") + ">" +
        label + "</option>";
    });
    return out;
  }

  function badgePill(status) {
    var map = {
      pending: ["pending", "Pending review"], processing: ["processing", "Processing"],
      approved: ["approved", "Approved"], rejected: ["rejected", "Rejected"],
      duplicate: ["duplicate", "Duplicate"], needs_review: ["needs_review", "Needs review"],
    };
    var p = map[status] || ["pending", status];
    return '<span class="pill ' + p[0] + '">' + p[1] + "</span>";
  }

  /* ================================================================ landing */
  function landingPage() {
    var app = C.$("#app");
    C.setPageMeta("99.95squad — Practise HSC questions from real papers",
      "Search, filter and practise thousands of HSC-style questions. Image-first, exactly as printed.");
    app.innerHTML = C.spinner("Loading…");
    api.manifest().then(function (m) {
      var counts = m.counts || {};
      app.innerHTML =
        '<section class="hero">' +
        '<h1>Practise real HSC questions.<br>Exactly as they were printed.</h1>' +
        '<p class="sub">A searchable question bank built from trial papers, past papers and worksheets — ' +
        "every question rendered as a high-resolution image, so the maths, diagrams and graphs are never corrupted.</p>" +
        '<form class="searchbar" id="hero-search" action="#/browse" method="get">' +
        '<input type="search" name="q" placeholder="e.g. normal distribution, integration, projectile motion" aria-label="Search questions">' +
        '<button class="btn" type="submit">Search</button></form>' +
        '<div class="hero-actions">' +
        '<a class="btn ghost" href="#/browse">Browse all questions</a>' +
        '<a class="btn ghost" href="#/practice">Start a practice session</a>' +
        '<a class="btn ghost" href="#/upload">Contribute a paper</a>' +
        "</div>" +
        '<div class="hero-stats">' +
        '<div><div class="stat-num">' + (counts.questions || 0) + "</div><div class='stat-label'>Questions</div></div>" +
        '<div><div class="stat-num">' + (counts.papers || 0) + "</div><div class='stat-label'>Papers</div></div>" +
        '<div><div class="stat-num">' + (counts.topics || 0) + "</div><div class='stat-label'>Topics</div></div>" +
        "</div>" +
        (m.source === "sample" ? '<p class="fine" style="margin-top:18px">Preview build — sample question set. Publish your own export with <code>python -m pipeline export-static</code>.</p>' : "") +
        "</section>" +
        '<section class="grid cols-3" style="margin-top:26px">' +
        '<div class="card"><h3>📐 Image-first questions</h3><p class="muted" style="font-size:14px">Every question is a high-resolution crop of the original paper. Equations, diagrams, graphs and tables preserved exactly. Zoom in to read every detail.</p></div>' +
        '<div class="card"><h3>🔎 Search that works</h3><p class="muted" style="font-size:14px">Full-text search over OCR and metadata — plus filters for subject, course, topic, difficulty, marks, type and exam year.</p></div>' +
        '<div class="card"><h3>🎯 Serious practice</h3><p class="muted" style="font-size:14px">Timed sessions, custom sets, MCQ answering, solution reveals and progress analytics that find your weak topics.</p></div>' +
        "</section>";
      var form = C.$("#hero-search");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var q = form.querySelector("input").value.trim();
        location.hash = "#/browse" + (q ? "?q=" + encodeURIComponent(q) : "");
      });
    }).catch(function () {
      app.innerHTML = C.renderEmpty({ title: "No question data found", body: "This site has no content yet. Run the pipeline and export static content, or build with the sample set." });
    });
  }

  /* ================================================================ auth */
  function authPage(mode) {
    var app = C.$("#app");
    var isLogin = mode === "login";
    C.setPageMeta(isLogin ? "Sign in — 99.95squad" : "Create account — 99.95squad", "");
    var provider = auth.provider();
    app.innerHTML =
      '<div style="max-width:420px;margin:34px auto">' +
      '<div class="card">' +
      "<h2>" + (isLogin ? "Welcome back" : "Create your account") + "</h2>" +
      (provider === "local"
        ? '<div class="notice">Device-local mode — your profile is stored in this browser. ' +
          'To enable real accounts with synced progress, connect Supabase (see <a href="#/profile">profile → backend setup</a> or docs/AUTH.md).</div>'
        : '<div class="notice ok">Connected to Supabase — accounts are live.</div>') +
      (!isLogin ? '<div class="form-row"><label for="a-name">Name</label><input id="a-name" type="text" autocomplete="name" placeholder="Your name"></div>' : "") +
      '<div class="form-row"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email" placeholder="you@school.edu.au"></div>' +
      '<div class="form-row"><label for="a-pass">Password</label><input id="a-pass" type="password" autocomplete="current-password" placeholder="••••••••"></div>' +
      '<button class="btn block" id="a-submit">' + (isLogin ? "Sign in" : "Create account") + "</button>" +
      (provider === "supabase"
        ? '<div class="oauth-divider"><span class="muted fine">or continue with</span></div>' +
          '<div class="oauth-buttons">' +
          '<button class="btn ghost block oauth-btn" data-provider="google" type="button">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>' +
          "Google</button>" +
          '<button class="btn ghost block oauth-btn" data-provider="apple" type="button">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#000" d="M17.05 20.28c-.98.95-2.05.86-3.08.38-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.38C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>' +
          "Apple</button></div>"
        : "") +
      '<p class="fine" style="margin-top:14px">' +
      (isLogin ? 'No account? <a href="#/signup">Create one</a>' : 'Already registered? <a href="#/login">Sign in</a>') +
      "</p></div></div>";

    // OAuth buttons (Google / Apple) via Supabase authorize flow
    C.$$(".oauth-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        auth.oauthLogin(btn.dataset.provider).catch(function (err) {
          C.toast(err.message || "OAuth unavailable", "error");
        });
      });
    });

    C.$("#a-submit").addEventListener("click", function () {
      var email = C.$("#a-email").value.trim();
      var pass = C.$("#a-pass").value;
      var name = C.$("#a-name") ? C.$("#a-name").value.trim() : "";
      if (!email || !pass) { C.toast("Email and password are required", "error"); return; }
      var p = isLogin ? auth.signIn(email, pass) : auth.signUp(email, pass, name);
      p.then(function (res) {
        if (!res.ok) { C.toast(res.error || "Something went wrong", "error"); return; }
        C.toast(isLogin ? "Signed in" : "Account created");
        location.hash = "#/dashboard";
      });
    });
  }

  /* ============================================================== dashboard */
  function dashboardPage() {
    var app = C.$("#app");
    C.setPageMeta("Dashboard — 99.95squad", "");
    var user = auth.currentUser();
    var ent = auth.entitlement();
    var backend = root.QB.backend;
    var hasBackend = backend.enabled();

    app.innerHTML =
      "<h1 class='page-title'>Dashboard</h1>" +
      (user
        ? '<p class="page-sub" id="dash-greeting">Welcome back.</p>'
        : '<p class="page-sub">Sign in to track XP, streaks and mastery across devices. <a href="#/login">Sign in</a> · <a href="#/signup">Create account</a></p>') +
      (!hasBackend
        ? '<div class="notice">The full learning platform (XP, streaks, mastery, leaderboards, comments) activates when Supabase is configured — see docs/AUTH.md. Everything below is empty until then; no statistics are fabricated.</div>'
        : "") +
      '<div id="dash-body"><div class="boot-screen">' + C.spinner("Loading your progress…") + "</div></div>";

    if (!hasBackend) { renderLocalFallback(app); return; }

    backend.getDashboard().then(function (d) {
      if (!C.alive(C.$("#dash-body"))) return;
      if (!d || !d.profile) {
        C.$("#dash-body").innerHTML =
          '<div class="notice">You need an account for progress tracking. <a href="#/login">Sign in</a></div>';
        return;
      }
      renderBackendDashboard(app, d);
    }).catch(function (err) {
      C.$("#dash-body").innerHTML = '<div class="error-banner">Could not load dashboard: ' + C.escapeHtml(err.message) + "</div>";
    });
  }

  function renderBackendDashboard(app, d) {
    var G = root.QB.gamification;
    var prof = d.profile || {};
    var goal = prof.daily_goal || 10;
    var goalPct = Math.min(100, Math.round(((d.questions_today || 0) / goal) * 100));
    var lp = G.levelProgress(d.xp);
    var mastery = d.mastery || [];
    var masteredCount = mastery.filter(function (m) { return m.stage === "mastered"; }).length;
    var achievements = (d.achievements || []).filter(Boolean);
    var activity = d.activity || [];

    var greeting = "Welcome back" + (prof.display_name ? ", " + C.escapeHtml(prof.display_name) : "") + ".";
    C.$("#dash-greeting").textContent = greeting;

    var weakTopic = null;
    var practising = mastery.filter(function (m) { return m.stage === "practising"; })
      .sort(function (a, b) { return a.accuracy - b.accuracy; });
    if (practising.length) weakTopic = practising[0];

    app.querySelector("#dash-body").innerHTML =
      /* ---- hero stats ---- */
      '<div class="grid cols-4">' +
      '<div class="statcard"><div class="label">XP</div><div class="value">' + d.xp + "</div>" +
      '<div class="bar" style="margin-top:6px"><span style="width:' + Math.round(lp.progress01 * 100) + '%"></span></div>' +
      '<div class="fine muted">Level ' + d.level + " · " + lp.into + " / " + lp.needed + " XP</div></div>" +
      '<div class="statcard"><div class="label">Streak</div><div class="value">' + d.streak + " day" + (d.streak === 1 ? "" : "s") + (d.streak >= 3 ? " 🔥" : "") + "</div></div>" +
      '<div class="statcard"><div class="label">Daily goal</div><div class="value">' + (d.questions_today || 0) + " / " + goal + "</div>" +
      '<div class="bar" style="margin-top:6px"><span style="width:' + goalPct + '%"></span></div></div>' +
      '<div class="statcard"><div class="label">Overall accuracy</div><div class="value">' + (d.accuracy || 0) + "%</div>" +
      '<div class="fine muted">' + d.total_questions + ' questions</div></div>' +
      "</div>" +
      /* ---- calendar ---- */
      '<div class="card" style="margin-top:16px"><h3>Activity</h3><div id="dash-cal"></div></div>' +
      '<div class="grid cols-3" style="margin-top:16px">' +
      '<div class="card"><h3>Continue practising</h3><div class="actions">' +
      '<a class="btn" href="#/practice">New session</a>' +
      '<a class="btn ghost" href="#/syllabus">Syllabus</a>' +
      '<a class="btn ghost" href="#/leaderboard">Leaderboard</a></div>' +
      (weakTopic
        ? '<p style="margin-top:12px">Weakest topic: <a class="chip" href="#/practice?source=weak">' +
          C.escapeHtml(api.topicName(weakTopic.topic_id) || weakTopic.topic_id) +
          ' <span class="fine">' + weakTopic.accuracy + "%</span></a></p>"
        : '<p class="muted fine" style="margin-top:12px">Practise a topic to find your weak spots.</p>') +
      "</div>" +
      '<div class="card"><h3>Topic mastery</h3><div id="dash-mastery"></div>' +
      '<div class="actions" style="margin-top:10px"><a class="btn ghost sm" href="#/syllabus">Open syllabus</a></div></div>' +
      '<div class="card"><h3>Achievements</h3><div id="dash-achievements"></div>' +
      '<div class="fine muted" style="margin-top:8px">' + masteredCount + " topic" + (masteredCount === 1 ? "" : "s") + " mastered</div></div>" +
      "</div>" +
      '<div class="grid cols-2" style="margin-top:16px">' +
      '<div class="card"><h3>Recommended practice</h3><div id="dash-recommended">' + C.spinner("Finding questions…") + "</div></div>" +
      '<div class="card"><h3>Recent activity</h3><div id="dash-recent-activity"></div></div>' +
      "</div>";

    // calendar
    var calEl = C.$("#dash-cal");
    root.QB.calendar.render(calEl, activity, { view: "month", onView: function (v) {
      root.QB.backend.dailyActivity(v === "year" ? 365 : v === "month" ? 30 : 7).then(function (data) {
        if (data && C.alive(calEl)) root.QB.calendar.render(calEl, data, { view: v });
      });
    }});

    // mastery mini list
    var masteryEl = C.$("#dash-mastery");
    masteryEl.innerHTML = mastery.slice(0, 4).map(function (m) {
      return '<div class="mastery-row"><span class="fine">' + C.escapeHtml(api.topicName(m.topic_id) || m.topic_id) + "</span>" +
        '<span class="badge ' + stageBadge(m.stage) + '">' + G.stageLabel(m.stage) + "</span></div>";
    }).join("") || '<p class="muted fine">No topic data yet.</p>';

    // achievements
    var achEl = C.$("#dash-achievements");
    achEl.innerHTML = achievements.slice(0, 4).map(function (a) {
      return '<div class="ach"><span class="ach-icon" aria-hidden="true">🏅</span>' +
        '<span><b>' + C.escapeHtml(a.name) + "</b><br><span class='fine muted'>" + C.escapeHtml(a.desc) + "</span></span></div>";
    }).join("") || '<p class="muted fine">Answer questions to earn achievements.</p>';

    // recommended questions
    recommendQuestions(C.$("#dash-recommended"), mastery, prof);

    // recent activity
    recentActivity(C.$("#dash-recent-activity"));
  }

  function stageBadge(stage) {
    return { unseen: "", learning: "type", practising: "diff", strong: "topic", mastered: "marks" }[stage] || "";
  }

  function recommendQuestions(el, mastery, prof) {
    var weakTopics = (mastery || []).filter(function (m) { return m.stage === "practising"; })
      .map(function (m) { return m.topic_id; });
    var profileCourses = prof.courses && prof.courses.length ? prof.courses : null;
    api.metaOnce().then(function (m) {
      if (!C.alive(el)) return;
      var courses = profileCourses ||
        m.courses.filter(function (c) { return c.n > 0; }).map(function (c) { return c.id; });
      courses = courses.slice(0, 4);
      var recs = [];
      var chain = Promise.resolve();
      courses.forEach(function (courseId) {
        chain = chain.then(function () {
          return api.courseRecords(courseId).then(function (all) {
            all.forEach(function (r) { recs.push(r); });
          }).catch(function () {});
        });
      });
      chain.then(function () {
        if (!C.alive(el) || !recs.length) { el.innerHTML = '<p class="muted fine">No questions available.</p>'; return; }
        var pool = weakTopics.length
          ? recs.filter(function (r) { return weakTopics.indexOf(r.topic_id) !== -1; })
          : recs;
        if (pool.length < 2) pool = recs;
        var picks = [];
        for (var i = 0; i < Math.min(3, pool.length) && pool.length; i++) {
          picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
        }
        el.innerHTML = picks.map(function (r) {
          return '<div class="rec-row"><a href="' + questionLink(r) + '">Q' + C.escapeHtml(r.qnum) +
            " · " + C.escapeHtml(r.paper_name || "") + "</a>" +
            (r.difficulty ? '<span class="badge diff">' + r.difficulty + "/5</span>" : "") + "</div>";
        }).join("");
      });
    });
  }

  function recentActivity(el) {
    root.QB.backend.dailyActivity(3).then(function (days) {
      if (!C.alive(el)) return;
      // daily_activity is aggregated; recent *question* activity needs the
      // attempts feed — use the last day's topics as a lightweight view.
      var last = days && days.length ? days[days.length - 1] : null;
      if (!last || !last.questions) {
        el.innerHTML = '<p class="muted fine">No activity yet — start a practice session.</p>';
        return;
      }
      var topics = (last.topics || []).slice(0, 4).map(function (t) {
        return C.escapeHtml(api.topicName(t) || t);
      });
      el.innerHTML = '<p class="fine">Today: <b>' + last.questions + "</b> questions · <b>" + last.xp +
        "</b> XP · <b>" + Math.round(last.questions ? (100 * last.correct / last.questions) : 0) +
        "%</b> accuracy</p>" +
        (topics.length ? '<p class="fine muted">Topics: ' + topics.join(" · ") + "</p>" : "");
    });
  }

  /* Honest device-local fallback (no backend): show the locally stored
   * practice history WITHOUT fabricating server-side stats. */
  function renderLocalFallback(app) {
    var stats = store.analytics();
    var st = store.load();
    var favs = st.favourites;
    app.querySelector("#dash-body").innerHTML =
      '<div class="grid cols-4">' +
      '<div class="statcard"><div class="label">Questions (this device)</div><div class="value">' + stats.total + "</div></div>" +
      '<div class="statcard"><div class="label">Accuracy</div><div class="value">' + stats.accuracy + "%</div></div>" +
      '<div class="statcard"><div class="label">Streak (device)</div><div class="value">' + stats.streak + "</div></div>" +
      '<div class="statcard"><div class="label">Practice time</div><div class="value">' + C.fmtTime(stats.seconds) + "</div></div>" +
      "</div>" +
      '<div class="grid cols-2" style="margin-top:16px">' +
      '<div class="card"><h3>Continue practising</h3><div class="actions">' +
      '<a class="btn" href="#/practice">New session</a>' +
      '<a class="btn ghost" href="#/browse">Browse questions</a>' +
      '<a class="btn ghost" href="#/saved">Saved (' + favs.length + ")</a></div></div>" +
      '<div class="card"><h3>Recently viewed</h3><div id="dash-recent"></div></div>' +
      "</div>";
    var recentEl = C.$("#dash-recent");
    recentEl.innerHTML = st.recent.length
      ? st.recent.slice(0, 5).map(function (id) { return '<p class="fine"><a href="#/question/' + encodeURIComponent(id) + '">View question</a></p>'; }).join("")
      : '<p class="muted fine">Questions you open will appear here.</p>';
  }

  /* =============================================================== syllabus */
  function syllabusPage() {
    var app = C.$("#app");
    C.setPageMeta("Syllabus — 99.95squad", "Track topic mastery from Unseen to Mastered.");
    app.innerHTML =
      "<h1 class='page-title'>Syllabus</h1>" +
      '<p class="page-sub">Progress each topic from <b>Unseen</b> → <b>Learning</b> → <b>Practising</b> → <b>Strong</b> → <b>Mastered</b>.</p>' +
      '<div id="syl-body">' + C.spinner("Loading your syllabus…") + "</div>";

    var backend = root.QB.backend;
    if (!backend.enabled() || !backend.currentUser()) {
      C.$("#syl-body").innerHTML =
        '<div class="notice">Syllabus tracking requires an account (Supabase backend — docs/AUTH.md).</div>' +
        '<div class="card"><h3>How mastery works</h3><ol class="step-list">' +
        "<li><b>Learning</b> — 1–2 attempts on a topic.</li>" +
        "<li><b>Practising</b> — 3+ attempts, accuracy under 70%.</li>" +
        "<li><b>Strong</b> — 3+ attempts, accuracy 70%+.</li>" +
        "<li><b>Mastered</b> — 5+ attempts, 90%+ accuracy, average difficulty 2.5+, practised recently.</li></ol></div>";
      return;
    }
    var G = root.QB.gamification;
    api.metaOnce().then(function (m) {
      backend.topicMastery().then(function (mastery) {
        if (!C.alive(C.$("#syl-body"))) return;
        mastery = mastery || [];
        var byTopic = {};
        mastery.forEach(function (t) { byTopic[t.topic_id] = t; });
        var topics = m.topics.filter(function (t) { return t.n > 0; });
        var stats = { unseen: 0, learning: 0, practising: 0, strong: 0, mastered: 0 };
        topics.forEach(function (t) {
          var st = byTopic[t.id] ? byTopic[t.id].stage : "unseen";
          stats[st]++;
        });
        C.$("#syl-body").innerHTML =
          '<div class="grid cols-5 syl-summary">' +
          G.STAGE_ORDER.map(function (s) {
            return '<div class="statcard"><div class="label">' + G.stageLabel(s) + "</div><div class='value'>" +
              stats[s] + "</div></div>";
          }).join("") + "</div>" +
          '<div class="card syl-path" style="margin-top:16px">' +
          topics.map(function (t) {
            var st = byTopic[t.id] ? byTopic[t.id] : { stage: "unseen", accuracy: 0, attempts: 0 };
            var idx = G.STAGE_ORDER.indexOf(st.stage);
            return (
              '<a class="syl-node" href="#/practice?topic=' + encodeURIComponent(t.id) + '">' +
              '<div class="syl-node-head"><b>' + C.escapeHtml(t.name) + "</b>" +
              '<span class="badge ' + stageBadge(st.stage) + '">' + G.stageLabel(st.stage) + "</span></div>" +
              '<div class="syl-track">' + G.STAGE_ORDER.map(function (s, i) {
                return '<span class="syl-dot' + (i <= idx ? " filled" : "") + '" title="' + G.stageLabel(s) + '"></span>' +
                  (i < G.STAGE_ORDER.length - 1 ? '<span class="syl-link' + (i < idx ? " filled" : "") + '"></span>' : "");
              }).join("") + "</div>" +
              '<div class="fine muted">' + st.attempts + " attempt" + (st.attempts === 1 ? "" : "s") +
              (st.accuracy ? " · " + st.accuracy + "%" : "") + "</div></a>"
            );
          }).join("") +
          "</div>" +
          '<div class="card" style="margin-top:16px"><h3>Recommended next</h3><div id="syl-recommended">' +
          '<p class="muted fine">Your weakest practised topic is listed first on this page — click its node to start a focused session.</p></div></div>';
      });
    });
  }

  /* ============================================================ leaderboard */
  function leaderboardPage() {
    var app = C.$("#app");
    C.setPageMeta("Leaderboard — 99.95squad", "Weekly and all-time XP rankings.");
    var backend = root.QB.backend;
    app.innerHTML =
      "<h1 class='page-title'>Leaderboard</h1>" +
      '<p class="page-sub">Ranked by XP earned on correctly answered questions. You can opt out in <a href="#/profile">settings</a>.</p>' +
      '<div class="tabs" id="lb-tabs">' +
      '<a href="#/leaderboard?period=week" data-period="week" class="active">This week</a>' +
      '<a href="#/leaderboard?period=all" data-period="all">All time</a></div>' +
      '<div id="lb-body">' + C.spinner("Loading…") + "</div>";

    if (!backend.enabled()) {
      C.$("#lb-body").innerHTML = '<div class="notice">Leaderboards require the Supabase backend (docs/AUTH.md).</div>';
      return;
    }
    var period = qs().get("period") === "all" ? "all" : "week";
    C.$$("#lb-tabs a").forEach(function (a) {
      a.classList.toggle("active", a.dataset.period === period);
    });
    var G = root.QB.gamification;
    backend.leaderboard(period, 100, 0).then(function (rows) {
      if (!C.alive(C.$("#lb-body"))) return;
      if (rows === null || !rows.length) {
        C.$("#lb-body").innerHTML = C.renderEmpty({ title: "No rankings yet", body: "Earn XP by answering questions correctly." });
        return;
      }
      var myId = backend.currentUser() && backend.currentUser().id;
      C.$("#lb-body").innerHTML =
        '<div class="card"><table class="table"><thead><tr><th>#</th><th>Student</th><th class="num">Level</th><th class="num">XP</th></tr></thead><tbody>' +
        rows.map(function (r) {
          var mine = myId && r.user_id === myId;
          return "<tr" + (mine ? ' class="row-mine"' : "") + ">" +
            "<td><b>" + r.rank + "</b></td>" +
            "<td>" + (r.avatar_url ? '<img class="lb-avatar" src="' + C.escapeHtml(r.avatar_url) + '" alt="">' : "") +
            C.escapeHtml(r.display_name || "Student") + (mine ? ' <span class="badge">you</span>' : "") + "</td>" +
            "<td class='num'>" + r.level + "</td>" +
            "<td class='num'><b>" + r.xp + "</b></td></tr>";
        }).join("") + "</tbody></table></div>";
    });
  }

  /* ===================================================== time analytics */
  function analyticsPage() {
    var app = C.$("#app");
    C.setPageMeta("Time analytics — 99.95squad", "Your timing vs the study community (aggregates only).");
    var backend = root.QB.backend;
    app.innerHTML =
      "<h1 class='page-title'>Time analytics</h1>" +
      '<p class="page-sub">Your average time per question compared with the community. Individual students\u2019 data is never shown — only aggregates.</p>' +
      '<div id="an-body">' + C.spinner("Loading…") + "</div>";
    if (!backend.enabled() || !backend.currentUser()) {
      C.$("#an-body").innerHTML = '<div class="notice">Time analytics require an account (Supabase backend — docs/AUTH.md).</div>';
      return;
    }
    backend.timeStats().then(function (t) {
      if (!C.alive(C.$("#an-body"))) return;
      if (!t) { C.$("#an-body").innerHTML = '<div class="notice">No timing data yet — answer a few questions.</div>'; return; }
      var u = t.user || {}, g = t.global || {};
      var faster = t.faster_slower_pct;
      var gAvg = g.avg_seconds || 0;
      var userAvg = u.avg_seconds || 0;
      var maxBar = Math.max(gAvg, userAvg, 1);
      function barRow(label, userVal, globalVal, unit) {
        return (
          '<div class="time-row"><div class="time-label">' + C.escapeHtml(label) + "</div>" +
          '<div class="bar" style="margin:4px 0"><span style="width:' + Math.round((userVal / maxBar) * 100) + '%"></span></div>' +
          '<div class="fine muted">You: ' + userVal + (unit || "s") + "</div>" +
          '<div class="bar bar-ghost" style="margin:4px 0"><span style="width:' + Math.round((globalVal / maxBar) * 100) + '%"></span></div>' +
          '<div class="fine muted">Community avg: ' + globalVal + (unit || "s") + " · n=" + (g.n || 0) + "</div></div>"
        );
      }
      C.$("#an-body").innerHTML =
        '<div class="grid cols-3">' +
        '<div class="statcard"><div class="label">Your average</div><div class="value">' + u.avg_seconds + "s</div></div>" +
        '<div class="statcard"><div class="label">Your median</div><div class="value">' + u.median_seconds + "s</div></div>" +
        '<div class="statcard"><div class="label">vs community</div><div class="value">' +
        (faster == null ? "—" : (faster >= 0 ? faster + "% faster" : Math.abs(faster) + "% slower")) + "</div></div>" +
        "</div>" +
        '<div class="card" style="margin-top:16px"><h3>Time per question</h3>' + barRow("All questions", userAvg, gAvg) +
        barRow("Correct", t.user_correct || 0, t.global_correct || 0) +
        barRow("Incorrect", t.user_incorrect || 0, t.global_incorrect || 0) + "</div>" +
        '<p class="fine muted" style="margin-top:10px">Faster/slower is computed from aggregate means; no individual data is exposed.</p>';
    });
  }

  /* ================================================================= browse */
  var browseState = { loading: false, gen: 0 };

  function browsePage() {
    var app = C.$("#app");
    C.setPageMeta("Browse questions — 99.95squad", "Search and filter HSC questions by subject, course, topic, difficulty and more.");
    app.innerHTML =
      "<h1 class='page-title'>Question browser</h1>" +
      '<div class="layout-sidebar">' +
      '<aside class="sidebar filters" id="filters">' +
      "<h3>Filters</h3><div id=\"filters-body\">" + C.spinner() + "</div></aside>" +
      '<section id="browse-main">' +
      '<div class="searchbar" style="margin-bottom:14px">' +
      '<input type="search" id="b-q" placeholder="Search questions… (e.g. integration, projectile, normal distribution)" aria-label="Search">' +
      '<button class="btn" id="b-search-btn">Search</button></div>' +
      '<div class="section-head">' +
      '<p class="muted fine" id="b-count">Loading…</p>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<label for="b-sort" class="fine" style="margin:0">Sort</label>' +
      '<select id="b-sort" style="width:auto;padding:6px 10px">' +
      '<option value="newest">Newest papers</option>' +
      '<option value="difficulty">Difficulty</option>' +
      '<option value="marks">Marks</option>' +
      '<option value="relevance">Relevance</option>' +
      '<option value="random">Random</option></select>' +
      '<button class="btn ghost sm" id="b-random">🎲 Random</button>' +
      "</div></div>" +
      '<div id="b-results">' + C.skeletonCards(4) + "</div>" +
      '<nav class="pager" id="b-pager" style="margin-top:16px;display:flex;gap:10px;align-items:center;justify-content:center"></nav>' +
      "</section></div>";

    withMeta(function (m) {
      var params = qs();
      var q = params.get("q") || "";
      C.$("#b-q").value = q;
      C.$("#b-sort").value = params.get("sort") || "newest";

      var body = C.$("#filters-body");
      body.innerHTML =
        '<label>Subject<select id="f-subject">' + selectOptions(m.subjects.filter(function (s) { return s.n > 0; }), "id", "name", params.get("subject")) + "</select></label>" +
        '<label>Course<select id="f-course">' + selectOptions(m.courses.filter(function (c) { return c.n > 0; }), "id", "name", params.get("course")) + "</select></label>" +
        '<label>Topic<select id="f-topic">' + selectOptions(m.topics.filter(function (t) { return t.n > 0; }), "id", "name", params.get("topic")) + "</select></label>" +
        '<div class="filter-row">' +
        '<label>Difficulty<select id="f-diffmin">' + selectOptions([{ id: 1, name: "1+" }, { id: 2, name: "2+" }, { id: 3, name: "3+" }, { id: 4, name: "4+" }, { id: 5, name: "5" }], "id", "name", params.get("difficulty_min")) + "</select></label>" +
        '<label>Type<select id="f-type">' + selectOptions(m.facets.question_types.map(function (t) { return { id: t, name: C.titleCase(t), n: 0 }; }), "id", "name", params.get("type")) + "</select></label>" +
        "</div>" +
        '<div class="filter-row">' +
        '<label>Marks ≥<select id="f-marks">' + selectOptions([{ id: 1, name: "1" }, { id: 2, name: "2" }, { id: 3, name: "3" }, { id: 5, name: "5" }], "id", "name", params.get("marks_min")) + "</select></label>" +
        '<label>Paper year<select id="f-year">' + selectOptions(m.facets.paper_years.map(function (y) { return { id: y, name: String(y), n: 0 }; }), "id", "name", params.get("paper_year")) + "</select></label>" +
        "</div>" +
        '<label>Paper type<select id="f-ptype">' + selectOptions(m.facets.paper_types.map(function (t) { return { id: t, name: C.titleCase(t), n: 0 }; }), "id", "name", params.get("paper_type")) + "</select></label>" +
        '<button class="btn" id="f-apply">Apply filters</button>' +
        '<a class="btn ghost" href="#/browse">Reset</a>' +
        '<div style="margin-top:12px"><a class="btn ghost block" href="#/practice?' + (params.get("course") ? "course=" + encodeURIComponent(params.get("course")) : "") + (params.get("topic") ? "&topic=" + encodeURIComponent(params.get("topic")) : "") + '">Practise this filter set</a></div>';

      function collectFilters() {
        return {
          subject: C.$("#f-subject").value || null,
          course: C.$("#f-course").value || null,
          topic: C.$("#f-topic").value || null,
          difficulty_min: C.$("#f-diffmin").value || null,
          type: C.$("#f-type").value || null,
          marks_min: C.$("#f-marks").value || null,
          paper_year: C.$("#f-year").value || null,
          paper_type: C.$("#f-ptype").value || null,
        };
      }
      function applyFromForm() {
        var f = collectFilters();
        var q = C.$("#b-q").value.trim();
        var p = new URLSearchParams();
        if (q) p.set("q", q);
        Object.keys(f).forEach(function (k) { if (f[k]) p.set(k, f[k]); });
        var sort = C.$("#b-sort").value;
        if (sort !== "newest") p.set("sort", sort);
        location.hash = "#/browse" + (p.toString() ? "?" + p.toString() : "");
      }

      C.$("#f-apply").addEventListener("click", applyFromForm);
      C.$("#b-search-btn").addEventListener("click", applyFromForm);
      C.$("#b-q").addEventListener("keydown", function (e) { if (e.key === "Enter") applyFromForm(); });
      C.$("#b-sort").addEventListener("change", applyFromForm);

      // course -> subject/topic cascading
      var courseSel = C.$("#f-course");
      courseSel.addEventListener("change", function () {
        var c = courseSel.value;
        var tSel = C.$("#f-topic");
        tSel.innerHTML = '<option value="">Any</option>' +
          m.topics.filter(function (t) { return !c || t.course_id === c; }).map(function (t) {
            return '<option value="' + C.escapeHtml(t.id) + '">' + C.escapeHtml(t.name) + " (" + t.n + ")</option>";
          }).join("");
      });
      courseSel.dispatchEvent(new Event("change"));

      C.$("#b-random").addEventListener("click", function () {
        runBrowse(true);
      });

      function runBrowse(randomPick) {
        var gen = ++browseState.gen;
        browseState.loading = true;
        var f = collectFilters();
        var q = C.$("#b-q").value.trim() || qs().get("q") || "";
        var sortBy = C.$("#b-sort").value;
        var pageNo = parseInt(qs().get("page") || "1", 10) || 1;
        var perPage = 20;
        var resultsEl = C.$("#b-results");
        resultsEl.innerHTML = C.skeletonCards(4);

        function render(records, total) {
          if (!C.alive(resultsEl) || gen !== browseState.gen) return;
          var sorted = search.sortRecords(records, sortBy, null);
          var pg = search.page(sorted, pageNo, perPage);
          C.$("#b-count").textContent = total + " question" + (total === 1 ? "" : "s") + (q ? " matching “" + q + "”" : "");
          if (!pg.items.length) {
            resultsEl.innerHTML = C.renderEmpty({
              icon: "🔍", title: "No questions match",
              body: "Try fewer filters or a simpler keyword — OCR text is imperfect, so single words like “integral” work best.",
              action: '<a class="btn ghost" href="#/browse">Reset filters</a>',
            });
          } else {
            resultsEl.innerHTML = pg.items.map(function (r) { return renderQCard(r, { thumb: true }); }).join("");
            bindFavButtons(resultsEl);
          }
          var pager = C.$("#b-pager");
          if (pg.pages > 1) {
            var html = "";
            if (pg.page > 1) html += '<a class="btn ghost sm" href="#/browse?' + withPage(pageNo - 1) + '">← Prev</a>';
            html += "<span class='fine'>Page " + pg.page + " of " + pg.pages + "</span>";
            if (pg.page < pg.pages) html += '<a class="btn ghost sm" href="#/browse?' + withPage(pageNo + 1) + '">Next →</a>';
            pager.innerHTML = html;
          } else pager.innerHTML = "";
        }
        function withPage(p) {
          var params = qs(); params.set("page", p);
          return params.toString();
        }

        var terms = q ? search.tokenize(q) : [];
        var f2 = {
          course: f.course, subject: f.subject, topic: f.topic, qtype: f.type,
          difficulty_min: f.difficulty_min, marks_min: f.marks_min,
          paper_year: f.paper_year, paper_type: f.paper_type,
        };

        search.searchIds(terms, f2, m).then(function (res) {
          if (gen !== browseState.gen) return;

          if (res.backend) {
            // backend search API returns records + total directly
            var recs = (res.records || []).filter(function (r) { return search.matchesFilters(r, f2); });
            if (randomPick && recs.length) { location.hash = questionLink(recs[Math.floor(Math.random() * recs.length)]); return; }
            render(recs, res.total || recs.length);
            return;
          }

          if (res.ids !== null) {
            // ids-based results (text search or facet-token filters):
            // page by slicing ids and fetching only the shards we need
            var pgIds = search.page(res.ids, pageNo, perPage);
            api.records(pgIds.items).then(function (recMap) {
              if (gen !== browseState.gen) return;
              var pageRecs = pgIds.items.map(function (id) { return recMap[id]; })
                .filter(function (r) { return r && search.matchesFilters(r, f2); });
              if (randomPick && res.ids.length) {
                var pick = res.ids[Math.floor(Math.random() * res.ids.length)];
                api.records([pick]).then(function (rm2) {
                  var r2 = rm2[pick];
                  if (r2) location.hash = questionLink(r2);
                });
                return;
              }
              var sorted = search.sortRecords(pageRecs, sortBy, null);
              render(sorted, res.total != null ? res.total : res.ids.length);
            });
            return;
          }

          // filters-only without facet index (legacy content): iterate shards
          var courses = res.courses;
          var all = [];
          var chain = Promise.resolve();
          courses.forEach(function (courseId) {
            chain = chain.then(function () {
              return api.courseRecords(courseId).then(function (recs) {
                recs.forEach(function (r) { if (search.matchesFilters(r, f2) && all.length < 3000) all.push(r); });
              });
            });
          });
          chain.then(function () {
            if (gen !== browseState.gen) return;
            if (randomPick && all.length) {
              location.hash = questionLink(all[Math.floor(Math.random() * all.length)]);
              return;
            }
            render(all, all.length);
          }).catch(function (err) {
            if (gen !== browseState.gen) return;
            resultsEl.innerHTML = '<div class="error-banner">Search failed: ' + C.escapeHtml(err.message) + "</div>";
          });
        }).catch(function (err) {
          if (gen !== browseState.gen) return;
          resultsEl.innerHTML = '<div class="error-banner">Search failed: ' + C.escapeHtml(err.message) + "</div>";
        }).finally(function () {
          if (gen === browseState.gen) browseState.loading = false;
        });
      }
      runBrowse(false);
    });
  }

  /* =============================================================== question */
  function questionPage(id) {
    var app = C.$("#app");
    app.innerHTML = C.spinner("Loading question…");
    api.records([id]).then(function (recMap) {
      var rec = recMap[id];
      if (!rec) {
        app.innerHTML = C.renderEmpty({ title: "Question not found", body: "It may have been removed from the published set.", action: '<a class="btn" href="#/browse">Browse questions</a>' });
        return;
      }
      store.recordView(id);
      C.setPageMeta("Question " + rec.qnum + " — 99.95squad",
        (rec.paper_name || "") + " Q" + rec.qnum + (rec.topic_id ? " · " + (api.topicName(rec.topic_id) || "") : ""));
      var topic = rec.topic_id ? api.topicName(rec.topic_id) : null;
      var sub = rec.subtopic_id ? api.subtopicName(rec.subtopic_id) : null;

      app.innerHTML =
        '<nav class="crumbs"><a href="#/browse">← Back to questions</a></nav>' +
        '<div class="card qcard" data-qid="' + C.escapeHtml(rec.id) + '">' +
        '<div class="qcard-head">' +
        '<span class="qcard-num">Q' + C.escapeHtml(rec.qnum) + "</span>" +
        (rec.section ? C.badge("Section " + rec.section) : "") +
        C.badge(rec.paper_name || "Unknown paper") +
        (topic ? C.badge(topic, "topic") + (sub ? C.badge(sub, "topic") : "") : "") +
        C.diffBadge(rec.difficulty) + C.marksBadge(rec.marks) + C.typeBadge(rec.qtype) +
        "</div>" +
        '<p class="qcard-meta">' + C.escapeHtml(rec.paper_name || "") +
        (rec.paper_year ? " · " + rec.paper_year : "") +
        (rec.paper_type ? " · " + C.titleCase(rec.paper_type) : "") +
        " · pages " + rec.pages[0] + (rec.pages[1] !== rec.pages[0] ? "–" + rec.pages[1] : "") + "</p>" +
        '<div id="q-image"></div>' +
        '<div class="q-timer-bar">' +
        '<span class="timer-display" id="q-timer">00:00</span>' +
        '<span class="fine muted">time on this question</span></div>' +
        '<div class="qcard-actions">' +
        '<button class="btn ok" id="q-correct">✓ I got it right</button>' +
        '<button class="btn ghost" id="q-wrong">✗ I got it wrong</button>' +
        '<button class="btn ghost" id="q-fav">' + (store.isFavourite(id) ? "★ Saved" : "☆ Save") + "</button>" +
        '<a class="btn ghost" href="#/report/' + encodeURIComponent(id) + '">Report</a>' +
        "</div>" +
        '<div id="q-xp-feedback" class="xp-feedback" hidden></div>' +
        '<details class="ocr" style="margin-top:14px"><summary>Show answer & solution</summary>' +
        '<div style="padding:10px 0"><div id="q-answer"></div></div></details>' +
        "</div>" +
        '<div class="grid cols-2" style="margin-top:18px">' +
        '<div class="card"><h3>Similar questions</h3><div id="q-similar">' + C.spinner("Finding similar…") + "</div></div>" +
        '<div class="card"><h3>Keep practising</h3><p class="muted" style="font-size:14px">Run a focused session on ' +
        C.escapeHtml(topic || "this topic") + ".</p>" +
        '<div class="actions">' +
        '<a class="btn" href="#/practice' + (rec.topic_id ? "?topic=" + encodeURIComponent(rec.topic_id) : "") + (rec.course_id ? (rec.topic_id ? "&" : "?") + "course=" + encodeURIComponent(rec.course_id) : "") + '">Practice ' + C.escapeHtml(topic || "this topic") + "</a>" +
        '<button class="btn ghost" id="q-another">Practice another like this</button>' +
        "</div></div>" +
        "</div>" +
        '<div class="card" style="margin-top:18px"><div id="q-comments"></div></div>';

      // image (zoomable) — WebP when supported, JPEG fallback, PNG on zoom
      var imgEl = C.$("#q-image");
      var detailSrc = C.pickImg(rec, "image");
      if (detailSrc) {
        imgEl.appendChild(C.zoomable(detailSrc, "Question " + rec.qnum));
      } else {
        imgEl.innerHTML = '<p class="muted">Image unavailable.</p>';
      }

      // answer + solution + OCR text
      var ansEl = C.$("#q-answer");
      api.text(id).then(function (txt) {
        if (!C.alive(ansEl)) return; // navigated away while loading
        var html = "";
        if (rec.answer) html += "<p><strong>Answer:</strong> " + C.escapeHtml(rec.answer) + "</p>";
        else html += "<p class='muted'>No short answer recorded for this question.</p>";
        var solSrc = C.pickImg(rec, "solution");
        if (solSrc) {
          html += '<p><strong>Worked solution:</strong></p><div id="q-sol-img"></div>';
        }
        if (txt && txt.ocr_clean) {
          html += "<details class='ocr'><summary>OCR text (for search — the image above is authoritative)</summary><pre style='white-space:pre-wrap'>" + C.escapeHtml(txt.ocr_clean) + "</pre></details>";
        }
        ansEl.innerHTML = html;
        if (solSrc) {
          var solEl = C.$("#q-sol-img");
          solEl.appendChild(C.zoomable(solSrc, "Solution for question " + rec.qnum));
        }
      });

      // ---- per-question timer -----------------------------------------------
      var qStart = Date.now();
      var qTimer = C.$("#q-timer");
      var qTimerTick = setInterval(function () {
        if (!C.alive(qTimer)) { clearInterval(qTimerTick); return; }
        qTimer.textContent = C.fmtTime(Math.round((Date.now() - qStart) / 1000));
      }, 1000);

      // ---- record attempt (server-side XP when backend enabled) -------------
      var recorded = false;
      var xpBox = C.$("#q-xp-feedback");
      function record(correct) {
        if (recorded) return;
        recorded = true;
        clearInterval(qTimerTick);
        var seconds = Math.round((Date.now() - qStart) / 1000);
        // local store always records (device history)
        store.recordAttempt({ qid: id, correct: correct, mode: "practice", seconds: seconds, topic_id: rec.topic_id });
        var backend = root.QB.backend;
        var toastMsg;
        if (!backend.enabled() || !backend.currentUser()) {
          toastMsg = correct ? "Marked correct" : "Marked incorrect — check the solution";
        } else {
          backend.recordAttempt({
            question_id: id, correct: correct, seconds: seconds,
            mode: "practice", course_id: rec.course_id, topic_id: rec.topic_id,
            difficulty: rec.difficulty,
          }).then(function (res) {
            if (!res) return;
            var G = root.QB.gamification;
            xpBox.hidden = false;
            var text = correct
              ? '<b>+' + res.xp_earned + " XP</b>" + (res.bonus ? ' <span class="fine">(includes ' + res.bonus + ' streak bonus)</span>' : "")
              : "No XP this time — check the solution and try again";
            xpBox.innerHTML = text +
              '<span class="fine muted"> · Level ' + res.level + " · Streak " + res.streak + " days · Today " + res.xp_today + " XP</span>";
            xpBox.classList.add(correct ? "xp-win" : "xp-loss");
            C.toast(correct ? "+" + res.xp_earned + " XP earned" : "Incorrect — no XP", correct ? "ok" : "");
          }).catch(function (err) {
            C.toast(correct ? "Marked correct" : "Marked incorrect");
            console.warn("record_attempt failed:", err && err.message);
          });
          return;
        }
        xpBox.hidden = false;
        xpBox.innerHTML = C.escapeHtml(toastMsg);
        xpBox.classList.add(correct ? "xp-win" : "xp-loss");
        C.toast(toastMsg, correct ? "ok" : "");
      }
      C.$("#q-correct").addEventListener("click", function () { record(true); });
      C.$("#q-wrong").addEventListener("click", function () { record(false); });

      // ---- favourite (device + backend) -------------------------------------
      C.$("#q-fav").addEventListener("click", function () {
        var fav = store.toggleFavourite(id);
        C.$("#q-fav").textContent = fav ? "★ Saved" : "☆ Save";
        if (root.QB.backend.enabled() && root.QB.backend.currentUser()) {
          root.QB.backend.setFavourite(id, fav);
        }
        C.toast(fav ? "Saved" : "Removed");
      });

      // ---- practice another like this ---------------------------------------
      var anotherBtn = C.$("#q-another");
      if (rec.course_id) {
        anotherBtn.addEventListener("click", function () {
          api.courseRecords(rec.course_id).then(function (recs) {
            var pool = rec.topic_id
              ? recs.filter(function (r) { return r.id !== id && r.topic_id === rec.topic_id; })
              : recs.filter(function (r) { return r.id !== id; });
            if (!pool.length) pool = recs.filter(function (r) { return r.id !== id; });
            if (!pool.length) { C.toast("No other questions in this set", "error"); return; }
            var pick = pool[Math.floor(Math.random() * pool.length)];
            location.hash = questionLink(pick);
          });
        });
      } else {
        anotherBtn.hidden = true;
      }

      // ---- comments -----------------------------------------------------------
      var commentsEl = C.$("#q-comments");
      if (commentsEl) root.QB.comments.render(commentsEl, id, {});

      // similar questions
      var similarEl = C.$("#q-similar");
      if (rec.course_id && rec.topic_id) {
        api.courseRecords(rec.course_id).then(function (recs) {
          if (!C.alive(similarEl)) return;
          var similar = recs.filter(function (r) {
            return r.id !== id && r.topic_id === rec.topic_id &&
              (rec.difficulty == null || r.difficulty == null || Math.abs(r.difficulty - rec.difficulty) <= 1.5);
          });
          // prefer same topic; if none, same course
          if (!similar.length) similar = recs.filter(function (r) { return r.id !== id; });
          similar = similar.slice(0, 3);
          similarEl.innerHTML = similar.length
            ? similar.map(function (r) {
                return '<p style="margin:8px 0"><a href="' + questionLink(r) + '">Q' + C.escapeHtml(r.qnum) +
                  " — " + C.escapeHtml(r.paper_name || "") + (r.difficulty ? " · " + r.difficulty + "/5" : "") + "</a></p>";
              }).join("")
            : '<p class="muted fine">No similar questions in this set.</p>';
        }).catch(function () {
          similarEl.innerHTML = '<p class="muted fine">Unavailable.</p>';
        });
      } else {
        similarEl.innerHTML = '<p class="muted fine">No similar questions in this set.</p>';
      }
    }).catch(function (err) {
      app.innerHTML = '<div class="error-banner">' + C.escapeHtml(err.message) + "</div>" +
        C.renderEmpty({ title: "Could not load question" });
    });
  }

  /* =============================================================== practice */
  function practicePage() {
    var app = C.$("#app");
    C.setPageMeta("Practice — 99.95squad", "Timed and untimed practice sessions with progress tracking.");
    var params = qs();
    app.innerHTML =
      "<h1 class='page-title'>Practice mode</h1>" +
      '<p class="page-sub">Pick a source and filters, then work through questions. Answers stay hidden until you reveal them.</p>' +
      '<div class="practice-toolbar">' +
      "<form id='p-setup' class='inline-form' style='display:flex;gap:8px;flex-wrap:wrap;flex:1'>" +
      '<select id="p-source" aria-label="Question source">' +
      '<option value="random">Random from filters</option>' +
      '<option value="topic">Topic practice</option>' +
      '<option value="weak">Weak topics</option>' +
      '<option value="favourites">My saved questions</option></select>' +
      '<select id="p-course" aria-label="Course"></select>' +
      '<select id="p-topic" aria-label="Topic"></select>' +
      '<select id="p-type" aria-label="Question type"><option value="">Any type</option>' +
      '<option value="multiple_choice">Multiple choice</option>' +
      '<option value="short_answer">Short answer</option>' +
      '<option value="extended_response">Extended response</option></select>' +
      '<select id="p-diff" aria-label="Minimum difficulty"><option value="">Any difficulty</option>' +
      '<option value="3">3+ (harder)</option><option value="4">4+ (hard)</option></select>' +
      '<select id="p-count" aria-label="Question count"><option value="5">5 questions</option>' +
      '<option value="10" selected>10 questions</option><option value="20">20 questions</option></select>' +
      '<label class="fine" style="display:flex;align-items:center;gap:5px;margin:0"><input type="checkbox" id="p-timed" style="width:auto"> Timed</label>' +
      '<select id="p-minutes" aria-label="Time limit"><option value="10">10 min</option><option value="15" selected>15 min</option><option value="30">30 min</option></select>' +
      '<button class="btn" type="submit">Start</button></form></div>' +
      '<div id="p-session"></div>' +
      '<div class="grid cols-2" style="margin-top:26px">' +
      '<div class="card"><h3>Custom question sets</h3><div id="p-sets"></div></div>' +
      '<div class="card"><h3>How it works</h3><ol class="step-list" style="margin:0">' +
      "<li>Pick a source — random, a topic, your weak areas, or your saved questions.</li>" +
      "<li>Answer multiple-choice questions directly; self-mark written answers after revealing the solution.</li>" +
      "<li>Every attempt feeds your progress page — accuracy, streaks and weak-topic detection.</li></ol></div>" +
      "</div>";

    withMeta(function (m) {
      var courseSel = C.$("#p-course");
      courseSel.innerHTML = selectOptions(m.courses.filter(function (c) { return c.n > 0; }), "id", "name", params.get("course"));
      var topicSel = C.$("#p-topic");
      topicSel.innerHTML = selectOptions(m.topics.filter(function (t) { return t.n > 0; }), "id", "name", params.get("topic"));
      courseSel.addEventListener("change", function () {
        var c = courseSel.value;
        topicSel.innerHTML = selectOptions(m.topics.filter(function (t) { return !c || t.course_id === c; }), "id", "name", params.get("topic"));
      });
      courseSel.dispatchEvent(new Event("change"));

      C.$("#p-sets").innerHTML = renderSets(m);
      bindSetActions(app, m);

      C.$("#p-setup").addEventListener("submit", function (e) {
        e.preventDefault();
        var source = C.$("#p-source").value;
        var filters = {
          course: C.$("#p-course").value || null,
          topic: C.$("#p-topic").value || null,
          qtype: C.$("#p-type").value || null,
          difficulty_min: C.$("#p-diff").value || null,
        };
        var count = parseInt(C.$("#p-count").value, 10) || 10;
        var timed = C.$("#p-timed").checked;
        var minutes = parseInt(C.$("#p-minutes").value, 10) || 15;

        root.QB.practice.buildSet(filters, count, source, m).then(function (built) {
          if (!built.qids.length) {
            C.toast("No questions match those choices", "error");
            return;
          }
          var s = root.QB.practice.startSession({
            qids: built.qids, records: built.records,
            name: C.titleCase(source) + (filters.topic ? " · " + (api.topicName(filters.topic) || "") : ""),
            timed: timed, minutes: minutes, mode: source,
          });
          C.$("#p-session").innerHTML = "";
          root.QB.practice.renderSession(C.$("#p-session"), function () { practicePage(); });
          C.$("#p-session").scrollIntoView({ behavior: "smooth" });
        });
      });
    });
  }

  function renderSets(m) {
    var sets = store.load().sets;
    if (!sets.length) {
      return '<p class="muted fine">Build a custom set from the filters above: pick your filters, then save them as a set.</p>' +
        '<button class="btn sm" id="p-save-set" style="margin-top:8px">Save current filters as a set</button>';
    }
    var html = sets.map(function (set, i) {
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">' +
        "<span style='flex:1'>" + C.escapeHtml(set.name) + ' <span class="fine muted">(' + set.qids.length + " questions)</span></span>" +
        '<button class="btn sm" data-practise-set="' + i + '">Practise</button>' +
        '<button class="btn ghost sm" data-delete-set="' + i + '" aria-label="Delete set">✕</button></div>';
    }).join("");
    return '<p class="fine muted">Your saved sets (device-local):</p>' + html;
  }

  function bindSetActions(app, m) {
    var saveBtn = C.$("#p-save-set", app);
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        var name = prompt("Name this set:", "Calculus focus");
        if (!name) return;
        var filters = {
          course: C.$("#p-course") ? C.$("#p-course").value || null : null,
          topic: C.$("#p-topic") ? C.$("#p-topic").value || null : null,
        };
        root.QB.practice.buildSet(filters, 200, "random", m).then(function (built) {
          store.createSet(name, built.qids, filters);
          C.toast("Set saved");
          C.$("#p-sets").innerHTML = renderSets(m);
          bindSetActions(app, m);
        });
      });
    }
    C.$$("[data-practise-set]", app).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var set = store.load().sets[parseInt(btn.dataset.practiseSet, 10)];
        if (!set) return;
        api.records(set.qids).then(function (recs) {
          var s = root.QB.practice.startSession({ qids: set.qids, records: recs, name: set.name, mode: "set" });
          C.$("#p-session").innerHTML = "";
          root.QB.practice.renderSession(C.$("#p-session"), function () { practicePage(); });
          C.$("#p-session").scrollIntoView({ behavior: "smooth" });
        });
      });
    });
    C.$$("[data-delete-set]", app).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var sets = store.load().sets;
        store.deleteSet(sets[parseInt(btn.dataset.deleteSet, 10)].id);
        C.$("#p-sets").innerHTML = renderSets(m);
        bindSetActions(app, m);
      });
    });
  }

  /* ================================================================== saved */
  function savedPage() {
    var app = C.$("#app");
    C.setPageMeta("Saved — 99.95squad", "");
    var st = store.load();
    app.innerHTML =
      "<h1 class='page-title'>Saved questions</h1>" +
      '<div class="tabs"><a href="#/saved" class="active">Favourites</a><a href="#/saved?tab=sets">Sets</a></div>' +
      '<div id="saved-body">' + C.spinner() + "</div>";

    var tab = qs().get("tab");
    C.$$(".tabs a").forEach(function (a) { a.classList.toggle("active", (tab === "sets") === a.href.includes("sets")); });

    if (tab === "sets") {
      var body = C.$("#saved-body");
      withMeta(function (m) {
        body.innerHTML = '<div id="saved-sets">' + renderSets(m) + "</div>";
        bindSetActions(body, m);
      });
      return;
    }
    if (!st.favourites.length) {
      C.$("#saved-body").innerHTML = C.renderEmpty({
        icon: "☆", title: "No saved questions yet",
        body: "Save questions while browsing to build a revision shortlist.",
        action: '<a class="btn" href="#/browse">Browse questions</a>',
      });
      return;
    }
    api.records(st.favourites).then(function (recMap) {
      var bodyEl = C.$("#saved-body");
      if (!C.alive(bodyEl)) return;
      var recs = st.favourites.map(function (id) { return recMap[id]; }).filter(Boolean);
      if (!recs.length) {
        bodyEl.innerHTML = C.renderEmpty({ title: "No saved questions found", body: "Some saved questions may no longer be in the published set." });
        return;
      }
      bodyEl.innerHTML =
        '<div class="actions" style="margin-bottom:14px">' +
        '<button class="btn" id="s-practise-all">Practise all (' + recs.length + ")</button></div>" +
        '<div id="s-session"></div>' +
        recs.map(function (r) { return renderQCard(r, { thumb: true }); }).join("");
      bindFavButtons(bodyEl);
      C.$("#s-practise-all").addEventListener("click", function () {
        var sessEl = C.$("#s-session");
        sessEl.innerHTML = "";
        sessEl.scrollIntoView({ behavior: "smooth" });
        var s = root.QB.practice.startSession({ qids: recs.map(function (r) { return r.id; }), records: recMap, name: "Saved questions", mode: "favourites" });
        root.QB.practice.renderSession(sessEl, function () { savedPage(); });
      });
    });
  }

  /* ================================================================ progress */
  function progressPage() {
    var app = C.$("#app");
    C.setPageMeta("Progress — 99.95squad", "");
    var stats = store.analytics();
    var st = store.load();

    app.innerHTML =
      "<h1 class='page-title'>Progress</h1>" +
      '<p class="page-sub">Your practice analytics, stored on this device' +
      (auth.provider() === "supabase" ? " and your account" : "") + ".</p>" +
      '<div class="grid cols-4">' +
      '<div class="statcard"><div class="label">Attempted</div><div class="value">' + stats.total + "</div></div>" +
      '<div class="statcard"><div class="label">Accuracy</div><div class="value">' + stats.accuracy + "%</div></div>" +
      '<div class="statcard"><div class="label">Streak</div><div class="value">' + stats.streak + " days</div></div>" +
      '<div class="statcard"><div class="label">Practice time</div><div class="value">' + C.fmtTime(stats.seconds) + "</div></div>" +
      "</div>" +
      '<div class="grid cols-2" style="margin-top:18px">' +
      '<div class="card"><h3>Activity — last 14 days</h3><div id="pr-activity">' + C.svgBars(stats.activity, { aria: "Questions attempted per day" }) + "</div></div>" +
      '<div class="card"><h3>Accuracy by topic</h3><div id="pr-topics"></div></div>' +
      "</div>" +
      '<div class="grid cols-2" style="margin-top:18px">' +
      '<div class="card"><h3>Weak topics</h3><div id="pr-weak"></div></div>' +
      '<div class="card"><h3>Recent activity</h3><div id="pr-recent"></div></div>' +
      "</div>";

    // topics
    var topicsEl = C.$("#pr-topics");
    if (!stats.topicStats.length) {
      topicsEl.innerHTML = '<p class="muted fine">Attempt some questions to see topic accuracy.</p>';
    } else {
      var topicRows = stats.topicStats.slice(0, 8).map(function (t) {
        var name = api.topicName(t.topic_id) || C.titleCase(String(t.topic_id).split(":").pop());
        return { label: name, value: t.accuracy + "%", pct: t.accuracy, color: t.accuracy >= 70 ? "#167a4c" : t.accuracy >= 40 ? "#a8540f" : "#c23b3b" };
      });
      topicsEl.innerHTML = C.svgBarsH(topicRows, { max: 100, aria: "Accuracy by topic" });
    }

    // weak
    var weakEl = C.$("#pr-weak");
    if (!stats.weak.length) {
      weakEl.innerHTML = '<p class="muted fine">No weak topics yet — keep practising! (A topic appears here once you have answered at least 3 questions with under 70% accuracy.)</p>';
    } else {
      weakEl.innerHTML = "<ul style='margin:0 0 12px;padding-left:18px'>" +
        stats.weak.map(function (t) {
          return "<li>" + C.escapeHtml(api.topicName(t.topic_id) || t.topic_id) + " — " + t.accuracy + "% (" + t.n + " attempts)</li>";
        }).join("") + "</ul>" +
        '<a class="btn sm" href="#/practice?source=weak">Practise weak topics</a>';
    }

    // recent
    var recentEl = C.$("#pr-recent");
    if (!st.history.length) {
      recentEl.innerHTML = '<p class="muted fine">Your practice history will appear here.</p>';
    } else {
      var recent = st.history.slice(-12).reverse();
      api.records(recent.map(function (h) { return h.qid; })).then(function (recs) {
        if (!C.alive(recentEl)) return;
        recentEl.innerHTML = recent.map(function (h) {
          var r = recs[h.qid];
          var label = r ? "Q" + r.qnum + " · " + (r.paper_name || "") : h.qid;
          return '<p style="margin:6px 0;font-size:13.5px">' +
            '<span class="pill ' + (h.correct ? "approved" : "rejected") + '" style="margin-right:6px">' + (h.correct ? "✓" : "✗") + "</span>" +
            (r ? '<a href="' + questionLink(r) + '">' + C.escapeHtml(label) + "</a>" : C.escapeHtml(label)) +
            '<span class="fine muted" style="float:right">' + C.fmtDate(h.ts) + "</span></p>";
        }).join("");
      });
    }
  }

  /* ================================================================ profile */
  function profilePage() {
    var app = C.$("#app");
    C.setPageMeta("Profile — 99.95squad", "");
    var user = auth.currentUser();
    var ent = auth.entitlement();
    var provider = auth.provider();

    app.innerHTML =
      "<h1 class='page-title'>Profile & settings</h1>" +
      '<div class="grid cols-2">' +
      '<div class="card"><h3>Account</h3>' +
      (user
        ? "<p><strong>" + C.escapeHtml(user.name || "Student") + "</strong><br><span class='muted'>" + C.escapeHtml(user.email || "") + "</span></p>"
        : '<p class="muted">Not signed in.</p>') +
      '<p>' + badgePill(ent.isPremium ? "approved" : "pending") + " <strong>" + C.escapeHtml(C.titleCase(ent.tier || "free")) + "</strong>" +
      (ent.premium_until ? " · until " + C.fmtDate(ent.premium_until) : "") + "</p>" +
      (provider === "local"
        ? '<div class="notice">Device-local mode: your profile and progress live in this browser only. ' +
          "Connect Supabase (set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in <code>config.js</code>) for real accounts — see docs/AUTH.md.</div>"
        : '<div class="notice ok">Connected to Supabase. Account and profile sync through the backend.</div>') +
      '<div class="actions">' +
      (user ? '<button class="btn ghost" id="pr-signout">Sign out</button>' : '<a class="btn" href="#/login">Sign in</a>') +
      '<a class="btn ghost" href="#/upload">Contribute a paper</a></div></div>' +
      '<div class="card"><h3>Your contributions</h3><div id="pr-subs"><div class="skeleton" style="height:60px"></div></div></div>' +
      '<div class="card"><h3>Study setup</h3>' +
      '<div class="form-row"><label for="pf-goal">Daily goal (questions per day)</label>' +
      '<input type="number" id="pf-goal" min="1" max="100" value="' + (store.load().profile.goal || 10) + '"></div>' +
      '<div class="form-row"><label for="pf-year">Year level</label><select id="pf-year">' +
      '<option value="">Not set</option><option value="11">Year 11</option><option value="12">Year 12</option></select></div>' +
      '<div class="form-row"><label>Courses</label><div id="pf-courses"></div></div>' +
      '<button class="btn sm" id="pf-save">Save study setup</button></div>' +
      '<div class="card"><h3>Data</h3><p class="muted fine">Your practice history, favourites and sets are stored locally. Export them any time.</p>' +
      '<div class="actions"><button class="btn ghost sm" id="pr-export">Export data (JSON)</button>' +
      '<button class="btn ghost sm danger" id="pr-clear">Clear local data</button></div>' +
      '<input type="file" id="pr-import" accept="application/json" hidden>' +
      '<button class="btn ghost sm" id="pr-import-btn" style="margin-top:8px">Import data</button></div>' +
      "</div>";

    auth.listSubmissions().then(function (subs) {
      var el = C.$("#pr-subs");
      if (!C.alive(el)) return;
      if (!subs || !subs.length) {
        el.innerHTML = '<p class="muted fine">No contributions yet. Upload a paper to earn ' +
          (root.QB_CONFIG.free || {}).premiumGiftDays + " days of premium access after approval.</p>";
        return;
      }
      el.innerHTML = subs.map(function (s) {
        return '<p style="margin:6px 0;font-size:13.5px">' + C.escapeHtml(s.filename || s.name || s.id) +
          " " + badgePill(s.status) + "</p>";
      }).join("");
    });

    var outBtn = C.$("#pr-signout");
    if (outBtn) outBtn.addEventListener("click", function () {
      auth.signOut().then(function () { C.toast("Signed out"); profilePage(); });
    });
    C.$("#pr-export").addEventListener("click", function () {
      var blob = new Blob([store.exportJSON()], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "99.95squad-data.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });
    C.$("#pr-import-btn").addEventListener("click", function () { C.$("#pr-import").click(); });
    C.$("#pr-import").addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try { store.importJSON(reader.result); C.toast("Data imported"); profilePage(); }
        catch (err) { C.toast("Invalid data file: " + err.message, "error"); }
      };
      reader.readAsText(file);
    });
    C.$("#pr-clear").addEventListener("click", function () {
      if (!confirm("Clear all local progress, favourites and sets? This cannot be undone.")) return;
      store.reset();
      C.toast("Local data cleared");
      profilePage();
    });

    // study setup
    var prof = store.load().profile || {};
    var yearSel = C.$("#pf-year");
    if (yearSel) {
      yearSel.value = prof.yearLevel ? String(prof.yearLevel) : "";
      withMeta(function (m) {
        var pc = C.$("#pf-courses");
        if (!C.alive(pc)) return;
        pc.innerHTML = '<div class="chiprow">' + m.courses
          .filter(function (c) { return c.n > 0; })
          .map(function (c) {
            return '<label class="chip" style="cursor:pointer"><input type="checkbox" value="' + C.escapeHtml(c.id) +
              '" style="width:auto;margin-right:6px">' + C.escapeHtml(c.name) + "</label>";
          }).join("") + "</div>";
        (prof.courses || []).forEach(function (id) {
          var box = pc.querySelector('input[value="' + id + '"]');
          if (box) box.checked = true;
        });
        var saveBtn = C.$("#pf-save");
        saveBtn.addEventListener("click", function () {
          var s = store.load();
          var courses = [];
          C.$$("#pf-courses input:checked").forEach(function (b) { courses.push(b.value); });
          s.profile = Object.assign({}, s.profile, {
            goal: Math.max(1, parseInt(C.$("#pf-goal").value, 10) || 10),
            yearLevel: yearSel.value ? parseInt(yearSel.value, 10) : null,
            courses: courses,
            onboarded: true,
          });
          store.save();
          C.toast("Study setup saved");
        });
      });
    }
  }

  /* ================================================================== upload */
  function sha256Hex(buffer) {
    if (!(window.crypto && window.crypto.subtle)) {
      return Promise.reject(new Error("secure hashing is unavailable (open this site over https)"));
    }
    return crypto.subtle.digest("SHA-256", buffer).then(function (digest) {
      return Array.prototype.map.call(new Uint8Array(digest), function (b) {
        return ("0" + b.toString(16)).slice(-2);
      }).join("");
    });
  }

  function uploadPage() {
    var app = C.$("#app");
    C.setPageMeta("Contribute a paper — 99.95squad", "");
    var up = (root.QB_CONFIG.upload) || {};
    var maxMB = Math.round((up.maxBytes || 25 * 1024 * 1024) / (1024 * 1024));
    app.innerHTML =
      "<h1 class='page-title'>Contribute a paper</h1>" +
      '<div class="grid cols-2">' +
      '<div class="card"><h3>Share a trial or exam paper</h3>' +
      '<p class="muted" style="font-size:14px">Got a trial paper, past paper or assessment task that isn\u2019t in the bank yet? Upload it. ' +
      "Approved, unique papers earn you <strong>" + (root.QB_CONFIG.free || {}).premiumGiftDays + " days of premium access</strong>.</p>" +
      '<ol class="step-list" style="margin-top:16px">' +
      "<li>Upload your PDF — it is hashed locally and checked against the library.</li>" +
      "<li>New papers are queued for moderation — nothing goes public automatically.</li>" +
      "<li>Once approved, the paper is processed and questions are published.</li>" +
      "<li>You receive " + (root.QB_CONFIG.free || {}).premiumGiftDays + " days of premium access as a thank-you.</li></ol>" +
      '<div class="dropzone" id="dz" tabindex="0" role="button" aria-label="Choose a PDF to upload">' +
      '<div class="icon" aria-hidden="true">📄</div>' +
      '<p><strong>Drop your PDF here</strong> or click to choose</p>' +
      '<p class="fine muted">PDF only · max ' + maxMB + ' MB · hashed locally · moderated before publishing</p>' +
      '<input type="file" id="dz-file" accept="application/pdf"></div>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;margin-top:14px;font-weight:500">' +
      '<input type="checkbox" id="dz-ack" style="width:auto;margin-top:3px"> ' +
      '<span>I confirm I am authorised to share this paper (I own it, or the school/author has permitted it), and I accept it will be published openly after approval.</span></label>' +
      '<div id="dz-result" style="margin-top:10px"></div></div>' +
      '<div class="card"><h3>Upload status</h3><div id="up-list"><div class="skeleton" style="height:60px"></div></div>' +
      '<div id="up-quota" class="notice" style="margin-top:12px"></div>' +
      "<h3 style='margin-top:20px'>Why contribute?</h3>" +
      "<p class='muted' style='font-size:14px'>Your school's trials and assessments are exactly what other students need. " +
      "Every approved paper grows the bank for everyone — and credits you with premium access.</p></div>" +
      "</div>";

    var dz = C.$("#dz");
    var fileInput = C.$("#dz-file");
    function handleFile(file) {
      if (!file) return;
      var resultEl = C.$("#dz-result");
      if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
        resultEl.innerHTML = '<div class="error-banner">Please choose a PDF file.</div>';
        return;
      }
      if ((up.maxBytes || 0) && file.size > up.maxBytes) {
        resultEl.innerHTML = '<div class="error-banner">This file is ' +
          Math.round(file.size / 1048576) + " MB — the limit is " + maxMB +
          " MB per file.</div>";
        return;
      }
      if (up.requireCopyrightAck && !C.$("#dz-ack").checked) {
        resultEl.innerHTML = '<div class="error-banner">Please confirm you are authorised to share this paper first.</div>';
        return;
      }
      resultEl.innerHTML = '<div class="notice">Checking <strong>' + C.escapeHtml(file.name) + "</strong>…</div>";
      file.arrayBuffer().then(function (buf) {
        // magic-byte check: PDFs start with %PDF-
        var head = String.fromCharCode.apply(null, new Uint8Array(buf.slice(0, 5)));
        if (head !== "%PDF-") {
          resultEl.innerHTML = '<div class="error-banner">That file does not look like a PDF (magic bytes " + C.escapeHtml(head) + "). Please upload a real PDF.</div>';
          return null;
        }
        return sha256Hex(buf).then(function (hash) { return { hash: hash, size: buf.byteLength }; });
      }).then(function (info) {
        if (!info) return;
        return api.knownHashes().then(function (known) {
          var existing = known[info.hash];
          if (existing) {
            resultEl.innerHTML =
              '<div class="notice warn">This paper is already in the library — <strong>' + C.escapeHtml(existing.name) +
              "</strong>. No need to upload it again (nice find though!).</div>";
            return;
          }
          var sub = {
            filename: file.name, name: file.name, sha256: info.hash,
            size_bytes: info.size, status: "pending", note: "Pending review",
          };
          return auth.addSubmission(sub).then(function (res) {
            var statusText = res.remote
              ? "Submission received and queued for moderation."
              : "Submission saved on this device. Connect a backend (docs/AUTH.md) to submit it to the moderation queue.";
            resultEl.innerHTML =
              '<div class="notice ok"><strong>Queued for review.</strong><br>' + C.escapeHtml(statusText) +
              '<br><span class="fine">Submission: ' + C.escapeHtml(res.id) + "</span></div>";
            C.$("#up-list").innerHTML = "";
            renderSubmissions(C.$("#up-list"));
            C.toast("Paper queued — thanks for contributing!");
          });
        });
      }).catch(function (err) {
        resultEl.innerHTML = '<div class="error-banner">Could not read file: ' + C.escapeHtml(err.message) + "</div>";
      });
    }
    dz.addEventListener("click", function () { fileInput.click(); });
    dz.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
    dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", function () { dz.classList.remove("drag"); });
    dz.addEventListener("drop", function (e) { e.preventDefault(); dz.classList.remove("drag"); handleFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener("change", function () { handleFile(fileInput.files[0]); fileInput.value = ""; });

    function renderSubmissions(el) {
      auth.listSubmissions().then(function (subs) {
        if (!C.alive(el)) return;
        if (!subs || !subs.length) {
          el.innerHTML = '<p class="muted fine">Nothing here yet — your uploads will show their status.</p>';
          return;
        }
        el.innerHTML = subs.map(function (s) {
          return '<p style="margin:8px 0;font-size:13.5px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">' +
            "<span>" + C.escapeHtml(s.filename || s.name || s.id) + "</span>" + badgePill(s.status) + "</p>";
        }).join("");
      });
    }
    // quota display
    auth.listSubmissions().then(function (subs) {
      var quotaEl = C.$("#up-quota");
      if (!C.alive(quotaEl)) return;
      var pending = (subs || []).filter(function (s) { return s.status === "pending" || s.status === "processing"; }).length;
      var max = up.maxPending || 10;
      quotaEl.innerHTML = "Pending submissions: <strong>" + pending + " / " + max + "</strong>" +
        (pending >= max ? ' <span class="fine">(limit reached — wait for moderation)</span>' : "");
    });
    renderSubmissions(C.$("#up-list"));
  }

  /* =================================================================== admin */
  function adminPage() {
    var app = C.$("#app");
    C.setPageMeta("Moderation — 99.95squad", "");
    var ent = auth.entitlement();
    app.innerHTML =
      "<h1 class='page-title'>Moderation queue</h1>" +
      '<p class="page-sub">Review contributed papers. Nothing uploaded becomes public before approval.</p>' +
      (auth.provider() === "local"
        ? '<div class="notice">Device-local mode — you are managing submissions stored in this browser. ' +
          "With a backend, moderators approve real submissions and the pipeline processes them (" +
          "<code>python -m pipeline uploads approve &lt;id&gt;</code>). See docs/AUTH.md.</div>"
        : "") +
      '<div class="card"><h3>Uploaded papers</h3><div id="ad-list">' + C.spinner() + "</div></div>" +
      '<div class="card"><h3>Problem reports</h3><div id="ad-reports"></div></div>';

    var statusFilter = { value: "" };
    auth.listSubmissions().then(function (subs) {
      var el = C.$("#ad-list");
      if (!subs || !subs.length) {
        el.innerHTML = C.renderEmpty({ title: "No submissions", body: "Student uploads will appear here for review." });
        return;
      }
      el.innerHTML =
        '<label class="fine">Filter: <select id="ad-filter" style="width:auto;margin-left:6px">' +
        '<option value="">All statuses</option>' +
        ['pending', 'processing', 'approved', 'rejected', 'duplicate', 'needs_review'].map(function (s) {
          return '<option value="' + s + '">' + C.titleCase(s) + "</option>";
        }).join("") + "</select></label>" +
        '<div id="ad-rows"></div>';
      var rowsEl = C.$("#ad-rows");
      function renderRows() {
        var list = subs.filter(function (s) { return !statusFilter.value || s.status === statusFilter.value; });
        rowsEl.innerHTML = list.length
          ? '<table class="table"><thead><tr><th>File</th><th>Uploader</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
            list.map(function (s) {
              return "<tr>" +
                "<td>" + C.escapeHtml(s.filename || s.name || s.id) + '<br><span class="fine muted">' + C.escapeHtml(s.id) + "</span></td>" +
                "<td>" + C.escapeHtml(s.uploader || "—") + "</td>" +
                "<td>" + badgePill(s.status) + "</td>" +
                "<td><div class='actions'>" +
                '<button class="btn sm ok" data-act="approve" data-id="' + C.escapeHtml(s.id) + '">Approve</button>' +
                '<button class="btn sm" data-act="duplicate" data-id="' + C.escapeHtml(s.id) + '">Duplicate</button>' +
                '<button class="btn sm ghost" data-act="needs_review" data-id="' + C.escapeHtml(s.id) + '">Needs review</button>' +
                '<button class="btn sm danger" data-act="reject" data-id="' + C.escapeHtml(s.id) + '">Reject</button>' +
                "</div></td></tr>";
            }).join("") + "</tbody></table>"
          : '<p class="muted fine">No submissions with this status.</p>';
        C.$$("[data-act]", rowsEl).forEach(function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.dataset.id, act = btn.dataset.act;
            auth.updateSubmission(id, { status: act }).then(function () {
              C.toast("Marked " + act);
              auth.listSubmissions().then(function (newSubs) { subs = newSubs; renderRows(); });
            });
          });
        });
      }
      C.$("#ad-filter").addEventListener("change", function () { statusFilter.value = C.$("#ad-filter").value; renderRows(); });
      renderRows();
    });

    var reports = store.load().reports;
    C.$("#ad-reports").innerHTML = reports.length
      ? reports.map(function (r) {
          return '<p style="margin:6px 0;font-size:13.5px"><strong>' + C.escapeHtml(r.reason) + "</strong> · " +
            C.escapeHtml(r.qid || "general") + ' <span class="fine muted">' + C.fmtDate(r.at) + "</span><br>" +
            C.escapeHtml(r.details || "") + "</p>";
        }).join("")
      : '<p class="muted fine">No problem reports yet.</p>';
  }

  /* ================================================================== report */
  function reportPage(qid) {
    var app = C.$("#app");
    C.setPageMeta("Report a problem — 99.95squad", "");
    app.innerHTML =
      '<div style="max-width:560px;margin:24px auto">' +
      '<div class="card"><h2>Report a problem</h2>' +
      (qid ? '<p class="muted">Question: <code>' + C.escapeHtml(qid) + "</code></p>" : "") +
      '<div class="form-row"><label for="r-reason">What\u2019s wrong?</label><select id="r-reason">' +
      '<option value="wrong-question">The question is cut off / cropped badly</option>' +
      '<option value="wrong-metadata">Wrong subject, topic or difficulty</option>' +
      '<option value="wrong-answer">The answer is wrong</option>' +
      '<option value="duplicate">Duplicate question</option>' +
      '<option value="copyright">Copyright concern</option>' +
      '<option value="other">Something else</option></select></div>' +
      '<div class="form-row"><label for="r-details">Details (optional)</label><textarea id="r-details" placeholder="Tell us what\u2019s wrong…"></textarea></div>' +
      '<button class="btn" id="r-submit">Send report</button></div></div>';
    C.$("#r-submit").addEventListener("click", function () {
      var reason = C.$("#r-reason").value;
      var details = C.$("#r-details").value.trim();
      auth.addReport({ qid: qid || null, reason: reason, details: details }).then(function () {
        C.toast("Thanks — the team will review this.");
        location.hash = qid ? "#/question/" + encodeURIComponent(qid) : "#/";
      });
    });
  }

  /* ============================================================== onboarding */
  function onboardingPage() {
    var app = C.$("#app");
    C.setPageMeta("Set up your account — 99.95squad", "");
    var profile = store.load().profile || {};
    if (profile.onboarded) { location.hash = "#/dashboard"; return; }

    app.innerHTML =
      '<div style="max-width:560px;margin:26px auto">' +
      '<div class="card"><h2>Welcome — let\u2019s set you up</h2>' +
      '<p class="muted" style="font-size:14px">Tell us what you\u2019re studying so your dashboard and recommendations fit you. You can change this any time in Settings.</p>' +
      '<div class="form-row"><label for="o-year">Year level</label>' +
      '<select id="o-year"><option value="">Select…</option><option value="11">Year 11</option><option value="12" selected>Year 12</option></select></div>' +
      '<div class="form-row"><label>Courses you study</label><div id="o-courses" class="chiprow"></div></div>' +
      '<div class="form-row"><label for="o-goal">Daily goal (questions per day)</label>' +
      '<input type="number" id="o-goal" min="1" max="100" value="' + (profile.goal || 10) + '"></div>' +
      '<div class="form-row"><label for="o-name">Name (optional)</label>' +
      '<input type="text" id="o-name" placeholder="Your name" value="' + C.escapeHtml(profile.name || "") + '"></div>' +
      '<button class="btn block" id="o-save">Save and continue</button></div></div>';

    withMeta(function (m) {
      var coursesEl = C.$("#o-courses");
      coursesEl.innerHTML = m.courses
        .filter(function (c) { return c.n > 0; })
        .map(function (c) {
          return '<label class="chip" style="cursor:pointer"><input type="checkbox" value="' + C.escapeHtml(c.id) +
            '" style="width:auto;margin-right:6px">' + C.escapeHtml(c.name) + "</label>";
        }).join("");
      var saved = profile.courses || [];
      C.$$("#o-courses input").forEach(function (box) {
        if (saved.indexOf(box.value) !== -1) box.checked = true;
      });

      C.$("#o-save").addEventListener("click", function () {
        var courses = [];
        C.$$("#o-courses input:checked").forEach(function (box) { courses.push(box.value); });
        var s = store.load();
        s.profile = {
          name: C.$("#o-name").value.trim() || s.profile.name || "",
          goal: Math.max(1, parseInt(C.$("#o-goal").value, 10) || 10),
          yearLevel: C.$("#o-year").value ? parseInt(C.$("#o-year").value, 10) : null,
          courses: courses,
          onboarded: true,
        };
        store.save();
        C.toast("All set — good luck!");
        location.hash = "#/dashboard";
      });
    });
  }

  /* ---------------------------------------------------------------- exposed */
  root.QB = root.QB || {};
  root.QB.pages = {
    landing: landingPage, auth: authPage, dashboard: dashboardPage,
    browse: browsePage, question: questionPage, practice: practicePage,
    saved: savedPage, progress: progressPage, profile: profilePage,
    upload: uploadPage, admin: adminPage, report: reportPage,
    onboarding: onboardingPage,
    syllabus: syllabusPage, leaderboard: leaderboardPage, analytics: analyticsPage,
    renderQCard: renderQCard, bindFavButtons: bindFavButtons,
  };
})();
