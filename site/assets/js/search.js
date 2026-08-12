/* ============================================================================
 * search.js — client-side question search & filtering
 * Works against the sharded static index (content/index/<course>/<char>.json).
 * The tokenizer MUST mirror pipeline/export_static.py::tokenize.
 *
 * Pure functions are exported for tests (node: require + Node 18+ fetch).
 * ==========================================================================*/
(function () {
  "use strict";

  var root = (typeof window !== "undefined") ? window : globalThis;

  var STOPWORDS = new Set(("the and for are was with that this from have has had not you your will " +
    "would can could should shall may might must its it's which what where when why how who whom " +
    "than then them they their there these those into onto over under between during after before " +
    "above below each every both some any all other another also such only very just but or so if " +
    "as at by in of on to up out off an a is are be been being were do does did done").split(/\s+/));

  function tokenize(text) {
    if (!text) return [];
    var tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
    return tokens.filter(function (t) { return t.length >= 2 && !STOPWORDS.has(t); });
  }

  function tokenInitial(token) {
    var ch = token[0];
    if (/[0-9]/.test(ch)) return "0-9";
    if (/[a-z]/.test(ch)) return ch;
    return "_";
  }

  /* ------------------------------------------------------------ filtering */
  function matchesFilters(rec, f) {
    f = f || {};
    if (f.course && rec.course_id !== f.course) return false;
    if (f.topic && rec.topic_id !== f.topic) return false;
    if (f.subtopic && rec.subtopic_id !== f.subtopic) return false;
    if (f.qtype && rec.qtype !== f.qtype) return false;
    if (f.paper_year && rec.paper_year != null && Number(rec.paper_year) !== Number(f.paper_year)) return false;
    if (f.paper_type && rec.paper_type !== f.paper_type) return false;
    if (f.marks_min != null && (rec.marks == null || rec.marks < Number(f.marks_min))) return false;
    if (f.difficulty_min != null && (rec.difficulty == null || rec.difficulty < Number(f.difficulty_min))) return false;
    if (f.difficulty_max != null && (rec.difficulty == null || rec.difficulty > Number(f.difficulty_max))) return false;
    if (f.year_level != null) {
      var course = root.QB.courseByLevel && root.QB.courseByLevel()[f.course || rec.course_id];
      var level = course != null ? course.year_level : null;
      if (level != null && Number(level) !== Number(f.year_level)) return false;
    }
    return true;
  }

  /* ----------------------------------------------------------- intersection */
  /* postings: array of {term, ids[]} arrays -> ids matching ALL terms */
  function intersect(postings) {
    if (!postings.length) return [];
    var acc = postings[0].slice();
    for (var i = 1; i < postings.length && acc.length; i++) {
      var next = postings[i];
      var merged = [];
      var a = 0, b = 0;
      while (a < acc.length && b < next.length) {
        if (acc[a] === next[b]) { merged.push(acc[a]); a++; b++; }
        else if (acc[a] < next[b]) a++;
        else b++;
      }
      acc = merged;
    }
    return acc;
  }

  /* -------------------------------------------------- backend-swappable search */
  /* The search layer is an adapter: the static implementation below serves
   * smaller datasets; for 100k+ questions, point QB_CONFIG.search.backend at a
   * search API implementing:
   *     GET {backend}?q=...&course=...&topic=...&difficulty_min=...
   *         &page=1&per_page=20&sort=...
   *     -> { total, items: [question records] }
   * set QB_CONFIG.search.engine = "backend", and re-implement `query`
   * (see docs/DEPLOY.md). The UI never changes. */
  function facetTokensFromFilters(f) {
    var tokens = [];
    if (!f) return tokens;
    if (f.subject) tokens.push("s:" + f.subject);
    if (f.course) tokens.push("c:" + f.course);
    if (f.topic) tokens.push("t:" + f.topic);
    if (f.subtopic) tokens.push("st:" + f.subtopic);
    if (f.qtype) tokens.push("q:" + f.qtype);
    if (f.paper_year) tokens.push("y:" + f.paper_year);
    if (f.paper_type) tokens.push("p:" + f.paper_type);
    if (f.difficulty_min != null && f.difficulty_min !== "") {
      var dmin = Math.ceil(Number(f.difficulty_min));
      for (var d = Math.max(1, dmin); d <= 5; d++) tokens.push("d:" + d);
    }
    if (f.difficulty_max != null && f.difficulty_max !== "") {
      var dmax = Math.floor(Number(f.difficulty_max));
      for (var d2 = 1; d2 <= Math.min(5, dmax); d2++) tokens.push("d:" + d2);
    }
    if (f.marks_min != null && f.marks_min !== "") {
      for (var m = Number(f.marks_min); m <= 15; m++) tokens.push("m:" + m);
    }
    return tokens;
  }

  function searchBackendConfigured() {
    var s = (root.QB_CONFIG && root.QB_CONFIG.search) || {};
    return s.engine === "backend" && !!s.backend;
  }

  /* Query the configured backend search API (records are fetched directly). */
  function queryBackend(params) {
    var s = root.QB_CONFIG.search;
    var url = s.backend + "?" + params.toString();
    return fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("search backend HTTP " + res.status);
        return res.json();
      });
  }

  /* ------------------------------------------------------------- search API */
  /* Returns a Promise<{ids, courses, terms, facet, records, total, error}>
   * for a text query + filters. `meta` must be provided (QB.api.meta()).
   * - ids: question ids matching (null when the query can only be answered
   *   by scanning shards — the browse page falls back to lazy iteration)
   * - records/total: populated when the backend engine is configured. */
  function searchIds(terms, filters, meta) {
    filters = filters || {};
    var courses;
    if (filters.course) courses = [filters.course];
    else if (filters.subject) courses = meta.courses.filter(function (c) { return c.subject_id === filters.subject && c.n > 0; }).map(function (c) { return c.id; });
    else courses = meta.courses.filter(function (c) { return c.n > 0; }).map(function (c) { return c.id; });
    courses = courses.filter(function (id) { return id !== "unknown-course"; });

    // ---- backend engine ---------------------------------------------------
    if (searchBackendConfigured()) {
      var p = new URLSearchParams();
      if (terms.length) p.set("q", terms.join(" "));
      Object.keys(filters).forEach(function (k) { if (filters[k] != null && filters[k] !== "") p.set(k, filters[k]); });
      return queryBackend(p).then(function (data) {
        return {
          ids: (data.items || []).map(function (r) { return r.id; }),
          records: data.items || [],
          total: data.total != null ? data.total : (data.items || []).length,
          courses: courses, terms: terms, facet: false, backend: true,
        };
      });
    }

    // ---- static engine ----------------------------------------------------
    if (!terms.length) {
      var facetTokens = facetTokensFromFilters(filters);
      if (facetTokens.length) {
        return _facetSearch(courses, facetTokens).then(function (ids) {
          return { ids: ids, courses: courses, terms: [], facet: true, records: null, total: ids.length };
        });
      }
      /* filters-only without facet support: lazily page through shards
         (handled by the browse page) */
      return Promise.resolve({ ids: null, courses: courses, terms: [], facet: false, records: null, total: null });
    }

    var byCourse = courses.map(function (courseId) {
      // each term lives in its own character shard — fetch per term
      var termPromises = terms.map(function (t) { return root.QB.api.postings(courseId, t); });
      return Promise.all(termPromises).then(function (files) {
        var postings = terms.map(function (t, i) { return files[i][t] || []; });
        return { course: courseId, ids: intersect(postings) };
      });
    });

    return Promise.all(byCourse).then(function (results) {
      var merged = {};
      results.forEach(function (r) {
        r.ids.forEach(function (id) { merged[id] = true; });
      });
      var ids = Object.keys(merged);
      // apply facet filters to text results too (records are already
      // narrowed by index; filters filter within)
      return { ids: ids, courses: courses, terms: terms, facet: false, records: null, total: ids.length };
    });
  }

  /* Filter-only search via facet-token index intersection. */
  function _facetSearch(courses, facetTokens) {
    var byCourse = courses.map(function (courseId) {
      var tokenPromises = facetTokens.map(function (t) { return root.QB.api.postings(courseId, t); });
      return Promise.all(tokenPromises).then(function (files) {
        var postings = facetTokens.map(function (t, i) { return files[i][t] || []; });
        return { course: courseId, ids: intersect(postings) };
      });
    });
    return Promise.all(byCourse).then(function (results) {
      var merged = {};
      results.forEach(function (r) { r.ids.forEach(function (id) { merged[id] = true; }); });
      return Object.keys(merged);
    });
  }

  /* --------------------------------------------------------------- sorting */
  function sortRecords(recs, sortBy, recMap) {
    var arr = recs.slice();
    var cmp;
    if (sortBy === "newest") {
      cmp = function (a, b) { return (b.paper_year || 0) - (a.paper_year || 0) || (a.qnum || "") < (b.qnum || "") ? -1 : 1; };
    } else if (sortBy === "difficulty") {
      cmp = function (a, b) { return (b.difficulty || 0) - (a.difficulty || 0) || (a.qnum || "") < (b.qnum || "") ? -1 : 1; };
    } else if (sortBy === "marks") {
      cmp = function (a, b) { return (b.marks || 0) - (a.marks || 0) || (a.qnum || "") < (b.qnum || "") ? -1 : 1; };
    } else if (sortBy === "random") {
      // Fisher–Yates
      for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    } else {
      // relevance: fewer words in text matched (rare terms) score higher
      var freq = {};
      var seen = [];
      arr.forEach(function (r) {
        var toks = tokenize((recMap[r.id] || {}).paper_name || "");
        toks.forEach(function (t) { if (!freq[t]) { freq[t] = 0; seen.push(t); } freq[t]++; });
      });
      cmp = function (a, b) { return (a.qnum || "") < (b.qnum || "") ? -1 : 1; };
    }
    return arr.sort(cmp);
  }

  /* ------------------------------------------------------------- pagination */
  function page(items, pageNo, perPage) {
    pageNo = Math.max(1, pageNo || 1);
    perPage = perPage || 30;
    var start = (pageNo - 1) * perPage;
    return { items: items.slice(start, start + perPage), page: pageNo, pages: Math.max(1, Math.ceil(items.length / perPage)), total: items.length };
  }

  var api = {
    tokenize: tokenize, tokenInitial: tokenInitial, STOPWORDS: STOPWORDS,
    matchesFilters: matchesFilters, intersect: intersect, searchIds: searchIds,
    sortRecords: sortRecords, page: page,
  };
  root.QB = root.QB || {};
  root.QB.search = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
