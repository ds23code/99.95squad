#!/usr/bin/env node
/* ============================================================================
 * dom_smoke.js — real-browser DOM smoke test for the static site.
 *
 * Loads the built site in jsdom, executes the actual frontend, and exercises:
 *   landing page, search, filters, empty states, question page, favourites,
 *   practice mode (MCQ answering + summary), progress analytics, upload flow
 *   (hash + dedupe + queue), login, and the 404 route.
 *
 * Two modes:
 *   stub (default)  — JSON via a local fs stub; verifies every emitted image
 *                     URL is a *public* content URL (content/images/...).
 *   live            — pass a base URL as the 4th argument
 *                     (`node scripts/dom_smoke.js site/_site node_modules/jsdom http://127.0.0.1:8080/`):
 *                     jsdom fetches real JSON over HTTP AND loads every
 *                     <img> through jsdom's resource loader; any failed
 *                     image (404 etc.) is recorded and fails the run.
 *
 * Exit code 0 = all checks passed.
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const siteDir = path.resolve(process.argv[2] || "site/_site");
const jsdomPath = process.argv[3] || "jsdom";
const liveBase = process.argv[4] ? String(process.argv[4]).replace(/\/$/, "") + "/" : null;
const supabaseMock = process.argv[5] === "--mock-supabase";
const { JSDOM } = require(jsdomPath);

/* ----------------------------------------------------------------------------
 * In-memory Supabase mock (only active with --mock-supabase).
 * Implements just enough of /auth/v1 + /rest/v1/rpc for the real frontend:
 *   - password sign-in
 *   - record_attempt (server-side XP + streak, mirroring supabase.sql)
 *   - get_dashboard / topic_mastery / daily_activity / time_stats
 *   - leaderboard / my_rank
 *   - comments (add/like/report/delete/list)
 *   - favourites
 * XP/streaks are computed HERE (mimicking the SECURITY DEFINER functions) —
 * the frontend never computes or stores them itself.
 * -------------------------------------------------------------------------- */
