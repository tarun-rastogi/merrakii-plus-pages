#!/usr/bin/env python3
"""Static file server + live presence + data save API for the Merrakii+ client dashboard.

Usage:
  python3 serve.py [port]

Endpoints:
  GET  /api/presence          → { viewers: [...], serverTime }
  POST /api/presence          → heartbeat body { id, name, tab?, color?, ip? }
  DELETE /api/presence?id=…   → leave
  PUT  /api/data/<name>       → save JSON (scope | updates | overview | feedback); regenerates updates HTML
"""

from __future__ import annotations

import html
import ipaddress
import json
import os
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
# Parent deliverable/ — SOW and Maple AI Updates live as siblings of this dashboard.
DELIVERABLE = os.path.dirname(ROOT)
# Browser resolves ../statement-of-work/... from / to /statement-of-work/...
SIBLING_MOUNTS = (
    "statement-of-work",
    "maple-ai-updates",
    "proposal",
    "presentation",
    "quotation",
    "Scope",
    "blueprint",
    "executive-dashboard",
    # The iframed Executive Dashboard reads level completion from this folder
    # using a path relative to its own location.
    "client-dashboard",
)
TTL_SEC = 25
CLEAN_EVERY = 5

DATA_WHITELIST = {
    "scope": os.path.join(ROOT, "data", "scope.json"),
    "updates": os.path.join(ROOT, "data", "updates.json"),
    "overview": os.path.join(ROOT, "data", "overview.json"),
    "feedback": os.path.join(ROOT, "data", "feedback.json"),
}
EXEC_OVERVIEW = os.path.join(DELIVERABLE, "executive-dashboard", "data", "overview.json")
EXEC_API_PREFIX = "/executive-dashboard/api/data/"
UPDATES_HTML = os.path.join(
    DELIVERABLE, "maple-ai-updates", "Maple_AI_Updates_2026-08-07.html"
)
UPDATES_HTML_LEGACY = os.path.join(
    DELIVERABLE, "maple-ai-updates", "Maple_AI_Updates_2026-08-05.html"
)
UPDATES_HTML_DASHBOARD_COPY = os.path.join(
    ROOT, "maple-ai-updates", "Maple_AI_Updates_2026-08-07.html"
)

_lock = threading.Lock()
_viewers: dict[str, dict] = {}
_last_clean = 0.0


def _now() -> float:
    return time.time()


def _clean(force: bool = False) -> None:
    global _last_clean
    now = _now()
    if not force and now - _last_clean < CLEAN_EVERY:
        return
    _last_clean = now
    expired = [vid for vid, v in _viewers.items() if now - v["seenAt"] > TTL_SEC]
    for vid in expired:
        del _viewers[vid]


def _normalize_ip(raw: str | None) -> str:
    if not raw:
        return ""
    text = str(raw).strip()
    if not text:
        return ""
    # X-Forwarded-For may be a comma-separated list — take the first (client).
    text = text.split(",")[0].strip()
    # Strip IPv4-mapped IPv6 prefix and optional brackets/port.
    if text.startswith("[") and "]" in text:
        text = text[1 : text.index("]")]
    if text.startswith("::ffff:"):
        text = text[7:]
    try:
        return str(ipaddress.ip_address(text))
    except ValueError:
        # Host:port forms (rare) — try without port for IPv4.
        if "." in text and text.count(":") == 1:
            try:
                return str(ipaddress.ip_address(text.rsplit(":", 1)[0]))
            except ValueError:
                return ""
        return ""


def _snapshot() -> list[dict]:
    _clean()
    rows = sorted(_viewers.values(), key=lambda v: (v["name"].lower(), v["id"]))
    return [
        {
            "id": v["id"],
            "name": v["name"],
            "tab": v.get("tab") or "overview",
            "color": v.get("color") or "#4361ee",
            "ip": v.get("ip") or "",
            "seenAt": int(v["seenAt"] * 1000),
        }
        for v in rows
    ]


