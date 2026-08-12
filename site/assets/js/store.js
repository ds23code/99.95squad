/* ============================================================================
 * store.js — device-local student state
 * Favourites, practice history, question sets, recently viewed, submissions.
 * Stored in localStorage under one key. When a backend is connected
 * (see auth.js / docs/AUTH.md) these records sync to the user's account.
 * ==========================================================================*/
(function () {
  "use strict";

  var KEY = "qb_state_v2";
  var root = window;

  function blank() {
    return {
      user: null,                 // {id, email, name}
      plan: { tier: "free", premium_until: null },  // device-local fallback only
      favourites: [],             // [qid]
      completed: {},              // qid -> {correct, at}
      history: [],                // [{qid, correct, ts, mode, seconds, topic_id}]
      recent: [],                 // [qid] most-recent-first
      sets: [],                   // [{id, name, qids, filters}]
      submissions: [],            // [{id, name, sha, status, at, note}]
      reports: [],               // [{qid, reason, details, at}]
      profile: { name: "", goal: 10, courses: [], subjects: [], yearLevel: null, onboarded: false },
    };
  }

  var state = null;
  function load() {
    if (state) return state;
    try {
      var raw = localStorage.getItem(KEY);
      state = raw ? Object.assign(blank(), JSON.parse(raw)) : blank();
    } catch (e) {
      state = blank();
    }
    return state;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }
  function reset() {
    state = blank();
    save();
  }
  function exportJSON() { return JSON.stringify(load(), null, 2); }
  function importJSON(text) {
    var data = JSON.parse(text);
    state = Object.assign(blank(), data);
    save();
  }

  /* ------------------------------------------------------------ favourites */
  function isFavourite(qid) { return load().favourites.indexOf(qid) !== -1; }
  function toggleFavourite(qid) {
    var s = load();
    var i = s.favourites.indexOf(qid);
    if (i === -1) s.favourites.unshift(qid);
    else s.favourites.splice(i, 1);
    save();
    return isFavourite(qid);
  }

  /* --------------------------------------------------------------- recent */
  function recordView(qid) {
    var s = load();
    s.recent = s.recent.filter(function (x) { return x !== qid; });
    s.recent.unshift(qid);
    if (s.recent.length > 40) s.recent.length = 40;
    save();
  }

  /* --------------------------------------------------------------- history */
  function recordAttempt(attempt) {
    /* attempt: {qid, correct, mode, seconds, topic_id} */
    var s = load();
    var corrVal = attempt.correct === null || attempt.correct === undefined ? null : !!attempt.correct;
    s.history.push(Object.assign({
      qid: attempt.qid, correct: corrVal, mode: attempt.mode || "practice",
      seconds: Math.round(attempt.seconds || 0), ts: new Date().toISOString(),
      topic_id: attempt.topic_id || null,
    }, {}));
    s.completed[attempt.qid] = { correct: corrVal, at: new Date().toISOString() };
    save();
  }

  /* ---------------------------------------------------------------- sets */
  function createSet(name, qids, filters) {
    var s = load();
    var set = {
      id: "set-" + Date.now().toString(36),
      name: name || "Untitled set",
      qids: qids || [],
      filters: filters || {},
      created: new Date().toISOString(),
    };
    s.sets.unshift(set);
    save();
    return set;
  }
  function deleteSet(id) {
    var s = load();
    s.sets = s.sets.filter(function (x) { return x.id !== id; });
    save();
  }
  function getSet(id) {
    return load().sets.filter(function (x) { return x.id === id; })[0] || null;
  }

  /* --------------------------------------------------------- submissions */
  function addSubmission(sub) {
    var s = load();
    s.submissions.unshift(Object.assign({ at: new Date().toISOString(), status: "pending" }, sub));
    save();
    return s.submissions[0];
  }
  function updateSubmission(id, patch) {
    var s = load();
    s.submissions = s.submissions.map(function (x) { return x.id === id ? Object.assign({}, x, patch) : x; });
    save();
  }

  /* ------------------------------------------------------------- reports */
  function addReport(report) {
    var s = load();
    s.reports.unshift(Object.assign({ at: new Date().toISOString() }, report));
    save();
  }

  /* ----------------------------------------------------------- analytics */
  function analytics() {
    var s = load();
    var total = s.history.length;
    var attempted = s.history.filter(function (h) { return h.correct !== null && h.correct !== undefined; }).length;
    var correct = s.history.filter(function (h) { return h.correct === true; }).length;
    var accuracy = attempted ? Math.round((correct / attempted) * 100) : 0;
    var seconds = s.history.reduce(function (a, h) { return a + (h.seconds || 0); }, 0);

    // per-topic stats
    var byTopic = {};
    s.history.forEach(function (h) {
      var t = h.topic_id || "unknown";
      byTopic[t] = byTopic[t] || { n: 0, attempted: 0, correct: 0 };
      byTopic[t].n++;
      if (h.correct !== null && h.correct !== undefined) byTopic[t].attempted++;
      if (h.correct === true) byTopic[t].correct++;
    });
    var topicStats = Object.keys(byTopic).map(function (t) {
      return { topic_id: t, n: byTopic[t].n, correct: byTopic[t].correct,
        accuracy: byTopic[t].attempted ? Math.round((byTopic[t].correct / byTopic[t].attempted) * 100) : 0 };
    }).sort(function (a, b) { return a.accuracy - b.accuracy; });

    // streak: consecutive days with >=1 attempt
    var tk = function (d) { return root.QB.core.todayKey(d); };
    var days = {};
    s.history.forEach(function (h) { days[String(h.ts).slice(0, 10)] = true; });
    var dayList = Object.keys(days).sort();
    var streak = 0;
    if (dayList.length) {
      var cursor = new Date();
      var key = tk(cursor);
      if (!days[key]) {
        cursor.setDate(cursor.getDate() - 1);
        key = tk(cursor);
      }
      while (days[key]) { streak++; cursor.setDate(cursor.getDate() - 1); key = tk(cursor); }
    }

    // activity per day (last 14 days)
    var activity = [];
    for (var i = 13; i >= 0; i--) {
      var d = new Date(); d.setDate(d.getDate() - i);
      var k = tk(d);
      activity.push({
        label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
        value: s.history.filter(function (h) { return String(h.ts).slice(0, 10) === k; }).length,
        key: k === tk(new Date()),
      });
    }

    // weak topics: lowest accuracy with n >= 3
    var weak = topicStats.filter(function (t) { return t.n >= 3 && t.accuracy < 70; }).slice(0, 5);
    // daily free limit
    var usedToday = s.history.filter(function (h) { return String(h.ts).slice(0, 10) === tk(new Date()); }).length;

    return {
      total: total, correct: correct, accuracy: accuracy, seconds: seconds,
      topicStats: topicStats, weak: weak, streak: streak, activity: activity,
      usedToday: usedToday, byTopic: byTopic,
    };
  }

  /* Study preferences: local profile first, then cached Supabase profile. */
  function prefs() {
    var s = load();
    var local = s.profile || {};
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem("qb_profile_cache")); } catch (e) { cached = null; }
    var subjects = [];
    var courses = [];
    if (cached && cached.subjects && cached.subjects.length) subjects = cached.subjects.slice();
    else if (local.subjects && local.subjects.length) subjects = local.subjects.slice();
    if (cached && cached.courses && cached.courses.length) courses = cached.courses.slice();
    else if (local.courses && local.courses.length) courses = local.courses.slice();
    return {
      subjects: subjects,
      courses: courses,
      onboarded: !!(local.onboarded || (cached && cached.onboarding_completed)),
      yearLevel: (cached && cached.year_level) || local.yearLevel || null,
      goal: (cached && cached.daily_goal) || local.goal || 10,
      optOut: !!(cached && cached.opt_out_leaderboard),
      displayName: (cached && cached.display_name) || local.name || "",
      avatarUrl: (cached && cached.avatar_url) || null,
    };
  }

  /* Restrict question queries to the student's selected subjects/courses
   * unless the caller already set an explicit subject/course filter. */
  function applyContentScope(filters) {
    var f = Object.assign({}, filters || {});
    var p = prefs();
    if (f.course || f.subject || (f.subjects && f.subjects.length) || (f.courses && f.courses.length)) {
      return f;
    }
    if (p.courses && p.courses.length) f.courses = p.courses.slice();
    else if (p.subjects && p.subjects.length) f.subjects = p.subjects.slice();
    return f;
  }

  root.QB = root.QB || {};
  root.QB.store = {
    load: load, save: save, reset: reset, exportJSON: exportJSON, importJSON: importJSON,
    isFavourite: isFavourite, toggleFavourite: toggleFavourite,
    recordView: recordView, recordAttempt: recordAttempt,
    createSet: createSet, deleteSet: deleteSet, getSet: getSet,
    addSubmission: addSubmission, updateSubmission: updateSubmission,
    addReport: addReport, analytics: analytics, blank: blank,
    prefs: prefs, applyContentScope: applyContentScope,
  };
})();