function makeSupabaseMock() {
  const state = {
    users: {},        // id -> {id, email, display_name, xp, level, daily_goal, opt_out_leaderboard, avatar_url}
    attempts: [],     // {user_id, question_id, correct, seconds, mode, course_id, topic_id, difficulty, created_at, xp}
    comments: [],     // {id, question_id, user_id, parent_id, body, likes, created_at}
    likes: [],        // {user_id, comment_id}
    session: null,    // {access_token, user}
  };
  let seq = 1;
  const now = new Date();
  function key(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function daysAgo(n) { const d = new Date(now); d.setDate(d.getDate() - n); return key(d); }
  function xpForDiff(d) { d = Number(d); return d <= 1 ? 5 : d <= 2 ? 10 : d <= 3 ? 15 : d <= 4 ? 25 : 40; }
  function levelFromXp(xp) { return Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * xp) / 50)) / 2)); }
  function streakFor(uid) {
    const days = new Set(state.attempts.filter((a) => a.user_id === uid).map((a) => key(new Date(a.created_at))));
    let streak = 0; let cur = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (;;) {
      const k = cur.getFullYear() + "-" + String(cur.getMonth() + 1).padStart(2, "0") + "-" + String(cur.getDate()).padStart(2, "0");
      if (!days.has(k)) break;
      streak++; cur.setDate(cur.getDate() - 1);
    }
    return streak;
  }
  function userById(uid) { return state.users[uid]; }
  function seedUser() {
    const uid = "user-" + seq++;
    const u = { id: uid, email: "student@school.edu.au", display_name: "Demo Student",
                xp: 0, level: 1, daily_goal: 10, opt_out_leaderboard: false, avatar_url: null };
    state.users[uid] = u;
    // seed 3 days of history so streak/calendar/leaderboard have data
    const hist = [
      { d: daysAgo(2), q: "h-q1", correct: true, sec: 30, diff: 2, topic: "mathematics-advanced:calculus" },
      { d: daysAgo(2), q: "h-q2", correct: true, sec: 45, diff: 3, topic: "mathematics-advanced:calculus" },
      { d: daysAgo(1), q: "h-q3", correct: false, sec: 60, diff: 3, topic: "mathematics-advanced:trigonometry" },
      { d: daysAgo(1), q: "h-q4", correct: true, sec: 25, diff: 1, topic: "mathematics-advanced:functions" },
      { d: daysAgo(0), q: "h-q5", correct: true, sec: 40, diff: 4, topic: "mathematics-advanced:calculus" },
    ];
    hist.forEach((h) => {
      const xp = h.correct ? xpForDiff(h.diff) : 0;
      state.attempts.push({ user_id: uid, question_id: h.q, correct: h.correct, seconds: h.sec,
        mode: "practice", course_id: "mathematics-advanced", topic_id: h.topic, difficulty: h.diff,
        created_at: h.d + "T09:00:00Z", xp: xp });
      u.xp += xp;
    });
    u.level = levelFromXp(u.xp);
    return u;
  }
  function dashboard(uid) {
    const u = userById(uid);
    const mine = state.attempts.filter((a) => a.user_id === uid);
    const total = mine.length;
    const correct = mine.filter((a) => a.correct).length;
    const today = mine.filter((a) => key(new Date(a.created_at)) === key(now));
    const byTopic = {};
    mine.forEach((a) => {
      if (!a.topic_id) return;
      byTopic[a.topic_id] = byTopic[a.topic_id] || { topic_id: a.topic_id, attempts: 0, correct: 0, xp: 0 };
      byTopic[a.topic_id].attempts++; if (a.correct) byTopic[a.topic_id].correct++; byTopic[a.topic_id].xp += a.xp;
    });
    const mastery = Object.keys(byTopic).map((t) => {
      const s = byTopic[t];
      const acc = 100 * s.correct / s.attempts;
      const stage = s.attempts < 3 ? "learning" : acc >= 90 ? "mastered" : acc >= 70 ? "strong" : "practising";
      return { topic_id: t, attempts: s.attempts, correct: s.correct, accuracy: Math.round(acc * 10) / 10, stage: stage };
    });
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = daysAgo(i);
      const dd = mine.filter((a) => key(new Date(a.created_at)) === d);
      days.push({ date: d, questions: dd.length, correct: dd.filter((a) => a.correct).length,
        seconds: dd.reduce((s, a) => s + a.seconds, 0), xp: dd.reduce((s, a) => s + a.xp, 0),
        topics: Array.from(new Set(dd.map((a) => a.topic_id).filter(Boolean))) });
    }
    return {
      profile: { id: u.id, display_name: u.display_name, avatar_url: u.avatar_url,
        access_tier: "free", is_admin: false, daily_goal: u.daily_goal, opt_out_leaderboard: u.opt_out_leaderboard },
      xp: u.xp, level: u.level, streak: streakFor(uid),
      xp_today: today.reduce((s, a) => s + a.xp, 0),
      questions_today: today.length, correct_today: today.filter((a) => a.correct).length,
      total_questions: total, accuracy: total ? Math.round(100 * correct / total) : 0,
      mastery: mastery, achievements: [
        { code: "first-question", name: "First steps", desc: "Answered your first question", unlocked: true },
        { code: "q10", name: "Getting going", desc: "Answered 10 questions", unlocked: total >= 10 },
      ], activity: days,
    };
  }
  function router(reqUrl, opts) {
    const url = new URL(reqUrl);
    const body = opts.body ? JSON.parse(opts.body) : {};
    const auth = (opts.headers || {}).Authorization || "";
    const bearer = auth.replace("Bearer ", "");
    function requireUser() {
      if (!state.session || state.session.access_token !== bearer) throw new Error("not authenticated");
      return state.session.user;
    }
    try {
      // ---- auth ----
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
        const u = Object.values(state.users).find((x) => x.email === body.email) || seedUser();
        state.session = { access_token: "tok-" + u.id, user: { id: u.id, email: u.email, user_metadata: { name: u.display_name } } };
        return { status: 200, json: { access_token: state.session.access_token, user: state.session.user } };
      }
      if (url.pathname === "/auth/v1/user") {
        if (!state.session) return { status: 401, json: {} };
        return { status: 200, json: state.session.user };
      }
      // ---- rpc ----
      if (url.pathname === "/rest/v1/rpc/record_attempt") {
        const u = requireUser();
        const xp = body.p_correct ? xpForDiff(body.p_difficulty || 1) : 0;
        state.attempts.push({ user_id: u.id, question_id: body.p_question_id, correct: body.p_correct,
          seconds: body.p_seconds || 0, mode: body.p_mode || "practice", course_id: body.p_course_id,
          topic_id: body.p_topic_id, difficulty: body.p_difficulty, created_at: now.toISOString(), xp: xp });
        const prof = userById(u.id);
        prof.xp += xp; prof.level = levelFromXp(prof.xp);
        return { status: 200, json: { xp_earned: xp, bonus: 0, correct: body.p_correct, level: prof.level,
          streak: streakFor(u.id), xp_today: state.attempts.filter((a) => a.user_id === u.id && key(new Date(a.created_at)) === key(now)).reduce((s, a) => s + a.xp, 0),
          questions_today: state.attempts.filter((a) => a.user_id === u.id && key(new Date(a.created_at)) === key(now)).length } };
      }
      if (url.pathname === "/rest/v1/rpc/get_dashboard") return { status: 200, json: dashboard(body.p_user) };
      if (url.pathname === "/rest/v1/rpc/topic_mastery") {
        const u = userById(body.p_user); if (!u) return { status: 200, json: [] };
        return { status: 200, json: dashboard(body.p_user).mastery };
      }
      if (url.pathname === "/rest/v1/rpc/daily_activity") {
        const u = userById(body.p_user); if (!u) return { status: 200, json: [] };
        return { status: 200, json: dashboard(body.p_user).activity };
      }
      if (url.pathname === "/rest/v1/rpc/time_stats") {
        const u = userById(body.p_user);
        const mine = (u ? state.attempts.filter((a) => a.user_id === u.id) : []).map((a) => a.seconds);
        const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
        const med = (arr) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
        const all = state.attempts.map((a) => a.seconds);
        return { status: 200, json: {
          user: { avg_seconds: Math.round(avg(mine) * 10) / 10, median_seconds: Math.round(med(mine) * 10) / 10, n: mine.length },
          global: { avg_seconds: Math.round(avg(all) * 10) / 10, median_seconds: Math.round(med(all) * 10) / 10, n: all.length },
          user_correct: 20, user_incorrect: 40, global_correct: 25, global_incorrect: 50,
          faster_slower_pct: 0 } };
      }
      if (url.pathname === "/rest/v1/rpc/leaderboard") {
        const rows = Object.values(state.users).filter((u) => !u.opt_out_leaderboard)
          .map((u) => ({ user_id: u.id, display_name: u.display_name, avatar_url: u.avatar_url, xp: u.xp, level: u.level }))
          .sort((a, b) => b.xp - a.xp)
          .map((r, i) => Object.assign({ rank: i + 1 }, r));
        return { status: 200, json: rows.slice(body.p_offset || 0, (body.p_offset || 0) + (body.p_limit || 50)) };
      }
      if (url.pathname === "/rest/v1/rpc/add_comment") {
        const u = requireUser();
        const c = { id: seq++, question_id: body.p_question_id, user_id: u.id, parent_id: body.p_parent_id || null,
          body: body.p_body, likes: 0, created_at: now.toISOString(), display_name: userById(u.id).display_name };
        if (/(fuck|dick|shit)/i.test(c.body)) return { status: 400, json: { message: "comment contains prohibited language" } };
        state.comments.push(c);
        return { status: 200, json: c };
      }
      if (url.pathname === "/rest/v1/rpc/like_comment") {
        const u = requireUser();
        const i = state.likes.findIndex((l) => l.user_id === u.id && l.comment_id === body.p_comment_id);
        if (i >= 0) state.likes.splice(i, 1); else state.likes.push({ user_id: u.id, comment_id: body.p_comment_id });
        const likes = state.likes.filter((l) => l.comment_id === body.p_comment_id).length;
        return { status: 200, json: { liked: i < 0, likes: likes } };
      }
      if (url.pathname === "/rest/v1/rpc/report_comment") return { status: 200, json: true };
      if (url.pathname === "/rest/v1/rpc/delete_own_comment") {
        const u = requireUser();
        const i = state.comments.findIndex((c) => c.id === body.p_comment_id && c.user_id === u.id);
        if (i >= 0) state.comments.splice(i, 1);
        return { status: 200, json: i >= 0 };
      }
      // ---- rest tables ----
      if (url.pathname === "/rest/v1/comments" && url.searchParams.get("select")) {
        const qid = decodeURIComponent((url.searchParams.get("question_id") || "").replace(/^eq\./, ""));
        const rows = state.comments.filter((c) => c.question_id === qid)
          .map((c) => Object.assign({}, c, { display_name: userById(c.user_id).display_name }));
        return { status: 200, json: rows };
      }
      if (url.pathname === "/rest/v1/favourites" && url.method === "GET") {
        return { status: 200, json: [] };
      }
      if (url.pathname === "/rest/v1/favourites" && url.method === "POST") return { status: 200, json: [body] };
      if (url.pathname === "/rest/v1/favourites" && url.method === "DELETE") return { status: 200, json: [] };
      return { status: 404, json: { message: "mock: no route " + url.pathname } };
    } catch (e) {
      return { status: 400, json: { message: e.message } };
    }
  }
  return { state, router };
}

