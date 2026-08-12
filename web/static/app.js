/* QuestionBank front-end behaviour */
(function () {
  "use strict";

  /* ---- filter form: cascade course/topic dropdowns ---- */
  var subject = document.getElementById("f-subject");
  var course = document.getElementById("f-course");
  var topic = document.getElementById("f-topic");
  if (subject && course) {
    function filterCourse() {
      var s = subject.value;
      Array.prototype.forEach.call(course.options, function (opt) {
        opt.hidden = s !== "" && opt.dataset.subject !== s;
        if (opt.hidden && opt.selected) opt.selected = false;
      });
    }
    subject.addEventListener("change", filterCourse);
    filterCourse();
  }
  if (course && topic) {
    function filterTopic() {
      var c = course.value;
      Array.prototype.forEach.call(topic.options, function (opt) {
        opt.hidden = c !== "" && opt.dataset.course !== c;
        if (opt.hidden && opt.selected) opt.selected = false;
      });
    }
    course.addEventListener("change", filterTopic);
    filterTopic();
  }
  /* practice form topics follow course too */
  var pCourse = document.getElementById("p-course");
  var pTopic = document.getElementById("p-topic");
  if (pCourse && pTopic) {
    pCourse.addEventListener("change", function () {
      var c = pCourse.value;
      Array.prototype.forEach.call(pTopic.options, function (opt) {
        opt.hidden = c !== "" && opt.dataset.course !== c;
        if (opt.hidden && opt.selected) opt.selected = false;
      });
    });
  }

  /* ---- question detail: reveal answer / marks ---- */
  var revealBtn = document.getElementById("reveal-answer");
  var answerBox = document.getElementById("answer-box");
  if (revealBtn && answerBox) {
    revealBtn.addEventListener("click", function () {
      if (answerBox.classList.contains("hidden")) {
        fetch(revealBtn.dataset.href)
          .then(function (r) { return r.json(); })
          .then(function (q) {
            var text = answerBox.querySelector(".answer-text");
            if (q.answer) {
              text.textContent = "Answer: " + q.answer;
            } else {
              text.textContent = "No short answer recorded for this question.";
            }
            var sol = answerBox.querySelector(".solution-image");
            sol.innerHTML = "";
            if (q.solution_image_url) {
              var img = document.createElement("img");
              img.src = q.solution_image_url;
              img.alt = "Solution image";
              sol.appendChild(img);
            } else if (q.solution_text) {
              var pre = document.createElement("pre");
              pre.textContent = q.solution_text;
              sol.appendChild(pre);
            }
            answerBox.classList.remove("hidden");
            revealBtn.textContent = "Hide answer";
          });
      } else {
        answerBox.classList.add("hidden");
        revealBtn.textContent = "Reveal answer";
      }
    });
  }

  /* ---- favourite / completed toggles ---- */
  var detailCard = document.querySelector(".card.detail");
  if (detailCard) {
    var qid = detailCard.dataset.qid;
    [["btn-favourite", "favourite"], ["btn-completed", "completed"]].forEach(function (pair) {
      var btn = document.getElementById(pair[0]);
      if (!btn) return;
      btn.addEventListener("click", function () {
        var active = !btn.dataset.active;
        fetch("/api/question/" + qid + "/mark", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: pair[1], active: active })
        }).then(function () {
          btn.dataset.active = active ? "1" : "";
          btn.style.opacity = active ? "1" : "0.55";
        });
      });
    });
  }

  /* ---- practice mode ---- */
  var practiceForm = document.getElementById("practice-form");
  var practiceArea = document.getElementById("practice-area");
  if (practiceForm && practiceArea) {
    var currentQ = null;

    practiceForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var params = new URLSearchParams(new FormData(practiceForm));
      fetch("/api/random?" + params.toString())
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.questions.length) {
            practiceArea.innerHTML = '<div class="empty"><p>No questions match those filters.</p></div>';
            return;
          }
          renderPractice(data.questions[0]);
        });
    });

    function renderPractice(q) {
      currentQ = q;
      var html = '<article class="card">' +
        '<div class="card-head">' +
        '<span class="qnum">Q' + (q.question_number || "?") + '</span>' +
        '<span class="badge">' + (q.course_name || "Unknown course") + '</span>' +
        (q.topic_name ? '<span class="badge topic">' + q.topic_name + "</span>" : "") +
        (q.difficulty ? '<span class="badge diff">Difficulty ' + q.difficulty + "/5</span>" : "") +
        (q.marks ? '<span class="badge marks">' + q.marks + " marks</span>" : "") +
        "</div>" +
        '<p class="meta">' + (q.paper_name || "Unknown paper") +
        (q.paper_year ? " · " + q.paper_year : "") + " · page " + q.page_start + "</p>" +
        (q.image_url ? '<img class="qimg" src="' + q.image_url + '" alt="Question image">' : "") +
        '<div class="practice-tools">' +
        '<div><button class="btn" data-action="reveal">Reveal answer</button> ' +
        '<button class="btn ghost" data-action="next">Next question</button></div>' +
        '<div class="answer-box hidden"></div>' +
        "</div></article>";
      practiceArea.innerHTML = html;

      var reveal = practiceArea.querySelector('[data-action="reveal"]');
      var answerBox = practiceArea.querySelector(".answer-box");
      reveal.addEventListener("click", function () {
        fetch("/api/question/" + q.id)
          .then(function (r) { return r.json(); })
          .then(function (full) {
            var html = "";
            if (full.answer) html += '<p class="answer-text">Answer: ' + full.answer + "</p>";
            else html += '<p class="answer-text">No short answer recorded.</p>';
            if (full.solution_image_url) html += '<div class="solution-image"><img src="' +
              full.solution_image_url + '" alt="Solution"></div>';
            answerBox.innerHTML = html;
            answerBox.classList.remove("hidden");
            reveal.textContent = "Answer revealed";
            reveal.disabled = true;
          });
      });
      practiceArea.querySelector('[data-action="next"]').addEventListener("click", function () {
        practiceForm.dispatchEvent(new Event("submit"));
      });
      practiceArea.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* ---- timer ---- */
  var timerEl = document.getElementById("timer");
  var timerBtn = document.getElementById("timer-toggle");
  if (timerEl && timerBtn) {
    var seconds = 0, interval = null;
    timerBtn.addEventListener("click", function () {
      if (interval) {
        clearInterval(interval);
        interval = null;
        timerBtn.textContent = "Resume timer";
      } else {
        interval = setInterval(function () {
          seconds++;
          var m = String(Math.floor(seconds / 60)).padStart(2, "0");
          var s = String(seconds % 60).padStart(2, "0");
          timerEl.textContent = m + ":" + s;
        }, 1000);
        timerBtn.textContent = "Pause timer";
      }
    });
  }
})();
