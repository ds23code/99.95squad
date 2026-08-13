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
      needs_changes: ["needs_changes", "Needs changes"],
    };
    var p = map[status] || ["pending", status];
    return '<span class="pill ' + p[0] + '">' + p[1] + "</span>";
  }

  /* ================================================================ landing */
  /* Typography-first dark editorial single page — one uninterrupted
   * narrative: TRAIN → MEASURE → IMPROVE → 99.95.
   * Display type Bricolage Grotesque, 99.95 motif in Instrument Serif italic,
   * labels IBM Plex Mono, body Schibsted Grotesk. Orange is the signal
   * colour. Styling lives in assets/css/app.css under `.landing`. */
  function lpKicker(n, label) {
    return '<p class="lp-kicker"><span class="lp-index">' + n + "</span><span>" + C.escapeHtml(label) + "</span></p>";
  }

  function landingPage() {
    var app = C.$("#app");
    C.setPageMeta("99.95squad — Train for the 99.95",
      "Built for the top 0.05%. Thousands of real HSC questions, exam-grade timing and precision analytics — one training system.");
    app.innerHTML = C.spinner("Loading…");
    api.manifest().then(function (m) {
      var counts = m.counts || {};
      if (!C.alive(app)) return;
      app.innerHTML =
        '<div class="landing">' +

        /* ---------------------------------------------------------- hero */
        '<section class="hero lp-section lp-hero" aria-labelledby="lp-h1">' +
        '<div class="lp-hero-grid">' +
        '<div class="lp-hero-main">' +
        '<p class="lp-kicker lp-hero-item" style="transition-delay:.05s"><span class="lp-index">99.95 SQUAD</span><span>Academic performance</span></p>' +
        '<h1 id="lp-h1" class="lp-display lp-hero-item" style="transition-delay:.12s">TRAIN FOR<br>THE <em class="lp-serif">99.95.</em></h1>' +
        '<p class="lp-sub lp-hero-item" style="transition-delay:.2s">Built for the top 0.05%. <b>Thousands of real HSC questions</b>, ' +
        "exam-grade timing and precision analytics \u2014 one training system.</p>" +
        '<div class="lp-cta lp-hero-item" style="transition-delay:.28s">' +
        '<a class="btn lp-btn-primary" href="#/signup">Start Training →</a>' +
        '<a class="btn lp-btn-ghost" href="#/browse">Browse the bank</a>' +
        "</div></div>" +
        '<div class="lp-hero-mark lp-hero-item" style="transition-delay:.2s" aria-hidden="true">99.95</div>' +
        "</div>" +
        '<div class="hero-stats lp-stats lp-hero-item" style="transition-delay:.36s">' +
        '<div class="lp-stat"><div class="stat-num">' + (counts.questions || 0) + "</div><div class='stat-label'>Questions</div></div>" +
        '<div class="lp-stat"><div class="stat-num">' + (counts.papers || 0) + "</div><div class='stat-label'>Papers</div></div>" +
        '<div class="lp-stat"><div class="stat-num">' + (counts.topics || 0) + "</div><div class='stat-label'>Topics</div></div>" +
        '<div class="lp-stat"><div class="stat-num"><span class="lp-serif">100%</span></div><div class="stat-label">Image-faithful</div></div>' +
        "</div>" +
        (m.source === "sample"
          ? '<p class="fine lp-sample-note">Preview build — sample question set. Publish your own export with <code>python -m pipeline export-static</code>.</p>'
          : "") +
        "</section>" +

        /* --------------------------------------------------- chapter strip */
        '<nav class="lp-chapters" aria-label="Landing sections">' +
        '<button class="lp-chapter" type="button" data-scroll="practice"><i>01</i> Practice</button>' +
        '<button class="lp-chapter" type="button" data-scroll="measure"><i>02</i> Measure</button>' +
        '<button class="lp-chapter" type="button" data-scroll="improve"><i>03</i> Improve</button>' +
        "</nav>" +

        /* -------------------------------------------------- 01 — practice */
        '<section class="lp-section lp-practice" id="practice" aria-labelledby="lp-h2">' +
        '<span class="lp-section-num" aria-hidden="true">01</span>' +
        '<div class="lp-cols">' +
        '<div class="lp-col-left">' +
        lpKicker("01", "Practice") +
        '<h2 id="lp-h2" class="lp-h2 lp-reveal">Make every question<br>count<span class="lp-serif">.</span></h2>' +
        '<p class="lp-body lp-reveal">Real papers, image-faithful questions, exam conditions. ' +
        "Answer, reveal, move on \u2014 the same loop you'll train with, right down to the timer.</p>" +
        '<p class="lp-body lp-reveal"><a class="lp-link" href="#/practice">Open practice mode →</a></p>' +
        "</div>" +
        '<div class="lp-col-right">' +
        '<div class="lp-panel lp-demo lp-reveal" id="lp-demo">' + C.spinner("Loading a question…") + "</div>" +
        '<p class="lp-demo-caption lp-reveal">Live demo — the real question bank · no sign-in required</p>' +
        "</div></div></section>" +

        /* --------------------------------------------------- 02 — measure */
        '<section class="lp-section lp-measure" id="measure" aria-labelledby="lp-h3">' +
        '<span class="lp-section-num" aria-hidden="true">02</span>' +
        '<div class="lp-cols lp-cols-flip">' +
        '<div class="lp-col-left">' +
        '<div class="lp-panel lp-reveal">' +
        '<div class="lp-measure-stats">' +
        '<div class="lp-measure-stat"><div class="label">XP</div><div class="value">1,240</div></div>' +
        '<div class="lp-measure-stat"><div class="label">Streak</div><div class="value hot">21 days</div></div>' +
        '<div class="lp-measure-stat"><div class="label">Accuracy</div><div class="value">74%</div></div>' +
        "</div>" +
        '<div class="lp-track" role="img" aria-label="Mastery path: unseen, learning, practising, strong, mastered">' +
        '<span class="lp-track-dot on"><i>Unseen</i></span><span class="lp-track-line"></span>' +
        '<span class="lp-track-dot on"><i>Learning</i></span><span class="lp-track-line"></span>' +
        '<span class="lp-track-dot on"><i>Practising</i></span><span class="lp-track-line"></span>' +
        '<span class="lp-track-dot"><i>Strong</i></span><span class="lp-track-line"></span>' +
        '<span class="lp-track-dot"><i>Mastered</i></span>' +
        "</div>" +
        '<div class="lp-report">' +
        '<div class="lp-report-row"><span class="lp-report-topic">Functions</span><span class="lp-report-bar"><i style="width:92%"></i></span><span class="lp-report-acc">92%</span><span class="lp-report-stage mastered">Mastered</span></div>' +
        '<div class="lp-report-row"><span class="lp-report-topic">Calculus</span><span class="lp-report-bar"><i style="width:71%"></i></span><span class="lp-report-acc">71%</span><span class="lp-report-stage">Strong</span></div>' +
        '<div class="lp-report-row"><span class="lp-report-topic">Trigonometry</span><span class="lp-report-bar"><i style="width:46%"></i></span><span class="lp-report-acc">46%</span><span class="lp-report-stage">Practising</span></div>' +
        '<div class="lp-report-row"><span class="lp-report-topic">Statistics</span><span class="lp-report-bar"><i style="width:12%"></i></span><span class="lp-report-acc">—</span><span class="lp-report-stage">Unseen</span></div>' +
        "</div></div>" +
        '<p class="lp-fig-note lp-reveal"><b>FIG. 02</b> Accuracy &amp; mastery, updated with every attempt</p>' +
        "</div>" +
        '<div class="lp-col-right">' +
        lpKicker("02", "Measure") +
        '<h2 id="lp-h3" class="lp-h2 lp-reveal">Know where<br>you stand<span class="lp-serif">.</span></h2>' +
        '<p class="lp-body lp-reveal">Every attempt is recorded server-side and turned into signal: streaks that keep you honest, ' +
        "accuracy per topic, and a mastery path from <i>unseen</i> to <i>mastered</i>.</p>" +
        '<p class="lp-body lp-reveal"><a class="lp-link" href="#/dashboard">Open your dashboard →</a></p>' +
        "</div></div></section>" +

        /* --------------------------------------------------- 03 — improve */
        '<section class="lp-section lp-improve" id="improve" aria-labelledby="lp-h4">' +
        '<span class="lp-section-num" aria-hidden="true">03</span>' +
        '<div class="lp-cols">' +
        '<div class="lp-col-left">' +
        lpKicker("03", "Improve") +
        '<h2 id="lp-h4" class="lp-h2 lp-reveal">Turn mistakes into<br>momentum<span class="lp-serif">.</span></h2>' +
        '<p class="lp-body lp-reveal">Weak topics are surfaced automatically and the next session is aimed straight at them. ' +
        "Mistakes stop being noise and start being a plan.</p>" +
        '<p class="lp-body lp-reveal"><a class="lp-link" href="#/practice?source=weak">Practise your weak topics →</a></p>' +
        "</div>" +
        '<div class="lp-col-right">' +
        '<div class="lp-weak lp-reveal">' +
        '<div class="lp-weak-head"><span>Weakest topic</span><span class="tag" id="lp-weak-tag">Auto-detected</span></div>' +
        '<div class="lp-weak-body">' +
        '<div class="lp-weak-topic" id="lp-weak-name">Trigonometry</div>' +
        '<div class="lp-weak-meta">' +
        "<span><b id='lp-weak-acc'>46%</b> accuracy</span><span><b>12</b> attempts</span><span><b>3 days</b> ago</span>" +
        "</div>" +
        '<a class="btn lp-btn-primary" id="lp-weak-cta" href="#/practice?source=weak">Start focused session →</a>' +
        '<div class="lp-flow"><span class="hot">Mistake</span><i></i><span>Diagnosed</span><i></i><span>Fixed</span></div>' +
        "</div></div>" +
        "</div></div></section>" +

        /* ------------------------------------------------- 04 — the bank */
        '<section class="lp-section lp-trust" id="trust" aria-labelledby="lp-h5">' +
        '<span class="lp-section-num" aria-hidden="true">04</span>' +
        '<div class="lp-cols">' +
        '<div class="lp-col-left">' +
        lpKicker("04", "The bank") +
        '<h2 id="lp-h5" class="lp-h2 lp-reveal">Human-reviewed.<br>Student-built<span class="lp-serif">.</span></h2>' +
        '<p class="lp-body lp-reveal">The best practice material is the paper your school just wrote. ' +
        "Students contribute; moderators review every upload before it is published.</p>" +
        '<form class="searchbar lp-search lp-reveal" id="lp-search" action="#/browse" method="get">' +
        '<input type="search" name="q" placeholder="Search the bank — try “integration”" aria-label="Search questions">' +
        '<button class="btn lp-btn-primary" type="submit">Search</button></form>' +
        "</div>" +
        '<div class="lp-col-right lp-rows">' +
        '<div class="lp-row lp-reveal"><span class="lp-row-index">01</span><div><b>Moderated</b>' +
        "<span>Every upload is reviewed before anything is published — nothing goes live automatically.</span></div></div>" +
        '<div class="lp-row lp-reveal"><span class="lp-row-index">02</span><div><b>Private</b>' +
        "<span>Your attempts and progress belong to you. Leaderboards show only what you opt into.</span></div></div>" +
        '<div class="lp-row lp-reveal"><span class="lp-row-index">03</span><div><b>Rewarded</b>' +
        "<span>Approved, unique papers earn the contributor " + (root.QB_CONFIG.free || {}).premiumGiftDays +
        " days of premium access.</span></div></div>" +
        '<p class="lp-body lp-reveal" style="margin-top:22px"><a class="lp-link" href="#/upload">Contribute a paper →</a></p>' +
        "</div></div></section>" +

        /* ------------------------------------------------------ 05 — start */
        '<section class="lp-section lp-final" id="start" aria-labelledby="lp-h6">' +
        lpKicker("05", "Start") +
        '<h2 id="lp-h6" class="lp-h2 lp-final-title lp-reveal">Your next question<br>is waiting<span class="lp-serif">.</span></h2>' +
        '<p class="lp-sub lp-reveal">Free to start. No card required. First session: five minutes.</p>' +
        '<div class="lp-cta lp-reveal">' +
        '<a class="btn lp-btn-primary" href="#/signup">Start Training →</a>' +
        '<a class="btn lp-btn-ghost" href="#/practice">Practise now</a>' +
        "</div>" +
        '<p class="lp-fine lp-reveal">Train → Measure → Improve → <span class="lp-serif">99.95</span></p>' +
        '<p class="lp-endpaper lp-reveal" aria-hidden="true">— End of paper —</p>' +
        "</section>" +
        "</div>";

      /* hero reveal on load (staggered) */
      C.$$(".lp-hero-item", app).forEach(function (el) { el.classList.add("in"); });

      /* scroll reveals */
      var io = null;
      if ("IntersectionObserver" in window) {
        io = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
          });
        }, { threshold: 0.12 });
        C.$$(".lp-reveal", app).forEach(function (el) { io.observe(el); });
      } else {
        C.$$(".lp-reveal", app).forEach(function (el) { el.classList.add("in"); });
      }

      /* in-page chapter navigation (scroll, not hash routes) */
      C.$$("[data-scroll]", app).forEach(function (btn) {
        btn.addEventListener("click", function () {
          var target = document.getElementById(btn.dataset.scroll);
          if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });

      /* bank search */
      var form = C.$("#lp-search");
      if (form) form.addEventListener("submit", function (e) {
        e.preventDefault();
        var q = form.querySelector("input").value.trim();
        location.hash = "#/browse" + (q ? "?q=" + encodeURIComponent(q) : "");
      });

      /* resolve the "weakest topic" card against the real bank */
      (function resolveWeak() {
        var nameEl = C.$("#lp-weak-name");
        var tagEl = C.$("#lp-weak-tag");
        var ctaEl = C.$("#lp-weak-cta");
        if (!nameEl) return;
        api.metaOnce().then(function (m) {
          var topics = (m.topics || []).filter(function (t) { return t.n > 0; });
          if (!topics.length) return;
          var t = topics.filter(function (x) { return /trig/i.test(x.name || ""); })[0] || topics[0];
          if (t && C.alive(nameEl)) {
            nameEl.textContent = t.name;
            if (ctaEl) ctaEl.href = "#/practice?topic=" + encodeURIComponent(t.id);
            if (tagEl) tagEl.textContent = "Auto-detected from your attempts";
          }
        }).catch(function () {});
      })();

      /* interactive question demo (real content, no backend writes) */
      lpQuestionDemo();
    }).catch(function () {
      app.innerHTML = C.renderEmpty({ title: "No question data found", body: "This site has no content yet. Run the pipeline and export static content, or build with the sample set." });
    });
  }

  /* ------------------------------------------------------ landing demo */
  var LP_LETTERS = ["A", "B", "C", "D", "E"];

  function lpPad(n) { return n < 10 ? "0" + n : String(n); }

  /* Collect real multiple-choice questions from the published content and
   * run a small interactive quiz inside the landing page. Mirrors the real
   * practice UI: options live in the printed question image; the letters are
   * the answer sheet. */
  function lpQuestionDemo() {
    var host = C.$("#lp-demo");
    if (!host) return;
    api.metaOnce().then(function (m) {
      var courses = (m.courses || []).filter(function (c) { return c.n > 0; });
      if (!courses.length) return;
      var chain = Promise.resolve([]);
      courses.slice(0, 6).forEach(function (c) {
        chain = chain.then(function (acc) {
          return api.courseRecords(c.id).then(function (recs) {
            return acc.concat(recs);
          }).catch(function () { return acc; });
        });
      });
      return chain.then(function (all) {
        var mcqs = all.filter(function (r) {
          return r.qtype === "multiple_choice" && r.answer && /^[A-E]$/i.test(String(r.answer).trim());
        });
        if (!mcqs.length) {
          if (C.alive(host)) host.innerHTML = '<div class="lp-demo-empty">No multiple-choice questions in this build yet — ' +
            "<a href='#/browse'>browse the bank instead</a>.</div>";
          return;
        }
        var pool = mcqs.slice();
        for (var i = pool.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }
        lpRunDemo(host, pool.slice(0, Math.min(4, pool.length)));
      });
    }).catch(function () { /* keep the spinner state silent */ });
  }

  function lpRunDemo(host, quiz) {
    var i = 0, score = 0, locked = false;
    var t0 = Date.now();
    var timerId = null;

    function fmt(secs) {
      var m = Math.floor(secs / 60), s = secs % 60;
      return lpPad(m) + ":" + lpPad(s);
    }
    function answerIndex(rec) {
      var a = String(rec.answer || "").trim().toUpperCase();
      var m = a.match(/^([A-E])/);
      return m ? m[1].charCodeAt(0) - 65 : -1;
    }
    function timerTick() {
      var el = C.$("#lp-demo-timer", host);
      if (!C.alive(host)) { if (timerId) clearInterval(timerId); return; }
      if (el) el.textContent = fmt(Math.round((Date.now() - t0) / 1000));
    }
    timerId = setInterval(timerTick, 1000);

    function render() {
      if (!C.alive(host)) { if (timerId) clearInterval(timerId); return; }
      if (i >= quiz.length) { result(); return; }
      var q = quiz[i];
      var courseName = api.courseName(q.course_id) || "HSC";
      var marks = q.marks ? " · " + q.marks + " MARKS" : "";
      var opts = (q.options && q.options.length
        ? q.options
        : [null, null, null, null]).map(function (o, idx) {
          var text = o && typeof o === "object" ? (o.text || o.label || "") : (o ? String(o) : "");
          if (!text) text = "Option " + LP_LETTERS[idx];
          return '<button class="lp-opt" type="button" data-idx="' + idx + '" aria-label="Option ' + LP_LETTERS[idx] + '">' +
            '<span class="lp-opt-letter">' + LP_LETTERS[idx] + "</span>" +
            '<span class="lp-opt-text">' + C.escapeHtml(text) + "</span></button>";
        }).join("");
      var imgSrc = C.pickImg(q, "image");
      host.innerHTML =
        '<div class="lp-panel-head">' +
        '<span>Question ' + lpPad(i + 1) + " / " + lpPad(quiz.length) + "</span>" +
        '<span>' + C.escapeHtml(String(courseName).toUpperCase()) + marks + "</span>" +
        '<span class="timer" id="lp-demo-timer">' + fmt(Math.round((Date.now() - t0) / 1000)) + "</span>" +
        "</div>" +
        '<div class="lp-panel-body">' +
        (imgSrc ? '<div class="lp-demo-fig"><img src="' + C.escapeHtml(imgSrc) +
          '" alt="Question ' + (i + 1) + ' from the bank, exactly as printed" loading="lazy"></div>' : "") +
        '<p class="fine" style="font-family:var(--lp-font-mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--lp-faint);margin:0 0 10px">' +
        "Select your answer — the options are printed in the question above.</p>" +
        '<div class="lp-demo-options" id="lp-demo-options">' + opts + "</div>" +
        '<div id="lp-demo-foot"></div>' +
        "</div>";
      C.$$(".lp-opt", host).forEach(function (btn) {
        btn.addEventListener("click", function () { answer(btn); });
      });
    }

    function answer(btn) {
      if (locked) return;
      locked = true;
      var q = quiz[i];
      var ansIdx = answerIndex(q);
      var idx = parseInt(btn.dataset.idx, 10);
      var correct = idx === ansIdx;
      if (correct) score++;
      C.$$(".lp-opt", host).forEach(function (b) {
        b.disabled = true;
        var bi = parseInt(b.dataset.idx, 10);
        if (bi === ansIdx) b.classList.add("right");
        else if (bi === idx) b.classList.add("wrong");
      });
      var foot = C.$("#lp-demo-foot");
      if (!foot) return;
      var fb = correct
        ? '<div class="lp-demo-fb ok" id="lp-demo-fb">Correct — keep going.</div>'
        : '<div class="lp-demo-fb bad" id="lp-demo-fb">Incorrect — the answer is ' + LP_LETTERS[Math.max(0, ansIdx)] + ".</div>";
      var last = i === quiz.length - 1;
      var next = '<button class="btn lp-btn-primary" type="button" id="lp-demo-next">' +
        (last ? "See your result →" : "Next question →") + "</button>";
      foot.innerHTML = fb + '<div class="lp-demo-next-wrap">' + next + "</div>";
      var nb = C.$("#lp-demo-next", host);
      if (nb) nb.addEventListener("click", function () { i++; locked = false; render(); });
    }

    function result() {
      if (timerId) clearInterval(timerId);
      if (!C.alive(host)) return;
      host.innerHTML =
        '<div class="lp-panel-head"><span>Session complete</span><span class="on">Practice</span></div>' +
        '<div class="lp-demo-result">' +
        '<div class="score"><span class="lp-serif">' + score + "</span> / " + quiz.length + "</div>" +
        "<p>Every attempt here feeds the same analytics as a real session.</p>" +
        '<div class="lp-cta" style="justify-content:center">' +
        '<a class="btn lp-btn-primary" href="#/practice">Start a real session →</a>' +
        '<a class="btn lp-btn-ghost" href="#/browse">Browse the bank</a>' +
        "</div></div>";
    }

    render();
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
        if (!isLogin || auth.needsOnboarding()) location.hash = "#/onboarding";
        else location.hash = "#/dashboard";
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

    if (!hasBackend || !user) { renderLocalFallback(app); return; }

    backend.getDashboard().then(function (d) {
      if (!C.alive(C.$("#dash-body"))) return;
      if (!d || !d.profile) {
        renderLocalFallback(app);
        return;
      }
      renderBackendDashboard(app, d);
    }).catch(function () {
      renderLocalFallback(app);
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
      "</div>" +
      '<div class="card" style="margin-top:16px"><h3>Learning Insights</h3><div id="dash-insights"></div></div>';

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
    renderLearningInsights(app.querySelector("#dash-insights"));
  }

  function stageBadge(stage) {
    return { unseen: "", learning: "type", practising: "diff", strong: "topic", mastered: "marks" }[stage] || "";
  }

  function recommendQuestions(el, mastery, prof) {
    var weakTopics = (mastery || []).filter(function (m) { return m.stage === "practising"; })
      .map(function (m) { return m.topic_id; });
    var scoped = store.applyContentScope({ courses: prof.courses && prof.courses.length ? prof.courses : null });
    api.metaOnce().then(function (m) {
      if (!C.alive(el)) return;
      var courses;
      if (scoped.courses && scoped.courses.length) courses = scoped.courses;
      else if (scoped.subjects && scoped.subjects.length) {
        courses = m.courses.filter(function (c) {
          return scoped.subjects.indexOf(c.subject_id) !== -1 && c.n > 0;
        }).map(function (c) { return c.id; });
      } else {
        courses = m.courses.filter(function (c) { return c.n > 0; }).map(function (c) { return c.id; });
      }
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
      "</div>" +
      '<div class="card" style="margin-top:16px"><h3>Learning Insights</h3><div id="dash-insights"></div></div>';
    var recentEl = C.$("#dash-recent");
    recentEl.innerHTML = st.recent.length
      ? st.recent.slice(0, 5).map(function (id) { return '<p class="fine"><a href="#/question/' + encodeURIComponent(id) + '">View question</a></p>'; }).join("")
      : '<p class="muted fine">Questions you open will appear here.</p>';
    renderLearningInsights(app.querySelector("#dash-insights"));
  }

  function renderLearningInsights(el) {
    if (!el || !C.alive(el)) return;
    var st = store.load();
    api.metaOnce().then(function (m) {
      if (!C.alive(el)) return;
      var allTopics = m.topics || [];
      var attemptedMap = {};
      st.history.forEach(function (h) {
        if (h.topic_id) {
          attemptedMap[h.topic_id] = attemptedMap[h.topic_id] || { n: 0, correct: 0 };
          attemptedMap[h.topic_id].n++;
          if (h.correct === true) attemptedMap[h.topic_id].correct++;
        }
      });
      var weakList = [];
      var strongList = [];
      var unpractisedList = [];
      allTopics.forEach(function (t) {
        if (!t.id) return;
        var stat = attemptedMap[t.id];
        if (!stat || stat.n === 0) {
          unpractisedList.push(t);
        } else {
          var acc = Math.round((stat.correct / stat.n) * 100);
          if (acc < 70) weakList.push({ t: t, acc: acc, n: stat.n });
          else if (acc >= 80 && stat.n >= 2) strongList.push({ t: t, acc: acc, n: stat.n });
        }
      });

      var recentMistakes = st.history.filter(function (h) { return h.correct === false; }).slice(-5).reverse();
      var recTopic = weakList.length ? weakList[0] : (unpractisedList.length ? { t: unpractisedList[0], acc: 0, n: 0 } : null);
      var recText = recTopic
        ? 'Practise <b>' + C.escapeHtml(recTopic.t.name) + '</b> (' +
          (recTopic.n > 0 ? 'accuracy ' + recTopic.acc + '% across ' + recTopic.n + ' attempts' : 'not yet practised') +
          ') — targeted focus builds mastery.'
        : 'Practise random questions across all topics to stay sharp.';

      el.innerHTML =
        '<div class="recommendation-box" style="margin-bottom:14px;padding:12px;background:var(--card-bg);border-left:4px solid var(--accent);border-radius:8px">' +
        '<b>Recommended practice:</b> ' + recText +
        (recTopic ? ' <a href="#/practice?topic=' + encodeURIComponent(recTopic.t.id) + '" class="btn sm" style="margin-left:8px">Start practice</a>' : '') +
        '</div>' +
        '<div class="grid cols-2">' +
        '<div><h4>Your weakest areas</h4>' +
        (weakList.length
          ? weakList.slice(0, 4).map(function (w) {
              return '<p class="fine" style="margin:4px 0"><a href="#/practice?topic=' + encodeURIComponent(w.t.id) + '">' +
                C.escapeHtml(w.t.name) + '</a> <span class="muted">(' + w.acc + '% acc across ' + w.n + ' attempts)</span></p>';
            }).join("")
          : '<p class="muted fine">No weak areas identified yet.</p>') +
        '<h4 style="margin-top:12px">Topics you\'re strong in</h4>' +
        (strongList.length
          ? strongList.slice(0, 4).map(function (s) {
              return '<p class="fine" style="margin:4px 0">' + C.escapeHtml(s.t.name) + ' <span class="ok">(' + s.acc + '% acc)</span></p>';
            }).join("")
          : '<p class="muted fine">Keep practising to build strong topics.</p>') +
        '</div>' +
        '<div><h4>Topics you haven\'t practised</h4>' +
        (unpractisedList.length
          ? unpractisedList.slice(0, 5).map(function (u) {
              return '<p class="fine" style="margin:4px 0"><a href="#/practice?topic=' + encodeURIComponent(u.id) + '">' + C.escapeHtml(u.name) + '</a></p>';
            }).join("")
          : '<p class="muted fine">You have attempted every topic!</p>') +
        '<h4 style="margin-top:12px">Recent mistakes</h4>' +
        (recentMistakes.length
          ? recentMistakes.map(function (m) {
              return '<p class="fine" style="margin:4px 0"><a href="#/question/' + encodeURIComponent(m.qid) + '">Question ' + C.escapeHtml(m.qid) + '</a> <span class="muted">(' + C.fmtDate(m.ts) + ')</span></p>';
            }).join("")
          : '<p class="muted fine">No recent mistakes.</p>') +
        '</div></div>';
    });
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
        var scoped = store.applyContentScope({});
        var topics = m.topics.filter(function (t) {
          if (!t.n) return false;
          if (scoped.courses && scoped.courses.length) return scoped.courses.indexOf(t.course_id) !== -1;
          if (scoped.subjects && scoped.subjects.length) {
            var course = m.courses.filter(function (c) { return c.id === t.course_id; })[0];
            return course && scoped.subjects.indexOf(course.subject_id) !== -1;
          }
          return true;
        });
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
      '<p class="page-sub">Ranked by XP earned on correctly answered questions. You can opt out in <a href="#/settings?tab=privacy">settings</a>.</p>' +
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
      var pref = store.prefs();
      var scopeNote = "";
      if ((pref.subjects && pref.subjects.length) || (pref.courses && pref.courses.length)) {
        var names = (pref.subjects || []).map(function (id) {
          var s = m.subjects.filter(function (x) { return x.id === id; })[0];
          return s ? s.name : id;
        });
        scopeNote = '<div class="notice" id="b-scope">Showing your subjects: <b>' +
          C.escapeHtml(names.join(", ") || "selected courses") +
          '</b>. <a href="#/settings?tab=subjects">Change in Settings</a></div>';
      }
      body.innerHTML = scopeNote +
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
        var f2 = store.applyContentScope({
          course: f.course, subject: f.subject, topic: f.topic, qtype: f.type,
          difficulty_min: f.difficulty_min, marks_min: f.marks_min,
          paper_year: f.paper_year, paper_type: f.paper_type,
        });

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

      var prev = store.load().completed[id];
      var prevHtml = "";
      if (prev) {
        var prevLabel = prev.correct === true ? "Correct ✓" : prev.correct === false ? "Incorrect ✗" : "Skipped ─";
        prevHtml = '<div class="previous-state badge" id="q-prev-state" style="margin-top:10px">Previously marked: <b>' + prevLabel + '</b></div>';
      }

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
        '<span class="timer-display" id="q-timer" role="timer" aria-live="off">00:00</span>' +
        '<button type="button" class="btn ghost sm" id="q-timer-toggle" aria-label="Pause or resume timer">Pause</button>' +
        '<button type="button" class="btn ghost sm" id="q-timer-reset" aria-label="Restart timer">Restart</button>' +
        '<span class="fine muted">time on this question</span></div>' +
        prevHtml +
        '<div class="qcard-actions" role="group" aria-label="Mark your answer">' +
        '<button type="button" class="btn ok" id="q-correct" aria-label="Mark Correct">✓ I got it right</button>' +
        '<button type="button" class="btn ghost" id="q-wrong" aria-label="Mark Incorrect">✗ I got it wrong</button>' +
        '<button type="button" class="btn ghost" id="q-skipped" aria-label="Mark Unattempted or Skipped">─ Unattempted / Skipped</button>' +
        '<button type="button" class="btn ghost" id="q-fav">' + (store.isFavourite(id) ? "★ Saved" : "☆ Save") + "</button>" +
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
      var qElapsed = 0;
      var qPaused = false;
      var qTimer = C.$("#q-timer");
      var qTimerToggle = C.$("#q-timer-toggle");
      var qTimerReset = C.$("#q-timer-reset");
      var qTimerTick = setInterval(function () {
        if (!C.alive(qTimer)) { clearInterval(qTimerTick); return; }
        if (!qPaused) {
          qElapsed = Math.round((Date.now() - qStart) / 1000);
          qTimer.textContent = C.fmtTime(qElapsed);
        }
      }, 1000);
      if (qTimerToggle) {
        qTimerToggle.addEventListener("click", function () {
          qPaused = !qPaused;
          if (!qPaused) { qStart = Date.now() - qElapsed * 1000; }
          qTimerToggle.textContent = qPaused ? "Resume" : "Pause";
        });
      }
      if (qTimerReset) {
        qTimerReset.addEventListener("click", function () {
          qStart = Date.now();
          qElapsed = 0;
          qTimer.textContent = "00:00";
        });
      }

      // ---- record attempt (server-side XP when backend enabled) -------------
      var recorded = false;
      var xpBox = C.$("#q-xp-feedback");
      function record(correct) {
        if (recorded) return;
        recorded = true;
        C.$("#q-correct").disabled = true;
        C.$("#q-wrong").disabled = true;
        C.$("#q-skipped").disabled = true;
        var seconds = qElapsed || Math.round((Date.now() - qStart) / 1000);
        // local store always records (device history)
        store.recordAttempt({ qid: id, correct: correct, mode: "practice", seconds: seconds, topic_id: rec.topic_id });
        var backend = root.QB.backend;
        var toastMsg;
        if (correct === null) {
          toastMsg = "Marked skipped / unattempted";
        } else {
          toastMsg = correct ? "Marked correct" : "Marked incorrect — check the solution";
        }
        if (!backend.enabled() || !backend.currentUser()) {
          xpBox.hidden = false;
          xpBox.innerHTML = C.escapeHtml(toastMsg);
          xpBox.className = "xp-feedback " + (correct === true ? "xp-win" : correct === false ? "xp-loss" : "xp-neutral");
          C.toast(toastMsg, correct === true ? "ok" : "");
          return;
        }
        backend.recordAttempt({
          question_id: id, correct: correct, seconds: seconds,
          mode: "practice", course_id: rec.course_id, topic_id: rec.topic_id,
          difficulty: rec.difficulty,
        }).then(function (res) {
          if (!res) return;
          var G = root.QB.gamification;
          xpBox.hidden = false;
          var text;
          if (correct === null) {
            text = "<b>Unattempted / Skipped</b> — no XP earned this time";
          } else if (correct) {
            text = '<b>+' + res.xp_earned + " XP</b>" + (res.bonus ? ' <span class="fine">(includes ' + res.bonus + ' streak bonus)</span>' : "");
          } else {
            text = "No XP this time — check the solution and try again";
          }
          xpBox.innerHTML = text +
            '<span class="fine muted"> · Level ' + res.level + " · Streak " + res.streak + " days · Today " + res.xp_today + " XP</span>";
          xpBox.className = "xp-feedback " + (correct === true ? "xp-win" : correct === false ? "xp-loss" : "xp-neutral");
          C.toast(correct === true ? "+" + res.xp_earned + " XP earned" : toastMsg, correct === true ? "ok" : "");
        }).catch(function (err) {
          xpBox.hidden = false;
          xpBox.innerHTML = C.escapeHtml(toastMsg);
          xpBox.className = "xp-feedback";
          C.toast(toastMsg);
          console.warn("record_attempt failed:", err && err.message);
        });
      }
      C.$("#q-correct").addEventListener("click", function () { record(true); });
      C.$("#q-wrong").addEventListener("click", function () { record(false); });
      C.$("#q-skipped").addEventListener("click", function () { record(null); });

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
      '<option value="mixed">Mixed practice</option>' +
      '<option value="exam">Exam mode</option>' +
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
      var scoped = store.applyContentScope({});
      var allowedCourses = m.courses.filter(function (c) {
        if (c.n <= 0) return false;
        if (scoped.courses && scoped.courses.length) return scoped.courses.indexOf(c.id) !== -1;
        if (scoped.subjects && scoped.subjects.length) return scoped.subjects.indexOf(c.subject_id) !== -1;
        return true;
      });
      var courseSel = C.$("#p-course");
      courseSel.innerHTML = selectOptions(allowedCourses.length ? allowedCourses : m.courses.filter(function (c) { return c.n > 0; }), "id", "name", params.get("course"));
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

        // exam mode: always timed, no per-question feedback, review at the end
        var isExam = source === "exam";
        if (isExam) { timed = true; }
        root.QB.practice.buildSet(filters, count, source, m).then(function (built) {
          if (!built.qids.length) {
            C.toast("No questions match those choices", "error");
            return;
          }
          var s = root.QB.practice.startSession({
            qids: built.qids, records: built.records,
            name: C.titleCase(source) + (filters.topic ? " · " + (api.topicName(filters.topic) || "") : ""),
            timed: timed, minutes: minutes, mode: isExam ? "exam" : source,
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
      (user ? '<button class="btn ghost" id="pr-signout">Log out</button>' : '<a class="btn" href="#/login">Sign in</a>') +
      '<a class="btn ghost" href="#/settings">Settings</a>' +
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
      auth.signOut().then(function () { C.toast("Signed out"); location.hash = "#/"; });
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
          auth.updateProfile({
            daily_goal: s.profile.goal,
            year_level: s.profile.yearLevel,
            courses: courses,
            onboarding_completed: true,
          }).catch(function () {});
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
    /* In Supabase mode an account is required: the PDF is stored in the
     * private bucket and moderated. Without a session, queueing locally
     * would silently lose the file, so we say so up front. */
    var needsAuth = auth.provider() === "supabase" && !auth.currentUser();
    app.innerHTML =
      "<h1 class='page-title'>Contribute a paper</h1>" +
      (needsAuth
        ? '<div class="notice" id="up-auth">Sign in to contribute — your PDF is stored securely and queued for moderation. ' +
          'Without an account, uploads cannot be submitted. ' +
          '<a href="#/login">Sign in</a> · <a href="#/signup">Create account</a></div>'
        : "") +
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
      if (auth.provider() === "supabase" && !auth.currentUser()) {
        resultEl.innerHTML = '<div class="error-banner">Please <a href="#/login">sign in</a> first — ' +
          "uploads are stored securely and queued for moderation on your account.</div>";
        return;
      }
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
          var storing = auth.provider() === "supabase" && auth.currentUser();
          resultEl.innerHTML = '<div class="notice">' + C.spinner() +
            "<span>Storing your PDF securely" + (storing ? " and queueing it" : "") + "…</span></div>";
          return auth.submitPaper(file, sub).then(function (res) {
            var statusText = res.remote
              ? "Your PDF is stored securely and the submission is queued for moderation."
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
        resultEl.innerHTML = '<div class="error-banner">Could not submit: ' + C.escapeHtml(err.message) +
          ' <button class="btn ghost sm" id="dz-retry" type="button" style="margin-left:6px">Try again</button></div>';
        var retry = C.$("#dz-retry");
        if (retry) retry.addEventListener("click", function () { handleFile(file); });
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
  var ADMIN_STATUSES = ["pending", "processing", "needs_review", "needs_changes", "approved", "rejected", "duplicate"];
  var ADMIN_QUEUE_STATUSES = ["pending", "processing", "needs_review", "needs_changes"];

  function adminPage() {
    var app = C.$("#app");
    C.setPageMeta("Moderation — 99.95squad", "");
    if (auth.provider() === "supabase") {
      var user = auth.currentUser();
      if (!user) {
        app.innerHTML = C.renderEmpty({
          title: "Sign in required",
          body: "Moderation requires a moderator account. Sign in to continue.",
          action: '<a class="btn" href="#/login">Sign in</a>',
        });
        return;
      }
      /* Server-verified gate — never trust the localStorage cache alone. */
      app.innerHTML = '<div class="boot-screen">' + C.spinner("Checking access…") + "</div>";
      auth.isAdmin().then(function (ok) {
        if (!C.alive(app)) return;
        if (!ok) {
          app.innerHTML = C.renderEmpty({
            title: "Moderators only",
            body: "This area is limited to accounts with is_admin set in the database. Sign in with a moderator account.",
            action: '<a class="btn" href="#/dashboard">Back to dashboard</a>',
          });
          return;
        }
        renderAdminApp(app, { local: false });
      }).catch(function () {
        if (C.alive(app)) {
          app.innerHTML = C.renderEmpty({
            title: "Could not verify access",
            body: "The moderation check failed. Check your connection and try again.",
            action: '<a class="btn" href="#/admin">Retry</a>',
          });
        }
      });
      return;
    }
    /* device-local mode: manage submissions stored in this browser */
    renderAdminApp(app, { local: true });
  }

  function adminStatusLabel(s) { return C.titleCase(String(s || "").replace(/_/g, " ")); }

  function adminRowActions(s) {
    var buttons = [];
    var acts = [
      ["approve", "Approve", "btn sm ok", s.status !== "approved"],
      ["reject", "Reject", "btn sm danger", s.status !== "rejected"],
      ["duplicate", "Duplicate", "btn sm", s.status !== "duplicate"],
      ["needs_review", "Needs review", "btn sm ghost", s.status !== "needs_review"],
      ["needs_changes", "Request changes", "btn sm ghost", s.status !== "needs_changes"],
      ["pending", "Move to queue", "btn sm ghost", s.status !== "pending" && s.status !== "processing"],
    ];
    acts.forEach(function (a) {
      if (a[3]) buttons.push('<button class="' + a[2] + '" data-quick="' + a[0] + '" data-id="' + C.escapeHtml(s.id) + '">' + a[1] + "</button>");
    });
    return buttons.join("");
  }

  function renderAdminApp(app, opts) {
    var view = qs().get("view") || "queue";
    var isQueueView = view === "queue";
    var isApprovedView = view === "approved";
    var isRejectedView = view === "rejected";
    var isHistoryView = view === "history";
    var subs = [];
    var loadGen = 0;

    app.innerHTML =
      "<h1 class='page-title'>Moderator</h1>" +
      '<p class="page-sub">Review student uploads. Approval and every status change go through secure server RPCs — students can never change their own status, and PDFs are opened via short-lived signed URLs.</p>' +
      (opts.local
        ? '<div class="notice">Device-local mode — you are managing submissions stored in this browser. ' +
          "PDFs are not stored in this mode; connect Supabase (docs/AUTH.md) for the full storage + moderation workflow. " +
          "Promote a moderator with <code>update profiles set is_admin = true where id = '&lt;uuid&gt;'</code>.</div>"
        : '<div class="notice ok">Signed in as a moderator. Actions call <code>approve_upload()</code> and <code>moderate_upload()</code> server-side.</div>') +
      '<div class="tabs" id="ad-tabs">' +
      [["queue", "Queue"], ["approved", "Approved"], ["rejected", "Rejected / duplicates"], ["history", "Review history"]].map(function (t) {
        return '<a href="#/admin?view=' + t[0] + '"' + (view === t[0] ? ' class="active"' : "") + ">" + t[1] + "</a>";
      }).join("") + "</div>" +
      '<div class="card"><div id="ad-list">' + C.spinner("Loading submissions…") + "</div></div>" +
      '<div class="card" id="ad-detail-card" hidden><h3>Submission detail</h3><div id="ad-detail"></div></div>' +
      '<div class="card"><h3>Problem reports</h3><div id="ad-reports"></div></div>';

    var listEl = C.$("#ad-list");
    /* Default the filter to "All statuses": each tab's own row-selection
     * logic (queue statuses / approved / rejected+duplicates) applies when
     * no explicit filter is chosen. */
    var statusFilter = { value: "" };

    function reload() {
      var gen = ++loadGen;
      listEl.innerHTML = C.spinner("Loading submissions…");
      var p = opts.local
        ? Promise.resolve(root.QB.store.load().submissions || [])
        : auth.adminListSubmissions();
      p.then(function (rows) {
        if (gen !== loadGen || !C.alive(listEl)) return;
        subs = rows || [];
        renderQueue();
      }).catch(function (err) {
        if (gen !== loadGen || !C.alive(listEl)) return;
        listEl.innerHTML = '<div class="error-banner">Could not load submissions: ' + C.escapeHtml(err.message) +
          ' <button class="btn ghost sm" id="ad-reload" type="button">Retry</button></div>';
        var rb = C.$("#ad-reload");
        if (rb) rb.addEventListener("click", reload);
      });
    }

    function renderQueue() {
      if (isHistoryView) { renderHistory(); return; }
      if (!subs.length) {
        listEl.innerHTML = C.renderEmpty({ title: "No submissions", body: "Student uploads will appear here for review." });
        return;
      }
      listEl.innerHTML =
        '<div class="ad-toolbar">' +
        '<label class="fine">Filter: <select id="ad-filter" style="width:auto;margin-left:6px">' +
        '<option value="">All statuses</option>' +
        ADMIN_STATUSES.map(function (s) {
          return '<option value="' + s + '"' + (statusFilter.value === s ? " selected" : "") + ">" + adminStatusLabel(s) + "</option>";
        }).join("") + "</select></label>" +
        '<span class="fine muted" id="ad-count"></span></div>' +
        '<div id="ad-rows"></div>';
      var rowsEl = C.$("#ad-rows");
      function renderRows() {
        var list = subs.filter(function (s) {
          if (statusFilter.value) return s.status === statusFilter.value;
          if (isQueueView) return ADMIN_QUEUE_STATUSES.indexOf(s.status) !== -1;
          if (isApprovedView) return s.status === "approved";
          if (isRejectedView) return s.status === "rejected" || s.status === "duplicate";
          return true;
        });
        var countEl = C.$("#ad-count");
        if (countEl) countEl.textContent = list.length + " submission" + (list.length === 1 ? "" : "s");
        rowsEl.innerHTML = list.length
          ? '<div class="table-scroll"><table class="table ad-table"><thead><tr>' +
            "<th>File</th><th>Uploader</th><th class='num'>Size</th><th>Submitted</th><th>Status</th><th>Paper ID / notes</th><th>Actions</th>" +
            "</tr></thead><tbody>" +
            list.map(function (s) {
              var dupInfo = s.duplicate_of
                ? '<div class="fine">dup of <code>' + C.escapeHtml(s.duplicate_of) + "</code>" +
                  (s.duplicate_type ? " · " + C.escapeHtml(s.duplicate_type) : "") + "</div>" : "";
              var name = s.uploader_name || s.uploader_email || s.uploader || "—";
              return "<tr>" +
                "<td><button class='btn ghost sm' data-open='" + C.escapeHtml(s.id) + "' title='Open details'>" +
                C.escapeHtml(s.filename || s.name || s.id) + "</button>" +
                '<br><span class="fine muted">' + C.escapeHtml(s.id) + "</span></td>" +
                "<td class='fine'>" + C.escapeHtml(name) +
                (s.uploader_name && s.uploader_email ? '<br><span class="muted">' + C.escapeHtml(s.uploader_email) + "</span>" : "") + "</td>" +
                "<td class='num fine'>" + (s.size_bytes ? Math.round(s.size_bytes / 1024) + " KB" : "—") + "</td>" +
                "<td class='fine'>" + (s.created_at ? C.fmtDate(s.created_at) : "—") + "</td>" +
                "<td>" + badgePill(s.status) + dupInfo + "</td>" +
                "<td class='fine'>" +
                (s.duplicate_of ? "" : (s.note && s.note !== "Pending review" ? C.escapeHtml(s.note) : "—")) + "</td>" +
                "<td><div class='actions ad-actions'>" +
                '<button class="btn sm ghost" data-pdf="' + C.escapeHtml(s.id) + '">View PDF</button>' +
                adminRowActions(s) +
                "</div></td></tr>";
            }).join("") + "</tbody></table></div>"
          : '<p class="muted fine">No submissions with this status.</p>';
        bindRowEvents(rowsEl);
      }
      C.$("#ad-filter").addEventListener("change", function () {
        statusFilter.value = C.$("#ad-filter").value;
        renderRows();
      });
      renderRows();
    }

    function bindRowEvents(scope) {
      C.$$("[data-open]", scope).forEach(function (btn) {
        btn.addEventListener("click", function () { showDetail(btn.dataset.open); });
      });
      C.$$("[data-pdf]", scope).forEach(function (btn) {
        btn.addEventListener("click", function () { openPdfViewer(byId(btn.dataset.pdf)); });
      });
      C.$$("[data-quick]", scope).forEach(function (btn) {
        btn.addEventListener("click", function () {
          var s = byId(btn.dataset.id);
          if (!s) return;
          showDetail(s.id);
          var sel = C.$("#ad-status");
          if (sel) sel.value = btn.dataset.quick;
          var row = C.$("#ad-dup-row");
          if (row) row.hidden = btn.dataset.quick !== "duplicate";
        });
      });
    }

    function byId(id) {
      return subs.filter(function (x) { return String(x.id) === String(id); })[0] || null;
    }

    function renderHistory() {
      listEl.innerHTML = C.spinner("Loading review history…");
      auth.listAuditEvents().then(function (rows) {
        if (!C.alive(listEl)) return;
        listEl.innerHTML = rows && rows.length
          ? '<div class="table-scroll"><table class="table"><thead><tr><th>When</th><th>Actor</th><th>Target</th><th>Change</th></tr></thead><tbody>' +
            rows.map(function (r) {
              return "<tr><td>" + C.fmtDate(r.created_at) + "</td><td>" + C.escapeHtml(r.actor || "") +
                "</td><td class='fine'>" + C.escapeHtml(r.target_id || "") + "</td><td>" +
                C.escapeHtml(r.previous_status || "—") + " → " + C.escapeHtml(r.new_status || r.action) +
                (r.notes ? '<div class="fine muted">' + C.escapeHtml(r.notes) + "</div>" : "") + "</td></tr>";
            }).join("") + "</tbody></table></div>"
          : '<p class="muted fine">No review history yet.</p>';
      }).catch(function () {
        if (C.alive(listEl)) listEl.innerHTML = '<div class="error-banner">Could not load review history.</div>';
      });
    }

    /* ------------------------------------------------------ detail + form */
    function showDetail(id) {
      var s = byId(id);
      var card = C.$("#ad-detail-card");
      var box = C.$("#ad-detail");
      if (!s || !card || !box) return;
      card.hidden = false;
      box.innerHTML =
        '<div class="ad-detail-head"><b>' + C.escapeHtml(s.filename || s.name || s.id) + "</b> " + badgePill(s.status) + "</div>" +
        '<div class="ad-detail-meta">' +
        "<div><span class='label'>Uploader</span>" + C.escapeHtml(s.uploader_name || s.uploader_email || s.uploader || "—") + "</div>" +
        "<div><span class='label'>Submitted</span>" + (s.created_at ? C.fmtDate(s.created_at) : "—") + "</div>" +
        "<div><span class='label'>Size</span>" + (s.size_bytes ? Math.round(s.size_bytes / 1024) + " KB" : "—") + "</div>" +
        "<div><span class='label'>Paper</span>" + [s.subject, s.course, s.year, s.paper_type].filter(Boolean).map(C.escapeHtml).join(" · ") + " —" + "</div>" +
        (s.sha256 ? "<div class='wide'><span class='label'>SHA-256</span><code>" + C.escapeHtml(s.sha256) + "</code></div>" : "") +
        (s.duplicate_of ? "<div class='wide'><span class='label'>Duplicate of</span><code>" + C.escapeHtml(s.duplicate_of) + "</code>" +
          (s.duplicate_type ? " <span class='fine muted'>(" + C.escapeHtml(s.duplicate_type) + ")</span>" : "") + "</div>" : "") +
        (s.storage_path ? "<div class='wide'><span class='label'>Stored at</span><code>" + C.escapeHtml(s.storage_path) + "</code></div>" : "") +
        "</div>" +
        (s.note && s.note !== "Pending review" ? "<p class='fine'><span class='label'>Notes</span> " + C.escapeHtml(s.note) + "</p>" : "") +
        '<div class="actions" style="margin:10px 0">' +
        '<button class="btn sm" id="ad-view-pdf" data-pdf="' + C.escapeHtml(s.id) + '">View PDF</button>' +
        "</div>" +
        '<form id="ad-form" class="ad-form">' +
        '<div class="form-row"><label for="ad-status">Change status</label>' +
        '<select id="ad-status">' + ADMIN_STATUSES.map(function (st) {
          return '<option value="' + st + '"' + (s.status === st ? " selected" : "") + ">" + adminStatusLabel(st) + "</option>";
        }).join("") + "</select></div>" +
        '<div class="form-row" id="ad-dup-row" hidden>' +
        '<label for="ad-dup-of">Duplicate of (paper ID or submission ID)</label>' +
        '<input type="text" id="ad-dup-of" placeholder="e.g. 2025-northside-physics-trial" value="' + C.escapeHtml(s.duplicate_of || "") + '">' +
        '<label for="ad-dup-type" style="margin-top:10px">Duplicate type</label>' +
        '<select id="ad-dup-type"><option value="exact_hash">Exact file (same hash)</option>' +
        '<option value="near_duplicate">Near-duplicate</option>' +
        '<option value="already_published">Already published in library</option>' +
        '<option value="other">Other</option></select></div>' +
        '<div class="form-row"><label for="ad-note">Review notes (visible to the uploader)</label>' +
        '<textarea id="ad-note" placeholder="e.g. low scan quality, missing cover page, typo in metadata…">' + C.escapeHtml(s.note || "") + "</textarea></div>" +
        '<button class="btn" id="ad-apply" type="submit">Apply status change</button>' +
        "</form>" +
        '<div id="ad-history"><p class="muted fine">Loading review history…</p></div>';
      var pdfBtn = C.$("#ad-view-pdf", box);
      if (pdfBtn) pdfBtn.addEventListener("click", function () { openPdfViewer(s); });
      var statusSel = C.$("#ad-status", box);
      var dupRow = C.$("#ad-dup-row", box);
      if (statusSel) {
        statusSel.addEventListener("change", function () {
          if (dupRow) dupRow.hidden = statusSel.value !== "duplicate";
        });
        if (dupRow) dupRow.hidden = statusSel.value !== "duplicate";
      }
      var form = C.$("#ad-form", box);
      if (form) form.addEventListener("submit", function (e) {
        e.preventDefault();
        applyStatus(s);
      });
      auth.listAuditEvents(String(s.id)).then(function (rows) {
        var h = C.$("#ad-history");
        if (!h) return;
        if (!rows || !rows.length) { h.innerHTML = '<p class="muted fine">No audit events yet.</p>'; return; }
        h.innerHTML = "<h4>Review history</h4>" + rows.map(function (r) {
          return '<p class="fine">' + C.fmtDate(r.created_at) + " · " + C.escapeHtml(r.actor || "") +
            " · " + C.escapeHtml(r.previous_status || "—") + " → " + C.escapeHtml(r.new_status || r.action) +
            (r.notes ? " — " + C.escapeHtml(r.notes) : "") + "</p>";
        }).join("");
      });
    }

    function applyStatus(s) {
      var status = C.$("#ad-status").value;
      var note = (C.$("#ad-note").value || "").trim();
      var dupOf = (C.$("#ad-dup-of") ? C.$("#ad-dup-of").value : "").trim();
      var dupType = (C.$("#ad-dup-type") ? C.$("#ad-dup-type").value : "").trim();
      var applyBtn = C.$("#ad-apply");
      if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = "Applying…"; }
      var op = status === "approved"
        ? auth.approveUpload(s.id)
        : auth.moderateUpload(s.id, status, note, dupOf || null, dupType || null);
      op.then(function () {
        C.toast("Marked " + adminStatusLabel(status));
        if (status === "approved") auth.refreshEntitlement().catch(function () {});
        var card = C.$("#ad-detail-card");
        if (card) card.hidden = true;
        reload();
      }).catch(function (err) {
        C.toast(err.message || "Action failed", "error");
        if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = "Apply status change"; }
      });
    }

    /* -------------------------------------------------------- PDF preview */
    function openPdfViewer(s) {
      if (!s) return;
      if (!s.storage_path) {
        C.modal(
          '<div class="pdf-viewer"><h3>No PDF on record</h3>' +
          '<p class="muted">This submission has no stored file (it predates PDF storage, or the upload never completed). ' +
          "Ask the student to re-upload it.</p></div>"
        );
        return;
      }
      var bodyId = "pv-body-" + Math.random().toString(36).slice(2, 8);
      var m = C.modal(
        '<div class="pdf-viewer"><h3>PDF preview</h3>' +
        '<p class="fine muted">' + C.escapeHtml(s.filename || s.name || "uploaded file") + " · " +
        C.escapeHtml(s.storage_path) + "</p>" +
        '<div id="' + bodyId + '">' + C.spinner("Requesting a secure signed link…") + "</div></div>"
      );
      var bodyEl = document.getElementById(bodyId);
      if (!bodyEl) return;
      var run = function () {
        bodyEl.innerHTML = C.spinner("Requesting a secure signed link…");
        auth.signUrl(s.storage_path, 3600).then(function (url) {
          if (!url) throw new Error("No file found at the stored path");
          return verifyPdfUrl(url).then(function (v) {
            if (v === "gone") throw new Error("The file could not be read — it may have been removed, or the link has expired");
            return { url: url, verified: v === "ok" };
          });
        }).then(function (info) {
          if (!C.alive(bodyEl)) return;
          bodyEl.innerHTML =
            '<div class="pdf-tools">' +
            '<a class="btn sm" href="' + C.escapeHtml(info.url) + '" target="_blank" rel="noopener">Open in new tab</a> ' +
            '<button class="btn ghost sm" id="pv-refresh" type="button">Refresh link</button></div>' +
            (info.verified ? "" :
              '<p class="notice warn" style="margin-bottom:10px">Could not pre-verify the link from this page ' +
              "(the browser may block the check). If the PDF does not appear below, use <b>Refresh link</b>.</p>") +
            '<iframe class="pdf-frame" src="' + C.escapeHtml(info.url) + '" title="PDF preview of ' +
            C.escapeHtml(s.filename || "uploaded file") + '"></iframe>';
          var rb = document.getElementById("pv-refresh");
          if (rb) rb.addEventListener("click", run);
        }).catch(function (err) {
          if (!C.alive(bodyEl)) return;
          bodyEl.innerHTML =
            '<div class="error-banner">' + C.escapeHtml(err.message) + "</div>" +
            '<p class="muted fine">Signed links expire after an hour and only work for the uploader or a moderator. ' +
            "If this persists, the file may have been deleted from storage.</p>" +
            '<button class="btn sm" id="pv-retry" type="button">Try again</button>';
          var rb = document.getElementById("pv-retry");
          if (rb) rb.addEventListener("click", run);
        });
      };
      run();
    }

    /* Probe the signed URL so an expired/removed file shows a clear error
     * instead of a silent browser PDF failure inside the iframe.
     * Returns "ok" (200/206), "gone" (explicit 4xx/5xx), or "unknown"
     * (network/CORS failure — the browser may still render the PDF, so we
     * show the iframe with a warning rather than blocking it). */
    function verifyPdfUrl(url) {
      return fetch(url, { method: "GET", headers: { "Range": "bytes=0-2047" } }).then(function (res) {
        if (res.status === 200 || res.status === 206) return "ok";
        return "gone";
      }).catch(function () { return "unknown"; });
    }

    /* ----------------------------------------------------------- bootstrap */
    reload();

    auth.listProblemReports().then(function (reports) {
      var el = C.$("#ad-reports");
      if (!el) return;
      el.innerHTML = reports && reports.length
        ? reports.map(function (r) {
            return '<p style="margin:6px 0;font-size:13.5px"><strong>' + C.escapeHtml(r.reason) + "</strong> · " +
              C.escapeHtml(r.qid || r.question_id || "general") + ' <span class="fine muted">' + C.fmtDate(r.at || r.created_at) + "</span><br>" +
              C.escapeHtml(r.details || "") + "</p>";
          }).join("")
        : '<p class="muted fine">No problem reports yet.</p>';
    });
  }

  /* ================================================================== report */
  function reportPage(qid) {
    var app = C.$("#app");
    C.setPageMeta("Report a problem — 99.95squad", "");
    app.innerHTML =
      '<div style="max-width:560px;margin:24px auto">' +
      '<div class="card"><h2>Report a problem</h2>' +
      (qid ? '<p class="muted">Question: <code>' + C.escapeHtml(qid) + "</code></p>" : "") +
      '<div class="form-row"><label for="r-reason">What\'s wrong?</label><select id="r-reason">' +
      '<option value="wrong-question">The question is cut off / cropped badly</option>' +
      '<option value="wrong-metadata">Wrong subject, topic or difficulty</option>' +
      '<option value="wrong-answer">The answer is wrong</option>' +
      '<option value="duplicate">Duplicate question</option>' +
      '<option value="copyright">Copyright concern</option>' +
      '<option value="other">Something else</option></select></div>' +
      '<div class="form-row"><label for="r-details">Details (optional)</label><textarea id="r-details" placeholder="Tell us what\'s wrong…"></textarea></div>' +
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
    if (profile.onboarded && !auth.needsOnboarding()) { location.hash = "#/dashboard"; return; }

    app.innerHTML =
      '<div style="max-width:640px;margin:26px auto">' +
      '<div class="card onboard">' +
      "<h2>Welcome — let's set you up</h2>" +
      '<p class="muted" style="font-size:14px">A few quick choices so your practice feed matches what you actually study. You can change this later in Settings.</p>' +
      '<ol class="onboard-steps" aria-hidden="true"><li class="active">Welcome</li><li>Subjects</li><li>Courses</li><li>Personalise</li></ol>' +
      '<div class="form-row"><label>Subjects you study</label>' +
      '<p class="field-hint">Pick every subject you want questions from. Others stay hidden until you add them.</p>' +
      '<div id="o-subjects" class="chiprow subject-grid"></div></div>' +
      '<div class="form-row"><label>Courses you study</label><div id="o-courses" class="chiprow"></div></div>' +
      '<div class="form-row"><label for="o-year">Year level</label>' +
      '<select id="o-year"><option value="">Select…</option><option value="11">Year 11</option><option value="12" selected>Year 12</option></select></div>' +
      '<div class="form-row"><label for="o-goal">Daily goal (questions per day)</label>' +
      '<input type="number" id="o-goal" min="1" max="100" value="' + (profile.goal || 10) + '"></div>' +
      '<div class="form-row"><label for="o-name">Name (optional)</label>' +
      '<input type="text" id="o-name" placeholder="Your name" value="' + C.escapeHtml(profile.name || "") + '"></div>' +
      '<button class="btn block" id="o-save">Save and continue</button></div></div>';

    withMeta(function (m) {
      var subjectsEl = C.$("#o-subjects");
      var coursesEl = C.$("#o-courses");
      var subjectList = m.subjects.slice().sort(function (a, b) {
        return (b.n || 0) - (a.n || 0) || String(a.name).localeCompare(String(b.name));
      });
      subjectsEl.innerHTML = subjectList.map(function (s) {
        return '<label class="chip" style="cursor:pointer"><input type="checkbox" value="' + C.escapeHtml(s.id) +
          '" style="width:auto;margin-right:6px">' + C.escapeHtml(s.name) +
          (s.n ? ' <span class="fine muted">(' + s.n + ")</span>" : "") + "</label>";
      }).join("");
      (profile.subjects || []).forEach(function (id) {
        var box = subjectsEl.querySelector('input[value="' + id + '"]');
        if (box) box.checked = true;
      });

      function renderCourses() {
        var selected = [];
        C.$$("#o-subjects input:checked").forEach(function (box) { selected.push(box.value); });
        var list = m.courses.filter(function (c) {
          if (c.n <= 0 && selected.length) return selected.indexOf(c.subject_id) !== -1;
          return !selected.length || selected.indexOf(c.subject_id) !== -1;
        });
        // Always include courses with questions so the smoke-test checkbox exists.
        if (!list.length) list = m.courses.filter(function (c) { return c.n > 0; });
        coursesEl.innerHTML = list.map(function (c) {
          return '<label class="chip" style="cursor:pointer"><input type="checkbox" value="' + C.escapeHtml(c.id) +
            '" style="width:auto;margin-right:6px">' + C.escapeHtml(c.name) +
            (c.n ? ' <span class="fine muted">(' + c.n + ")</span>" : "") + "</label>";
        }).join("");
        var saved = profile.courses || [];
        C.$$("#o-courses input").forEach(function (box) {
          if (saved.indexOf(box.value) !== -1) box.checked = true;
        });
      }
      renderCourses();
      C.$$("#o-subjects input").forEach(function (box) {
        box.addEventListener("change", renderCourses);
      });

      C.$("#o-save").addEventListener("click", function () {
        var subjects = [];
        C.$$("#o-subjects input:checked").forEach(function (box) { subjects.push(box.value); });
        var courses = [];
        C.$$("#o-courses input:checked").forEach(function (box) { courses.push(box.value); });
        if (!courses.length && subjects.length) {
          m.courses.forEach(function (c) {
            if (subjects.indexOf(c.subject_id) !== -1) courses.push(c.id);
          });
        }
        var s = store.load();
        var name = C.$("#o-name").value.trim() || s.profile.name || "";
        var goal = Math.max(1, parseInt(C.$("#o-goal").value, 10) || 10);
        var yearLevel = C.$("#o-year").value ? parseInt(C.$("#o-year").value, 10) : null;
        s.profile = {
          name: name, goal: goal, yearLevel: yearLevel,
          subjects: subjects, courses: courses, onboarded: true,
        };
        store.save();
        auth.updateProfile({
          display_name: name, daily_goal: goal, year_level: yearLevel,
          subjects: subjects, courses: courses, onboarding_completed: true,
        }).then(function () { return auth.refreshEntitlement(); }).catch(function () {});
        C.toast("All set — good luck!");
        location.hash = "#/dashboard";
      });
    });
  }

  /* =============================================================== settings */
  function settingsPage() {
    var app = C.$("#app");
    C.setPageMeta("Settings — 99.95squad", "");
    var user = auth.currentUser();
    var ent = auth.entitlement();
    var tab = qs().get("tab") || "account";
    var tabs = [
      ["account", "Account"], ["subjects", "Subjects"],
      ["preferences", "Preferences"], ["privacy", "Privacy"],
    ];
    app.innerHTML =
      "<h1 class='page-title'>Settings</h1>" +
      '<p class="page-sub">Manage your profile, subjects and privacy. Protected fields such as XP and admin status cannot be edited here.</p>' +
      '<div class="tabs" id="st-tabs">' +
      tabs.map(function (t) {
        return '<a href="#/settings?tab=' + t[0] + '"' + (tab === t[0] ? ' class="active"' : "") + ">" + t[1] + "</a>";
      }).join("") + "</div>" +
      '<div id="st-body"></div>';

    var body = C.$("#st-body");
    var pref = store.prefs();

    if (tab === "subjects") {
      body.innerHTML =
        '<div class="card"><h3>Selected subjects</h3>' +
        '<p class="muted fine">Your practice feed, browse results, recommendations and random questions use this list.</p>' +
        '<div id="st-subjects" class="chiprow subject-grid"></div>' +
        '<div class="form-row" style="margin-top:16px"><label>Courses</label><div id="st-courses" class="chiprow"></div></div>' +
        '<button class="btn" id="st-save-subjects">Save subjects</button></div>';
      withMeta(function (m) {
        var subEl = C.$("#st-subjects");
        var courseEl = C.$("#st-courses");
        if (!C.alive(subEl)) return;
        subEl.innerHTML = m.subjects.map(function (s) {
          return '<label class="chip" style="cursor:pointer"><input type="checkbox" value="' + C.escapeHtml(s.id) +
            '" style="width:auto;margin-right:6px">' + C.escapeHtml(s.name) + "</label>";
        }).join("");
        (pref.subjects || []).forEach(function (id) {
          var box = subEl.querySelector('input[value="' + id + '"]');
          if (box) box.checked = true;
        });
        function renderCourses() {
          var selected = [];
          C.$$("#st-subjects input:checked").forEach(function (b) { selected.push(b.value); });
          var list = m.courses.filter(function (c) {
            return !selected.length || selected.indexOf(c.subject_id) !== -1;
          });
          courseEl.innerHTML = list.map(function (c) {
            return '<label class="chip" style="cursor:pointer"><input type="checkbox" value="' + C.escapeHtml(c.id) +
              '" style="width:auto;margin-right:6px">' + C.escapeHtml(c.name) + "</label>";
          }).join("");
          (pref.courses || []).forEach(function (id) {
            var box = courseEl.querySelector('input[value="' + id + '"]');
            if (box) box.checked = true;
          });
        }
        renderCourses();
        C.$$("#st-subjects input").forEach(function (b) { b.addEventListener("change", renderCourses); });
        C.$("#st-save-subjects").addEventListener("click", function () {
          var subjects = []; var courses = [];
          C.$$("#st-subjects input:checked").forEach(function (b) { subjects.push(b.value); });
          C.$$("#st-courses input:checked").forEach(function (b) { courses.push(b.value); });
          if (!courses.length && subjects.length) {
            m.courses.forEach(function (c) {
              if (subjects.indexOf(c.subject_id) !== -1) courses.push(c.id);
            });
          }
          auth.updateProfile({ subjects: subjects, courses: courses }).then(function () {
            C.toast("Subjects saved — your question feed will update");
            settingsPage();
          }).catch(function (err) { C.toast(err.message || "Could not save", "error"); });
        });
      });
      return;
    }

    if (tab === "preferences") {
      body.innerHTML =
        '<div class="card"><h3>Study preferences</h3>' +
        '<div class="form-row"><label for="st-goal">Daily goal</label>' +
        '<input type="number" id="st-goal" min="1" max="100" value="' + (pref.goal || 10) + '"></div>' +
        '<div class="form-row"><label for="st-year">Year level</label><select id="st-year">' +
        '<option value="">Not set</option><option value="11">Year 11</option><option value="12">Year 12</option></select></div>' +
        '<button class="btn" id="st-save-pref">Save preferences</button></div>';
      C.$("#st-year").value = pref.yearLevel ? String(pref.yearLevel) : "";
      C.$("#st-save-pref").addEventListener("click", function () {
        auth.updateProfile({
          daily_goal: Math.max(1, parseInt(C.$("#st-goal").value, 10) || 10),
          year_level: C.$("#st-year").value ? parseInt(C.$("#st-year").value, 10) : null,
        }).then(function () { C.toast("Preferences saved"); }).catch(function (err) {
          C.toast(err.message || "Could not save", "error");
        });
      });
      return;
    }

    if (tab === "privacy") {
      body.innerHTML =
        '<div class="card"><h3>Privacy</h3>' +
        '<label class="chip" style="cursor:pointer"><input type="checkbox" id="st-optout" style="width:auto;margin-right:6px"> Hide me from the leaderboard</label>' +
        '<p class="muted fine" style="margin-top:10px">Your attempts, XP and profile entitlements stay private. Other students only see leaderboard rows you have not opted out of.</p>' +
        '<button class="btn" id="st-save-privacy" style="margin-top:12px">Save privacy</button></div>' +
        '<div class="card"><h3>Log out</h3><p class="muted fine">Sign out of this device and clear the cached session.</p>' +
        '<button class="btn ghost" id="st-logout">Log out</button></div>';
      C.$("#st-optout").checked = !!pref.optOut;
      C.$("#st-save-privacy").addEventListener("click", function () {
        auth.updateProfile({ opt_out_leaderboard: C.$("#st-optout").checked }).then(function () {
          C.toast("Privacy saved");
        }).catch(function (err) { C.toast(err.message || "Could not save", "error"); });
      });
      C.$("#st-logout").addEventListener("click", function () {
        auth.signOut().then(function () { C.toast("Signed out"); location.hash = "#/"; });
      });
      return;
    }

    body.innerHTML =
      '<div class="card"><h3>Account</h3>' +
      (user
        ? "<p><strong>" + C.escapeHtml(user.name || pref.displayName || "Student") + "</strong><br><span class='muted'>" + C.escapeHtml(user.email || "") + "</span></p>"
        : '<p class="muted">Not signed in. <a href="#/login">Sign in</a></p>') +
      '<p>' + badgePill(ent.isPremium ? "approved" : "pending") + " <strong>" + C.escapeHtml(C.titleCase(ent.tier || "free")) + "</strong></p>" +
      '<div class="form-row"><label for="st-name">Display name</label>' +
      '<input type="text" id="st-name" value="' + C.escapeHtml(pref.displayName || (user && user.name) || "") + '"></div>' +
      '<button class="btn" id="st-save-account">Save profile</button>' +
      '<a class="btn ghost" href="#/profile" style="margin-left:8px">Open full profile</a></div>' +
      '<div class="card"><h3>Session</h3><button class="btn ghost" id="st-logout-2">Log out</button></div>';
    var saveAcc = C.$("#st-save-account");
    if (saveAcc) saveAcc.addEventListener("click", function () {
      auth.updateProfile({ display_name: C.$("#st-name").value.trim() }).then(function () {
        C.toast("Profile saved");
      }).catch(function (err) { C.toast(err.message || "Could not save", "error"); });
    });
    var out2 = C.$("#st-logout-2");
    if (out2) out2.addEventListener("click", function () {
      auth.signOut().then(function () { C.toast("Signed out"); location.hash = "#/"; });
    });
  }

  /* ---------------------------------------------------------------- exposed */
  root.QB = root.QB || {};
  root.QB.pages = {
    landing: landingPage, auth: authPage, dashboard: dashboardPage,
    browse: browsePage, question: questionPage, practice: practicePage,
    saved: savedPage, progress: progressPage, profile: profilePage,
    upload: uploadPage, admin: adminPage, report: reportPage,
    onboarding: onboardingPage, settings: settingsPage,
    syllabus: syllabusPage, leaderboard: leaderboardPage, analytics: analyticsPage,
    renderQCard: renderQCard, bindFavButtons: bindFavButtons,
  };
})();
