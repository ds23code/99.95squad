/* ============================================================================
 * comments.js — question comments widget.
 * Server-side (Supabase): rate limited, profanity filtered, own-delete only,
 * likes, reports, admin hide. Client renders + calls the RPCs.
 * ==========================================================================*/
(function () {
  "use strict";

  var root = window;
  var C = root.QB.core;
  var B = root.QB.backend;

  function avatar(name, url) {
    if (url) return '<img class="cmt-avatar" src="' + C.escapeHtml(url) + '" alt="">';
    var initial = (name || "?").charAt(0).toUpperCase();
    return '<span class="cmt-avatar cmt-avatar-initial">' + C.escapeHtml(initial) + "</span>";
  }

  function render(container, questionId, opts) {
    opts = opts || {};
    container.innerHTML =
      '<div class="comments">' +
      "<h3>Discussion</h3>" +
      (B.enabled() ? "" : '<div class="notice">Comments require the Supabase backend — see docs/AUTH.md.</div>') +
      '<form class="cmt-form" id="cmt-form">' +
      '<textarea id="cmt-input" rows="2" placeholder="Ask a question or share a tip… (be kind)" maxlength="1000"></textarea>' +
      '<div class="actions"><button class="btn sm" type="submit">Post</button>' +
      '<span class="cmt-error" id="cmt-error"></span></div>' +
      "</form>" +
      '<div class="cmt-list" id="cmt-list"><p class="muted fine">Loading…</p></div>' +
      "</div>";

    var list = C.$("#cmt-list", container);
    var errorEl = C.$("#cmt-error", container);
    var form = C.$("#cmt-form", container);

    function load() {
      B.listComments(questionId).then(function (rows) {
        if (rows === null) { list.innerHTML = '<p class="muted fine">Comments unavailable.</p>'; return; }
        if (!rows.length) { list.innerHTML = '<p class="muted fine">No comments yet — start the discussion.</p>'; return; }
        var byId = {};
        rows.forEach(function (r) { byId[r.id] = r; });
        var top = rows.filter(function (r) { return r.parent_id == null; });
        var children = rows.filter(function (r) { return r.parent_id != null; });
        var user = B.currentUser();
        list.innerHTML = top.map(function (c) { return renderRow(c, children, byId, user); }).join("");
        bind(list);
      });
    }

    function renderRow(c, children, byId, user) {
      var replies = children.filter(function (ch) { return ch.parent_id === c.id; }).map(function (ch) { return renderRow(ch, [], byId, user); }).join("");
      var mine = user && c.user_id === user.id;
      return (
        '<div class="cmt" data-cid="' + c.id + '">' +
        '<div class="cmt-head">' + avatar(c.display_name || "Student", c.avatar_url) +
        "<strong>" + C.escapeHtml(c.display_name || "Student") + "</strong>" +
        '<span class="muted fine">' + C.fmtDate(c.created_at) + "</span></div>" +
        '<p class="cmt-body">' + C.escapeHtml(c.body) + "</p>" +
        '<div class="cmt-actions">' +
        '<button class="cmt-act" data-act="like" data-cid="' + c.id + '">♥ <span class="cmt-likes">' + c.likes + "</span></button>" +
        '<button class="cmt-act" data-act="reply" data-cid="' + c.id + '">Reply</button>' +
        '<button class="cmt-act" data-act="report" data-cid="' + c.id + '">Report</button>' +
        (mine ? '<button class="cmt-act danger" data-act="delete" data-cid="' + c.id + '">Delete</button>' : "") +
        "</div>" +
        (replies ? '<div class="cmt-replies">' + replies + "</div>" : "") +
        "</div>"
      );
    }

    function bind(scope) {
      C.$$("[data-act]", scope).forEach(function (btn) {
        btn.addEventListener("click", function () {
          var cid = btn.dataset.cid;
          var act = btn.dataset.act;
          if (act === "like") {
            B.likeComment(cid).then(function (res) {
              if (!res) return;
              var el = C.$('[data-cid="' + cid + '"] .cmt-likes', scope);
              if (el) el.textContent = res.likes;
            });
          } else if (act === "reply") {
            var input = C.$("#cmt-input", container);
            input.placeholder = "Reply to comment…";
            input.dataset.parent = cid;
            input.focus();
          } else if (act === "report") {
            var reason = prompt("Why are you reporting this comment?", "offensive or unhelpful");
            if (!reason) return;
            B.reportComment(cid, reason).then(function () { C.toast("Thanks — our moderators will review it."); });
          } else if (act === "delete") {
            if (!confirm("Delete this comment?")) return;
            B.deleteOwnComment(cid).then(function () {
              var el = C.$('[data-cid="' + cid + '"]', scope);
              if (el) el.remove();
            });
          }
        });
      });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errorEl.textContent = "";
      var input = C.$("#cmt-input", container);
      var body = input.value.trim();
      if (!body) return;
      var parent = input.dataset.parent ? Number(input.dataset.parent) : null;
      if (!B.authed()) { errorEl.textContent = "Sign in to comment."; return; }
      B.addComment(questionId, body, parent).then(function (row) {
        if (row === null) { errorEl.textContent = "Could not post — backend required or rate limited."; return; }
        input.value = "";
        input.dataset.parent = "";
        input.placeholder = "Ask a question or share a tip… (be kind)";
        load();
      }).catch(function (err) {
        errorEl.textContent = err && err.message ? err.message : "Could not post comment.";
      });
    });

    load();
  }

  root.QB = root.QB || {};
  root.QB.comments = { render: render };
})();