const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf8");
const dom = new JSDOM(html, {
  url: liveBase || "https://example.com/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  resources: liveBase ? "usable" : undefined,  // live: actually load <img>/<link> over HTTP
});
const { window } = dom;
const { webcrypto } = require("crypto");


if (!window.crypto || !window.crypto.subtle) {
  try {
    Object.defineProperty(window, "crypto", {
      value: webcrypto, configurable: true, writable: true,
    });
  } catch (e) { /* jsdom may expose a non-configurable getter */ }
}
window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = function () {};
window.confirm = () => true;
window.prompt = (msg, def) => def || "reported by test";

/* image load failures (live mode): any <img> that 404s fires an error event */
const failedImageUrls = [];
if (liveBase) {
  window.document.addEventListener("error", function (e) {
    const t = e.target;
    if (t && t.tagName === "IMG") failedImageUrls.push(t.getAttribute("src") || "(no src)");
  }, true);
}

let mock = null;
if (supabaseMock) {
  // turn on the backend + point it at the in-memory mock
  mock = makeSupabaseMock();
  window.fetch = (url, opts) => {
    opts = opts || {};
    const abs = String(url);
    if (abs.indexOf("mock.supabase.co") !== -1) {
      const res = mock.router(abs, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
      return Promise.resolve({ ok: res.status < 400, status: res.status, json: () => Promise.resolve(res.json) });
    }
    // static content from disk (stub)
    const clean = abs.replace(/^https:\/\/example\.com\//, "").replace(/^\.\//, "");
    const file = path.join(siteDir, decodeURIComponent(clean.split("?")[0]));
    return fs.promises.readFile(file).then(
      (buf) => ({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(buf.toString("utf8"))) }),
      () => ({ ok: false, status: 404, json: () => Promise.resolve({}) })
    );
  };
} else if (liveBase) {
  // real network for JSON (node >= 18 has global fetch, which requires
  // absolute URLs — resolve relative ones against the document base)
  window.fetch = (url) => globalThis.fetch(new URL(url, window.location.href).href);
} else {
  window.fetch = (url) => {
    const clean = String(url).replace(/^https:\/\/example\.com\//, "").replace(/^\.\//, "");
    const file = path.join(siteDir, decodeURIComponent(clean.split("?")[0]));
    return fs.promises.readFile(file).then(
      (buf) => ({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(buf.toString("utf8"))) }),
      () => ({ ok: false, status: 404, json: () => Promise.resolve({}) })
    );
  };
}

let failures = [];
function check(name, cond, extra) {
  if (cond) console.log("  ✓ " + name);
  else { failures.push(name); console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(cond, timeout, label) {
  const start = Date.now();
  while (Date.now() - start < (timeout || 8000)) {
    if (cond()) return true;
    await sleep(60);
  }
  console.log("  (timeout waiting for: " + label + ")");
  return false;
}
const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => Array.prototype.slice.call(window.document.querySelectorAll(sel));
function nav(hash) {
  // jsdom fires hashchange automatically when location.hash is set
  window.location.hash = hash;
}
function click(el) { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }

// load the app scripts in order (config first)
const scripts = ["config.js", "core.js", "store.js", "api.js", "search.js",
  "gamification.js", "backend.js", "auth.js", "calendar.js", "comments.js",
  "practice.js", "pages.js", "main.js"];
for (const s of scripts) {
  const file = s === "config.js" ? "config.js" : path.join("assets", "js", s);
  const code = fs.readFileSync(path.join(siteDir, file), "utf8");
  window.eval(code);
  if (supabaseMock && s === "config.js") {
    window.QB_CONFIG.SUPABASE_URL = "https://mock.supabase.co";
    window.QB_CONFIG.SUPABASE_ANON_KEY = "mock-anon";
  }
}

async function main() {
  // ---- landing ---------------------------------------------------------
  await waitFor(() => $(".hero h1"), 8000, "landing hero");
  check("landing page renders hero", !!$(".hero h1"));
  check("landing shows question stats", !!$(".hero-stats .stat-num"));

  // ---- browse: text search ----------------------------------------------
  nav("#/browse?q=normal+distribution");
  await waitFor(() => $(".qcard"), 10000, "search results");
  const count = $("[id=b-count]") ? $("[id=b-count]").textContent : "";
  check("search finds normal-distribution questions", count.indexOf("1 question") !== -1 || $$(".qcard").length >= 1, count);
  const cardImg = $(".qcard img");
  check("question card image lazy-loads", cardImg && cardImg.getAttribute("loading") === "lazy");

  // ---- browse: filters only ----------------------------------------------
  nav("#/browse?course=mathematics-advanced&difficulty_min=3");
  await waitFor(() => $(".qcard"), 10000, "filtered results");
  check("filtered browse renders cards", $$(".qcard").length >= 1);

  // ---- browse: empty state ------------------------------------------------
  nav("#/browse?q=zzzznonsenseword");
  await waitFor(() => $(".empty-state"), 10000, "empty state");
  check("empty state shown for no matches", !!$(".empty-state"));

  // ---- question page -------------------------------------------------------
  // discover a real question id (prefer an MCQ) from the exported content
  const lookup = JSON.parse(fs.readFileSync(path.join(siteDir, "content", "questions", "lookup.json"), "utf8"));
  const shardIds = Object.keys(lookup);
  let qid = null;
  for (const id of shardIds) {
    const ref = lookup[id];
    const recs = JSON.parse(fs.readFileSync(
      path.join(siteDir, "content", "questions", ref[0], "shard-" + ref[1] + ".json"), "utf8"));
    const rec = recs.find((r) => r.id === id);
    if (rec && rec.qtype === "multiple_choice") { qid = id; break; }
  }
  if (!qid) qid = shardIds[0];
  nav("#/question/" + qid);
  await waitFor(() => $(".qcard-num"), 10000, "question page");
  check("question page renders", !!$(".qcard-num"));
  const detailImg = $(".qimg-detail");
  check("question image zoomable", !!detailImg);
  if (detailImg) {
    const src = detailImg.getAttribute("src") || "";
    check("question image URL is a public content URL",
      src.indexOf("content/images/") !== -1, src);
    if (!liveBase) {
      // relative form under the site root: must NOT start with "/"
      check("question image URL is relative (no leading slash)", src.charAt(0) !== "/", src);
    }
  }
  const favBtn = $("[id=q-fav]");
  click(favBtn);
  await sleep(150);
  check("favourite toggle works", $("[id=q-fav]").textContent.indexOf("Saved") !== -1);
  const recents = window.QB.store.load().recent;
  check("recently viewed recorded", recents.length >= 1 && recents[0] === qid);

  // ---- practice: MCQ session -----------------------------------------------
  nav("#/practice");
  await waitFor(() => $("[id=p-setup]"), 10000, "practice setup");
  // pick multiple choice from mathematics advanced
  const courseSel = $("[id=p-course]");
  courseSel.value = "mathematics-advanced";
  courseSel.dispatchEvent(new window.Event("change"));
  const typeSel = $("[id=p-type]");
  typeSel.value = "multiple_choice";
  click($("[id=p-setup] button[type=submit]"));
  await waitFor(() => $(".mcq-option"), 10000, "practice question");
  check("practice session starts with MCQ", !!$(".mcq-option"));
  const optA = $$(".mcq-option")[0];
  click(optA);
  await sleep(200);
  const fb = $("[id=p-feedback]");
  check("MCQ answer feedback appears", !!fb && !fb.hidden);
  check("feedback is correct/incorrect", fb && (fb.textContent.indexOf("Correct") !== -1 || fb.textContent.indexOf("answer is") !== -1));
  check("mistake feedback is playful but kind", fb && (fb.textContent.indexOf("answer is") === -1 || /not quite|examiner|learning moment|onward|stronger|check the working|method/i.test(fb.textContent)));
  click($("[id=p-next]"));
  await sleep(200);
  // finish session quickly: answer whatever comes
  for (let i = 0; i < 12; i++) {
    const mcq = $(".mcq-option");
    const reveal = $("[id=p-reveal]");
    const next = $("[id=p-next]");
    const got = $("[id=p-got-right]");
    if (!mcq && !reveal) break;
    if (mcq) { click(mcq); await sleep(80); const n = $("[id=p-next]"); if (n) click(n); }
    else if (reveal) { click(reveal); await sleep(80); const g = $("[id=p-got-right]"); if (g) click(g); }
    await sleep(80);
  }
  await waitFor(() => $(".statcard .value"), 5000, "session summary");
  check("session summary rendered", !!$(".statcard .value"));

  // ---- practice: exam mode ---------------------------------------------------
  nav("#/practice");
  await waitFor(() => $("[id=p-setup]"), 10000, "practice setup (exam)");
  const srcSel = $("[id=p-source]");
  srcSel.value = "exam";
  const examCourse = $("[id=p-course]");
  examCourse.value = "mathematics-advanced";
  examCourse.dispatchEvent(new window.Event("change"));
  const examType = $("[id=p-type]");
  examType.value = "multiple_choice";
  click($("[id=p-setup] button[type=submit]"));
  await waitFor(() => $(".mcq-option"), 10000, "exam question");
  check("exam mode: timed forced on", window.QB.practice.session && window.QB.practice.session.timed === true);
  const examOpt = $$(".mcq-option")[0];
  click(examOpt);
  await sleep(200);
  const examFb = $("[id=p-feedback]");
  check("exam mode: answer recorded without reveal", examFb && examFb.textContent.indexOf("recorded") !== -1, examFb && examFb.textContent);
  click($("[id=p-next]"));
  await sleep(150);
  // jump to the summary via the quit button
  const quitBtn = $("[id=p-quit]");
  if (quitBtn) click(quitBtn);
  await waitFor(() => $(".exam-review"), 5000, "exam review");
  check("exam mode: end-of-session review shown", !!$(".exam-review"));
  const selfBtn = $('[data-self="right"]');
  if (selfBtn) { click(selfBtn); await sleep(150); check("exam mode: self-mark records attempt", window.QB.store.analytics().total >= 1); }

  // ---- progress analytics ----------------------------------------------------
  nav("#/progress");
  await waitFor(() => $("[id=pr-activity]"), 8000, "progress page");
  const attempts = window.QB.store.analytics().total;
  check("progress records attempts", attempts >= 1, "attempts=" + attempts);
  check("activity chart renders", !!$("#pr-activity svg"));

  // ---- upload flow ------------------------------------------------------------
  nav("#/upload");
  await waitFor(() => $("[id=dz]"), 8000, "upload page");
  // prime the published-hashes cache so we can exercise the duplicate path
  const nodeCrypto = require("crypto");
  const knownHashes = await window.QB.api.knownHashes();
  const dupBytes = Uint8Array.from(Buffer.from("%PDF-dup"));
  const dupHash = nodeCrypto.createHash("sha256").update(Buffer.from(dupBytes)).digest("hex");
  knownHashes[dupHash] = { name: "Existing Trial 2025", kind: "paper" };

  function fakePdf(name, bytes, size) {
    return {
      name: name,
      type: "application/pdf",
      size: size || bytes.length,
      arrayBuffer: () => Promise.resolve(Uint8Array.from(Buffer.from(bytes)).buffer),
    };
  }
  const goodPdf = fakePdf("My_School_2025_Physics_Trial.pdf", "%PDF-1.4 some content");
  const dupPdf = fakePdf("Copy_of_Existing_Trial.pdf", Buffer.from(dupBytes).toString("latin1"));
  const badMagic = fakePdf("virus.exe.pdf", "MZ\x90\x00 fake exe content");
  const tooBig = fakePdf("Huge.pdf", "%PDF-1.4", 30 * 1024 * 1024);
  function dropFile(file, ack) {
    const dz = $("[id=dz]");
    const cb = $("[id=dz-ack]");
    if (cb) cb.checked = !!ack;
    const dropEvent = new window.Event("drop", { bubbles: true });
    Object.defineProperty(dropEvent, "dataTransfer", { value: { files: [file] } });
    dz.dispatchEvent(dropEvent);
  }

  // no copyright acknowledgement -> rejected
  dropFile(goodPdf, false);
  await waitFor(() => $("[id=dz-result]") && $("[id=dz-result]").textContent.indexOf("authorised") !== -1, 8000, "ack required");
  check("upload requires copyright acknowledgement", $("[id=dz-result]").textContent.indexOf("authorised") !== -1);

  // magic-byte check rejects non-PDFs
  dropFile(badMagic, true);
  await waitFor(() => $("[id=dz-result]") && $("[id=dz-result]").textContent.indexOf("does not look like a PDF") !== -1, 8000, "magic rejected");
  check("non-PDF rejected by magic bytes", $("[id=dz-result]").textContent.indexOf("does not look like a PDF") !== -1);

  // size limit
  dropFile(tooBig, true);
  await waitFor(() => $("[id=dz-result]") && $("[id=dz-result]").textContent.indexOf("limit") !== -1, 8000, "size rejected");
  check("oversize file rejected", $("[id=dz-result]").textContent.indexOf("limit") !== -1);

  // valid upload -> queued
  dropFile(goodPdf, true);
  await waitFor(() => $("[id=dz-result]") && $("[id=dz-result]").textContent.indexOf("Queued") !== -1, 12000, "upload queued");
  const dzText = $("[id=dz-result]") ? $("[id=dz-result]").textContent : "";
  check("upload hashed + queued (not auto-published)", dzText.indexOf("Queued for review") !== -1, dzText.slice(0, 120));
  const subs = window.QB.store.load().submissions;
  check("submission stored with pending status", subs.length >= 1 && subs[0].status === "pending");

  // duplicate detection: a file whose hash matches a published paper
  dropFile(dupPdf, true);
  await waitFor(() => $("[id=dz-result]") && $("[id=dz-result]").textContent.indexOf("already in the library") !== -1, 12000, "duplicate flagged");
  check("duplicate upload flagged", $("[id=dz-result]").textContent.indexOf("already in the library") !== -1);

  // ---- onboarding + Today dashboard -------------------------------------------
  nav("#/onboarding");
  await waitFor(() => $("[id=o-save]"), 8000, "onboarding page");
  const yearSel = $("[id=o-year]");
  yearSel.value = "12";
  const courseBoxes = $$("#o-courses input");
  if (courseBoxes.length) courseBoxes[0].checked = true;
  click($("[id=o-save]"));
  await waitFor(() => $(".statcard .label") && window.document.body.textContent.indexOf("Today") !== -1, 8000, "dashboard Today");
  const profile = window.QB.store.load().profile;
  check("onboarding saved profile", profile.onboarded === true && profile.goal === 10);
  if (!supabaseMock) {
    check("dashboard renders after onboarding", window.document.body.textContent.indexOf("Continue practising") !== -1);
  }

  // ---- login (device-local mode) ----------------------------------------------
  nav("#/login");
  await waitFor(() => $("[id=a-email]"), 8000, "login page");
  $("[id=a-email]").value = "student@school.edu.au";
  $("[id=a-pass]").value = "password123";
  click($("[id=a-submit]"));
  await waitFor(() => $("[id=nav-account]") && $("[id=nav-account]").textContent.indexOf("dashboard") !== -1, 8000, "signed in");
  const user = window.QB.auth.currentUser();
  check("sign-in works (local provider)", !!(user && user.email === "student@school.edu.au"));

  // ---- 404 ---------------------------------------------------------------------
  nav("#/definitely-not-a-page");
  await waitFor(() => $(".empty-state h2"), 8000, "404 page");
  check("unknown route shows 404", !!$(".empty-state h2"));

  // ---- report page ---------------------------------------------------------------
  nav("#/report/" + qid);
  await waitFor(() => $("[id=r-submit]"), 8000, "report page");
  click($("[id=r-submit]"));
  await sleep(200);
  if (!supabaseMock) {
    check("problem report stored", window.QB.store.load().reports.length >= 1);
  }

  // ---- SUPABASE-MOCK MODE: full learning-platform flows ----------------------
  if (supabaseMock) {
    // session was created by the base-section sign-in (supabase provider)
    check("auth: persistent session present", !!window.QB.auth.currentUser());
    check("auth: provider is supabase", window.QB.auth.provider() === "supabase");
    // sign-out then sign-in again proves the full auth lifecycle
    await window.QB.auth.signOut();
    check("auth: sign-out clears session", window.QB.auth.currentUser() == null);
    nav("#/login");
    await waitFor(() => $("[id=a-email]"), 8000, "login page (mock)");
    $("[id=a-email]").value = "student@school.edu.au";
    $("[id=a-pass]").value = "password123";
    click($("[id=a-submit]"));
    await waitFor(() => window.QB.auth.currentUser() != null, 8000, "signed in (mock)");
    check("auth: sign-in creates session", !!window.QB.auth.currentUser());
    await sleep(300); // let any trailing navigation settle before the question visit

    // record an attempt on a question -> server XP feedback
    nav("#/question/" + qid);
    const qpOk = await waitFor(() => $("[id=q-correct]"), 10000, "question page (mock)");
    if (!qpOk) { console.log("APP HTML (mock q timeout):", (window.document.querySelector("#app").innerHTML || "").slice(0, 400)); }
    click($("[id=q-correct]"));
    await waitFor(() => $("[id=q-xp-feedback]") && !$("[id=q-xp-feedback]").hidden, 8000, "xp feedback");
    const xpText = $("[id=q-xp-feedback]").textContent;
    check("gamification: XP feedback shown", xpText.indexOf("XP") !== -1, xpText.slice(0, 80));
    const attemptsAfter = mock.state.attempts.filter((a) => a.user_id === mock.state.session.user.id).length;
    check("gamification: attempt recorded server-side", attemptsAfter >= 6, "attempts=" + attemptsAfter);

    // dashboard: XP, level, streak, calendar, achievements
    nav("#/dashboard");
    await waitFor(() => $("[id=dash-body]") && $("[id=dash-body]").textContent.indexOf("XP") !== -1, 10000, "dashboard (mock)");
    const dashText = window.document.body.textContent;
    check("dashboard: XP + level shown", /Level \d/.test(dashText) && dashText.indexOf("XP") !== -1);
    check("dashboard: streak shown", /Streak/.test(dashText));
    check("dashboard: activity calendar rendered", !!$("[id=dash-cal] .cal-grid"));
    check("dashboard: mastery list rendered", $("[id=dash-mastery]") && $("[id=dash-mastery]").textContent.indexOf("Calculus") !== -1);
    check("dashboard: achievements rendered", !!$("[id=dash-achievements]") && $("[id=dash-achievements]").textContent.indexOf("First steps") !== -1);

    // leaderboard
    nav("#/leaderboard");
    await waitFor(() => $(".table tbody tr"), 10000, "leaderboard rows");
    const lbRows = Array.prototype.map.call($$(".table tbody tr"), function (tr) {
      return tr.textContent;
    });
    const xps = lbRows.map(function (r) { var m = r.match(/(\d+)$/); return m ? parseInt(m[1], 10) : -1; });
    const sorted = xps.every(function (v, i) { return i === 0 || xps[i - 1] >= v; });
    check("leaderboard: rows ranked by XP (desc)", sorted && lbRows.some(function (r) { return r.indexOf("Demo Student") !== -1; }), JSON.stringify(xps));
    check("leaderboard: shows rank + xp", /\d/.test($(".table tbody tr td").textContent));

    // comments: post + like + delete own
    nav("#/question/" + qid);
    await waitFor(() => $("[id=cmt-form]"), 10000, "comments (mock)");
    $("[id=cmt-input]").value = "Great question — the substitution trick works well!";
    click($("[id=cmt-form] button[type=submit]"));
    await waitFor(() => $("[id=cmt-list]") && $("[id=cmt-list]").textContent.indexOf("Great question") !== -1, 8000, "comment posted");
    check("comments: post appears", $("[id=cmt-list]").textContent.indexOf("Great question") !== -1);
    // profanity blocked
    $("[id=cmt-input]").value = "this is a fuck test";
    click($("[id=cmt-form] button[type=submit]"));
    await waitFor(() => $("[id=cmt-error]") && $("[id=cmt-error]").textContent.length > 0, 8000, "profanity blocked");
    check("comments: profanity filtered", $("[id=cmt-error]").textContent.indexOf("prohibited") !== -1);
    // like
    const likeBtn = $('[data-act="like"]');
    if (likeBtn) { click(likeBtn); await sleep(200); check("comments: like works", mock.state.likes.length >= 1); }
    // delete own
    const delBtn = $('[data-act="delete"]');
    if (delBtn) { click(delBtn); await sleep(200); check("comments: delete own works", $("[id=cmt-list]").textContent.indexOf("Great question") === -1); }

    // syllabus
    nav("#/syllabus");
    await waitFor(() => $(".syl-node"), 10000, "syllabus (mock)");
    const sylText = $("[id=syl-body]").textContent;
    check("syllabus: stage badges rendered", /Learning|Strong|Mastered/.test(sylText), sylText.slice(0, 120));
    check("syllabus: mastery stages counted", !!$(".syl-summary"));
  }

  // ---- live-only: every image the page actually rendered must have loaded --
  if (liveBase) {
    await sleep(1500); // let pending image loads settle
    check("no image failed to load (network 404 check)",
      failedImageUrls.length === 0,
      failedImageUrls.slice(0, 5).join(", "));
    // belt & braces: re-fetch every unique <img> src that is still present
    const imgs = $$("img").map((i) => i.getAttribute("src")).filter(Boolean);
    const unique = Array.from(new Set(imgs));
    const bad = [];
    for (const src of unique) {
      try {
        const abs = new URL(src, window.location.href).href;
        const res = await globalThis.fetch(abs);
        if (!res.ok) bad.push(src + " -> " + res.status);
      } catch (e) { bad.push(src + " -> fetch error"); }
    }
    check("all rendered image URLs fetch HTTP 200", bad.length === 0, bad.join(", "));
  }

  console.log("");
  if (failures.length) {
    console.log("DOM SMOKE FAILED: " + failures.length + " check(s)");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("DOM SMOKE PASSED — all checks ok" + (liveBase ? " (live mode @ " + liveBase + ")" : ""));
  process.exit(0);
}

main().catch((err) => {
  console.error("DOM SMOKE ERROR:", err);
  process.exit(2);
});
