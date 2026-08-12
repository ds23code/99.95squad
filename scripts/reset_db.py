"""Reset the database and generated images (keeps source PDFs)."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

from pipeline.config import Config


def main() -> int:
    cfg = Config.load()
    db_path = Path(cfg.paths["database"])
    for path, label in (
        (db_path, "database"),
        (Path(cfg.paths["questions_dir"]), "question images"),
        (Path(cfg.paths["pages_dir"]), "page images"),
        (Path(cfg.paths["solutions_dir"]), "solution images"),
        (Path(cfg.paths["exports_dir"]), "exports"),
    ):
        if path.exists():
            if path.is_dir():
                shutil.rmtree(path)
                print(f"removed {label} dir: {path}")
            else:
                path.unlink()
                print(f"removed {label}: {path}")
    print("done. Run `python -m pipeline init` to recreate the database.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
