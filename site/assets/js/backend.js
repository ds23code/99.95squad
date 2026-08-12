/* ============================================================================
 * backend.js — dynamic user-data client (Supabase REST).
 *
 * Keeps STATIC question content (api.js / content/) completely separate from
 * DYNAMIC user data (attempts, XP, mastery, leaderboards, comments, ...).
 * All dynamic state is server-side in Supabase; localStorage is never trusted
 * for XP / streaks / levels / premium / leaderboard scores.
 *
 * Without a configured backend every call resolves to `null` and the UI shows
 * an honest "backend required" state — never fabricated statistics.
 * ==========================================================================*/
(function () {
  "use strict";

  var root = window;
  var SESSION_KEY = "qb_supabase_session";

  function cfg() { return root.QB_CONFIG || {}; }
  function enabled() { return !!(cfg().SUPABASE_URL && cfg().SUPABASE_ANON_KEY); }

  function session() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch (e) { return null; }
  }
  function authed() { return enabled() && !!(session() && session().access_token); }

  function headers() {
    var h = {
      "apikey": cfg().SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    };
    var s = session();
    if (s && s.access_token) h["Authorization"] = "Bearer " + s.access_token;
    return h;
  }

  function post(path, body) {
    return fetch(cfg().SUPABASE_URL + path, {
      method: "POST", headers: headers(), body: JSON.stringify(body || {}),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error(j.message || j.msg || "HTTP " + res.status); });
      return res.json();
    });
  }

  function get(path) {
    return fetch(cfg().SUPABASE_URL + path, { headers: headers() }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error(j.message || "HTTP " + res.status); });
      return res.json();
    });
  }

  function rpc(fn, body) {
    return post("/rest/v1/rpc/" + fn, body || {});
  }

  /* ------------------------------------------------------------------ auth */
  function currentUser() {
    var s = session();
    return s && s.user ? { id: s.user.id, email: s.user.email } : null;
  }

  /* ------------------------------------------------------------- gamification */
  function recordAttempt(attempt) {
    if (!authed()) return Promise.resolve(null);
    return rpc("record_attempt", {
      p_question_id: attempt.question_id,
      p_correct: !!attempt.correct,
      p_seconds: Math.max(0, Math.round(attempt.seconds || 0)),
      p_mode: attempt.mode || "practice",
      p_course_id: attempt.course_id || null,
      p_topic_id: attempt.topic_id || null,
      p_difficulty: attempt.difficulty != null ? Number(attempt.difficulty) : null,
    });
  }

  function getDashboard() {
    var u = currentUser();
    if (!u) return Promise.resolve(null);
    return rpc("get_dashboard", { p_user: u.id }).catch(function () { return null; });
  }

  function topicMastery() {
    var u = currentUser();
    if (!u) return Promise.resolve(null);
    return rpc("topic_mastery", { p_user: u.id }).catch(function () { return null; });
  }

  function dailyActivity(days) {
    var u = currentUser();
    if (!u) return Promise.resolve(null);
    return rpc("daily_activity", { p_user: u.id, p_days: days || 30 }).catch(function () { return null; });
  }

  function timeStats() {
    var u = currentUser();
    if (!u) return Promise.resolve(null);
    return rpc("time_stats", { p_user: u.id }).catch(function () { return null; });
  }

  function leaderboard(period, limit, offset) {
    if (!enabled()) return Promise.resolve(null);
    return rpc("leaderboard", {
      p_period: period || "week", p_limit: limit || 50, p_offset: offset || 0,
    }).catch(function () { return null; });
  }

  function myRank(period) {
    if (!authed()) return Promise.resolve(null);
    return rpc("my_rank", { p_period: period || "week" }).catch(function () { return null; });
  }

  /* ----------------------------------------------------------------- comments */
  function listComments(questionId) {
    if (!enabled()) return Promise.resolve(null);
    return get(
      "/rest/v1/comments?select=*&question_id=eq." + encodeURIComponent(questionId) +
      "&order=created_at.asc"
    ).catch(function () { return null; });
  }

  function addComment(questionId, body, parentId) {
    if (!authed()) return Promise.resolve(null);
    return rpc("add_comment", {
      p_question_id: questionId, p_body: body, p_parent_id: parentId || null,
    }).catch(function (err) { throw err; });
  }

  function deleteOwnComment(commentId) {
    if (!authed()) return Promise.resolve(null);
    return rpc("delete_own_comment", { p_comment_id: commentId }).catch(function () { return null; });
  }

  function likeComment(commentId) {
    if (!authed()) return Promise.resolve(null);
    return rpc("like_comment", { p_comment_id: commentId }).catch(function () { return null; });
  }

  function reportComment(commentId, reason) {
    if (!authed()) return Promise.resolve(null);
    return rpc("report_comment", { p_comment_id: commentId, p_reason: reason || null }).catch(function () { return null; });
  }

  /* --------------------------------------------------------------- favourites */
  function favourites() {
    var u = currentUser();
    if (!u) return Promise.resolve(null);
    return get("/rest/v1/favourites?select=question_id&user_id=eq." + u.id).catch(function () { return null; });
  }
  function setFavourite(questionId, on) {
    var u = currentUser();
    if (!u) return Promise.resolve(null);
    var url = "/rest/v1/favourites?user_id=eq." + u.id + "&question_id=eq." + encodeURIComponent(questionId);
    if (on) {
      return post(url.replace("?user_id", "?on_conflict=question_id,user_id&user_id"), {
        user_id: u.id, question_id: questionId,
      }).then(function () { return true; }).catch(function () { return null; });
    }
    return fetch(cfg().SUPABASE_URL + url, { method: "DELETE", headers: headers() })
      .then(function () { return false; }).catch(function () { return null; });
  }

  root.QB = root.QB || {};
  root.QB.backend = {
    enabled: enabled, authed: authed, currentUser: currentUser,
    recordAttempt: recordAttempt, getDashboard: getDashboard,
    topicMastery: topicMastery, dailyActivity: dailyActivity,
    timeStats: timeStats, leaderboard: leaderboard, myRank: myRank,
    listComments: listComments, addComment: addComment,
    deleteOwnComment: deleteOwnComment, likeComment: likeComment,
    reportComment: reportComment, favourites: favourites, setFavourite: setFavourite,
  };
})();
