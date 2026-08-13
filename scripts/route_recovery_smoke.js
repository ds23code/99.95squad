#!/usr/bin/env node
"use strict";

/* Execute the actual inline 404.html recovery code against GitHub Pages URLs.
 * This covers direct navigation/refresh, which an in-app hash-router smoke
 * cannot exercise because the request fails before index.html loads. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "site", "404.html"), "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/i);
if (!match) throw new Error("site/404.html has no inline recovery script");

function recover(pathname, search = "", hostname = "ds23code.github.io") {
  let replacement = null;
  const location = {
    origin: "https://" + hostname,
    hostname,
    pathname,
    search,
    hash: "",
    replace(value) { replacement = value; },
  };
  vm.runInNewContext(match[1], { location }, { filename: "site/404.html" });
  return replacement;
}

const checks = [
  ["admin direct path", recover("/99.95squad/admin"),
    "https://ds23code.github.io/99.95squad/#/admin"],
  ["query-bearing settings path", recover("/99.95squad/settings", "?tab=subjects"),
    "https://ds23code.github.io/99.95squad/#/settings?tab=subjects"],
  ["nested report path", recover("/99.95squad/report/paper-q1"),
    "https://ds23code.github.io/99.95squad/#/report/paper-q1"],
];

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual === expected) console.log("  ✓ " + name);
  else {
    failed += 1;
    console.error("  ✗ " + name + " — expected " + expected + ", got " + actual);
  }
}
if (failed) process.exit(1);
console.log("ROUTE RECOVERY SMOKE PASSED — all checks ok");
