"""
Coleta resultados, tabela e estatísticas do Brasileirão Série A via
SofaScore (API não-oficial, sem autenticação).

Gera: ../data/brasileirao.json

Endpoints utilizados:
  /unique-tournament/325/seasons               → lista de temporadas
  /unique-tournament/325/season/{id}/rounds    → rodadas disponíveis
  /unique-tournament/325/season/{id}/events/round/{r} → partidas de cada rodada
"""
from __future__ import annotations

import json
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

import requests

warnings.filterwarnings("ignore")

# ──────────────────────────────────────────────────────────────────
# Configuração
# ──────────────────────────────────────────────────────────────────

TOURNAMENT_ID = 325       # Brasileirão Série A no SofaScore
OUTPUT_FILE   = Path(__file__).parent.parent / "data" / "brasileirao.json"

BASE_URL = "https://api.sofascore.com/api/v1"
IMG_URL  = "https://img.sofascore.com/api/v1"

HEADERS = {
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

REQUEST_DELAY = 0.2   # segundos entre requisições (evita bloqueio)
MAX_RETRY     = 3


# ──────────────────────────────────────────────────────────────────
# Utilitários
# ──────────────────────────────────────────────────────────────────

def progress(pct: int, msg: str) -> None:
    print(f"PROGRESS:{pct}:{msg}", flush=True)


def get(path: str, retries: int = MAX_RETRY) -> dict:
    url = f"{BASE_URL}{path}"
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            if r.ok:
                return r.json()
            if r.status_code == 429:
                wait = 2 ** (attempt + 1)
                time.sleep(wait)
                continue
            # 404 é normal (rodada sem dados ainda)
            if r.status_code == 404:
                return {}
        except requests.RequestException as exc:
            if attempt == retries - 1:
                raise RuntimeError(f"Erro ao buscar {url}: {exc}") from exc
            time.sleep(1)
    return {}


def badge_url(team_id: int | None) -> str:
    if not team_id:
        return ""
    return f"{IMG_URL}/team/{team_id}/image"


# ──────────────────────────────────────────────────────────────────
# Descoberta de temporada
# ──────────────────────────────────────────────────────────────────

def find_current_season() -> tuple[int, int]:
    """
    Retorna (season_id, year) da temporada mais recente do Brasileirão.
    Prioriza o ano atual; fallback para o mais recente disponível.
    """
    data = get(f"/unique-tournament/{TOURNAMENT_ID}/seasons")
    seasons = data.get("seasons", [])
    if not seasons:
        raise RuntimeError("Nenhuma temporada encontrada no SofaScore para o Brasileirão.")

    current_year = datetime.now().year

    # Tenta encontrar temporada do ano corrente
    for s in seasons:
        if s.get("year") == current_year:
            return s["id"], current_year

    # Fallback: temporada mais recente disponível
    seasons_sorted = sorted(seasons, key=lambda s: s.get("year", 0), reverse=True)
    best = seasons_sorted[0]
    return best["id"], best.get("year", current_year)


# ──────────────────────────────────────────────────────────────────
# Coleta de partidas
# ──────────────────────────────────────────────────────────────────

def fetch_rounds(season_id: int) -> list[int]:
    data = get(f"/unique-tournament/{TOURNAMENT_ID}/season/{season_id}/rounds")
    rounds_raw = data.get("rounds", [])
    return sorted({r["round"] for r in rounds_raw if "round" in r})


def map_event(ev: dict) -> dict | None:
    """Converte um evento SofaScore para o formato que o frontend espera."""
    home = ev.get("homeTeam") or {}
    away = ev.get("awayTeam") or {}
    if not home.get("name") or not away.get("name"):
        return None

    status_type = (ev.get("status") or {}).get("type", "")
    finished     = status_type in ("finished", "afterextratime", "afterpenalties", "canceled")

    hs = ev.get("homeScore") or {}
    as_ = ev.get("awayScore") or {}
    home_score = hs.get("current") if finished else None
    away_score = as_.get("current") if finished else None

    ts = ev.get("startTimestamp")
    date_str = ""
    if ts:
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        date_str = dt.strftime("%Y-%m-%d")

    round_info = ev.get("roundInfo") or {}
    round_num  = round_info.get("round", 0)

    return {
        "idEvent":          str(ev.get("id", "")),
        "strHomeTeam":      home.get("name", ""),
        "strAwayTeam":      away.get("name", ""),
        "intHomeScore":     home_score,
        "intAwayScore":     away_score,
        "intRound":         str(round_num),
        "dateEvent":        date_str,
        "strHomeTeamBadge": badge_url(home.get("id")),
        "strAwayTeamBadge": badge_url(away.get("id")),
        "status":           status_type,
        # IDs para detalhes futuros
        "_homeTeamId":      home.get("id"),
        "_awayTeamId":      away.get("id"),
    }


# ──────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────

def main() -> None:
    progress(5, "Conectando ao SofaScore...")

    try:
        season_id, year = find_current_season()
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

    progress(10, f"Temporada {year} (ID {season_id}). Buscando rodadas...")

    try:
        rounds = fetch_rounds(season_id)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

    if not rounds:
        print("Nenhuma rodada encontrada.", file=sys.stderr)
        sys.exit(1)

    total_rounds = len(rounds)
    progress(15, f"{total_rounds} rodadas detectadas. Coletando partidas...")

    all_events: list[dict] = []

    for i, rnd in enumerate(rounds):
        pct = 15 + int((i / total_rounds) * 75)
        progress(pct, f"Rodada {rnd}/{rounds[-1]}...")

        try:
            data = get(
                f"/unique-tournament/{TOURNAMENT_ID}"
                f"/season/{season_id}/events/round/{rnd}"
            )
            for ev in data.get("events", []):
                mapped = map_event(ev)
                if mapped:
                    all_events.append(mapped)
            time.sleep(REQUEST_DELAY)
        except RuntimeError as e:
            print(f"Aviso: rodada {rnd} falhou — {e}", file=sys.stderr)
            continue

    if not all_events:
        print("Nenhuma partida coletada. Verifique a conexão.", file=sys.stderr)
        sys.exit(1)

    # Rodada mais recente com placar
    finished = [e for e in all_events if e["intHomeScore"] is not None]
    latest_round = max(int(e["intRound"]) for e in finished) if finished else 1

    progress(93, f"{len(all_events)} partidas. Rodada atual: {latest_round}. Salvando...")

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "season":       year,
        "season_id":    season_id,
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest_round": latest_round,
        "source":       "SofaScore",
        "matches":      all_events,
    }
    OUTPUT_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    progress(100, f"Concluído — {len(all_events)} partidas, {latest_round} rodadas jogadas.")


if __name__ == "__main__":
    main()
