/* ============================================================================
 * api.js — lazy loading of the static content tree
 * All data files live under content/ (committed sample or full export).
 * Shards and index files are fetched on demand and cached in memory.
 * ==========================================================================*/
(function () {
  "use strict";

  var BASE = "content/";
  var cache = {};
  var pending = {};
  var root = window;

  function url(path) { return BASE + path; }

  /* ------------------------------------------------------------------
   * imageUrl — resolve a content-relative image path ("images/...") to
   * a browser URL relative to the site root ("content/images/...").
   *
   * Shard JSON stores image paths relative to the *content* root. If they
   * were used as-is in <img src>, the browser would resolve them against
   * the document root (e.g. /99.95squad/images/...) and every question
   * image would 404. Prefixing with BASE keeps everything relative, so the
   * site works from the domain root AND under a GitHub Pages subpath.
   * ------------------------------------------------------------------ */
  function imageUrl(rel) {
    if (!rel) return null;
    if (/^(https?:)?\/\//i.test(rel) || rel.indexOf("data:") === 0) return rel;
    return BASE + rel;
  }

  function loadJSON(path, force) {
    if (cache[path] && !force) return Promise.resolve(cache[path]);
    if (pending[path]) return pending[path];
    var p = fetch(url(path))
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + path);
        return res.json();
      })
      .then(function (data) { cache[path] = data; return data; })
      .finally(function () { delete pending[path]; });
    pending[path] = p;
    return p;
  }

  function manifest() { return loadJSON("manifest.json"); }

  function meta() {
    return Promise.all([
      loadJSON("meta/subjects.json"),
      loadJSON("meta/courses.json"),
      loadJSON("meta/topics.json"),
      loadJSON("meta/papers.json"),
      loadJSON("meta/facets.json"),
    ]).then(function (parts) {
      return {
        subjects: parts[0], courses: parts[1], topics: parts[2],
        papers: parts[3], facets: parts[4],
      };
    });
  }

  function lookup() { return loadJSON("questions/lookup.json"); }

  function courseMeta(courseId) { return loadJSON("questions/" + encodeURIComponent(courseId) + "/meta.json"); }

  function shard(courseId, n) {
    return loadJSON("questions/" + encodeURIComponent(courseId) + "/shard-" + n + ".json");
  }

  /* all records of a course (fetches every shard once; cached).
     Courses without exported content resolve to [] rather than rejecting. */
  function courseRecords(courseId) {
    return courseMeta(courseId).catch(function () { return { shards: 0 }; }).then(function (m) {
      var all = [];
      var cursor = Promise.resolve();
      for (var j = 0; j < m.shards; j++) {
        (function (n) {
          cursor = cursor.then(function () {
            return shard(courseId, n).then(function (recs) { all = all.concat(recs); });
          });
        })(j);
      }
      return cursor.then(function () { return all; });
    });
  }

  /* fetch records for a list of ids, lazily grouped by [course, shard] */
  function records(ids) {
    return lookup().then(function (lk) {
      var groups = {};
      var missing = [];
      ids.forEach(function (id) {
        var ref = lk[id];
        if (!ref) { missing.push(id); return; }
        var key = ref[0] + "|" + ref[1];
        groups[key] = groups[key] || { course: ref[0], shard: ref[1], ids: [] };
        groups[key].ids.push(id);
      });
      var keys = Object.keys(groups);
      var out = {};
      var cursor = Promise.resolve();
      keys.forEach(function (key) {
        var g = groups[key];
        cursor = cursor.then(function () {
          return shard(g.course, g.shard).then(function (recs) {
            var byId = {};
            recs.forEach(function (r) { byId[r.id] = r; });
            g.ids.forEach(function (id) { if (byId[id]) out[id] = byId[id]; });
          });
        });
      });
      return cursor.then(function () { return out; });
    });
  }

  /* ------------------------------------------------------------ search index */
  function indexMeta(courseId) { return loadJSON("index/" + encodeURIComponent(courseId) + "/meta.json"); }
  function termFile(courseId, char) {
    return loadJSON("index/" + encodeURIComponent(courseId) + "/" + char + ".json");
  }

  /* term -> [qid] postings, with per-course cache.
     Consults index/<course>/meta.json first so we never request a character
     file that was not exported (zero 404s on a healthy site). */
  var termCache = {};
  var indexCharsCache = {};
  function postings(courseId, term) {
    var char = root.QB.search.tokenInitial(term);
    var key = courseId + "|" + char;
    if (termCache[key]) return Promise.resolve(termCache[key]);
    var charsPromise = indexCharsCache[courseId] || indexMeta(courseId).then(function (m) {
      indexCharsCache[courseId] = m.chars || [];
      return indexCharsCache[courseId];
    }).catch(function () {
      indexCharsCache[courseId] = [];
      return [];
    });
    return charsPromise.then(function (chars) {
      if (chars.indexOf(char) === -1) {
        termCache[key] = {};
        return termCache[key];
      }
      return termFile(courseId, char)
        .then(function (terms) { termCache[key] = terms; return terms; })
        .catch(function () { termCache[key] = {}; return termCache[key]; });
    });
  }

  /* ------------------------------------------------------------- per-question */
  function text(qid) {
    return loadJSON("text/" + encodeURIComponent(qid) + ".json").catch(function () { return null; });
  }

  /* -------------------------------------------------------------- upload hashes */
  function knownHashes() { return loadJSON("uploads/hashes.json").catch(function () { return {}; }); }

  /* ------------------------------------------------------- name resolvers */
  var metaCache = null;
  var metaPromise = null;
  function metaOnce() {
    if (metaCache) return Promise.resolve(metaCache);
    if (metaPromise) return metaPromise;
    metaPromise = meta().then(function (m) { metaCache = m; return m; });
    return metaPromise;
  }
  function courseById(id) {
    if (!metaCache) return null;
    return metaCache.courses.filter(function (c) { return c.id === id; })[0] || null;
  }
  function courseByLevel() {
    var out = {};
    if (metaCache) metaCache.courses.forEach(function (c) { out[c.id] = c; });
    return out;
  }
  function courseName(id) {
    var c = courseById(id);
    return c ? c.name : null;
  }
  function topicName(id) {
    if (!metaCache || !id) return null;
    for (var i = 0; i < metaCache.topics.length; i++) {
      if (metaCache.topics[i].id === id) return metaCache.topics[i].name;
    }
    return null;
  }
  function subtopicName(id) {
    if (!metaCache || !id) return null;
    for (var i = 0; i < metaCache.topics.length; i++) {
      var subs = metaCache.topics[i].subtopics || [];
      for (var j = 0; j < subs.length; j++) if (subs[j].id === id) return subs[j].name;
    }
    return null;
  }

  /* --------------------------------------------------------------- exposed */
  root.QB = root.QB || {};
  root.QB.api = {
    BASE: BASE, loadJSON: loadJSON, manifest: manifest, meta: meta,
    lookup: lookup, shard: shard, courseMeta: courseMeta, courseRecords: courseRecords,
    records: records, indexMeta: indexMeta, termFile: termFile, postings: postings,
    text: text, knownHashes: knownHashes, imageUrl: imageUrl,
    metaOnce: metaOnce, courseById: courseById, courseByLevel: courseByLevel,
    courseName: courseName, topicName: topicName, subtopicName: subtopicName,
  };
})();
