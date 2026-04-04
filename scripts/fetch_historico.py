"""
Baixa e processa o dataset histórico do Brasileirão.
Fontes:
  - adaoduque/Brasileirao_Dataset: CSV completo 2003–2024
  - adaoduque/Brasileirao_Dataset/data/brasileirao-2025.json: 2025 (com gols, posse, chutes)

Gera: ../data/historico.json
"""
from __future__ import annotations

import json
import sys
import warnings
from datetime import date, datetime
from io import StringIO
from pathlib import Path

import pandas as pd
import requests

warnings.filterwarnings("ignore")

BASE_URL = "https://raw.githubusercontent.com/adaoduque/Brasileirao_Dataset/master"
OUTPUT   = Path(__file__).parent.parent / "data" / "historico.json"

URLS = {
    "full": f"{BASE_URL}/campeonato-brasileiro-full.csv",
    "gols": f"{BASE_URL}/campeonato-brasileiro-gols.csv",
    "json_2025": f"{BASE_URL}/data/brasileirao-2025.json",
}


def progress(pct: int, msg: str) -> None:
    print(f"PROGRESS:{pct}:{msg}", flush=True)


def parse_date_ddmmyyyy(s: str) -> str | None:
    if not s or str(s).strip() in ("", "nan", "None"):
        return None
    try:
        return datetime.strptime(str(s).strip(), "%d/%m/%Y").strftime("%Y-%m-%d")
    except ValueError:
        return None


def parse_date_ddmmyy(s: str) -> str | None:
    """DD/MM/YY (2-digit year) → YYYY-MM-DD"""
    if not s or str(s).strip() in ("", "nan", "None"):
        return None
    try:
        return datetime.strptime(str(s).strip(), "%d/%m/%y").strftime("%Y-%m-%d")
    except ValueError:
        return None


def extract_year_ddmmyyyy(s: str) -> str:
    try:
        parts = str(s).strip().split("/")
        if len(parts) == 3:
            return parts[2]
    except Exception:
        pass
    return ""


def calc_standings(rows: list[dict]) -> list[dict]:
    """Calcula classificação a partir de lista de dicts com h/a/hs/as."""
    teams: dict[str, dict] = {}
    for row in rows:
        home = str(row.get("h", "")).strip()
        away = str(row.get("a", "")).strip()
        try:
            hs  = int(row["hs"])
            as_ = int(row["as"])
        except (ValueError, KeyError, TypeError):
            continue
        if not home or not away or home == "nan" or away == "nan":
            continue
        for t in (home, away):
            if t not in teams:
                teams[t] = {"team": t, "points": 0, "played": 0,
                            "wins": 0, "draws": 0, "losses": 0,
                            "gf": 0, "ga": 0}
        teams[home]["played"] += 1; teams[away]["played"] += 1
        teams[home]["gf"]     += hs; teams[home]["ga"]    += as_
        teams[away]["gf"]     += as_; teams[away]["ga"]   += hs
        if hs > as_:
            teams[home]["wins"]   += 1; teams[home]["points"] += 3
            teams[away]["losses"] += 1
        elif hs < as_:
            teams[away]["wins"]   += 1; teams[away]["points"] += 3
            teams[home]["losses"] += 1
        else:
            teams[home]["draws"]  += 1; teams[home]["points"] += 1
            teams[away]["draws"]  += 1; teams[away]["points"] += 1

    st = sorted(teams.values(),
                key=lambda x: (-x["points"], -(x["gf"] - x["ga"]), -x["gf"]))
    for i, t in enumerate(st):
        t["position"] = i + 1
        t["sg"]       = t["gf"] - t["ga"]
    return st


