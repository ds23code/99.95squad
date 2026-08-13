/* ============================================================================
 * backend.js — dynamic user-data client (Supabase REST).
 *
 * Static question content stays separate from dynamic, server-authoritative
 * user data. Authenticated calls use auth.js's expiry-aware transport so a
 * rotated/expired access token cannot silently turn into empty dashboard data.
 * ==========================================================================*/
(function () {
  "use strict";
  var root = window;

  function cfg() { return root.QB_CONFIG || {}; }
  function enabled() { return !!(cfg().SUPABASE_URL && cfg().SUPABASE_ANON_KEY); }
  function session() { return root.QB.auth && root.QB.auth.currentSession ? root.QB.auth.currentSession() : null; }
  function authed() { return enabled() && !!(session() && session().access_token); }

  function parse(res) {
    return res.text().then(function (text) {
      var data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (e) { data = { message: text }; }
      }
      if (!res.ok) {
        var err = new Error((data && (data.message || data.msg || data.error_description || data.error)) || "HTTP " + res.status);
        err.status = res.status;
        err.body = data;
        throw err;
      }
      return data;
    });
  }

  function request(path, options, allowAnonymous) {
    options = Object.assign({}, options || {});
    if (authed()) return root.QB.auth.authenticatedFetch(path, options).then(parse);
    if (!allowAnonymous) return Promise.reject(new Error("Sign in required"));
    options.headers = Object.assign({ apikey: cfg().SUPABASE_ANON_KEY }, options.headers || {});
    return fetch(cfg().SUPABASE_URL + path, options).then(parse);
  }

  function post(path, body) {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }, false);
  }
  function get(path, allowAnonymous) { return request(path, {}, !!allowAnonymous); }
  function rpc(fn, body) { return post("/rest/v1/rpc/" + fn, body || {}); }

  function currentUser() {
    var s = session();
    return s && s.user ? { id: s.user.id, email: s.user.email } : null;
  }

  function recordAttempt(attempt) {
    if (!authed()) return Promise.resolve(null);
    return rpc("record_attempt", {
      p_question_id: attempt.question_id,
      p_correct: attempt.correct === null || attempt.correct === undefined ? null : !!attempt.correct,
      p_seconds: Math.max(0, Math.round(attempt.seconds || 0)),
      p_mode: attempt.mode || "practice",
      p_course_id: attempt.course_id || null,
      p_topic_id: attempt.topic_id || null,
      p_difficulty: attempt.difficulty != null ? Number(attempt.difficulty) : null,
    });
  }

  function getDashboard() {
    var u = currentUser();
    return u ? rpc("get_dashboard", { p_user: u.id }) : Promise.resolve(null);
  }
  function topicMastery() {
    var u = currentUser();
    return u ? rpc("topic_mastery", { p_user: u.id }) : Promise.resolve(null);
  }
  function dailyActivity(days) {
    var u = currentUser();
    return u ? rpc("daily_activity", { p_user: u.id, p_days: days || 30 }) : Promise.resolve(null);
  }
  function timeStats() {
    var u = currentUser();
    return u ? rpc("time_stats", { p_user: u.id }) : Promise.resolve(null);
  }
  function leaderboard(period, limit, offset) {
    if (!authed()) return Promise.resolve(null);
    return rpc("leaderboard", { p_period: period || "week", p_limit: limit || 50, p_offset: offset || 0 });
  }
  function myRank(period) {
    return authed() ? rpc("my_rank", { p_period: period || "week" }) : Promise.resolve(null);
  }

  function listComments(questionId) {
    if (!enabled()) return Promise.resolve(null);
    return get("/rest/v1/comments?select=*&question_id=eq." + encodeURIComponent(questionId) + "&order=created_at.asc", true);
  }
  function addComment(questionId, body, parentId) {
    if (!authed()) return Promise.resolve(null);
    return rpc("add_comment", { p_question_id: questionId, p_body: body, p_parent_id: parentId || null });
  }
  function deleteOwnComment(commentId) {
    return authed() ? rpc("delete_own_comment", { p_comment_id: commentId }) : Promise.resolve(null);
  }
  function likeComment(commentId) {
    return authed() ? rpc("like_comment", { p_comment_id: commentId }) : Promise.resolve(null);
  }
  function reportComment(commentId, reason) {
    return authed() ? rpc("report_comment", { p_comment_id: commentId, p_reason: reason || null }) : Promise.resolve(null);
  }

  function favourites() {
    var u = currentUser();
    return u ? get("/rest/v1/favourites?select=question_id&user_id=eq." + encodeURIComponent(u.id)) : Promise.resolve(null);
  }
  function setFavourite(questionId, on) {
    var u = currentUser();
    if (!u) return Promise.resolve(null);
    var url = "/rest/v1/favourites?user_id=eq." + encodeURIComponent(u.id) + "&question_id=eq." + encodeURIComponent(questionId);
    if (on) {
      return request(url.replace("?user_id", "?on_conflict=question_id,user_id&user_id"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ user_id: u.id, question_id: questionId }),
      }).then(function () { return true; });
    }
    return request(url, { method: "DELETE" }).then(function () { return false; });
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
