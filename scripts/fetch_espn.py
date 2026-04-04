"""
Coleta resultados e calendário do Brasileirão Série A via ESPN (API não-oficial).
Uma única requisição retorna os 380 jogos da temporada.

Gera: ../data/brasileirao.json
"""
from __future__ import annotations

import json
import re
import sys
import warnings
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

warnings.filterwarnings("ignore")

# ──────────────────────────────────────────────────────────────────
# Configuração
# ──────────────────────────────────────────────────────────────────

SEASON      = datetime.now().year
LEAGUE_SLUG = "bra.1"   # Brasileirão Série A no ESPN
OUTPUT_FILE = Path(__file__).parent.parent / "data" / "brasileirao.json"

BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer"

ROUND_GAP_DAYS = 4   # dias de pausa entre rodadas para agrupar


# ──────────────────────────────────────────────────────────────────
# Utilitários
# ──────────────────────────────────────────────────────────────────

def progress(pct: int, msg: str) -> None:
    print(f"PROGRESS:{pct}:{msg}", flush=True)


def parse_dt(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


# ──────────────────────────────────────────────────────────────────
# Agrupamento em rodadas
# ──────────────────────────────────────────────────────────────────

def assign_rounds(events: list[dict]) -> list[dict]:
    """
    ESPN não expõe o número da rodada — inferimos agrupando jogos
    que ocorrem dentro de uma janela de até ROUND_GAP_DAYS dias entre si.
    """
    if not events:
        return events

    sorted_evs = sorted(events, key=lambda e: e["date"])

    round_num   = 1
    round_start = parse_dt(sorted_evs[0]["date"])

    for ev in sorted_evs:
        dt = parse_dt(ev["date"])
        if (dt - round_start).days > ROUND_GAP_DAYS:
            round_num  += 1
            round_start = dt
        ev["_round"] = round_num

    return sorted_evs


# ──────────────────────────────────────────────────────────────────
# Mapeamento de eventos
# ──────────────────────────────────────────────────────────────────

def map_event(ev: dict) -> dict | None:
    comp = (ev.get("competitions") or [{}])[0]
    competitors = comp.get("competitors", [])

    home = next((c for c in competitors if c.get("homeAway") == "home"), None)
    away = next((c for c in competitors if c.get("homeAway") == "away"), None)
    if not home or not away:
        return None

    status_type = (comp.get("status") or {}).get("type") or {}
    completed   = status_type.get("completed", False)
    status_name = status_type.get("name", "")

    home_score = int(home["score"]) if completed and home.get("score") not in (None, "") else None
    away_score = int(away["score"]) if completed and away.get("score") not in (None, "") else None

    dt_str = ev.get("date", "")
    date_str = dt_str[:10] if dt_str else ""

    venue_name = (ev.get("venue") or {}).get("fullName", "")

    return {
        "idEvent":          ev.get("id", ""),
        "strHomeTeam":      home["team"].get("displayName", ""),
        "strAwayTeam":      away["team"].get("displayName", ""),
        "intHomeScore":     home_score,
        "intAwayScore":     away_score,
        "intRound":         str(ev.get("_round", 0)),
        "dateEvent":        date_str,
        "strHomeTeamBadge": home["team"].get("logo", ""),
        "strAwayTeamBadge": away["team"].get("logo", ""),
        "status":           status_name,
        "venue":            venue_name,
        "_espnId":          ev.get("id", ""),
    }


# ──────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────

def main() -> None:
    progress(5, f"Conectando ao ESPN — Brasileirão {SEASON}...")

    url = (
        f"{BASE_URL}/{LEAGUE_SLUG}/scoreboard"
        f"?dates={SEASON}0101-{SEASON}1231&limit=500"
    )

    try:
        r = requests.get(url, timeout=20)
        r.raise_for_status()
    except requests.RequestException as exc:
        print(f"Erro ao buscar ESPN: {exc}", file=sys.stderr)
        sys.exit(1)

    raw_events = r.json().get("events", [])
    if not raw_events:
        print(f"Nenhum evento encontrado para {SEASON}.", file=sys.stderr)
        sys.exit(1)

    progress(40, f"{len(raw_events)} partidas recebidas. Processando...")

    # Atribui rodadas por agrupamento de datas
    raw_events = assign_rounds(raw_events)

    progress(55, "Mapeando partidas...")

    all_matches: list[dict] = []
    for ev in raw_events:
        mapped = map_event(ev)
        if mapped and mapped["strHomeTeam"] and mapped["strAwayTeam"]:
            all_matches.append(mapped)

    if not all_matches:
        print("Nenhuma partida mapeada.", file=sys.stderr)
        sys.exit(1)

    # Rodada mais recente com placar
    finished  = [m for m in all_matches if m["intHomeScore"] is not None]
    latest_round = max(int(m["intRound"]) for m in finished) if finished else 1

    progress(80, "Buscando estatísticas de jogadores...")

    player_stats: list[dict] = []
    try:
        rs = requests.get(
            f"{BASE_URL}/{LEAGUE_SLUG}/statistics",
            timeout=10,
        )
        if rs.ok:
            for cat in rs.json().get("stats", []):
                cat_name = cat.get("name", "")
                for leader in cat.get("leaders", []):
                    athlete = leader.get("athlete", {})
                    aid     = athlete.get("id", "")
                    # shortDisplayValue: "M: 8, G: 6: A: 0"
                    short = leader.get("shortDisplayValue", "")
                    # format: "M: 8, G: 6: A: 0"  — use regex for robustness
                    def _int(key: str) -> int:
                        m = re.search(rf'{key}:\s*(\d+)', short)
                        return int(m.group(1)) if m else 0
                    entry = {
                        "id":      aid,
                        "name":    athlete.get("displayName", ""),
                        "photo":   f"https://a.espncdn.com/i/headshots/soccer/players/full/{aid}.png" if aid else "",
                        "cat":     cat_name,
                        "value":   int(leader.get("value", 0)),
                        "matches": _int("M"),
                        "goals":   _int("G"),
                        "assists": _int("A"),
                    }
                    player_stats.append(entry)
    except Exception as e:
        print(f"Aviso: estatísticas de jogadores não disponíveis — {e}", file=sys.stderr)

    progress(88, f"{len(all_matches)} jogos. Rodada atual: {latest_round}. Salvando...")

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "season":       SEASON,
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest_round": latest_round,
        "source":       "ESPN",
        "matches":      all_matches,
        "player_stats": player_stats,
    }
    OUTPUT_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    progress(100, f"Concluído — {len(all_matches)} partidas, {latest_round} rodadas jogadas.")


if __name__ == "__main__":
    main()
