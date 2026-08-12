/* ============================================================================
 * calendar.js — daily activity heatmap (GitHub-contribution style).
 * Views: week / month / year. Clicking a cell shows that day's detail
 * (questions, accuracy, XP, study time, topics) via the `onDay` callback.
 * Pure DOM renderer; data comes from QB.backend.dailyActivity (server-side).
 * ==========================================================================*/
(function () {
  "use strict";

  var root = window;
  var C = root.QB.core;

  function pad(n) { return String(n).padStart(2, "0"); }
  function key(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

  function level(day) {
    var q = day.questions || 0;
    if (q === 0) return 0;
    if (q <= 2) return 1;
    if (q <= 5) return 2;
    if (q <= 10) return 3;
    return 4;
  }

  function fmtSeconds(secs) {
    secs = secs || 0;
    var m = Math.floor(secs / 60);
    return m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "m" : m + "m";
  }

  /* data: [{date, questions, correct, seconds, xp, topics}] (from backend) */
  function render(container, data, opts) {
    opts = opts || {};
    var view = opts.view || "month";
    var byDate = {};
    (data || []).forEach(function (d) { byDate[d.date] = d; });

    var cells = [];
    var now = new Date();
    var rangeStart, rangeEnd;

    if (view === "week") {
      var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
      rangeStart = start; rangeEnd = now;
      for (var i = 0; i < 7; i++) {
        var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        cells.push(d);
      }
    } else if (view === "month") {
      var first = new Date(now.getFullYear(), now.getMonth(), 1);
      var last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      rangeStart = first; rangeEnd = last;
      // leading blanks to align weekday columns
      var lead = first.getDay();
      for (i = 0; i < lead; i++) cells.push(null);
      for (var d2 = new Date(first); d2 <= last; d2.setDate(d2.getDate() + 1)) cells.push(new Date(d2));
    } else { // year
      var yStart = new Date(now.getFullYear(), 0, 1);
      rangeStart = yStart;
      var yEnd = new Date(now.getFullYear(), 11, 31);
      rangeEnd = yEnd;
      var lead2 = yStart.getDay();
      for (i = 0; i < lead2; i++) cells.push(null);
      for (var d3 = new Date(yStart); d3 <= yEnd; d3.setDate(d3.getDate() + 1)) cells.push(new Date(d3));
    }

    var totalQuestions = 0, totalXp = 0, totalSecs = 0, totalCorrect = 0;
    (data || []).forEach(function (d) {
      if (d.date >= key(rangeStart) && d.date <= key(rangeEnd)) {
        totalQuestions += d.questions || 0;
        totalXp += d.xp || 0;
        totalSecs += d.seconds || 0;
        totalCorrect += d.correct || 0;
      }
    });

    var weekdays = ["S", "M", "T", "W", "T", "F", "S"];
    var html =
      '<div class="cal-head">' +
      '<div class="cal-totals">' +
      '<span><b>' + totalQuestions + "</b> questions</span>" +
      '<span><b>' + totalXp + "</b> XP</span>" +
      '<span><b>' + fmtSeconds(totalSecs) + "</b> study</span>" +
      '<span><b>' + Math.round(totalQuestions ? (100 * totalCorrect / totalQuestions) : 0) + "%</b> accuracy</span>" +
      "</div>" +
      '<div class="cal-views" role="tablist">' +
      '<button class="cal-view' + (view === "week" ? " active" : "") + '" data-view="week">Week</button>' +
      '<button class="cal-view' + (view === "month" ? " active" : "") + '" data-view="month">Month</button>' +
      '<button class="cal-view' + (view === "year" ? " active" : "") + '" data-view="year">Year</button>' +
      "</div></div>";

    if (view === "year") {
      html += '<div class="cal-weekdays">' + weekdays.map(function (w) { return "<span>" + w + "</span>"; }).join("") + "</div>";
    }
    html += '<div class="cal-grid cal-' + view + '">';
    cells.forEach(function (d) {
      if (!d) { html += '<span class="cal-cell cal-blank"></span>'; return; }
      var k = key(d);
      var day = byDate[k];
      var lvl = day ? level(day) : 0;
      var label = d.toDateString() + (day ? ": " + day.questions + " questions, " + day.xp + " XP, " + fmtSeconds(day.seconds) : ": no activity");
      html += '<span class="cal-cell cal-l' + lvl + '" data-date="' + k + '" tabindex="0" role="gridcell" ' +
        'aria-label="' + C.escapeHtml(label) + '" title="' + C.escapeHtml(label) + '"></span>';
    });
    html += "</div>";
    html += '<div class="cal-legend"><span class="muted fine">less</span>' +
      [0, 1, 2, 3, 4].map(function (l) { return '<span class="cal-cell cal-l' + l + '"></span>'; }).join("") +
      '<span class="muted fine">more</span></div>';
    html += '<div class="cal-day-detail" id="cal-day-detail"><p class="muted fine">Click a day for details.</p></div>';

    container.innerHTML = html;

    // view switcher
    C.$$(".cal-view", container).forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (opts.onView) opts.onView(btn.dataset.view);
      });
    });

    // day click -> detail
    C.$$(".cal-cell[data-date]", container).forEach(function (cell) {
      function show() {
        var day = byDate[cell.dataset.date] || { questions: 0, correct: 0, xp: 0, seconds: 0, topics: [] };
        var detail = C.$("#cal-day-detail", container);
        var topicNames = (day.topics || []).slice(0, 4).map(function (t) {
          return C.escapeHtml(root.QB.api.topicName(t) || t);
        });
        detail.innerHTML =
          "<strong>" + C.escapeHtml(new Date(cell.dataset.date).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })) + "</strong>" +
          '<div class="cal-day-stats">' +
          "<span>Questions: <b>" + day.questions + "</b></span>" +
          "<span>Accuracy: <b>" + Math.round(day.questions ? (100 * day.correct / day.questions) : 0) + "%</b></span>" +
          "<span>XP: <b>" + day.xp + "</b></span>" +
          "<span>Study: <b>" + fmtSeconds(day.seconds) + "</b></span></div>" +
          (topicNames.length ? '<p class="fine muted">Topics: ' + topicNames.join(" · ") + "</p>" : "");
        if (opts.onDay) opts.onDay(day);
      }
      cell.addEventListener("click", show);
      cell.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(); } });
    });
  }

  root.QB = root.QB || {};
  root.QB.calendar = { render: render };
})();
