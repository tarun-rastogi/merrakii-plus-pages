#!/usr/bin/env python3
"""Static server + overview save API for the Merrakii+ Executive Dashboard.

Usage:
  python3 serve.py          # default port 3008
  python3 serve.py 3008

Endpoints:
  PUT /api/data/overview  → save data/overview.json
"""

from __future__ import annotations

import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DELIVERABLE = os.path.dirname(ROOT)
DEFAULT_PORT = 3008
DATA_WHITELIST = {
    "overview": os.path.join(ROOT, "data", "overview.json"),
}
# Level completion is read from the Client Dashboard's scope.json, so that
# sibling folder is mounted read-only when this page runs standalone.
SIBLING_MOUNTS = ("client-dashboard",)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        rel = parsed.path.lstrip("/")
        if rel:
            top = rel.split("/", 1)[0]
            if top in SIBLING_MOUNTS:
                candidate = os.path.normpath(os.path.join(DELIVERABLE, rel))
                if candidate == DELIVERABLE or candidate.startswith(DELIVERABLE + os.sep):
                    return candidate
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_PUT(self):
        parsed = urlparse(self.path)
        # Standalone (:3008) uses /api/data/overview; iframed under client-dashboard
        # uses /executive-dashboard/api/data/overview (handled by that server).
        path = parsed.path
        if path.startswith("/executive-dashboard/api/data/"):
            path = "/api/data/" + path.split("/api/data/", 1)[-1]
        if not path.startswith("/api/data/"):
            self.send_error(404, "Not found")
            return
        name = path[len("/api/data/") :].strip("/").split("/")[0]
        path_file = DATA_WHITELIST.get(name)
        if not path_file:
            self.send_error(404, "Unknown data name")
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return
        os.makedirs(os.path.dirname(path_file), exist_ok=True)
        with open(path_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        body = json.dumps({"ok": True, "name": name}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


def main() -> None:
    import sys

    port = int(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PORT)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Executive Dashboard: http://127.0.0.1:{port}/")
    print(f"Data save API: PUT http://127.0.0.1:{port}/api/data/overview")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()


if __name__ == "__main__":
    main()
