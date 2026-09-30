# Brazilian Football Dashboard | Project Context

## Goal
Build an interactive, free dashboard with no paid dependencies that brings together information about Brazilian football clubs: rounds, standings, players, result metrics, performance and financial/market data.

## Scope

### Clubs
- Every Brazilian football club (initial focus: Brasileirão Série A)
- Users can filter by club in the dashboard

### Competitions covered
- **Brasileirão Série A** (main priority)
- **Copa do Brasil**
- **Copa Libertadores da América**

### Planned metrics and sections

#### 1. Overview / KPIs
- League position, points, points percentage
- Result streak (last 5 matches)
- Next match (opponent, date, competition)

#### 2. Results and Rounds
- Full standings table (with a filter by half of the season)
- Round-by-round results
- Head-to-head history

#### 3. Performance
- Goals scored vs conceded (total and by competition)
- Possession, shots, corners (if available in the API)
- Home vs away performance
- Results heatmap by round

#### 4. Players
- Top scorers and assists by competition
- Cards (yellow/red)
- Minutes played and starts

#### 5. Financial / Market Data (future phase)
- Squad market value (Transfermarkt as reference)
- Transfers (signings and departures)
- Investment vs performance comparison

---

## Technical Architecture

### Dashboard technology
- **Plain HTML + CSS + JavaScript** (single file, opens in any browser)
- Charts with **Chart.js** (CDN, no installation)
- Responsive layout with CSS Grid/Flexbox
- Interactive filters (club, competition, season)
- No backend: data consumed directly via fetch() from the APIs

### Data sources (free APIs)

#### Main source: TheSportsDB (ACTIVE)
- **Free plan**: no API key, no daily request limit
- **Coverage**: Brasileirão Série A, Copa do Brasil and other leagues
- **Available data**: current season (2026) in real time
- **Base URL**: `https://www.thesportsdb.com/api/v1/json/3/`
- **Endpoints used**:
  - `lookuptable.php?l={id}&s={season}`: standings (limited to 5 teams on the free plan)
  - `eventsround.php?id={id}&r={round}&s={season}`: matches by round (complete, 10 matches)
  - `eventsnextleague.php?id={id}`: upcoming matches
- **League IDs**:
  - Brasileirão Série A: 4351
  - Copa do Brasil: 4725
- **Strategy**: since the free table only returns 5 teams, the full standings (20 teams) are calculated from the results of every round
- **URL**: https://www.thesportsdb.com/

#### Secondary source: API-Football (api-sports.io), BACKUP
- **Free plan**: 100 requests/day, access to every endpoint
- **Limitation**: 2022-2024 seasons only (no 2025/2026 on the free plan)
- **API key**: registered at dashboard.api-football.com
- **Coverage**: Brasileirão (71), Copa do Brasil (73), Libertadores (13)
- **Docs**: https://www.api-football.com/documentation-v3
- **Future use**: after an upgrade, it could replace TheSportsDB with richer data (detailed stats, top scorers, etc.)

### Data strategy
- **Local calculation**: standings built from round-by-round results
- **Parallelism**: rounds 1-15 fetched in parallel via Promise.all
- **In-memory cache**: data stored in JS variables (per session)
- **Badges**: collected automatically from each match's data (strHomeTeamBadge/strAwayTeamBadge)

---

## File Structure (planned)

```
Dashboard Futebol/
├── CONTEXT.md              ← this file
├── index.html              ← main dashboard (HTML + CSS + JS in a single file)
├── data/
│   ├── teams.json          ← static team data (name, badge, colours)
│   └── config.json         ← league IDs, current season, API keys
└── assets/
    └── escudos/            ← local badge fallback (optional)
```

---

## Visual Identity (suggestion)

- **Background**: dark (#0f1923 or #1a1a2e)
- **Cards**: dark grey (#16213e or #1e293b) with subtle borders
- **Primary accent**: green (#10b981), a nod to Brazilian football
- **Secondary accent**: yellow (#f59e0b), national identity
- **Main text**: white (#f1f5f9)
- **Secondary text**: light grey (#94a3b8)
- **Font**: Inter or system font (no external dependency)
- **Style**: clean, professional, inspired by BI dashboards

---

## Rules and Assumptions

1. **Zero cost**: no paid tools or services
2. **Single file**: the dashboard must work by opening a single HTML file in the browser
3. **Responsive**: works on desktop and mobile
4. **Real data**: use real APIs, not mock data (except during prototyping)
5. **Smart caching**: minimise API calls to respect limits
6. **Progressive**: start with the essentials (standings + results) and evolve

---

## Development Phases

### Phase 1: MVP (priority)
- [ ] Register with API-Football and get the key
- [ ] Dashboard HTML/CSS structure (layout, colours, responsiveness)
- [ ] Brasileirão Série A standings (interactive table)
- [ ] Results by round
- [ ] Club filter
- [ ] localStorage cache

### Phase 2: Expansion
- [ ] Add Copa do Brasil and Libertadores
- [ ] Players section (top scorers, cards)
- [ ] Performance stats (goals, home vs away)
- [ ] Upcoming matches and calendar

### Phase 3: Advanced
- [ ] Financial/market data (may require manual scraping or CSV)
- [ ] Club comparison
- [ ] Advanced charts (radar, results heatmap)
- [ ] Data export (CSV/PDF)

---

## Notes for the Assistant (Claude)

- The user is a data and BI professional, so technical terminology is fine
- Prioritise practical, applicable and well-structured solutions
- The dashboard is plain HTML/JS: do not use frameworks such as React or Vue
- Keep the code clean, commented and organised
- When evolving the dashboard, preserve the existing structure
- Dashboard language: English
- Date format: DD/MM/YYYY
- Decimal separator: point (e.g. 75.5%)
