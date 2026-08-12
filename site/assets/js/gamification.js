/* ============================================================================
 * gamification.js — pure logic for XP, levels, streaks, mastery.
 * These functions MIRROR the server-side formulas in site/backend/supabase.sql
 * (level_from_xp, xp_for_difficulty, current_streak, mastery_stage).
 *
 * The SERVER is the source of truth — these are used for:
 *   - honest UI rendering of server-returned values (level progress bars,
 *     stage labels, streak display)
 *   - unit tests (tests/test_gamification.js) so the client and server
 *     formulas cannot drift silently
 *
 * They are NEVER used to grant XP/streaks/levels — that happens only inside
 * the record_attempt() SECURITY DEFINER function.
 * ==========================================================================*/
(function () {
  "use strict";

  var root = (typeof window !== "undefined") ? window : globalThis;

  /* total XP required to REACH level L (cumulative):
     level 1 -> 0, 2 -> 100, 3 -> 300, 4 -> 600, 5 -> 1000 ... = 50*(L-1)*L */
  function xpForLevel(L) { return 50 * (L - 1) * L; }

  function levelFromXp(xp) {
    // solve 50*(L-1)*L <= xp  =>  L = (1 + sqrt(1 + 4*xp/50)) / 2
    xp = Math.max(0, Math.floor(xp || 0));
    return Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * xp) / 50)) / 2));
  }

  /* {current, into, needed, progress01} — XP within the current level */
  function levelProgress(xp) {
    xp = Math.max(0, Math.floor(xp || 0));
    var L = levelFromXp(xp);
    var base = xpForLevel(L);
    var next = xpForLevel(L + 1);
    return {
      level: L,
      into: xp - base,
      needed: next - base,
      progress01: Math.min(1, (xp - base) / Math.max(1, next - base)),
    };
  }

  /* XP earned for a correct attempt by difficulty (mirror of xp_for_difficulty) */
  function xpForDifficulty(d) {
    d = Number(d);
    if (d <= 1) return 5;
    if (d <= 2) return 10;
    if (d <= 3) return 15;
    if (d <= 4) return 25;
    return 40;
  }

  /* day keys: array of 'YYYY-MM-DD' with an attempt.
     Streak counts consecutive days ending TODAY; if there is no activity
     today yet, a streak ending YESTERDAY is preserved (lenient rule —
     matches current_streak in supabase.sql). */
  function currentStreak(dayKeys, now) {
    now = now || new Date();
    var streak = 0;
    var cur = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var set = {};
    (dayKeys || []).forEach(function (k) { set[k] = true; });
    function key(d) {
      return d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0");
    }
    if (!set[key(cur)]) cur.setDate(cur.getDate() - 1); // grace: ends yesterday
    for (;;) {
      if (!set[key(cur)]) break;
      streak++;
      cur.setDate(cur.getDate() - 1);
    }
    return streak;
  }

  /* Mastery stage from question stats (mirror of mastery_stage) */
  var STAGE_ORDER = ["unseen", "learning", "practising", "strong", "mastered"];
  function masteryStage(stats) {
    stats = stats || {};
    var attempts = stats.attempts || 0;
    if (attempts === 0) return "unseen";
    if (attempts < 3) return "learning";
    var accuracy = stats.correct != null ? (100 * stats.correct) / attempts : (stats.accuracy || 0);
    var avgDiff = stats.avg_difficulty || 0;
    var daysSince = stats.days_since_last || 9999;
    if (attempts >= 5 && accuracy >= 90 && avgDiff >= 2.5 && daysSince <= 60) return "mastered";
    if (accuracy >= 70) return "strong";
    return "practising";
  }

  /* 0..1 "syllabus progress" for a topic's current stage (display) */
  function stageProgress(stage) {
    var idx = STAGE_ORDER.indexOf(stage);
    return idx < 0 ? 0 : (idx + 1) / STAGE_ORDER.length;
  }

  function stageLabel(stage) {
    return {
      unseen: "Unseen", learning: "Learning", practising: "Practising",
      strong: "Strong", mastered: "Mastered",
    }[stage] || stage;
  }

  /* Daily activity aggregation (mirrors daily_activity) from attempts */
  function aggregateDaily(attempts, days, now) {
    now = now || new Date();
    var byDay = {};
    (attempts || []).forEach(function (a) {
      var d = new Date(a.created_at || a.ts || now);
      var k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      byDay[k] = byDay[k] || { questions: 0, correct: 0, seconds: 0, xp: 0, topics: {} };
      byDay[k].questions++;
      if (a.correct) byDay[k].correct++;
      byDay[k].seconds += a.seconds || 0;
      byDay[k].xp += a.xp || 0;
      if (a.topic_id) byDay[k].topics[a.topic_id] = true;
    });
    var out = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      var k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      var day = byDay[k] || { questions: 0, correct: 0, seconds: 0, xp: 0, topics: {} };
      out.push({
        date: k,
        questions: day.questions,
        correct: day.correct,
        seconds: day.seconds,
        xp: day.xp,
        topics: Object.keys(day.topics),
      });
    }
    return out;
  }

  /* Timing statistics (mirrors time_stats shape) */
  function timingStats(attempts, globalStats) {
    var own = attempts || [];
    function median(arr) {
      if (!arr.length) return 0;
      var s = arr.slice().sort(function (a, b) { return a - b; });
      var mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }
    function avg(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : 0; }
    var secs = own.map(function (a) { return a.seconds || 0; });
    var correctSecs = own.filter(function (a) { return a.correct; }).map(function (a) { return a.seconds || 0; });
    var wrongSecs = own.filter(function (a) { return !a.correct; }).map(function (a) { return a.seconds || 0; });
    var g = globalStats || { avg: 0, median: 0, n: 0, correctAvg: 0, wrongAvg: 0 };
    var userAvg = avg(secs);
    var fasterPct = g.avg > 0 ? Math.round(((g.avg - userAvg) / g.avg) * 100) : null;
    return {
      user: { avg_seconds: Math.round(userAvg * 10) / 10, median_seconds: Math.round(median(secs) * 10) / 10, n: secs.length },
      global: { avg_seconds: g.avg, median_seconds: g.median, n: g.n },
      user_correct: Math.round(avg(correctSecs) * 10) / 10,
      user_incorrect: Math.round(avg(wrongSecs) * 10) / 10,
      global_correct: g.correctAvg || 0,
      global_incorrect: g.wrongAvg || 0,
      faster_slower_pct: fasterPct,
    };
  }

  /* Leaderboard ranking (pure, mirrors leaderboard RPC) */
  function rankLeaderboard(entries, opts) {
    opts = opts || {};
    var rows = (entries || [])
      .filter(function (e) { return !e.opt_out; })
      .sort(function (a, b) { return (b.xp || 0) - (a.xp || 0); })
      .map(function (e, i) {
        return { rank: i + 1, user_id: e.user_id, display_name: e.display_name || "Student",
                 avatar_url: e.avatar_url || null, xp: e.xp || 0, level: e.level || 1 };
      });
    var offset = opts.offset || 0;
    var limit = opts.limit || rows.length;
    return rows.slice(offset, offset + limit);
  }

  var api = {
    xpForLevel: xpForLevel, levelFromXp: levelFromXp, levelProgress: levelProgress,
    xpForDifficulty: xpForDifficulty, currentStreak: currentStreak,
    masteryStage: masteryStage, stageProgress: stageProgress, stageLabel: stageLabel,
    STAGE_ORDER: STAGE_ORDER, aggregateDaily: aggregateDaily,
    timingStats: timingStats, rankLeaderboard: rankLeaderboard,
  };
  root.QB = root.QB || {};
  root.QB.gamification = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