def _esc(s: object) -> str:
    return html.escape(str(s if s is not None else ""), quote=True)



def _cell_class(text: str) -> str:
    t = (text or "").strip().lower()
    if not t:
        return "is-empty"
    if "paused" in t or "pause" in t:
        return "is-pause"
    if "alfran" in t or "in progress" in t or "strategic decision" in t:
        return "is-focus"
    return ""


def regenerate_updates_html(data: dict) -> None:
    """Rebuild the standalone Maple AI Updates HTML from updates.json (day × page matrix)."""
    doc = data.get("document") or {}
    sheets = data.get("sheets") or {}
    pages_sheet = sheets.get("Pages") or []
    matrix = sheets.get("Daily matrix") or []
    level_row_sheet = sheets.get("Level row") or []
    flow = sheets.get("Journey flow") or []

    meta = doc.get("meta") or {}
    meta_html = ""
    for k, v in meta.items():
        meta_html += (
            f'<div class="meta-item"><dt>{_esc(k)}</dt><dd>{_esc(v)}</dd></div>\n'
        )

    flow_steps = []
    for i, row in enumerate(flow):
        if i == 0:
            continue
        step = row[0] if row else ""
        if step:
            flow_steps.append(str(step))
    flow_steps_html = ""
    for i, step in enumerate(flow_steps):
        if i:
            flow_steps_html += '<span class="arrow">→</span>\n'
        flow_steps_html += f'<span class="step">{_esc(step)}</span>\n'

    page_meta: dict[str, dict] = {}
    for i, row in enumerate(pages_sheet):
        if i == 0 or not row:
            continue
        row = list(row) + [""] * max(0, 3 - len(row))
        page_meta[str(row[2])] = {"level": str(row[0]), "levelName": str(row[1])}

    header = matrix[0] if matrix else []
    page_cols = []
    for c in range(2, len(header)):
        name = str(header[c] or "")
        meta_p = page_meta.get(name) or {}
        level = ""
        if level_row_sheet and level_row_sheet[0] and c < len(level_row_sheet[0]):
            level = str(level_row_sheet[0][c] or "")
        if not level:
            level = str(meta_p.get("level") or "")
        page_cols.append(
            {
                "index": c,
                "name": name,
                "level": level,
                "levelName": str(meta_p.get("levelName") or ""),
            }
        )

    level_groups: list[dict] = []
    for p in page_cols:
        if not level_groups or level_groups[-1]["level"] != p["level"]:
            level_groups.append(
                {"level": p["level"], "levelName": p["levelName"], "count": 1}
            )
        else:
            level_groups[-1]["count"] += 1

    level_ths = ""
    for g in level_groups:
        short = g["levelName"]
        if short.startswith("Level ") and " — " in short:
            short = short.split(" — ", 1)[1]
        label = f'{g["level"]} · {short}' if short else g["level"]
        level_ths += (
            f'<th class="lvl-{_esc(g["level"])}" colspan="{g["count"]}">{_esc(label)}</th>\n'
        )

    page_ths = "".join(f"<th>{_esc(p['name'])}</th>\n" for p in page_cols)

    body_rows = ""
    for r, row in enumerate(matrix):
        if r == 0:
            continue
        row = list(row) + [""] * max(0, len(header) - len(row))
        day = row[0]
        badge = row[1]
        body_rows += "<tr>\n"
        body_rows += '<td class="day-col">'
        if badge:
            body_rows += f'<span class="badge">{_esc(badge)}</span> '
        body_rows += f'<span class="day-title">{_esc(day)}</span></td>\n'
        for p in page_cols:
            text = str(row[p["index"]] if p["index"] < len(row) else "")
            cls = _cell_class(text)
            shown = _esc(text) if text.strip() else "—"
            shown = shown.replace("\n", "<br />\n")
            body_rows += f'<td class="cell {cls}">{shown}</td>\n'
        body_rows += "</tr>\n"

    strategic = doc.get("strategicNote") or ""
    strategic_html = ""
    if strategic:
        strategic_html = f"""
        <section class="strategic-box">
          <h2>Strategic decision</h2>
          <p>{_esc(strategic)}</p>
        </section>
        """

    subtitle = doc.get("subtitle") or ""
    subtitle_html = (
        f'<p class="subtitle">{_esc(subtitle)}</p>' if subtitle.strip() else ""
    )
    meta_block = (
        f'<dl class="meta-grid">\n          {meta_html}\n        </dl>'
        if meta_html.strip()
        else ""
    )

    flow_note = doc.get("flowNote") or ""
    flow_intro = doc.get("flowIntro") or ""
    flow_html = ""
    if flow_intro.strip() or flow_note.strip() or flow_steps:
        flow_note_html = (
            f'<p class="flow-note">{_esc(flow_note)}</p>' if flow_note.strip() else ""
        )
        flow_intro_html = f"<p>{_esc(flow_intro)}</p>" if flow_intro.strip() else ""
        flow_steps_block = (
            f'<div class="flow-steps">\n            {flow_steps_html}\n          </div>'
            if flow_steps
            else ""
        )
        flow_html = f"""
        <section class="flow-box" aria-label="Blueprint student journey">
          <h2>Blueprint student journey (wireframe target)</h2>
          {flow_intro_html}
          {flow_steps_block}
          {flow_note_html}
        </section>
        """

    footer_left = _esc(doc.get("footerLeft") or "Maple AI Technologies").replace(
        "\n", "<br />\n"
    )
    footer_right = _esc(doc.get("footerRight") or "").replace("\n", "<br />\n")

    style_block = """<style>
    :root {
      --cyan: #00b4d8; --blue: #4361ee; --purple: #7c3aed; --navy: #1c2340;
      --gray: #888fa8; --muted: #64748b; --line: #e2e8f0; --paper: #ffffff;
      --soft: #f8fafc; --doc-w: 1440px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "DM Sans", system-ui, sans-serif;
      color: var(--navy);
      background:
        radial-gradient(ellipse 70% 50% at 10% 0%, rgba(0, 180, 216, 0.14), transparent 55%),
        radial-gradient(ellipse 60% 40% at 90% 10%, rgba(124, 58, 237, 0.12), transparent 50%),
        linear-gradient(165deg, #f0f9fc 0%, #f1f5f9 45%, #eef2ff 100%);
      line-height: 1.45;
    }
    .wrap-screen { padding: 24px 16px 56px; }
    .toolbar { width: var(--doc-w); max-width: 100%; margin: 0 auto 16px; }
    .btn-print {
      font: 600 14px inherit; padding: 12px 22px; border: none; border-radius: 10px;
      background: linear-gradient(135deg, var(--blue), var(--purple)); color: #fff; cursor: pointer;
    }
    .doc {
      width: var(--doc-w); max-width: 100%; margin: 0 auto; background: var(--paper);
      border-radius: 16px; border: 1px solid var(--line); overflow: hidden;
      box-shadow: 0 8px 40px rgba(28, 35, 64, 0.08);
    }
    .doc-header {
      padding: 32px 36px 28px;
      background: linear-gradient(180deg, #fff, #f8fafc);
      border-bottom: 1px solid var(--line);
    }
    .brand-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 20px; }
    .brand-row img.maple { height: 48px; }
    .brand-row img.merrakii { height: 36px; }
    .label-chip {
      display: inline-block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--blue); background: rgba(67, 97, 238, 0.1);
      padding: 6px 12px; border-radius: 999px; margin-bottom: 10px;
    }
    h1 { margin: 0 0 8px; font-size: clamp(1.6rem, 3vw, 2.1rem); letter-spacing: -0.02em; }
    .subtitle { margin: 0; color: var(--muted); max-width: 58em; }
    .meta-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px 18px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line);
    }
    .meta-item dt {
      font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--gray); margin: 0 0 4px;
    }
    .meta-item dd { margin: 0; font-weight: 600; }
    .doc-body { padding: 28px 36px 40px; }
    .strategic-box {
      border: 1px solid rgba(217, 119, 6, 0.35); background: rgba(217, 119, 6, 0.08);
      border-radius: 12px; padding: 14px 16px; margin-bottom: 18px;
    }
    .strategic-box h2 { margin: 0 0 6px; font-size: 1rem; color: #b45309; }
    .strategic-box p { margin: 0; }
    .flow-box {
      background: linear-gradient(135deg, rgba(0, 180, 216, 0.08), rgba(124, 58, 237, 0.06));
      border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin-bottom: 18px;
    }
    .flow-box h2 { margin: 0 0 8px; font-size: 1.05rem; }
    .flow-box p { margin: 0 0 10px; color: var(--muted); font-size: 0.92rem; }
    .flow-steps { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; font-weight: 600; font-size: 0.88rem; }
    .flow-steps .arrow { color: var(--blue); }
    .flow-note { margin-top: 10px !important; margin-bottom: 0 !important; }
    .matrix-wrap {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      overflow-x: auto;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      max-height: min(70vh, 760px);
      border: 1px solid var(--line);
      border-radius: 12px;
      margin-bottom: 12px;
    }
    table.matrix {
      border-collapse: separate; border-spacing: 0; width: max-content; min-width: 100%; font-size: 0.78rem;
    }
    table.matrix th, table.matrix td {
      border-right: 1px solid var(--line); border-bottom: 1px solid var(--line);
      vertical-align: top; padding: 8px 10px;
    }
    table.matrix thead th { background: #f1f5f9; font-weight: 700; text-align: left; line-height: 1.25; }
    table.matrix thead tr.level-row th { text-align: center; font-size: 0.72rem; letter-spacing: 0.04em; text-transform: uppercase; }
    table.matrix thead tr.page-row th { font-size: 0.72rem; min-width: 150px; max-width: 190px; white-space: normal; background: #f8fafc; }
    table.matrix .lvl-L1 { background: rgba(67, 97, 238, 0.14); }
    table.matrix .lvl-L2 { background: rgba(0, 180, 216, 0.16); }
    table.matrix .lvl-L3 { background: rgba(217, 119, 6, 0.14); }
    table.matrix .lvl-L4 { background: rgba(124, 58, 237, 0.12); }
    table.matrix .lvl-L5 { background: rgba(124, 58, 237, 0.18); }
    table.matrix .lvl-L6 { background: rgba(5, 150, 105, 0.14); }
    table.matrix th.day-col, table.matrix td.day-col {
      position: sticky; left: 0; background: #fff; min-width: 150px; font-weight: 700;
      box-shadow: 2px 0 0 var(--line); z-index: 2;
    }
    table.matrix thead th.day-col { background: #e2e8f0; z-index: 3; }
    table.matrix .badge {
      display: inline-block; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.05em;
      text-transform: uppercase; color: #fff; background: var(--navy); padding: 2px 6px; border-radius: 4px;
    }
    table.matrix td.cell { min-width: 150px; max-width: 210px; line-height: 1.4; }
    table.matrix td.cell.is-empty { color: #94a3b8; background: #fcfcfd; }
    table.matrix td.cell.is-pause { background: rgba(217, 119, 6, 0.06); }
    table.matrix td.cell.is-focus { background: rgba(5, 150, 105, 0.08); }
    .legend { display: flex; flex-wrap: wrap; gap: 12px 18px; font-size: 0.8rem; color: var(--muted); margin-bottom: 20px; }
    .summary {
      background: var(--soft); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px;
    }
    .summary h2 { margin: 0 0 10px; font-size: 1.05rem; }
    .summary ol { margin: 0; padding-left: 1.2rem; }
    .summary li { margin-bottom: 6px; }
    .doc-footer {
      display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
      padding: 18px 36px; border-top: 1px solid var(--line); font-size: 0.82rem; color: var(--muted);
    }
    @media print {
      body { background: #fff; }
      .toolbar { display: none; }
      .doc { box-shadow: none; border: none; }
      .matrix-wrap { overflow: visible; }
    }
  </style>"""

    out = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Maple AI Updates — {_esc(doc.get("meta", {}).get("Product", "Merrakii+"))}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&display=swap" rel="stylesheet" />
  {style_block}
