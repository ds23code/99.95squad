#!/usr/bin/env python3
"""Local dev server for the static site.

    python scripts/serve_site.py [--port 8080] [--dir site/_site]

If the built _site does not exist it builds it first.
"""

from __future__ import annotations

import argparse
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve the built static site")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--dir", default=str(SITE / "_site"))
    args = parser.parse_args(argv)

    site_dir = Path(args.dir)
    if not (site_dir / "index.html").exists():
        from scripts.build_site import build

        print("building site first…")
        build(site_dir, force=True)

    handler = http.server.SimpleHTTPRequestHandler
    os = __import__("os")
    os.chdir(site_dir)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), handler)
    print(f"99.95squad static site on http://0.0.0.0:{args.port} (dir {site_dir})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
