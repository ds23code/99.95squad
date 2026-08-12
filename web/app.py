"""Flask application for the QuestionBank website.

Run with:  python -m pipeline serve [--port N]
"""

from __future__ import annotations

import os
from pathlib import Path

from flask import (
    Flask,
    abort,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    url_for,
)

from pipeline.config import Config, default_config

from . import db as qb_db


def create_app(config: Config | None = None) -> Flask:
    app = Flask(__name__)
    app.config["QB_CONFIG"] = config or default_config()
    app.secret_key = "local-admin-review"  # local tool only; real auth comes from the backend

    # template filter: JSON parse for review_flags
    import json as _json

    @app.template_filter("from_json")
    def _from_json(value):
        if not value:
            return []
        try:
            return _json.loads(value)
        except (ValueError, TypeError):
            return []

    @app.teardown_appcontext
    def _close_db(exc=None):
        db = g.pop("_qb_db", None)
        if db is not None:
            db.close()

    def get_db():
        if "_qb_db" not in g:
            g._qb_db = qb_db.get_db(app.config["QB_CONFIG"])
        return g._qb_db

    def cfg() -> Config:
        return app.config["QB_CONFIG"]

    # ------------------------------------------------------------ admin review
    from . import review as admin_review

    admin_review.register(app)

    # ------------------------------------------------------------------ pages
    @app.route("/")
    def index():
        db = get_db()
        filters = _filters_from_request()
        q = request.args.get("q", "").strip()
        try:
            page = max(1, int(request.args.get("page", 1)))
        except ValueError:
            page = 1
        per_page = 30
        questions, total = db.search_questions(
            q or None, filters=filters, limit=per_page, offset=(page - 1) * per_page
        )
        return render_template(
            "index.html",
            questions=[_decorate(cfg(), q) for q in questions],
            total=total,
            page=page,
            pages=(total + per_page - 1) // per_page,
            q=q,
            filters=filters,
            options=qb_db.filter_options(db),
            active="search",
        )

    @app.route("/browse")
    def browse():
        db = get_db()
        with db.conn() as c:
            subjects = [dict(r) for r in c.execute(
                """SELECT s.id, s.name, COUNT(DISTINCT q.id) AS n
                   FROM subjects s
                   LEFT JOIN courses c ON c.subject_id = s.id
                   LEFT JOIN questions q ON q.course_id = c.id
                   GROUP BY s.id HAVING n > 0 ORDER BY s.name"""
            ).fetchall()]
            courses = [dict(r) for r in c.execute(
                """SELECT c.id, c.name, c.subject_id, COUNT(DISTINCT q.id) AS n
                   FROM courses c
                   LEFT JOIN questions q ON q.course_id = c.id
                   GROUP BY c.id HAVING n > 0 ORDER BY c.name"""
            ).fetchall()]
            topics = [dict(r) for r in c.execute(
                """SELECT t.id, t.name, t.course_id, COUNT(DISTINCT q.id) AS n
                   FROM topics t
                   LEFT JOIN questions q ON q.topic_id = t.id
                   GROUP BY t.id HAVING n > 0 ORDER BY n DESC"""
            ).fetchall()]
        return render_template(
            "browse.html", subjects=subjects, courses=courses, topics=topics, active="browse"
        )

    @app.route("/question/<qid>")
    def question_page(qid: str):
        db = get_db()
        q = db.get_question(qid)
        if not q:
            abort(404)
        return render_template("question.html", q=_decorate(cfg(), q), active="")

    @app.route("/practice")
    def practice():
        return render_template(
            "practice.html", options=qb_db.filter_options(get_db()), active="practice"
        )

    # ------------------------------------------------------------ api routes
    @app.route("/api/search")
    def api_search():
        db = get_db()
        filters = _filters_from_request()
        q = request.args.get("q", "").strip()
        try:
            limit = min(int(request.args.get("limit", 50)), 200)
        except ValueError:
            limit = 50
        questions, total = db.search_questions(q or None, filters=filters, limit=limit)
        return jsonify(
            {
                "total": total,
                "questions": [_decorate(cfg(), q) for q in questions],
            }
        )

    @app.route("/api/random")
    def api_random():
        db = get_db()
        filters = _filters_from_request()
        try:
            n = min(int(request.args.get("n", 1)), 20)
        except ValueError:
            n = 1
        questions = db.random_questions(filters=filters, n=n)
        return jsonify({"questions": [_decorate(cfg(), q) for q in questions]})

    @app.route("/api/question/<qid>")
    def api_question(qid: str):
        db = get_db()
        q = db.get_question(qid)
        if not q:
            return jsonify({"error": "not found"}), 404
        return jsonify(_decorate(cfg(), q, include_answer=True))

    @app.route("/api/question/<qid>/mark", methods=["POST"])
    def api_mark(qid: str):
        db = get_db()
        q = db.get_question(qid)
        if not q:
            return jsonify({"error": "not found"}), 404
        kind = request.json.get("kind") if request.is_json else request.form.get("kind")
        if kind not in ("favourite", "completed"):
            return jsonify({"error": "kind must be favourite|completed"}), 400
        if request.json.get("active", True):
            db.set_user_mark(qid, kind)
        else:
            db.unset_user_mark(qid, kind)
        return jsonify({"ok": True, "kind": kind})

    @app.route("/images/<path:path>")
    def images(path: str):
        data_dir = Path(cfg().paths["data_dir"])
        return send_from_directory(data_dir, path)

    @app.errorhandler(404)
    def not_found(e):
        return render_template("error.html", message="Page not found"), 404

    return app


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _course_id_list() -> list[str]:
    """Course ids for the review form datalist."""
    from pipeline.config import default_config

    return [c["id"] for c in default_config().courses()]


def _filters_from_request() -> dict:
    return {
        "course_id": request.args.get("course") or None,
        "subject_id": request.args.get("subject") or None,
        "topic_id": request.args.get("topic") or None,
        "year_level": _int_arg("year_level"),
        "difficulty_min": _float_arg("difficulty_min"),
        "difficulty_max": _float_arg("difficulty_max"),
        "question_type": request.args.get("type") or None,
        "paper_year": _int_arg("paper_year"),
        "paper_type": request.args.get("paper_type") or None,
        "marks_min": _int_arg("marks_min"),
    }


def _int_arg(name: str):
    val = request.args.get(name)
    if val is None or val == "":
        return None
    try:
        return int(val)
    except ValueError:
        return None


def _float_arg(name: str):
    val = request.args.get(name)
    if val is None or val == "":
        return None
    try:
        return float(val)
    except ValueError:
        return None


def _decorate(config: Config, q: dict, include_answer: bool = False) -> dict:
    out = dict(q)
    out["image_url"] = qb_db.image_url(config, q.get("image_path"))
    out["solution_image_url"] = qb_db.image_url(config, q.get("solution_image_path"))
    if not include_answer:
        out["answer"] = None  # never leak answers into list views
    return out


if __name__ == "__main__":
    app = create_app()
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port, debug=True, threaded=True)
