"""
Fetches market values and player data for Brazilian clubs
from the public dcaribou/transfermarkt-datasets dataset (via DuckDB).
Output: ../data/market-values.json

Dataset: https://github.com/dcaribou/transfermarkt-datasets
Usage:
    python fetch_transfermarkt.py
"""

from __future__ import annotations

import json
import sys
import warnings
from datetime import date, datetime
from pathlib import Path

import duckdb

warnings.filterwarnings("ignore")

# ──────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────

DATASET_BASE   = "https://pub-e682421888d945d684bcae8890b0ec20.r2.dev/data"
COMPETITION_ID = "BRA1"   # Brasileirão Série A on Transfermarkt
OUTPUT_FILE    = Path(__file__).parent.parent / "data" / "market-values.json"

# Position mapping to short English display names
POSITION_MAP = {
    "Goalkeeper":        "Goalkeeper",
    "Centre-Back":       "Centre-Back",
    "Left-Back":         "Left-Back",
    "Right-Back":        "Right-Back",
    "Defensive Midfield": "Defensive Mid",
    "Central Midfield":  "Central Mid",
    "Attacking Midfield": "Attacking Mid",
    "Left Midfield":     "Left Mid",
    "Right Midfield":    "Right Mid",
    "Left Winger":       "Left Winger",
    "Right Winger":      "Right Winger",
    "Second Striker":    "Second Striker",
    "Centre-Forward":    "Centre-Forward",
    "Attack":            "Forward",
    "Midfield":          "Midfielder",
    "Defender":          "Defender",
}

# Normalisation: Transfermarkt name → ESPN name (used by the main filter)
TEAM_NAME_MAP = {
    "Esporte Clube Bahia":              "Bahia",
    "Sociedade Esportiva Palmeiras":    "Palmeiras",
    "Clube do Remo":                    "Remo",
    "Associação Chapecoense de Futebol": "Chapecoense",
    "Sport Club Corinthians Paulista":  "Corinthians",
    "Grêmio Foot-Ball Porto Alegrense": "Grêmio",
    "Esporte Clube Vitória":            "Vitória",
    "Santos Futebol Clube":             "Santos",
    "Fluminense Football Club":         "Fluminense",
    "Clube Atlético Mineiro":           "Atlético-MG",
    "Mirasol Futebol Clube":            "Mirassol",
    "S. A. F. Botafogo":               "Botafogo",
    "Botafogo de Futebol e Regatas":    "Botafogo",
    "São Paulo Futebol Clube":          "São Paulo",
    "Cruzeiro Esporte Clube":           "Cruzeiro",
    "Clube de Regatas do Flamengo":     "Flamengo",
    "Sport Club Internacional":         "Internacional",
    "Clube Atlético Paranaense":        "Athletico Paranaense",
    "Coritiba Foot Ball Club":          "Coritiba",
    "Club de Regatas Vasco da Gama":    "Vasco da Gama",
    "Red Bull Bragantino":              "Red Bull Bragantino",
    "Esporte Clube Juventude":          "Juventude",
    "Fortaleza Esporte Clube":          "Fortaleza",
    "Ceará Sporting Club":              "Ceará",
    "Sport Club do Recife":             "Sport Recife",
}


# ──────────────────────────────────────────────────────────────────
# Utilities
# ──────────────────────────────────────────────────────────────────

def progress(pct: int, msg: str) -> None:
    print(f"PROGRESS:{pct}:{msg}", flush=True)


def calc_age(dob_str: str) -> int | None:
    if not dob_str or str(dob_str) in ("", "nan", "None"):
        return None
    try:
        birth = datetime.strptime(str(dob_str)[:10], "%Y-%m-%d").date()
        today = date.today()
        return today.year - birth.year - (
            (today.month, today.day) < (birth.month, birth.day)
        )
    except ValueError:
        return None


# ──────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────

def main() -> None:
    progress(5, "Connecting to the Transfermarkt dataset...")

    conn = duckdb.connect()

    # ── 1. Brasileirão clubs ──────────────────────────────────
    progress(15, "Fetching Série A clubs (BR1)...")

    clubs_url = f"{DATASET_BASE}/clubs.csv.gz"
    try:
        clubs_df = conn.execute(f"""
            SELECT club_id, name
            FROM read_csv_auto('{clubs_url}')
            WHERE domestic_competition_id = '{COMPETITION_ID}'
        """).df()
    except Exception as e:
        print(f"Error fetching clubs: {e}", file=sys.stderr)
        sys.exit(1)

    if clubs_df.empty:
        print(f"No clubs found for competition_id='{COMPETITION_ID}'.", file=sys.stderr)
        sys.exit(1)

    club_ids      = clubs_df["club_id"].tolist()
    club_name_map = dict(zip(clubs_df["club_id"], clubs_df["name"]))
    ids_str       = ", ".join(str(i) for i in club_ids)

    progress(30, f"{len(club_ids)} clubs found. Fetching players...")

    # ── 2. Club players ───────────────────────────────────
    players_url = f"{DATASET_BASE}/players.csv.gz"
    try:
        players_df = conn.execute(f"""
            SELECT
                player_id,
                name,
                current_club_id,
                position,
                sub_position,
                date_of_birth,
                market_value_in_eur
            FROM read_csv_auto('{players_url}')
            WHERE current_club_id IN ({ids_str})
              AND market_value_in_eur IS NOT NULL
              AND market_value_in_eur > 0
            ORDER BY market_value_in_eur DESC
        """).df()
    except Exception as e:
        print(f"Error fetching players: {e}", file=sys.stderr)
        sys.exit(1)

    progress(70, f"{len(players_df)} players found. Processing...")

    # ── 3. Normalise data ───────────────────────────────────────
    result = []
    for _, row in players_df.iterrows():
        club_name = club_name_map.get(row["current_club_id"], "")

        # Position: prefer sub_position (more specific), fall back to position
        raw_pos  = str(row.get("sub_position") or row.get("position") or "")
        position = POSITION_MAP.get(raw_pos, raw_pos) if raw_pos else "—"

        # Normalise the club name to match ESPN
        team_normalized = TEAM_NAME_MAP.get(club_name, club_name)

        result.append({
            "name":     row["name"],
            "team":     team_normalized,
            "position": position,
            "age":      calc_age(row.get("date_of_birth")),
            "value":    int(row["market_value_in_eur"]),
        })

    progress(90, f"Saving {len(result)} players...")

    # ── 4. EUR → BRL rate ──────────────────────────────────────
    brl_rate = 6.20  # fallback
    try:
        rate_res = conn.execute("""
            SELECT json_extract_string(
                (SELECT * FROM read_json_auto('https://api.exchangerate-api.com/v4/latest/EUR')),
                '$.rates.BRL'
            )
        """).fetchone()
        if rate_res and rate_res[0]:
            brl_rate = round(float(rate_res[0]), 4)
    except Exception:
        pass  # use fallback

    # ── 5. Save JSON ────────────────────────────────────────────
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "last_updated": date.today().isoformat(),
        "source":       "Transfermarkt via dcaribou/transfermarkt-datasets",
        "eur_brl_rate": brl_rate,
        "players":      result,
    }
    OUTPUT_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    progress(100, f"Done. {len(result)} players saved to {OUTPUT_FILE.name}.")


if __name__ == "__main__":
    main()
