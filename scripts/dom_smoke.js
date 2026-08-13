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
const jsdomArg = process.argv[3] || "jsdom";
const jsdomPath = jsdomArg.startsWith("/") ? jsdomArg : (jsdomArg.startsWith(".") || jsdomArg.startsWith("node_modules") ? path.resolve(jsdomArg) : jsdomArg);
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
  function jwt(role, exp) {
    function part(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
    return part({ alg: "none", typ: "JWT" }) + "." + part({ role: role, exp: exp }) + ".mock";
  }
  const state = {
    users: {},        // id -> {id, email, display_name, xp, level, daily_goal, opt_out_leaderboard, avatar_url, is_admin, access_tier, premium_until, contribution_credits}
    attempts: [],     // {user_id, question_id, correct, seconds, mode, course_id, topic_id, difficulty, created_at, xp}
    comments: [],     // {id, question_id, user_id, parent_id, body, likes, created_at}
    reports: [],      // {id, reporter, question_id, reason, details, created_at}
    likes: [],        // {user_id, comment_id}
    submissions: [],  // {id, uploader, filename, name, sha256, size_bytes, status, note, storage_path, duplicate_of, duplicate_type, created_at}
    objects: {},      // storagePath -> {owner}
    audit: [],        // {created_at, actor, action, target_id, previous_status, new_status, notes}
    session: null,    // normalized rotating auth session
    authCalls: { user: 0, refresh: 0 },
    dashboardFailuresRemaining: 0,
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
  function seedAdmin() {
    const uid = "user-admin-" + seq++;
    const u = { id: uid, email: "admin@99.95squad.org", display_name: "Demo Moderator",
                xp: 0, level: 1, daily_goal: 10, opt_out_leaderboard: false, avatar_url: null,
                is_admin: true, access_tier: "admin", premium_until: null, contribution_credits: 0 };
    state.users[uid] = u;
    return u;
  }
  function adminOf(uid) { const u = userById(uid); return !!(u && u.is_admin); }
  function audit(actor, action, targetId, prev, next, notes) {
    state.audit.push({ created_at: now.toISOString(), actor: actor, action: action,
      target_id: targetId, previous_status: prev, new_status: next, notes: notes || null });
  }
  function seedUser() {
    const uid = "user-" + seq++;
    const u = { id: uid, email: "student@school.edu.au", display_name: "Demo Student",
                xp: 0, level: 1, daily_goal: 10, opt_out_leaderboard: false, avatar_url: null,
                is_admin: false, access_tier: "free", premium_until: null, contribution_credits: 0 };
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
    /* RPC/JSON bodies are parsed; binary bodies (PDF uploads) are passed
     * through untouched and never parsed. */
    let body = {};
    if (opts.body) {
      if (typeof opts.body === "string") {
        try { body = JSON.parse(opts.body); } catch (e) { body = { __raw: opts.body }; }
      } else {
        body = { __raw: opts.body };
      }
    }
    const auth = (opts.headers || {}).Authorization || "";
    const bearer = auth.replace("Bearer ", "");
    function requireUser() {
      if (!state.session || state.session.access_token !== bearer) throw new Error("not authenticated");
      return state.session.user;
    }
    try {
      // ---- auth ----
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
        if (body.password === "wrong-password") {
          return { status: 400, json: { message: "Invalid login credentials" } };
        }
        const u = Object.values(state.users).find((x) => x.email === body.email)
          || (body.email === "admin@99.95squad.org" ? seedAdmin() : seedUser());
        const exp = Math.floor(Date.now() / 1000) + 3600;
        state.session = {
          access_token: jwt("authenticated", exp), refresh_token: "refresh-" + seq++,
          expires_in: 3600, expires_at: exp, token_type: "bearer",
          user: { id: u.id, email: u.email, user_metadata: { name: u.display_name } },
        };
        return { status: 200, json: state.session };
      }
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
        if (!state.session || body.refresh_token !== state.session.refresh_token) {
          return { status: 400, json: { message: "Invalid Refresh Token" } };
        }
        state.authCalls.refresh++;
        const exp = Math.floor(Date.now() / 1000) + 3600;
        state.session = Object.assign({}, state.session, {
          access_token: jwt("authenticated", exp), refresh_token: "refresh-" + seq++,
          expires_in: 3600, expires_at: exp,
        });
        return { status: 200, json: state.session };
      }
      if (url.pathname === "/auth/v1/signup") {
        const u = Object.values(state.users).find((x) => x.email === body.email) || seedUser();
        u.email = body.email;
        u.display_name = (body.data && body.data.name) || u.display_name;
        return { status: 200, json: { user: { id: u.id, email: u.email, user_metadata: body.data || {} } } };
      }
      if (url.pathname === "/auth/v1/user") {
        state.authCalls.user++;
        if (!state.session || state.session.access_token !== bearer) return { status: 401, json: { message: "invalid session" } };
        return { status: 200, json: state.session.user };
      }
      if (url.pathname === "/auth/v1/logout") return { status: 204, json: null };
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
      if (url.pathname === "/rest/v1/rpc/get_dashboard") {
        if (state.dashboardFailuresRemaining > 0) {
          state.dashboardFailuresRemaining--;
          return { status: 503, json: { message: "mock cloud dashboard outage" } };
        }
        return { status: 200, json: dashboard(body.p_user) };
      }
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
      if (url.pathname === "/rest/v1/favourites" && (opts.method || "GET") === "GET") {
        return { status: 200, json: [] };
      }
      if (url.pathname === "/rest/v1/favourites" && (opts.method || "GET") === "POST") return { status: 200, json: [body] };
      if (url.pathname === "/rest/v1/favourites" && (opts.method || "GET") === "DELETE") return { status: 200, json: [] };
      if (url.pathname === "/rest/v1/problem_reports" && (opts.method || "GET") === "POST") {
        const u = requireUser();
        if (body.reporter !== u.id) return { status: 403, json: { message: "not authorized" } };
        const row = Object.assign({ id: seq++, created_at: now.toISOString() }, body);
        state.reports.push(row);
        return { status: 201, json: [row] };
      }
      if (url.pathname === "/rest/v1/problem_reports" && (opts.method || "GET") === "GET") {
        const u = requireUser();
        return { status: 200, json: state.reports.filter((r) => r.reporter === u.id || adminOf(u.id)) };
      }
      // ---- profiles (own row readable; admin may read any) ----
      if (url.pathname === "/rest/v1/profiles" && (opts.method || "GET") === "GET") {
        const u = requireUser();
        const qid = decodeURIComponent((url.searchParams.get("id") || "").replace(/^eq\./, ""));
        const target = userById(qid);
        if (!target) return { status: 200, json: [] };
        if (target.id !== u.id && !adminOf(u.id)) return { status: 200, json: [] };
        return { status: 200, json: [Object.assign({}, target, { email: target.email })].map((p) => ({
          id: p.id, email: p.email, display_name: p.display_name, access_tier: p.access_tier,
          is_admin: p.is_admin, daily_goal: p.daily_goal, opt_out_leaderboard: p.opt_out_leaderboard,
          premium_until: p.premium_until, contribution_credits: p.contribution_credits, avatar_url: p.avatar_url,
        })) };
      }
      // ---- upload submissions (RLS: own rows, or all rows for admins) ----
      if (url.pathname === "/rest/v1/upload_submissions" && (opts.method || "GET") === "GET") {
        const u = requireUser();
        const rows = state.submissions.filter((s) => s.uploader === u.id || adminOf(u.id));
        return { status: 200, json: rows };
      }
      if (url.pathname === "/rest/v1/upload_submissions" && (opts.method || "GET") === "POST") {
        const u = requireUser();
        if (body.uploader && body.uploader !== u.id) {
          return { status: 403, json: { message: "new row violates row-level security policy" } };
        }
        if (body.storage_path && !body.storage_path.startsWith(u.id + "/")) {
          return { status: 400, json: { message: "storage_path must be under your own folder" } };
        }
        const row = {
          id: "sub-" + seq++, uploader: u.id, filename: body.filename || null, name: body.name || null,
          sha256: body.sha256 || null, size_bytes: body.size_bytes || 0, status: "pending",
          note: body.note || "Pending review", premium_granted: false, reviewed_at: null, reviewed_by: null,
          duplicate_of: null, duplicate_type: null, storage_path: body.storage_path || null,
          created_at: now.toISOString(),
        };
        state.submissions.push(row);
        return { status: 201, json: row };
      }
      // ---- audit events (admins only) ----
      if (url.pathname === "/rest/v1/audit_events" && (opts.method || "GET") === "GET") {
        const u = requireUser();
        if (!adminOf(u.id)) return { status: 200, json: [] };
        const tid = decodeURIComponent((url.searchParams.get("target_id") || "").replace(/^eq\./, ""));
        const rows = tid ? state.audit.filter((a) => a.target_id === tid) : state.audit.slice();
        return { status: 200, json: rows };
      }
      // ---- moderation RPCs ----
      if (url.pathname === "/rest/v1/rpc/is_admin") {
        const u = requireUser();
        return { status: 200, json: adminOf(u.id) };
      }
      if (url.pathname === "/rest/v1/rpc/admin_list_submissions") {
        const u = requireUser();
        if (!adminOf(u.id)) return { status: 403, json: { message: "not authorized" } };
        const rows = state.submissions.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).map((s) => {
          const owner = userById(s.uploader);
          return Object.assign({}, s, { uploader_email: owner ? owner.email : null, uploader_name: owner ? owner.display_name : null });
        });
        return { status: 200, json: rows };
      }
      if (url.pathname === "/rest/v1/rpc/queue_upload" || url.pathname === "/rest/v1/rpc/approve_upload") {
        const u = requireUser();
        if (!adminOf(u.id)) return { status: 403, json: { message: "not authorized" } };
        const sub = state.submissions.find((s) => s.id === body.submission_id);
        if (!sub) return { status: 400, json: { message: "submission not found" } };
        if (sub.status === "processing" || sub.status === "approved") {
          return { status: 409, json: { message: "active or published submissions are immutable" } };
        }
        const prev = sub.status;
        sub.status = "queued"; sub.premium_granted = false;
        sub.reviewed_at = now.toISOString(); sub.reviewed_by = u.id;
        sub.processing_error = null; sub.duplicate_of = null; sub.duplicate_type = null;
        audit(u.id, "queue_upload", sub.id, prev, "queued", null);
        return { status: 200, json: sub };
      }
      if (url.pathname === "/rest/v1/rpc/moderate_upload") {
        const u = requireUser();
        if (!adminOf(u.id)) return { status: 403, json: { message: "not authorized" } };
        const sub = state.submissions.find((s) => s.id === body.submission_id);
        if (!sub) return { status: 400, json: { message: "submission not found" } };
        if (body.new_status === "approved") {
          if (sub.status === "processing" || sub.status === "approved") {
            return { status: 409, json: { message: "active or published submissions are immutable" } };
          }
          const prev = sub.status;
          sub.status = "queued"; sub.premium_granted = false;
          sub.reviewed_at = now.toISOString(); sub.reviewed_by = u.id;
          sub.processing_error = null; sub.duplicate_of = null; sub.duplicate_type = null;
          audit(u.id, "queue_upload", sub.id, prev, "queued", null);
          return { status: 200, json: sub };
        }
        const prev = sub.status;
        sub.status = body.new_status;
        sub.reviewed_at = now.toISOString(); sub.reviewed_by = u.id;
        sub.note = body.p_notes != null ? body.p_notes : sub.note;
        if (body.new_status === "duplicate") {
          sub.duplicate_of = (body.p_duplicate_of || "").trim() || sub.duplicate_of;
          sub.duplicate_type = (body.p_duplicate_type || "").trim() || sub.duplicate_type;
        } else {
          sub.duplicate_of = null; sub.duplicate_type = null;
        }
        audit(u.id, "moderate_upload", sub.id, prev, body.new_status, body.p_notes || null);
        return { status: 200, json: sub };
      }
      // ---- private storage bucket ----
      const storageMatch = url.pathname.match(/^\/storage\/v1\/object\/(sign\/)?paper-uploads\/(.+)$/);
      if (storageMatch) {
        const isSign = !!storageMatch[1];
        const objPath = decodeURIComponent(storageMatch[2]);
        if (isSign && (opts.method || "GET") === "POST") {
          // Only the object owner or an admin may mint a signed link
          // (mirrors the storage.objects SELECT policy).
          const u = requireUser();
          const obj = state.objects[objPath];
          if (!obj) return { status: 400, json: { message: "Object not found" } };
          if (obj.owner !== u.id && !adminOf(u.id)) return { status: 403, json: { message: "not authorized" } };
          return { status: 200, json: { signedURL: "/object/sign/paper-uploads/" + objPath + "?token=test-token" } };
        }
        if (isSign && (opts.method || "GET") === "GET") {
          // Signed URLs are accessed with the token in the URL, not a
          // session header — mirror real Supabase Storage behaviour.
          const obj = state.objects[objPath];
          if (!obj) return { status: 404, json: {} };
          return { status: 206, json: {} }; // Range probe: file exists and is readable
        }
        if (!isSign && (opts.method || "GET") === "POST") {
          const u = requireUser();
          const top = objPath.split("/")[0];
          if (top !== u.id) return { status: 403, json: { message: "not authorized" } };
          state.objects[objPath] = { owner: u.id };
          return { status: 200, json: { Key: objPath } };
        }
        return { status: 404, json: { message: "mock: no storage route" } };
      }
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

/* jsdom has no canvas implementation; core.pickImg probes WebP via
 * canvas.toDataURL and must not throw / spam Not implemented errors. */
try {
  const proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
  if (proto) {
    proto.toDataURL = function () { return "data:,"; };
  }
} catch (e) { /* ignore */ }

/* image load failures (live mode): any <img> that 404s fires an error event */
const failedImageUrls = [];
if (liveBase) {
  window.document.addEventListener("error", function (e) {
    const t = e.target;
    if (t && t.tagName === "IMG") failedImageUrls.push(t.getAttribute("src") || "(no src)");
  }, true);
}

function fetchResponse(status, data) {
  const text = data == null ? "" : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(text),
  };
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
      return Promise.resolve(fetchResponse(res.status, res.json));
    }
    // static content from disk (stub)
    const clean = abs.replace(/^https:\/\/example\.com\//, "").replace(/^\.\//, "");
    const file = path.join(siteDir, decodeURIComponent(clean.split("?")[0]));
    return fs.promises.readFile(file).then(
      (buf) => fetchResponse(200, JSON.parse(buf.toString("utf8"))),
      () => fetchResponse(404, {})
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
  if (s === "config.js") {
    if (supabaseMock) {
      window.QB_CONFIG.SUPABASE_URL = "https://mock.supabase.co";
      window.QB_CONFIG.SUPABASE_ANON_KEY = "mock-anon";
    } else {
      // Stub/live runs exercise device-local auth + dashboard. A real
      // SUPABASE_URL in the built config.js must not hijack those flows.
      window.QB_CONFIG.SUPABASE_URL = "";
      window.QB_CONFIG.SUPABASE_ANON_KEY = "";
    }
  }
}

async function main() {
  // ---- landing ---------------------------------------------------------
  await waitFor(() => $(".hero h1"), 8000, "landing hero");
  check("landing page renders hero", !!$(".hero h1"));
  check("landing shows question stats", !!$(".hero-stats .stat-num"));

  // Header Subjects is a query-bearing settings route (a previous exact-route
  // matcher incorrectly sent this link to the in-app 404 page).
  nav("#/settings?tab=subjects");
  await waitFor(() => $("#st-tabs .active"), 8000, "subjects settings route");
  check("Subjects navigation opens the subjects settings tab",
    $("#st-tabs .active") && $("#st-tabs .active").textContent === "Subjects");

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

  // ---- question page UX: timer controls, correct/incorrect/skipped & persistence ----
  const timerToggle = $("[id=q-timer-toggle]");
  const timerReset = $("[id=q-timer-reset]");
  check("question timer toggle button present", !!timerToggle);
  check("question timer reset button present", !!timerReset);
  if (timerToggle) {
    click(timerToggle);
    await sleep(80);
    check("question timer pauses correctly", timerToggle.textContent === "Resume");
    click(timerToggle);
    await sleep(80);
    check("question timer resumes correctly", timerToggle.textContent === "Pause");
  }
  const skipBtn = $("[id=q-skipped]");
  check("skipped/unattempted mark button present", !!skipBtn);
  const correctBtn = $("[id=q-correct]");
  if (correctBtn) {
    click(correctBtn);
    await sleep(150);
    check("marking question disables controls against double-submission", correctBtn.disabled === true);
    const stored = window.QB.store.load().completed[qid];
    check("mark result persists in local store", stored && stored.correct === true);
    nav("#/browse");
    await sleep(150);
    nav("#/question/" + qid);
    await waitFor(() => $("[id=q-prev-state]"), 5000, "previous state badge");
    check("re-opening question shows student previous state", !!$("[id=q-prev-state]"));
  }

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
  // Student uploads require an account in every provider. In local smoke mode,
  // create one first; Supabase mode exercises signup/session semantics below.
  if (!supabaseMock) {
    const signup = await window.QB.auth.signUp("student@school.edu.au", "password123", "Demo Student");
    check("sign-up creates a local authenticated account", signup.ok && !!window.QB.auth.currentUser());
  }
  // In supabase-mock mode the upload flow is exercised AFTER sign-in (see the
  // moderation section). Here (stub/live) we exercise validation and queueing.
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

  if (!supabaseMock) {
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
  }

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

  // ---- login (device-local or Supabase mock) -----------------------------------
  await window.QB.auth.signOut();
  nav("#/login");
  await waitFor(() => $("[id=a-email]"), 8000, "login page");
  $("[id=a-email]").value = "student@school.edu.au";
  $("[id=a-pass]").value = "password123";
  click($("[id=a-submit]"));
  await waitFor(() => $("[id=nav-account]") && $("[id=nav-account]").textContent.indexOf("dashboard") !== -1, 8000, "signed in");
  await waitFor(() => window.location.hash === "#/dashboard", 8000, "post-login navigation");
  const user = window.QB.auth.currentUser();
  check("sign-in works with the configured auth provider", !!(user && user.email === "student@school.edu.au"));

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
    const pendingSignup = await window.QB.auth.signUp("pending@school.edu.au", "password123", "Pending Student");
    check("auth: confirmation-pending signup is not treated as signed in",
      pendingSignup.ok && pendingSignup.requiresEmailConfirmation && window.QB.auth.currentUser() == null);
    const badLogin = await window.QB.auth.signIn("student@school.edu.au", "wrong-password");
    check("auth: login surfaces Supabase credential errors",
      badLogin.ok === false && badLogin.error.indexOf("Invalid login credentials") !== -1, badLogin.error);
    nav("#/login");
    await waitFor(() => $("[id=a-email]"), 8000, "login page (mock)");
    $("[id=a-email]").value = "student@school.edu.au";
    $("[id=a-pass]").value = "password123";
    click($("[id=a-submit]"));
    await waitFor(() => window.QB.auth.currentUser() != null, 8000, "signed in (mock)");
    check("auth: sign-in creates session", !!window.QB.auth.currentUser());
    const persisted = window.QB.auth.currentSession();
    persisted.expires_at = Math.floor(Date.now() / 1000) - 1;
    window.localStorage.setItem("qb.supabase.session", JSON.stringify(persisted));
    const refreshBefore = mock.state.authCalls.refresh;
    await Promise.all([window.QB.auth.refreshSession(false), window.QB.auth.refreshSession(false)]);
    const refreshed = window.QB.auth.currentSession();
    check("auth: concurrent refresh is serialized",
      mock.state.authCalls.refresh === refreshBefore + 1,
      "refresh calls=" + (mock.state.authCalls.refresh - refreshBefore));
    check("auth: rotated refresh token is persisted",
      refreshed.refresh_token === mock.state.session.refresh_token && refreshed.refresh_token !== persisted.refresh_token);
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

    // A cloud outage must not masquerade as a genuinely empty dashboard.
    mock.state.dashboardFailuresRemaining = 1;
    nav("#/browse");
    await sleep(100);
    nav("#/dashboard");
    await waitFor(() => $("[id=dash-cloud-error]"), 8000, "dashboard cloud error");
    const outageText = $("[id=dash-cloud-error]") ? $("[id=dash-cloud-error]").textContent : "";
    check("dashboard outage: cloud error is visibly distinct from empty progress",
      outageText.indexOf("Cloud progress is temporarily unavailable") !== -1 &&
      outageText.indexOf("mock cloud dashboard outage") !== -1, outageText);
    check("dashboard outage: fallback is explicitly device-local",
      $("[id=dash-body]").textContent.indexOf("Questions (this device)") !== -1 &&
      $("[id=dash-body]").textContent.indexOf("your cloud progress has not been treated as empty") !== -1);
    click($("[id=dash-cloud-retry]"));
    await waitFor(() => $("[id=dash-cal] .cal-grid"), 10000, "dashboard cloud retry");
    check("dashboard outage: retry restores the cloud dashboard",
      !$("[id=dash-cloud-error]") && !!$("[id=dash-cal] .cal-grid"));

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

    // ---- uploads + moderation (supabase mode) ------------------------------
    const studentId = mock.state.session.user.id;
    nav("#/upload");
    await waitFor(() => $("[id=dz]"), 8000, "upload page (mock)");
    dropFile(fakePdf("Mock_High_2026_Physics_Trial.pdf", "%PDF-1.4 mock trial paper"), true);
    await waitFor(() => $("[id=dz-result]") && $("[id=dz-result]").textContent.indexOf("Queued") !== -1, 12000, "upload queued (mock)");
    const mySubs = mock.state.submissions.filter((s) => s.uploader === studentId);
    check("moderation: PDF stored in private bucket", mySubs.length >= 1 && !!mock.state.objects[mySubs[0].storage_path]);
    check("moderation: submission row references own storage path",
      mySubs.length >= 1 && mySubs[0].storage_path.indexOf(studentId + "/") === 0, mySubs[0] && mySubs[0].storage_path);
    check("moderation: new submission is pending (never pre-approved)",
      mySubs.length >= 1 && mySubs[0].status === "pending" && mySubs[0].premium_granted === false);

    // a student must never reach the moderation interface
    nav("#/admin");
    await waitFor(() => $(".empty-state h2"), 8000, "admin gate (student)");
    check("moderation: student blocked from admin page",
      !!$(".empty-state") && $(".empty-state").textContent.indexOf("Moderators only") !== -1);

    // admin signs in and sees the student's submission with uploader info
    await window.QB.auth.signOut();
    await sleep(150);
    nav("#/login");
    await waitFor(() => $("[id=a-email]"), 8000, "login page (admin)");
    $("[id=a-email]").value = "admin@99.95squad.org";
    $("[id=a-pass]").value = "password123";
    click($("[id=a-submit]"));
    await waitFor(() => window.QB.auth.currentUser() != null, 8000, "admin signed in");
    await sleep(200);
    nav("#/admin");
    await waitFor(() => $(".ad-table tbody tr"), 10000, "admin queue rows");
    const adText = $(".ad-table").textContent;
    check("moderation: admin sees student submission", adText.indexOf("Mock_High_2026_Physics_Trial.pdf") !== -1, adText.slice(0, 160));
    check("moderation: uploader identity resolved", adText.indexOf("Demo Student") !== -1, adText.slice(0, 160));

    // admin opens the PDF through a signed URL
    click($('[data-pdf]'));
    await waitFor(() => $(".pdf-frame") || $(".error-banner"), 10000, "pdf preview");
    const pdfSrc = $(".pdf-frame") ? $(".pdf-frame").getAttribute("src") : "";
    check("moderation: PDF preview via signed URL", pdfSrc.indexOf("token=") !== -1, pdfSrc);

    // Admin approval is queueing only. Extraction/export completion is a
    // separate authenticated processor action and is the entitlement gate.
    click($('[data-open]'));
    await waitFor(() => $("[id=ad-status]"), 8000, "detail form");
    $("[id=ad-status]").value = "approved";
    click($("[id=ad-apply]"));
    await waitFor(() => mock.state.submissions.length >= 1 && mock.state.submissions[0].status === "queued", 8000, "submission queued");
    check("moderation: approval queues processing server-side", mock.state.submissions[0].status === "queued");
    check("moderation: queueing does not grant contributor entitlement",
      mock.state.users[studentId].access_tier === "free" &&
      mock.state.users[studentId].contribution_credits === 0 &&
      mock.state.submissions[0].premium_granted === false);
    check("moderation: queue action audited", mock.state.audit.some((a) => a.action === "queue_upload" && a.new_status === "queued"));

    // Failed-processing metadata is visible to the moderator and can be retried.
    const selected = mock.state.submissions[0];
    selected.status = "needs_review";
    selected.processing_attempts = 1;
    selected.processing_error = "Detector failed on page 3";
    nav("#/dashboard"); await sleep(100); nav("#/admin");
    await waitFor(() => $(".ad-table tbody tr"), 8000, "failed processing row");
    click($('[data-open]'));
    await waitFor(() => $("#ad-detail") && $("#ad-detail").textContent.indexOf("Detector failed") !== -1, 8000, "processing failure detail");
    check("moderation: processing error and attempt metadata shown",
      $("#ad-detail").textContent.indexOf("Detector failed on page 3") !== -1 &&
      $("#ad-detail").textContent.indexOf("Processing attempts1") !== -1,
      $("#ad-detail").textContent.slice(0, 220));

    // Once claimed, regular moderation transitions are locked.
    selected.status = "processing";
    selected.processing_error = null;
    nav("#/dashboard"); await sleep(100); nav("#/admin?view=queue");
    await waitFor(() => $(".ad-table tbody tr"), 8000, "processing queue row");
    click($('[data-open]'));
    await waitFor(() => $("#ad-detail") && $("#ad-detail").textContent.indexOf("controlled processor") !== -1, 8000, "processing lock");
    check("moderation: processing rows have no mutable status form", !$("#ad-form"));

    // Simulate the secure processor's successful completion after publication.
    selected.status = "approved";
    selected.paper_id = "2026-mock-high-physics-trial";
    selected.question_count = 12;
    selected.premium_granted = true;
    const owner = mock.state.users[studentId];
    owner.access_tier = "contributor";
    owner.premium_until = new Date(Date.now() + 14 * 86400000).toISOString();
    owner.contribution_credits = 1;
    mock.state.audit.push({ created_at: new Date().toISOString(), actor: mock.state.session.user.id,
      action: "complete_upload_processing", target_id: selected.id,
      previous_status: "processing", new_status: "approved", notes: null });

    // The approved tab shows publication metadata and an immutable row.
    nav("#/dashboard"); await sleep(100); nav("#/admin?view=approved");
    await waitFor(() => $(".ad-table tbody tr"), 8000, "approved tab");
    check("moderation: approved tab shows approved submission",
      $(".ad-table").textContent.indexOf("Mock_High_2026_Physics_Trial.pdf") !== -1);
    click($('[data-open]'));
    await waitFor(() => $("#ad-detail") && $("#ad-detail").textContent.indexOf("2026-mock-high") !== -1, 8000, "published metadata");
    check("moderation: approved row shows paper/question publication metadata",
      $("#ad-detail").textContent.indexOf("2026-mock-high-physics-trial") !== -1 &&
      $("#ad-detail").textContent.indexOf("Questions12") !== -1);
    check("moderation: approved rows are immutable", !$("#ad-form"));
    check("moderation: contributor premium granted only on completion",
      mock.state.users[studentId].access_tier === "contributor" &&
      mock.state.users[studentId].contribution_credits === 1 &&
      new Date(mock.state.users[studentId].premium_until) > new Date());
    check("moderation: completion audited", mock.state.audit.some((a) => a.action === "complete_upload_processing" && a.new_status === "approved"));

    // sign back in as the student: they see their own status + premium
    await window.QB.auth.signOut();
    await sleep(150);
    nav("#/login");
    await waitFor(() => $("[id=a-email]"), 8000, "login page (student 2)");
    $("[id=a-email]").value = "student@school.edu.au";
    $("[id=a-pass]").value = "password123";
    click($("[id=a-submit]"));
    await waitFor(() => window.QB.auth.currentUser() != null, 8000, "student signed in (2)");
    await sleep(400); // let refreshEntitlement fetch the profile
    check("moderation: student entitlement upgraded after approval",
      window.QB.auth.entitlement().isPremium === true &&
      window.QB.auth.entitlement().tier === "contributor",
      JSON.stringify(window.QB.auth.entitlement()));
    nav("#/upload");
    await waitFor(() => $("[id=up-list]") && $("[id=up-list]").textContent.indexOf("Approved") !== -1, 8000, "student sees approved status");
    check("moderation: student sees own approved status", $("[id=up-list]").textContent.indexOf("Approved") !== -1);
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