</head>
<body>
  <div class="wrap-screen">
    <div class="toolbar">
      <button type="button" class="btn-print" onclick="window.print()">Print / Save PDF</button>
    </div>

    <article class="doc">
      <header class="doc-header">
        <div class="brand-row">
          <img class="maple" src="images/maple-ai-logo.jpg" alt="Maple AI Technologies" />
          <img class="merrakii" src="images/merrakii-logo.png" alt="Merrakii" />
        </div>
        <span class="label-chip">Maple AI Updates</span>
        <h1>{_esc(doc.get("title") or "Updates")}</h1>
        {subtitle_html}
        {meta_block}
      </header>

      <div class="doc-body">
        {strategic_html}
        {flow_html}

        <h2 style="margin:0 0 10px;font-size:1.1rem">Daily progress matrix</h2>
        <p style="margin:0 0 12px;color:var(--muted);font-size:0.9rem">
          Rows = days (Mon 3 Aug onward). Columns = Build Blueprint levels and pages. Scroll horizontally to review all pages.
        </p>
        <div class="matrix-wrap">
          <table class="matrix">
            <thead>
              <tr class="level-row">
                <th class="day-col" rowspan="2">Day</th>
                {level_ths}
              </tr>
              <tr class="page-row">
                {page_ths}
              </tr>
            </thead>
            <tbody>
              {body_rows}
            </tbody>
          </table>
        </div>
        <p class="legend">
          <span>Empty / — = no update that day</span>
          <span>Amber tint = paused pending wireframe</span>
          <span>Green tint = strategic / active focus</span>
        </p>
      </div>

      <footer class="doc-footer">
        <div>{footer_left}</div>
        <div>{footer_right}</div>
      </footer>
    </article>
  </div>