def main() -> None:
    progress(5, "Baixando dataset histórico do Brasileirão...")

    # ── 1. CSV principal (2003–2024) ─────────────────────────────────
    try:
        r = requests.get(URLS["full"], timeout=45)
        r.raise_for_status()
        full_df = pd.read_csv(StringIO(r.text), sep=",", encoding="utf-8",
                              dtype=str, on_bad_lines="skip")
    except Exception as e:
        print(f"Erro ao baixar full.csv: {e}", file=sys.stderr)
        sys.exit(1)

    full_df.columns = [c.strip() for c in full_df.columns]
    full_df          = full_df.fillna("")
    full_df["season"] = full_df["data"].apply(extract_year_ddmmyyyy)

    seasons_csv = sorted([s for s in full_df["season"].unique()
                          if len(s) == 4 and s.isdigit()])

    progress(18, f"CSV carregado: {len(full_df)} jogos ({seasons_csv[0]}–{seasons_csv[-1]})")

    # ── 2. JSON 2025 ─────────────────────────────────────────────────
    matches_2025: list[dict] = []
    gols_2025_by_season: dict[str, list] = {}
    try:
        r2 = requests.get(URLS["json_2025"], timeout=30)
        r2.raise_for_status()
        raw_2025 = r2.json()
        if isinstance(raw_2025, list):
            data_2025 = raw_2025
        elif isinstance(raw_2025, dict):
            # might be {"partidas": [...]} or similar
            data_2025 = raw_2025.get("partidas") or raw_2025.get("jogos") or list(raw_2025.values())[0]
        else:
            data_2025 = []

        scorers_25: list[dict] = []
        for m in data_2025:
            home = str(m.get("mandante", "")).strip()
            away = str(m.get("visitante", "")).strip()
            try:
                hs  = int(m.get("gol_mandante", 0))
                as_ = int(m.get("gol_visitante", 0))
            except (ValueError, TypeError):
                continue
            if not home or not away:
                continue

            date_raw = str(m.get("data", "")).strip()
            date_iso = parse_date_ddmmyy(date_raw) or parse_date_ddmmyyyy(date_raw)

            gols = m.get("gols") or []
            goals_compact = []
            for g in gols:
                player = str(g.get("atleta", "")).strip()
                minute = g.get("minuto")
                goal_type = str(g.get("tipo_de_gol", "")).strip()
                is_home_scorer = True  # default; refine below
                # Determine which side scored based on club field if present
                club = str(g.get("clube", "")).strip()
                if club:
                    is_home_scorer = (club == home)
                goals_compact.append({
                    "p": player,
                    "m": minute,
                    "t": "h" if is_home_scorer else "a",
                })
                # collect for scorer ranking
                if goal_type.lower() not in ("gol contra", "contra"):
                    scorers_25.append({"player": player, "club": club or (home if is_home_scorer else away)})

            winner = m.get("vencedor", "")
            if not winner:
                winner = home if hs > as_ else (away if as_ > hs else "Empate")

            match_compact = {
                "s":  "2025",
                "r":  str(m.get("rodata", "")).strip(),
                "d":  date_iso,
                "h":  home,
                "a":  away,
                "hs": hs,
                "as": as_,
                "w":  str(winner).strip() or "Empate",
            }
            # Store rich stats for display
            stats = {}
            for key, field in [("ph","posse_mandante"),("pv","posse_visitante"),
                                ("sh","chutes_mandante"),("sv","chutes_visitante"),
                                ("soh","chutes_alvo_mandante"),("sov","chutes_alvo_visitante")]:
                val = m.get(field)
                if val is not None:
                    try:
                        stats[key] = int(val)
                    except (ValueError, TypeError):
                        pass
            if stats:
                match_compact["stats"] = stats
            if goals_compact:
                match_compact["goals"] = goals_compact

            matches_2025.append(match_compact)

        # Scorers 2025
        from collections import Counter
        cnt = Counter((s["player"], s["club"]) for s in scorers_25)
        gols_2025_by_season["2025"] = [
            {"player": k[0], "club": k[1], "goals": v}
            for k, v in cnt.most_common(20)
        ]

        progress(28, f"2025 JSON carregado: {len(matches_2025)} jogos")

    except Exception as e:
        print(f"Aviso: 2025 JSON não carregado: {e}", file=sys.stderr)

    # ── 3. Montar partidas compactas do CSV ──────────────────────────
    progress(32, "Processando partidas históricas 2003–2024...")

    matches_csv: list[dict] = []
    for _, row in full_df.iterrows():
        try:
            hs  = int(row["mandante_Placar"])
            as_ = int(row["visitante_Placar"])
        except (ValueError, KeyError, TypeError):
            continue
        home = str(row.get("mandante", "")).strip()
        away = str(row.get("visitante", "")).strip()
        if not home or not away or home == "nan" or away == "nan":
            continue
        venc   = str(row.get("vencedor", "")).strip()
        winner = venc if venc and venc not in ("", "nan") else "Empate"
        matches_csv.append({
            "s":  row["season"],
            "r":  str(row.get("rodata", "")).strip(),
            "d":  parse_date_ddmmyyyy(row["data"]),
            "h":  home,
            "a":  away,
            "hs": hs,
            "as": as_,
            "w":  winner,
        })

    all_matches = matches_csv + matches_2025
    all_seasons = sorted(set([m["s"] for m in all_matches if m["s"] and len(m["s"]) == 4]))

    progress(42, f"{len(all_matches)} partidas totais ({all_seasons[0]}–{all_seasons[-1]})")

    # ── 4. Classificação por temporada ───────────────────────────────
    progress(48, "Calculando classificações por temporada...")

    standings_by_season: dict[str, list] = {}
    for season in all_seasons:
        season_matches = [m for m in all_matches if m["s"] == season]
        standings_by_season[season] = calc_standings(season_matches)

    progress(58, f"Classificações prontas para {len(all_seasons)} temporadas")

    # ── 5. Ranking de técnicos ───────────────────────────────────────
    progress(62, "Calculando ranking de técnicos...")

    coaches: dict[str, dict] = {}

    # Do CSV (2003–2024)
    for _, row in full_df.iterrows():
        try:
            hs  = int(row["mandante_Placar"])
            as_ = int(row["visitante_Placar"])
        except (ValueError, KeyError, TypeError):
            continue
        for coach_key, is_home in [("tecnico_mandante", True), ("tecnico_visitante", False)]:
            coach = str(row.get(coach_key, "")).strip()
            if not coach or coach in ("", "nan", "None"):
                continue
            if coach not in coaches:
                coaches[coach] = {"name": coach, "matches": 0, "wins": 0,
                                  "draws": 0, "losses": 0, "points": 0}
            c = coaches[coach]
            c["matches"] += 1
            scored   = hs  if is_home else as_
            conceded = as_ if is_home else hs
            if scored > conceded:
                c["wins"]   += 1; c["points"] += 3
            elif scored == conceded:
                c["draws"]  += 1; c["points"] += 1
            else:
                c["losses"] += 1

    # Do JSON 2025
    try:
        for m in data_2025:
            try:
                hs  = int(m.get("gol_mandante", 0))
                as_ = int(m.get("gol_visitante", 0))
            except (ValueError, TypeError):
                continue
            for coach_key, is_home in [("tecnico_mandante", True), ("tecnico_visitante", False)]:
                coach = str(m.get(coach_key, "")).strip()
                if not coach or coach in ("", "nan"):
                    continue
                if coach not in coaches:
                    coaches[coach] = {"name": coach, "matches": 0, "wins": 0,
                                      "draws": 0, "losses": 0, "points": 0}
                c = coaches[coach]
                c["matches"] += 1
                scored   = hs  if is_home else as_
                conceded = as_ if is_home else hs
                if scored > conceded:
                    c["wins"]   += 1; c["points"] += 3
                elif scored == conceded:
                    c["draws"]  += 1; c["points"] += 1
                else:
                    c["losses"] += 1
    except NameError:
        pass

    coaches_list = [
        {**c, "efficiency": round(c["points"] / (c["matches"] * 3) * 100, 1)}
        for c in coaches.values()
        if c["matches"] >= 20
    ]
    coaches_list.sort(key=lambda x: (-x["points"], -x["efficiency"]))

    progress(70, f"{len(coaches_list)} técnicos no ranking (mín. 20 jogos)")

    # ── 6. Artilheiros (gols.csv) ────────────────────────────────────
    progress(74, "Baixando e processando dados de gols...")

    scorers_all_time: list[dict] = []
    scorers_by_season: dict[str, list] = {}

    try:
        r3 = requests.get(URLS["gols"], timeout=45)
        r3.raise_for_status()
        gols_df = pd.read_csv(StringIO(r3.text), sep=",", encoding="utf-8",
                              dtype=str, on_bad_lines="skip")
        gols_df.columns = [c.strip() for c in gols_df.columns]
        gols_df          = gols_df.fillna("")

        cols       = list(gols_df.columns)
        player_col = next((c for c in cols if c.lower() in ("atleta", "jogador", "player")), None)
        club_col   = next((c for c in cols if c.lower() in ("clube", "club", "time")), None)
        id_col     = next((c for c in cols if c.lower() in ("partida_id", "id_partida", "jogo_id")), None)
        tipo_col   = next((c for c in cols if "tipo" in c.lower()), None)

        if player_col and club_col:
            if tipo_col:
                gols_df = gols_df[~gols_df[tipo_col].str.lower().str.contains(
                    r"gol contra|contra|own goal", na=False)]

            if id_col:
                id_season = full_df[["ID", "season"]].rename(columns={"ID": id_col})
                gols_df   = gols_df.merge(id_season, on=id_col, how="left")
            else:
                gols_df["season"] = ""

            # All-time (CSV only, 2003–2024)
            at = (gols_df.groupby([player_col, club_col])
                  .size().reset_index(name="goals")
                  .sort_values("goals", ascending=False))
            scorers_all_time = [
                {"player": row[player_col], "club": row[club_col], "goals": int(row["goals"])}
                for _, row in at.head(100).iterrows()
            ]

            # By season (CSV)
            for season in seasons_csv:
                sg = gols_df[gols_df["season"] == season]
                if sg.empty:
                    continue
                by_s = (sg.groupby([player_col, club_col])
                        .size().reset_index(name="goals")
                        .sort_values("goals", ascending=False))
                scorers_by_season[season] = [
                    {"player": row[player_col], "club": row[club_col], "goals": int(row["goals"])}
                    for _, row in by_s.head(20).iterrows()
                ]

        progress(85, f"{len(scorers_all_time)} artilheiros all-time processados")

    except Exception as e:
        print(f"Aviso: gols.csv não processado: {e}", file=sys.stderr)

    # Adicionar artilheiros 2025 (do JSON)
    if gols_2025_by_season.get("2025"):
        scorers_by_season["2025"] = gols_2025_by_season["2025"]

    # ── 7. Salvar ────────────────────────────────────────────────────
    progress(93, f"{len(all_matches)} partidas prontas. Salvando JSON...")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "last_updated":        date.today().isoformat(),
        "source":              "adaoduque/Brasileirao_Dataset (GitHub)",
        "seasons":             all_seasons,
        "standings_by_season": standings_by_season,
        "scorers_all_time":    scorers_all_time,
        "scorers_by_season":   scorers_by_season,
        "coaches":             coaches_list,
        "matches":             all_matches,
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    size_kb = OUTPUT.stat().st_size // 1024
    progress(100, f"Concluído — {len(all_matches)} jogos, {len(all_seasons)} temporadas ({size_kb} KB)")


if __name__ == "__main__":
    main()
