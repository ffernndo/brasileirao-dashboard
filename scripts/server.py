"""
Local server for the Brazilian football dashboard.
Serves static files and exposes an SSE endpoint for data updates.

Usage:
    pip install -r scripts/requirements.txt
    python3 scripts/server.py
    → Open: http://localhost:8000
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import requests as _req
from flask import Flask, Response, jsonify, send_from_directory

ROOT        = Path(__file__).parent.parent
SCRIPTS_DIR = Path(__file__).parent
DATA_DIR    = ROOT / "data"

app = Flask(__name__, static_folder=None)


# ── Static routes ───────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(ROOT, filename)


# ── Match details (SofaScore proxy) ────────────────────────

_SF_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    ),
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Origin":          "https://www.sofascore.com",
    "Referer":         "https://www.sofascore.com/",
}
_SF_BASE = "https://api.sofascore.com/api/v1"


def _get_json(url: str) -> dict | None:
    try:
        r = _req.get(url, timeout=10)
        if r.ok:
            return r.json()
    except Exception:
        pass
    return None


@app.route("/event-details/<string:event_id>")
def event_details(event_id: str):
    """
    Returns match stats via the ESPN summary.
    Includes venue, stats per team, goals with player/minute.
    """
    url  = f"https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary?event={event_id}"
    data = _get_json(url)
    if not data:
        return jsonify({})

    # Venue
    venue = ((data.get("gameInfo") or {}).get("venue") or {}).get("fullName")

    # Stats per team (boxscore)
    teams_stats = (data.get("boxscore") or {}).get("teams", [])

    # Details (goals, etc.) + home/away flag
    header_comp  = ((data.get("header") or {}).get("competitions") or [{}])[0]
    details      = header_comp.get("details") or []
    competitors  = header_comp.get("competitors") or []
    home_team    = next(
        (c.get("team", {}).get("displayName")
         for c in competitors if c.get("homeAway") == "home"),
        None,
    )

    return jsonify({
        "venue":      venue,
        "teamsStats": teams_stats,
        "details":    details,
        "homeTeam":   home_team,
    })


# ── Collection pipeline ────────────────────────────────────────────

# (file, label, pct_start, pct_end)
PIPELINE = [
    ("fetch_espn.py",          "Brasileirão (ESPN)",        3,  60),
    ("fetch_transfermarkt.py", "Market (Transfermarkt)",  60,  97),
]


def _sse(step: str, progress: int, message: str) -> str:
    return f"data: {json.dumps({'step': step, 'progress': progress, 'message': message})}\n\n"


def _clean_stderr(raw: str) -> str:
    """Removes Python library warnings and shows only real errors."""
    lines = [
        line for line in raw.splitlines()
        if line.strip()
        and "Warning" not in line
        and "warnings.warn" not in line
        and not line.startswith("  ")  # indentation of warning tracebacks
    ]
    return "\n".join(lines).strip()[:400]


def _stream_script(script_name: str, label: str, pct_start: int, pct_end: int):
    script_path = SCRIPTS_DIR / script_name
    pct_range   = pct_end - pct_start

    proc = subprocess.Popen(
        [sys.executable, "-W", "ignore", str(script_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    for line in proc.stdout:
        line = line.strip()
        if not line.startswith("PROGRESS:"):
            continue
        parts = line.split(":", 2)
        if len(parts) != 3:
            continue
        try:
            raw_pct = int(parts[1])
            msg     = parts[2]
            scaled  = pct_start + int(raw_pct * pct_range / 100)
            yield _sse(script_name, scaled, msg)
        except ValueError:
            continue

    proc.wait()

    if proc.returncode != 0:
        raw_err = proc.stderr.read() or ""
        err = _clean_stderr(raw_err) or f"Script exited with code {proc.returncode}"
        raise RuntimeError(f"Error in {label}: {err}")


@app.route("/update")
def update():
    def generate():
        yield _sse("start", 0, "Starting update...")
        try:
            for script_name, label, pct_start, pct_end in PIPELINE:
                yield _sse(script_name, pct_start, f"Fetching {label}...")
                yield from _stream_script(script_name, label, pct_start, pct_end)
                yield _sse(script_name, pct_end, f"{label} done.")
            yield _sse("done", 100, "Data updated successfully!")
        except RuntimeError as exc:
            yield _sse("error", -1, str(exc))

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Auto-update on startup ────────────────────────────

DATA_MAX_AGE_HOURS = 4  # update if the data is more than 4 hours old


def _needs_update() -> bool:
    """Returns True if the main file is missing or out of date."""
    br_file = DATA_DIR / "brasileirao.json"
    if not br_file.exists():
        return True
    age_hours = (time.time() - br_file.stat().st_mtime) / 3600
    return age_hours > DATA_MAX_AGE_HOURS


def _run_pipeline_silent() -> None:
    """Runs the collection pipeline in the background, without SSE."""
    print("  [auto] Starting background data collection...")
    for script_name, label, _, _ in PIPELINE:
        script_path = SCRIPTS_DIR / script_name
        print(f"  [auto] {label}...")
        try:
            result = subprocess.run(
                [sys.executable, "-W", "ignore", str(script_path)],
                capture_output=True, text=True, timeout=120,
            )
            if result.returncode != 0:
                err = _clean_stderr(result.stderr) or f"code {result.returncode}"
                print(f"  [auto] Error in {label}: {err}", file=sys.stderr)
        except subprocess.TimeoutExpired:
            print(f"  [auto] Timeout in {label}", file=sys.stderr)
        except Exception as e:
            print(f"  [auto] Failure in {label}: {e}", file=sys.stderr)
    print("  [auto] Collection complete.")


# ── Entry point ───────────────────────────────────────────────────

if __name__ == "__main__":
    DATA_DIR.mkdir(exist_ok=True)
    print("=" * 45)
    print("  Football Dashboard | http://localhost:8000")
    print("=" * 45)
    if _needs_update():
        print("  Data missing or out of date, collecting...")
        t = threading.Thread(target=_run_pipeline_silent, daemon=True)
        t.start()
    else:
        print("  Recent data found. Ready!")
    app.run(debug=False, port=8000, threaded=True)