</body>
</html>
"""
    os.makedirs(os.path.dirname(UPDATES_HTML), exist_ok=True)
    with open(UPDATES_HTML, "w", encoding="utf-8") as f:
        f.write(out)
    try:
        os.makedirs(os.path.dirname(UPDATES_HTML_DASHBOARD_COPY), exist_ok=True)
        with open(UPDATES_HTML_DASHBOARD_COPY, "w", encoding="utf-8") as f:
            f.write(out)
    except OSError:
        pass
    if os.path.isfile(UPDATES_HTML_LEGACY):
        try:
            with open(UPDATES_HTML_LEGACY, "w", encoding="utf-8") as f:
                f.write(
                    "<!DOCTYPE html><html><head><meta charset='UTF-8'>"
                    "<meta http-equiv='refresh' content='0;url=Maple_AI_Updates_2026-08-07.html'>"
                    "<title>Redirecting…</title></head><body>"
                    "<p>This update log has moved to "
                    "<a href='Maple_AI_Updates_2026-08-07.html'>Maple_AI_Updates_2026-08-07.html</a>."
                    "</p></body></html>\n"
                )
        except OSError:
            pass


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def translate_path(self, path: str) -> str:
        """Serve dashboard files from ROOT; map sibling deliverable folders too."""
        parsed = urlparse(path)
        rel = parsed.path.lstrip("/")
        if rel:
            top = rel.split("/", 1)[0]
            if top in SIBLING_MOUNTS:
                candidate = os.path.normpath(os.path.join(DELIVERABLE, rel))
                # Stay inside deliverable/ (no path traversal).
                if candidate == DELIVERABLE or candidate.startswith(DELIVERABLE + os.sep):
                    return candidate
        return super().translate_path(path)

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if (
            path.startswith("/api/presence")
            or path.startswith("/api/data/")
            or path.startswith(EXEC_API_PREFIX)
        ):
            self.send_response(204)
            self._cors()
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/presence":
            with _lock:
                viewers = _snapshot()
            self._json(200, {"viewers": viewers, "serverTime": int(_now() * 1000)})
            return
        super().do_GET()

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        # Executive Dashboard iframed under this server saves here.
        if parsed.path.startswith(EXEC_API_PREFIX):
            name = parsed.path[len(EXEC_API_PREFIX) :].strip("/").split("/")[0]
            if name != "overview":
                self._json(404, {"error": "Unknown executive data file"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                data = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "Invalid JSON"})
                return
            if not isinstance(data, dict):
                self._json(400, {"error": "JSON object required"})
                return
            os.makedirs(os.path.dirname(EXEC_OVERVIEW), exist_ok=True)
            with open(EXEC_OVERVIEW, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.write("\n")
            self._json(200, {"ok": True, "name": "overview", "savedAt": int(_now() * 1000)})
            return

        if not parsed.path.startswith("/api/data/"):
            self.send_error(404)
            return
        name = parsed.path[len("/api/data/") :].strip("/").split("/")[0]
        if name not in DATA_WHITELIST:
            self._json(404, {"error": "Unknown data file"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "Invalid JSON"})
            return
        if not isinstance(data, dict):
            self._json(400, {"error": "JSON object required"})
            return

        path = DATA_WHITELIST[name]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")

        if name == "updates":
            try:
                regenerate_updates_html(data)
            except Exception as exc:  # noqa: BLE001
                self._json(
                    500,
                    {"error": "Saved JSON but failed to regenerate HTML", "detail": str(exc)},
                )
                return

        self._json(200, {"ok": True, "name": name, "savedAt": int(_now() * 1000)})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/presence":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "Invalid JSON"})
            return

        vid = str(data.get("id") or "").strip()[:64]
        name = str(data.get("name") or "").strip()[:40]
        if not vid or not name:
            self._json(400, {"error": "id and name are required"})
            return

        tab = str(data.get("tab") or "overview").strip()[:40] or "overview"
        color = str(data.get("color") or "#4361ee").strip()[:20]

        forwarded = self.headers.get("X-Forwarded-For") or self.headers.get("X-Real-IP")
        remote = ""
        try:
            remote = self.client_address[0] if self.client_address else ""
        except (TypeError, IndexError):
            remote = ""
        browser_ip = _normalize_ip(data.get("ip"))
        connection_ip = _normalize_ip(forwarded) or _normalize_ip(remote)
        # Prefer browser-reported public IP; fall back to connection IP.
        ip = browser_ip or connection_ip

        with _lock:
            _viewers[vid] = {
                "id": vid,
                "name": name,
                "tab": tab,
                "color": color,
                "ip": ip,
                "seenAt": _now(),
            }
            viewers = _snapshot()

        self._json(200, {"ok": True, "viewers": viewers, "serverTime": int(_now() * 1000)})

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/presence":
            self.send_error(404)
            return
        qs = parse_qs(parsed.query)
        vid = (qs.get("id") or [""])[0].strip()[:64]
        with _lock:
            if vid and vid in _viewers:
                del _viewers[vid]
            viewers = _snapshot()
        self._json(200, {"ok": True, "viewers": viewers, "serverTime": int(_now() * 1000)})


def main() -> None:
    import socket
    import sys

    port = int(sys.argv[1] if len(sys.argv) > 1 else "5055")

    class ReuseServer(ThreadingHTTPServer):
        allow_reuse_address = True
        allow_reuse_port = True

    # Prefer IPv4 so we don't fight macOS dual-stack leftovers.
    server = ReuseServer(("0.0.0.0", port), Handler)
    # Also try to claim IPv6 localhost if free (best-effort).
    try:
        sock6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        sock6.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        sock6.bind(("::1", port))
        sock6.close()
    except OSError:
        pass

    print(f"Client dashboard + presence on http://127.0.0.1:{port}/")
    print(f"Presence API: http://127.0.0.1:{port}/api/presence")
    print(f"Data save API: PUT http://127.0.0.1:{port}/api/data/{{scope|updates|overview|feedback}}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
