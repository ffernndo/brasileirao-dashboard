"""
Collects Brasileirão Série A results from TheSportsDB (free, no auth).
Output: ../data/brasileirao.json

Round strategy:
  1. Check the season calendar to see which dates have passed
  2. Work out the last round played based on today's date
  3. Fetch only the rounds needed (not all 38)
"""
from __future__ import annotations

import json
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from pathlib import Path

import requests

warnings.filterwarnings("ignore")

API_BASE   = "https://www.thesportsdb.com/api/v1/json/3"
LEAGUE_ID  = 4351
SEASON     = 2026
MAX_ROUNDS = 38
WORKERS    = 4
MAX_RETRY  = 3

OUTPUT = Path(__file__).parent.parent / "data" / "brasileirao.json"


def progress(pct: int, msg: str) -> None:
    print(f"PROGRESS:{pct}:{msg}", flush=True)


def get_max_round_by_date() -> int:
    """
    Checks the season calendar and returns the last round
    with matches scheduled up to today + 1 buffer round (it may be in progress).
    Fallback: uses the date of Round 1 to estimate by weeks elapsed.
    """
    today = date.today().isoformat()

    # Attempt 1: full season calendar
    try:
        r = requests.get(
            f"{API_BASE}/eventsseason.php?id={LEAGUE_ID}&s={SEASON}",
            timeout=10,
        )
        events = r.json().get("events") or []
        if len(events) >= 50:  # full dataset (free tier returns partial data)
            past = {
                int(e["intRound"])
                for e in events
                if e.get("dateEvent", "") <= today and e.get("intRound")
            }
            if past:
                return min(max(past) + 2, MAX_ROUNDS)
    except Exception:
        pass

    # Attempt 2: take the date of Round 1 and estimate by weeks
    try:
        r = requests.get(
            f"{API_BASE}/eventsround.php?id={LEAGUE_ID}&r=1&s={SEASON}",
            timeout=10,
        )
        events = r.json().get("events") or []
        if events:
            round1_date = datetime.strptime(events[0]["dateEvent"], "%Y-%m-%d").date()
            weeks_elapsed = max(1, (date.today() - round1_date).days // 7)
            estimated = min(weeks_elapsed + 3, MAX_ROUNDS)
            progress(8, f"Date-based estimate: up to round {estimated} (week {weeks_elapsed})")
            return estimated
    except Exception:
        pass

    return 15  # conservative fallback


def fetch_round(round_num: int) -> tuple[int, list[dict]]:
    url = f"{API_BASE}/eventsround.php?id={LEAGUE_ID}&r={round_num}&s={SEASON}"
    for attempt in range(MAX_RETRY):
        try:
            r = requests.get(url, timeout=15)
            if r.status_code == 200:
                events = r.json().get("events") or []
                return round_num, [e for e in events if e.get("strStatus") == "Match Finished"]
        except Exception as exc:
            if attempt < MAX_RETRY - 1:
                time.sleep(0.5 * (attempt + 1))
            else:
                print(f"Round {round_num} failed: {exc}", file=sys.stderr)
    return round_num, []


def main() -> None:
    progress(5, f"Detecting current round | {date.today().strftime('%d/%m/%Y')}...")

    max_round = get_max_round_by_date()
    progress(10, f"Fetching rounds 1–{max_round} in parallel...")

    all_matches: list[dict] = []
    finished_rounds: list[int] = []
    completed = 0
    total = max_round

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(fetch_round, r): r for r in range(1, max_round + 1)}

        for future in as_completed(futures):
            completed += 1
            round_num, matches = future.result()

            if matches:
                all_matches.extend(matches)
                finished_rounds.append(round_num)

            pct = 10 + int(completed / total * 82)
            status = f"{len(matches)} match(es)" if matches else "no data"
            progress(pct, f"Round {round_num} | {status}")

    if not all_matches:
        print(f"No matches found for {SEASON}.", file=sys.stderr)
        sys.exit(1)

    latest_round = max(finished_rounds)
    progress(95, f"{len(all_matches)} matches in {len(finished_rounds)} rounds. Saving...")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "season":       SEASON,
        "last_updated": datetime.now().isoformat(timespec="seconds"),
        "latest_round": latest_round,
        "matches":      all_matches,
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    progress(100, f"Saved | {len(all_matches)} matches, current round: {latest_round}.")


if __name__ == "__main__":
    main()
