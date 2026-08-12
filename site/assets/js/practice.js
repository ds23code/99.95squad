/* ============================================================================
 * practice.js — practice session engine
 * Timed / untimed sessions, MCQ answering, solution reveal, self-marking,
 * attempt recording (feeds progress analytics), end-of-session summary.
 * ==========================================================================*/
(function () {
  "use strict";

  var root = window;
  var C = root.QB.core;

  var session = null;

  /* ------------------------------------------------------------- set building */
  /* source: "random" | "topic" | "favourites" | "set" | "weak" */
  function buildSet(filters, count, source, meta) {
    var store = root.QB.store;
    if (source === "favourites") {
      return root.QB.api.records(store.load().favourites).then(function (recs) {
        return { qids: Object.keys(recs), records: recs };
      });
    }
    if (source === "set") {
      /* handled by caller: pass qids directly */
      return Promise.resolve({ qids: filters.qids || [], records: {} });
    }
    return root.QB.api.meta().then(function (m) {
      var scoped = root.QB.store.applyContentScope ? root.QB.store.applyContentScope(filters) : filters;
      filters = scoped;
      var courses;
      if (filters.course) courses = [filters.course];
      else if (filters.courses && filters.courses.length) courses = filters.courses.slice();
      else if (filters.subjects && filters.subjects.length) {
        courses = m.courses.filter(function (c) {
          return filters.subjects.indexOf(c.subject_id) !== -1 && c.n > 0;
        }).map(function (c) { return c.id; });
      } else {
        courses = m.courses.filter(function (c) { return c.n > 0; }).map(function (c) { return c.id; });
      }
      var chain = Promise.resolve({});
      courses.forEach(function (courseId) {
        chain = chain.then(function (acc) {
          return root.QB.api.courseRecords(courseId).then(function (recs) {
            recs.forEach(function (r) { acc[r.id] = r; });
            return acc;
          });
        });
      });
      return chain.then(function (all) {
        var matched = Object.keys(all).filter(function (id) { return root.QB.search.matchesFilters(all[id], filters); });
        if (source === "weak") {
          var stats = store.analytics();
          var weakTopics = stats.weak.map(function (t) { return t.topic_id; });
          var weakIds = matched.filter(function (id) {
            return weakTopics.indexOf(all[id].topic_id) !== -1;
          });
          if (weakIds.length >= 3) matched = weakIds;
        }
        // shuffle
        for (var i = matched.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = matched[i]; matched[i] = matched[j]; matched[j] = t;
        }
        matched = matched.slice(0, count || 10);
        return { qids: matched, records: all };
      });
    });
  }

  /* ------------------------------------------------------------------ session */
  function startSession(opts) {
    /* opts: {qids, records, name, timed, minutes, mode} */
    session = {
      qids: opts.qids || [],
      records: opts.records || {},
      name: opts.name || "Practice",
      timed: !!opts.timed,
      minutes: opts.minutes || 15,
      mode: opts.mode || "practice",
      idx: 0,
      results: [],
      seconds: 0,
      startedAt: Date.now(),
      timer: null,
      finished: false,
      totalQuestions: (opts.qids || []).length,
    };
    return session;
  }

  function currentRecord() {
    if (!session || session.idx >= session.qids.length) return null;
    return session.records[session.qids[session.idx]] || null;
  }

  function answerCurrent(selectedLetter) {
    if (!session || session.finished) return null;
    var rec = currentRecord();
    if (!rec) return null;
    var correct = String(rec.answer || "").trim().toUpperCase() === String(selectedLetter || "").trim().toUpperCase();
    pushResult(rec, correct);
    return { correct: correct, answer: rec.answer };
  }

  function selfMark(correct) {
    if (!session || session.finished) return;
    var rec = currentRecord();
    if (!rec) return;
    pushResult(rec, correct === null ? null : !!correct);
  }

  function pushResult(rec, correct) {
    session.results.push({ qid: rec.id, correct: correct, topic_id: rec.topic_id });
    root.QB.store.recordAttempt({
      qid: rec.id, correct: correct, mode: session.mode,
      seconds: session.seconds / Math.max(session.totalQuestions, 1),
      topic_id: rec.topic_id,
    });
    // server-side attempt + XP when the backend is available
    var B = root.QB.backend;
    if (B && B.enabled() && B.currentUser()) {
      B.recordAttempt({
        question_id: rec.id, correct: correct,
        seconds: Math.max(1, Math.round(session.seconds / Math.max(session.totalQuestions, 1))),
        mode: session.mode === "practice" ? "practice" : (session.mode === "set" ? "practice" : session.mode),
        course_id: rec.course_id, topic_id: rec.topic_id, difficulty: rec.difficulty,
      }).catch(function () {});
    }
  }

  function next() {
    if (!session) return null;
    session.idx++;
    if (session.idx >= session.qids.length) finish();
    return session;
  }

  function finish() {
    if (!session || session.finished) return;
    session.finished = true;
    if (session.timer) { clearInterval(session.timer); session.timer = null; }
    session.seconds = Math.round((Date.now() - session.startedAt) / 1000);
  }

  function quit() {
    if (!session) return;
    if (session.timer) clearInterval(session.timer);
    session.finished = true;
  }

  function summary() {
    var n = session.results.length;
    var attempted = session.results.filter(function (r) { return r.correct !== null && r.correct !== undefined; }).length;
    var correct = session.results.filter(function (r) { return r.correct === true; }).length;
    var incorrect = session.results.filter(function (r) { return r.correct === false; }).length;
    return {
      attempted: attempted, total: n, correct: correct, incorrect: incorrect,
      accuracy: attempted ? Math.round((correct / attempted) * 100) : 0,
      seconds: session.seconds, name: session.name,
    };
  }

  /* ------------------------------------------------------------------- render */
  function startTimer(container) {
    var el = C.$("#p-timer", container);
    if (!session.timer && session.timed) {
      session.timer = setInterval(function () {
        if (!session.paused) {
          session.seconds++;
          if (el) el.textContent = C.fmtTime(session.seconds);
          if (session.timed && session.minutes && session.seconds >= session.minutes * 60) finish();
        }
        if (session.finished && session.timer) { clearInterval(session.timer); session.timer = null; }
      }, 1000);
    }
    var toggleBtn = C.$("#p-timer-toggle", container);
    if (toggleBtn) {
      toggleBtn.addEventListener("click", function () {
        session.paused = !session.paused;
        toggleBtn.textContent = session.paused ? "Resume" : "Pause";
      });
    }
  }

  function renderSession(container, onDone) {
    if (!container || !container.isConnected) return; // navigated away
    container.innerHTML = "";
    var rec = currentRecord();
    if (!rec) { finish(); renderSummary(container, onDone); return; }

    var prog = Math.min(100, Math.round((session.idx / session.totalQuestions) * 100));
    var mcq = rec.qtype === "multiple_choice" && /^[A-E]$/i.test(String(rec.answer || ""));

    container.innerHTML =
      '<div class="practice-toolbar">' +
      '<div class="bar" style="flex:1"><span style="width:' + prog + '%"></span></div>' +
      '<span class="fine">Question ' + (session.idx + 1) + " of " + session.totalQuestions + "</span>" +
      '<span class="timer-display" id="p-timer" role="timer" aria-live="off">' + C.fmtTime(session.seconds) + "</span>" +
      '<button type="button" class="btn ghost sm" id="p-timer-toggle" aria-label="Pause or resume timer">' + (session.paused ? "Resume" : "Pause") + '</button>' +
      '<button type="button" class="btn ghost sm" id="p-quit">End session</button>' +
      "</div>" +
      '<div class="card qcard" id="p-card">' +
      '<div class="qcard-head">' +
      '<span class="qcard-num">Q' + C.escapeHtml(rec.qnum) + "</span>" +
      C.badge(rec.paper_name || "Unknown paper") +
      (rec.topic_id ? C.badge(root.QB.api.topicName(rec.topic_id) || rec.topic_id, "topic") : "") +
      C.diffBadge(rec.difficulty) + C.marksBadge(rec.marks) + C.typeBadge(rec.qtype) +
      "</div>" +
      '<p class="qcard-meta">' + C.escapeHtml(rec.paper_name || "") +
      (rec.paper_year ? " · " + rec.paper_year : "") + " · page " + rec.pages[0] +
      (rec.pages[1] !== rec.pages[0] ? "–" + rec.pages[1] : "") + "</p>" +
      '<div id="p-image"></div>' +
      '<div id="p-answer-zone"></div>' +
      "</div>";

    var imgEl = C.$("#p-image", container);
    var imgSrc = C.pickImg(rec, "image");
    if (imgSrc) {
      imgEl.appendChild(C.zoomable(imgSrc, "Question " + rec.qnum));
    } else {
      imgEl.innerHTML = '<p class="muted">Image unavailable.</p>';
    }

    var zone = C.$("#p-answer-zone", container);

    if (mcq) {
      renderMcq(zone, rec, container, onDone);
    } else {
      renderFreeResponse(zone, rec, container, onDone);
    }
    startTimer(container);
    C.$("#p-quit", container).addEventListener("click", function () {
      quit();
      renderSummary(container, onDone);
    });
  }

  function renderMcq(zone, rec, container, onDone) {
    var letters = ["A", "B", "C", "D", "E"];
    var exam = session.mode === "exam";
    zone.innerHTML =
      '<p class="fine" style="margin:14px 0 4px">' +
      (exam ? "Select your answer — it will be marked at the end." :
              "Select the correct option (read the options in the image above):") +
      "</p>" +
      '<div class="mcq-options" role="group" aria-label="Multiple choice options">' +
      letters.map(function (l) {
        return '<button class="mcq-option" data-letter="' + l + '"><span class="opt-letter">' + l + "</span>" +
          '<span class="opt-text">Option ' + l + "</span></button>";
      }).join("") +
      "</div>" +
      '<div class="feedback" id="p-feedback" hidden></div>' +
      '<div class="actions" style="margin-top:14px"><button class="btn" id="p-next" hidden>Next question</button></div>';

    var answered = false;
    C.$$(".mcq-option", zone).forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (answered) return;
        answered = true;
        var letter = btn.dataset.letter;
        var result = answerCurrent(letter);
        btn.classList.add(result.correct ? "correct" : "wrong");
        var fb = C.$("#p-feedback", zone);
        fb.hidden = false;
        if (exam) {
          fb.className = "feedback neutral";
          fb.textContent = "Answer " + letter + " recorded.";
        } else if (result.correct) {
          fb.className = "feedback correct";
          fb.textContent = "Correct — " + letter + ".";
        } else {
          fb.className = "feedback incorrect";
          fb.textContent = "Not quite. The answer is " + result.answer + ". " + mistakeFeedback();
        }
        C.$("#p-next", zone).hidden = false;
      });
    });
    C.$("#p-next", zone).addEventListener("click", function () { next(); renderSession(container, onDone); });
  }

  function renderFreeResponse(zone, rec, container, onDone) {
    var exam = session.mode === "exam";
    zone.innerHTML =
      '<div class="actions" style="margin-top:14px">' +
      '<button class="btn" id="p-reveal">' + (exam ? "Check my answer" : "Reveal answer") + "</button>" +
      "</div>" +
      '<div id="p-answer-box" hidden>' +
      '<div class="answer-box" style="background:var(--ok-soft);border:1px solid #bfe3cf;border-radius:10px;padding:14px;margin-top:12px">' +
      (rec.answer ? "<p><strong>Answer:</strong> " + C.escapeHtml(rec.answer) + "</p>" : "<p>No short answer recorded for this question.</p>") +
      '<div id="p-solution-image"></div>' +
      "</div>" +
      '<div class="actions" style="margin-top:12px">' +
      (exam
        ? '<button type="button" class="btn ok" id="p-got-right" aria-label="Mark Correct">I got it right</button>' +
          '<button type="button" class="btn ghost" id="p-got-wrong" aria-label="Mark Incorrect">I got it wrong</button>' +
          '<button type="button" class="btn ghost" id="p-got-skipped" aria-label="Mark Unattempted or Skipped">─ Skipped</button>' +
          '<span class="fine muted">Self-marked in exam mode — no hints until you check.</span>'
        : '<button type="button" class="btn ok" id="p-got-right" aria-label="Mark Correct">I got it right</button>' +
          '<button type="button" class="btn ghost" id="p-got-wrong" aria-label="Mark Incorrect">I got it wrong</button>' +
          '<button type="button" class="btn ghost" id="p-got-skipped" aria-label="Mark Unattempted or Skipped">─ Skipped</button>') +
      "</div></div>" +
      '<div class="actions" style="margin-top:14px"><button class="btn" id="p-next" hidden>Next question</button></div>';

    C.$("#p-reveal", zone).addEventListener("click", function () {
      C.$("#p-reveal", zone).hidden = true;
      C.$("#p-answer-box", zone).hidden = false;
      var sol = C.$("#p-solution-image", zone);
      var solSrc = C.pickImg(rec, "solution");
      if (solSrc) {
        sol.appendChild(C.zoomable(solSrc, "Solution for question " + rec.qnum));
      }
    });
    C.$("#p-got-right", zone).addEventListener("click", function () { selfMark(true); next(); renderSession(container, onDone); });
    C.$("#p-got-wrong", zone).addEventListener("click", function () { selfMark(false); next(); renderSession(container, onDone); });
    C.$("#p-got-skipped", zone).addEventListener("click", function () { selfMark(null); next(); renderSession(container, onDone); });
    C.$("#p-next", zone).addEventListener("click", function () { next(); renderSession(container, onDone); });
  }

  /* Playful (never harassing) feedback for wrong answers — curated, rotating,
   * deterministic per session. Used only to soften the blow of a miss and
   * point back to the working. */
  var MISTAKE_LINES = [
    "Not quite — the examiner isn't impressed yet. Review the working and come back stronger.",
    "Oof, that one slipped. The solution's right there — study it, then show it who's boss.",
    "Close? No? Okay — read the method below, then try a similar one.",
    "The mark scheme disagrees, but the next question won't know that. Onward.",
    "That's a learning moment, not a failure — check the solution and lock it in.",
  ];
  function mistakeFeedback() {
    var n = session ? session.mistakeCount = (session.mistakeCount || 0) + 1 : 1;
    return MISTAKE_LINES[(n - 1) % MISTAKE_LINES.length];
  }

  function renderSummary(container, onDone) {
    var s = summary();
    var exam = session.mode === "exam";
    var reviewRows = "";
    if (exam) {
      var recordMap = session.records || {};
      reviewRows =
        '<div class="exam-review"><h3>Review</h3>' +
        session.qids.map(function (qid, i) {
          var rec = recordMap[qid];
          var res = session.results[i];
          if (!rec) return "";
          var auto = res && res.correct !== undefined;
          var badge = auto
            ? '<span class="badge ' + (res.correct ? "marks" : "diff") + '">' + (res.correct ? "correct" : "missed") + "</span>"
            : '<span class="badge type">self-mark</span>';
          return (
            '<div class="exam-row" data-qid="' + C.escapeHtml(qid) + '">' +
            '<div><a href="#/question/' + encodeURIComponent(qid) + '">Q' + C.escapeHtml(rec.qnum || "?") + "</a>" +
            (rec.answer ? ' <span class="fine muted">answer: ' + C.escapeHtml(rec.answer) + "</span>" : "") + "</div>" +
            badge +
            (auto ? "" :
              '<div class="actions" style="gap:6px">' +
              '<button class="btn sm ok" data-self="right" data-qid="' + C.escapeHtml(qid) + '">Right</button>' +
              '<button class="btn sm ghost" data-self="wrong" data-qid="' + C.escapeHtml(qid) + '">Wrong</button></div>') +
            "</div>"
          );
        }).join("") + "</div>";
    }
    container.innerHTML =
      '<div class="card" style="max-width:640px;margin:0 auto">' +
      "<h2>Session complete</h2>" +
      '<div class="grid cols-3" style="margin:18px 0">' +
      '<div class="statcard"><div class="label">Attempted</div><div class="value">' + s.attempted + "</div></div>" +
      '<div class="statcard"><div class="label">Correct</div><div class="value">' + s.correct + "</div></div>" +
      '<div class="statcard"><div class="label">Accuracy</div><div class="value">' + s.accuracy + "%</div></div>" +
      "</div>" +
      '<p class="muted">Time: ' + C.fmtTime(s.seconds) + " · Mode: " + C.titleCase(s.name) + "</p>" +
      reviewRows +
      '<div class="actions">' +
      '<button class="btn" id="p-again">Practise again</button>' +
      '<a class="btn ghost" href="#/progress">View progress</a>' +
      "</div></div>";
    var again = C.$("#p-again", container);
    if (again) again.addEventListener("click", function () { onDone && onDone(); });
    if (exam) {
      C.$$("[data-self]", container).forEach(function (btn) {
        btn.addEventListener("click", function () {
          var qid = btn.dataset.qid;
          var idx = session.qids.indexOf(qid);
          if (idx < 0 || session.results[idx]) return;
          var rec = session.records[qid];
          var correct = btn.dataset.self === "right";
          session.results[idx] = { qid: qid, correct: correct, topic_id: rec && rec.topic_id };
          root.QB.store.recordAttempt({
            qid: qid, correct: correct, mode: "exam",
            seconds: Math.round(session.seconds / Math.max(session.totalQuestions, 1)),
            topic_id: rec && rec.topic_id,
          });
          var B = root.QB.backend;
          if (B && B.enabled() && B.currentUser()) {
            B.recordAttempt({
              question_id: qid, correct: correct,
              seconds: Math.round(session.seconds / Math.max(session.totalQuestions, 1)),
              mode: "exam", course_id: rec && rec.course_id,
              topic_id: rec && rec.topic_id, difficulty: rec && rec.difficulty,
            }).catch(function () {});
          }
          var row = C.$('[data-qid="' + C.escapeHtml(qid) + '"]', container);
          if (row) {
            row.querySelector(".badge.type").textContent = correct ? "correct" : "missed";
            row.querySelector(".badge.type").className = "badge " + (correct ? "marks" : "diff");
            row.querySelector(".actions").remove();
          }
        });
      });
    }
    C.toast("Session recorded — progress updated.");
  }

  root.QB = root.QB || {};
  root.QB.practice = {
    buildSet: buildSet, startSession: startSession, currentRecord: currentRecord,
    answerCurrent: answerCurrent, selfMark: selfMark, next: next, finish: finish,
    quit: quit, summary: summary, renderSession: renderSession, renderSummary: renderSummary,
    get session() { return session; },  // current session state (read-only view)
  };
})();
