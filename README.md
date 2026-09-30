# Brasileirão Série A 2026 | Dashboard

Interactive dashboard for Brazil's top football league (Campeonato Brasileiro Série A), with standings, statistics and player market values.

**[Open the dashboard](https://fexndev.github.io/brasileirao-dashboard/)**

## Features

- **Standings table** with zones (Libertadores, Sudamericana, relegation) and the last 5 matches
- **Statistics**: league KPIs, goals by team, home/away performance, trends by round
- **Market**: player market values (Transfermarkt), sortable by name, team, position, age and value
- **Automatic daily update** via GitHub Actions (7am BRT)

## Data sources

| Source | Data |
|---|---|
| [ESPN](https://www.espn.com.br) | Matches, results, rounds |
| [Transfermarkt](https://www.transfermarkt.com) | Player market values |

## Run locally

```bash
pip install -r scripts/requirements.txt
python3 scripts/server.py
# Open: http://localhost:8000
```

## Technologies

- HTML, CSS, JavaScript (no frameworks)
- Chart.js for charts
- Python + Flask (local server)
- GitHub Actions (automatic updates)
