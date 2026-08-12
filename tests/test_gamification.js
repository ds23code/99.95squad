#!/usr/bin/env node
/* Unit tests for the gamification logic module (mirrors supabase.sql). */
"use strict";

const G = require(process.argv[2] || "../site/assets/js/gamification.js");
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ✓ " + name);
  else { failures++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}

// ---- XP / levels -----------------------------------------------------------
check("xpForLevel(1) = 0", G.xpForLevel(1) === 0, G.xpForLevel(1));
check("xpForLevel(2) = 100", G.xpForLevel(2) === 100, G.xpForLevel(2));
check("xpForLevel(3) = 300", G.xpForLevel(3) === 300, G.xpForLevel(3));
check("levelFromXp(0) = 1", G.levelFromXp(0) === 1);
check("levelFromXp(99) = 1", G.levelFromXp(99) === 1);
check("levelFromXp(100) = 2", G.levelFromXp(100) === 2, G.levelFromXp(100));
check("levelFromXp(300) = 3", G.levelFromXp(300) === 3, G.levelFromXp(300));
check("levelFromXp(600) = 4", G.levelFromXp(600) === 4, G.levelFromXp(600));
check("levelFromXp(1000) = 5", G.levelFromXp(1000) === 5, G.levelFromXp(1000));
check("levelFromXp(negative) = 1", G.levelFromXp(-5) === 1);

const lp = G.levelProgress(100);
check("levelProgress(100) level 2", lp.level === 2 && lp.into === 0 && lp.needed === 200 && lp.progress01 === 0, JSON.stringify(lp));

// difficulty -> XP (mirror of xp_for_difficulty)
check("xpForDifficulty(1) = 5", G.xpForDifficulty(1) === 5);
check("xpForDifficulty(2) = 10", G.xpForDifficulty(2) === 10);
check("xpForDifficulty(3) = 15", G.xpForDifficulty(3) === 15);
check("xpForDifficulty(4) = 25", G.xpForDifficulty(4) === 25);
check("xpForDifficulty(5) = 40", G.xpForDifficulty(5) === 40);

// ---- streaks ---------------------------------------------------------------
const today = new Date();
function key(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function daysAgo(n) { const d = new Date(today); d.setDate(d.getDate() - n); return key(d); }
check("streak 0 with no days", G.currentStreak([]) === 0);
check("streak 1 today", G.currentStreak([daysAgo(0)]) === 1);
check("streak 3 consecutive", G.currentStreak([daysAgo(0), daysAgo(1), daysAgo(2)]) === 3);
check("streak survives yesterday-only", G.currentStreak([daysAgo(1), daysAgo(2)]) === 2);
check("streak resets after a gap", G.currentStreak([daysAgo(0), daysAgo(3), daysAgo(4)]) === 1);
check("streak ignores order", G.currentStreak([daysAgo(2), daysAgo(0), daysAgo(1)]) === 3);

// ---- mastery ---------------------------------------------------------------
check("0 attempts -> unseen", G.masteryStage({ attempts: 0 }) === "unseen");
check("1 attempt -> learning", G.masteryStage({ attempts: 1, correct: 1 }) === "learning");
check("2 attempts -> learning", G.masteryStage({ attempts: 2, correct: 2 }) === "learning");
check("3 attempts 50% -> practising", G.masteryStage({ attempts: 3, correct: 1.5 }) === "practising");
check("3 attempts 75% -> strong", G.masteryStage({ attempts: 3, correct: 2.25 }) === "strong");
check("5 attempts 90% easy -> strong", G.masteryStage({ attempts: 5, correct: 4.5, avg_difficulty: 2, days_since_last: 2 }) === "strong");
check("5 attempts 90% hard recent -> mastered",
  G.masteryStage({ attempts: 5, correct: 4.5, avg_difficulty: 3, days_since_last: 10 }) === "mastered");
check("5 attempts 90% hard stale -> strong",
  G.masteryStage({ attempts: 5, correct: 4.5, avg_difficulty: 3, days_since_last: 90 }) === "strong");
check("stage order", JSON.stringify(G.STAGE_ORDER) === JSON.stringify(["unseen", "learning", "practising", "strong", "mastered"]));

// ---- daily activity aggregation --------------------------------------------
const attempts = [
  { created_at: daysAgo(1), correct: true, seconds: 30, xp: 10, topic_id: "t1" },
  { created_at: daysAgo(1), correct: false, seconds: 40, xp: 0, topic_id: "t1" },
  { created_at: daysAgo(0), correct: true, seconds: 20, xp: 15, topic_id: "t2" },
];
const agg = G.aggregateDaily(attempts, 7);
check("aggregate returns 7 days", agg.length === 7);
check("today questions = 1", agg[6].questions === 1, JSON.stringify(agg[6]));
check("today xp = 15", agg[6].xp === 15);
check("yesterday questions = 2", agg[5].questions === 2);
check("yesterday accuracy = 50", agg[5].correct === 1);
check("yesterday topics listed", Array.isArray(agg[5].topics) && agg[5].topics.indexOf("t1") !== -1);

// ---- timing statistics -------------------------------------------------------
const timing = G.timingStats(
  [
    { seconds: 10, correct: true }, { seconds: 20, correct: true },
    { seconds: 40, correct: false }, { seconds: 30, correct: true },
  ],
  { avg: 25, median: 25, n: 100, correctAvg: 20, wrongAvg: 45 }
);
check("timing user avg", timing.user.avg_seconds === 25, timing.user.avg_seconds);
check("timing user median", timing.user.median_seconds === 25, timing.user.median_seconds);
check("timing user n", timing.user.n === 4);
check("timing correct/incorrect split", timing.user_correct === 20 && timing.user_incorrect === 40);
check("faster/slower vs global", timing.faster_slower_pct === 0, timing.faster_slower_pct);
const faster = G.timingStats([{ seconds: 5, correct: true }], { avg: 25, median: 25, n: 100, correctAvg: 20, wrongAvg: 45 });
check("faster pct positive", faster.faster_slower_pct === 80, faster.faster_slower_pct);

// ---- leaderboard ranking ------------------------------------------------------
const entries = [
  { user_id: "a", display_name: "Alice", xp: 150, level: 3 },
  { user_id: "b", display_name: "Bob", xp: 300, level: 4 },
  { user_id: "c", display_name: "Cara", xp: 100, level: 2, opt_out: true },
  { user_id: "d", display_name: "", xp: 50, level: 1 },
];
const ranked = G.rankLeaderboard(entries);
check("opt-out excluded", ranked.length === 3 && !ranked.some((r) => r.user_id === "c"));
check("sorted by xp desc", ranked[0].user_id === "b" && ranked[1].user_id === "a" && ranked[2].user_id === "d");
check("rank numbers", ranked[0].rank === 1 && ranked[2].rank === 3);
check("display fallback", ranked[2].display_name === "Student");
const paged = G.rankLeaderboard(entries, { offset: 1, limit: 1 });
check("pagination", paged.length === 1 && paged[0].user_id === "a");

console.log("");
if (failures) { console.log("GAMIFICATION TESTS FAILED: " + failures); process.exit(1); }
console.log("GAMIFICATION TESTS PASSED");
