"""
Busca valores de mercado e dados de jogadores de clubes brasileiros
a partir do dataset público dcaribou/transfermarkt-datasets (via DuckDB).
Gera: ../data/market-values.json

Dataset: https://github.com/dcaribou/transfermarkt-datasets
Uso:
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
# Configuração
# ──────────────────────────────────────────────────────────────────

DATASET_BASE   = "https://pub-e682421888d945d684bcae8890b0ec20.r2.dev/data"
COMPETITION_ID = "BRA1"   # Brasileirão Série A no Transfermarkt
OUTPUT_FILE    = Path(__file__).parent.parent / "data" / "market-values.json"

# Mapeamento de posições EN → PT-BR
POSITION_MAP = {
    "Goalkeeper":        "Goleiro",
    "Centre-Back":       "Zagueiro",
    "Left-Back":         "Lateral Esq.",
    "Right-Back":        "Lateral Dir.",
    "Defensive Midfield": "Vol. Defensivo",
    "Central Midfield":  "Meia Central",
    "Attacking Midfield": "Meia Atac.",
    "Left Midfield":     "Meia Esq.",
    "Right Midfield":    "Meia Dir.",
    "Left Winger":       "Ponta Esq.",
    "Right Winger":      "Ponta Dir.",
    "Second Striker":    "Segundo Atac.",
    "Centre-Forward":    "Centroavante",
    "Attack":            "Atacante",
    "Midfield":          "Meia",
    "Defender":          "Defensor",
}

# Normalização: nome Transfermarkt → nome ESPN (usado no filtro principal)
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
# Utilitários
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
    progress(5, "Conectando ao dataset do Transfermarkt...")

    conn = duckdb.connect()

    # ── 1. Clubes do Brasileirão ──────────────────────────────────
    progress(15, "Buscando clubes da Série A (BR1)...")

    clubs_url = f"{DATASET_BASE}/clubs.csv.gz"
    try:
        clubs_df = conn.execute(f"""
            SELECT club_id, name
            FROM read_csv_auto('{clubs_url}')
            WHERE domestic_competition_id = '{COMPETITION_ID}'
        """).df()
    except Exception as e:
        print(f"Erro ao buscar clubes: {e}", file=sys.stderr)
        sys.exit(1)

    if clubs_df.empty:
        print(f"Nenhum clube encontrado para competition_id='{COMPETITION_ID}'.", file=sys.stderr)
        sys.exit(1)

    club_ids      = clubs_df["club_id"].tolist()
    club_name_map = dict(zip(clubs_df["club_id"], clubs_df["name"]))
    ids_str       = ", ".join(str(i) for i in club_ids)

    progress(30, f"{len(club_ids)} clubes encontrados. Buscando jogadores...")

    # ── 2. Jogadores dos clubes ───────────────────────────────────
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
        print(f"Erro ao buscar jogadores: {e}", file=sys.stderr)
        sys.exit(1)

    progress(70, f"{len(players_df)} jogadores encontrados. Processando...")

    # ── 3. Normalizar dados ───────────────────────────────────────
    result = []
    for _, row in players_df.iterrows():
        club_name = club_name_map.get(row["current_club_id"], "")

        # Posição: preferir sub_position (mais específica), fallback para position
        raw_pos  = str(row.get("sub_position") or row.get("position") or "")
        position = POSITION_MAP.get(raw_pos, raw_pos) if raw_pos else "—"

        # Normaliza nome do clube para coincidir com ESPN
        team_normalized = TEAM_NAME_MAP.get(club_name, club_name)

        result.append({
            "name":     row["name"],
            "team":     team_normalized,
            "position": position,
            "age":      calc_age(row.get("date_of_birth")),
            "value":    int(row["market_value_in_eur"]),
        })

    progress(90, f"Salvando {len(result)} jogadores...")

    # ── 4. Cotação EUR → BRL ──────────────────────────────────────
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
        pass  # usa fallback

    # ── 5. Salvar JSON ────────────────────────────────────────────
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
    progress(100, f"Concluído. {len(result)} jogadores salvos em {OUTPUT_FILE.name}.")


if __name__ == "__main__":
    main()
