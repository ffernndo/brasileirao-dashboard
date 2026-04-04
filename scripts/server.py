"""
Servidor local para o Dashboard Futebol Brasil.
Serve arquivos estáticos e expõe endpoint SSE para atualização de dados.

Uso:
    pip install -r scripts/requirements.txt
    python3 scripts/server.py
    → Abrir: http://localhost:8000
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


# ── Rotas estáticas ───────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(ROOT, filename)


# ── Detalhes de partida (proxy SofaScore) ────────────────────────

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
    Retorna estatísticas de uma partida via ESPN summary.
    Inclui venue, stats por time, gols com jogador/minuto.
    """
    url  = f"https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary?event={event_id}"
    data = _get_json(url)
    if not data:
        return jsonify({})

    # Venue
    venue = ((data.get("gameInfo") or {}).get("venue") or {}).get("fullName")

    # Estatísticas por time (boxscore)
    teams_stats = (data.get("boxscore") or {}).get("teams", [])

    # Detalhes (gols, etc.) + indicador home/away
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


# ── Pipeline de coleta ────────────────────────────────────────────

# (arquivo, label, pct_início, pct_fim)
PIPELINE = [
    ("fetch_espn.py",          "Brasileirão (ESPN)",        3,  60),
    ("fetch_transfermarkt.py", "Mercado (Transfermarkt)",  60,  97),
]


def _sse(step: str, progress: int, message: str) -> str:
    return f"data: {json.dumps({'step': step, 'progress': progress, 'message': message})}\n\n"


def _clean_stderr(raw: str) -> str:
    """Remove avisos de bibliotecas Python — mostra só erros reais."""
    lines = [
        line for line in raw.splitlines()
        if line.strip()
        and "Warning" not in line
        and "warnings.warn" not in line
        and not line.startswith("  ")  # indentação de tracebacks de warning
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
        err = _clean_stderr(raw_err) or f"Script encerrado com código {proc.returncode}"
        raise RuntimeError(f"Erro em {label}: {err}")


@app.route("/update")
def update():
    def generate():
        yield _sse("start", 0, "Iniciando atualização...")
        try:
            for script_name, label, pct_start, pct_end in PIPELINE:
                yield _sse(script_name, pct_start, f"Buscando {label}...")
                yield from _stream_script(script_name, label, pct_start, pct_end)
                yield _sse(script_name, pct_end, f"{label} concluído.")
            yield _sse("done", 100, "Dados atualizados com sucesso!")
        except RuntimeError as exc:
            yield _sse("error", -1, str(exc))

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Auto-atualização na inicialização ────────────────────────────

DATA_MAX_AGE_HOURS = 4  # atualiza se dados tiverem mais de 4 horas


def _needs_update() -> bool:
    """Retorna True se o arquivo principal está ausente ou desatualizado."""
    br_file = DATA_DIR / "brasileirao.json"
    if not br_file.exists():
        return True
    age_hours = (time.time() - br_file.stat().st_mtime) / 3600
    return age_hours > DATA_MAX_AGE_HOURS


def _run_pipeline_silent() -> None:
    """Executa o pipeline de coleta em background, sem SSE."""
    print("  [auto] Iniciando coleta de dados em background...")
    for script_name, label, _, _ in PIPELINE:
        script_path = SCRIPTS_DIR / script_name
        print(f"  [auto] {label}...")
        try:
            result = subprocess.run(
                [sys.executable, "-W", "ignore", str(script_path)],
                capture_output=True, text=True, timeout=120,
            )
            if result.returncode != 0:
                err = _clean_stderr(result.stderr) or f"código {result.returncode}"
                print(f"  [auto] Erro em {label}: {err}", file=sys.stderr)
        except subprocess.TimeoutExpired:
            print(f"  [auto] Timeout em {label}", file=sys.stderr)
        except Exception as e:
            print(f"  [auto] Falha em {label}: {e}", file=sys.stderr)
    print("  [auto] Coleta concluída.")


# ── Entry point ───────────────────────────────────────────────────

if __name__ == "__main__":
    DATA_DIR.mkdir(exist_ok=True)
    print("=" * 45)
    print("  Dashboard Futebol — http://localhost:8000")
    print("=" * 45)
    if _needs_update():
        print("  Dados ausentes ou desatualizados — coletando...")
        t = threading.Thread(target=_run_pipeline_silent, daemon=True)
        t.start()
    else:
        print("  Dados recentes encontrados. Pronto!")
    app.run(debug=False, port=8000, threaded=True)
