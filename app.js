/**
 * ============================================================================
 * BRASILEIRÃO SÉRIE A 2026 — Dashboard Application
 * ============================================================================
 * Aplicação frontend servida via Flask (scripts/server.py).
 * Os dados são coletados por scripts Python e salvos como JSON locais.
 *
 * Arquitetura:
 *   - Dados fornecidos por scripts/fetch_sofascore.py e fetch_transfermarkt.py
 *   - Classificação calculada localmente a partir dos resultados
 *   - Botão "Atualizar Dados" aciona pipeline via SSE (Server-Sent Events)
 *   - Barra de progresso em tempo real durante a coleta
 *   - Renderização via template strings injetados no DOM
 *   - Chart.js para gráficos interativos
 *
 * @author Dashboard Futebol Brasil
 * @version 3.0.0
 * ============================================================================
 */

/* --------------------------------------------------------------------------
 * CONSTANTES DE CONFIGURAÇÃO
 * -------------------------------------------------------------------------- */

/** Endpoints dos dados JSON gerados pelos scripts Python */
const DATA_BRASILEIRAO = 'data/brasileirao.json';
const DATA_MARKET      = 'data/market-values.json';

/** Detecta se está rodando no GitHub Pages (estático) vs localhost (Flask) */
const IS_STATIC = window.location.hostname !== 'localhost'
    && window.location.hostname !== '127.0.0.1';

/** Cotação EUR → BRL (sobrescrita pelo JSON quando disponível) */
let EUR_TO_BRL = 6.20;


/* --------------------------------------------------------------------------
 * ESTADO GLOBAL DA APLICAÇÃO
 * -------------------------------------------------------------------------- */

/**
 * Estado centralizado do dashboard.
 * Todas as funções de renderização leem deste objeto.
 *
 * @type {{
 *   standings:     Array<TeamStats>|null,
 *   selectedTeam:  string,
 *   selectedRound: number|null,
 *   lastUpdated:   Date|null,
 *   allMatches:    Array<Object>,
 *   activeTab:     string,
 *   chartInstances: Array<Chart>
 * }}
 */
let appState = {
    standings:      null,
    selectedTeam:   'Todos os times',
    selectedRound:  null,
    lastUpdated:    null,
    allMatches:     [],
    activeTab:      'tabela',
    chartInstances: [],
    season:         null,
    mercadoSort:    'value',    // field to sort by: 'name','team','position','age','value'
    mercadoSortDir: 'desc',     // 'asc' or 'desc'
};


/* ============================================================================
 * SEÇÃO 2: CÁLCULOS E PROCESSAMENTO DE DADOS
 * ============================================================================ */

/**
 * Calcula a classificação completa a partir dos resultados das partidas.
 * Processa gols, pontos, vitórias/empates/derrotas (casa e fora),
 * e ordena por pontos → saldo de gols → gols marcados.
 *
 * @param {Array<Object>} matches - Array de partidas finalizadas da API
 * @returns {{
 *   standings:  Array<TeamStats>,
 *   teamBadges: Object<string, string>
 * }}
 */
function calculateStandings(matches) {
    const teams = {};
    const teamBadges = {};

    matches.forEach(match => {
        // Ignorar jogos não disputados (placar null = ainda não jogado)
        if (match.intHomeScore === null || match.intHomeScore === undefined || match.intHomeScore === '') return;

        const home = match.strHomeTeam;
        const away = match.strAwayTeam;
        const homeScore = parseInt(match.intHomeScore) || 0;
        const awayScore = parseInt(match.intAwayScore) || 0;
        const matchDate = new Date(match.dateEvent + 'T12:00:00');

        // Inicializa times se ainda não existem
        [home, away].forEach(t => {
            if (!teams[t]) {
                teams[t] = {
                    name: t, points: 0, played: 0,
                    wins: 0, draws: 0, losses: 0,
                    goalsFor: 0, goalsAgainst: 0,
                    homeWins: 0, homeDraws: 0, homeLosses: 0,
                    homeGoalsFor: 0, homeGoalsAgainst: 0,
                    awayWins: 0, awayDraws: 0, awayLosses: 0,
                    awayGoalsFor: 0, awayGoalsAgainst: 0,
                    lastMatchDate: null, matches: []
                };
            }
        });

        // Escudos
        teamBadges[home] = match.strHomeTeamBadge;
        teamBadges[away] = match.strAwayTeamBadge;

        // Estatísticas do mandante
        teams[home].played++;
        teams[home].goalsFor += homeScore;
        teams[home].goalsAgainst += awayScore;
        teams[home].homeGoalsFor += homeScore;
        teams[home].homeGoalsAgainst += awayScore;
        if (!teams[home].lastMatchDate || matchDate > teams[home].lastMatchDate) {
            teams[home].lastMatchDate = matchDate;
        }
        teams[home].matches.push({
            opponent: away, score: homeScore, conceded: awayScore,
            isHome: true, date: matchDate
        });

        // Estatísticas do visitante
        teams[away].played++;
        teams[away].goalsFor += awayScore;
        teams[away].goalsAgainst += homeScore;
        teams[away].awayGoalsFor += awayScore;
        teams[away].awayGoalsAgainst += homeScore;
        if (!teams[away].lastMatchDate || matchDate > teams[away].lastMatchDate) {
            teams[away].lastMatchDate = matchDate;
        }
        teams[away].matches.push({
            opponent: home, score: awayScore, conceded: homeScore,
            isHome: false, date: matchDate
        });

        // Distribuição de pontos
        if (homeScore > awayScore) {
            teams[home].wins++; teams[home].points += 3; teams[home].homeWins++;
            teams[away].losses++; teams[away].awayLosses++;
        } else if (homeScore < awayScore) {
            teams[away].wins++; teams[away].points += 3; teams[away].awayWins++;
            teams[home].losses++; teams[home].homeLosses++;
        } else {
            teams[home].draws++; teams[home].points += 1; teams[home].homeDraws++;
            teams[away].draws++; teams[away].points += 1; teams[away].awayDraws++;
        }
    });

    // Ordenação: pontos → saldo de gols → gols marcados
    const standings = Object.values(teams).sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        const sgDiff = (b.goalsFor - b.goalsAgainst) - (a.goalsFor - a.goalsAgainst);
        if (sgDiff !== 0) return sgDiff;
        return b.goalsFor - a.goalsFor;
    });

    standings.forEach((team, i) => { team.position = i + 1; });
    return { standings, teamBadges };
}


function getFilteredMatches() {
    let matches = appState.allMatches;
    if (appState.turno === 'primeiro') {
        matches = matches.filter(m => parseInt(m.intRound) <= 19);
    } else if (appState.turno === 'segundo') {
        matches = matches.filter(m => parseInt(m.intRound) >= 20);
    }
    return matches;
}

function applyFilters() {
    const matches = getFilteredMatches();
    if (matches.length > 0) {
        const { standings, teamBadges } = calculateStandings(matches);
        standings.forEach(t => {
            const prev = (appState.standings || []).find(s => s.name === t.name);
            t.badge = teamBadges[t.name] || (prev && prev.badge) || '';
        });
        appState.standings = standings;
        const rounds = [...new Set(matches.map(m => parseInt(m.intRound)))].sort((a, b) => a - b);
        if (!rounds.includes(appState.selectedRound)) {
            appState.selectedRound = rounds[rounds.length - 1];
        }
    } else {
        appState.standings = [];
    }
    render();
}

function buildPointsProgression(matches) {
    const rounds = [...new Set(matches.map(m => parseInt(m.intRound)))].sort((a, b) => a - b);
    const teamNames = [...new Set(matches.flatMap(m => [m.strHomeTeam, m.strAwayTeam]))];
    const cumPts = {};
    teamNames.forEach(t => { cumPts[t] = 0; });
    const series = {};
    teamNames.forEach(t => { series[t] = []; });
    rounds.forEach(round => {
        matches.filter(m => parseInt(m.intRound) === round).forEach(m => {
            const hs = parseInt(m.intHomeScore) || 0;
            const as = parseInt(m.intAwayScore) || 0;
            if (hs > as) cumPts[m.strHomeTeam] += 3;
            else if (hs < as) cumPts[m.strAwayTeam] += 3;
            else { cumPts[m.strHomeTeam] += 1; cumPts[m.strAwayTeam] += 1; }
        });
        teamNames.forEach(t => { series[t].push(cumPts[t]); });
    });
    return { rounds, series };
}


/* ============================================================================
 * SEÇÃO 3: FORMATAÇÃO
 * ============================================================================ */

/**
 * Formata data no padrão brasileiro DD/MM/AAAA.
 * @param {Date|string} date
 * @returns {string}
 */
function formatDate(date) {
    if (!date) return '';
    const d = new Date(date);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/**
 * Formata data curta DD/MM (sem ano).
 * @param {Date|string} date
 * @returns {string}
 */
function formatDateShort(date) {
    if (!date) return '';
    const d = new Date(date);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Formata hora no padrão HH:MM pt-BR.
 * @param {Date} date
 * @returns {string}
 */
function formatTime(date) {
    if (!date) return '';
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Formata valor de mercado em EUR para exibição compacta.
 * Ex: 45000000 → "€ 45,0 M", 500000 → "€ 500 mil"
 *
 * @param {number} v - Valor em EUR
 * @returns {string}
 */
function formatMarketValue(v) {
    if (v >= 1000000) return `\u20AC ${(v / 1000000).toFixed(1).replace('.', ',')} M`;
    if (v >= 1000) return `\u20AC ${Math.round(v / 1000)} mil`;
    return `\u20AC ${v}`;
}

function formatMarketValueBRL(v) {
    const brl = v * EUR_TO_BRL;
    if (brl >= 1000000) return `R$ ${(brl / 1000000).toFixed(1).replace('.', ',')} M`;
    if (brl >= 1000) return `R$ ${Math.round(brl / 1000)} mil`;
    return `R$ ${Math.round(brl)}`;
}


/* ============================================================================
 * SEÇÃO 4: FUNÇÕES DE RENDERIZAÇÃO
 * ============================================================================ */

/**
 * Renderiza o header com título, filtros e timestamp.
 *
 * @param {number} latestRound - Última rodada disponível
 * @param {string} selectedTeam - Time selecionado no filtro
 * @param {number} selectedRound - Rodada selecionada
 * @param {Date|null} lastUpdated - Data da última atualização
 * @returns {string} HTML do header
 */
function renderHeader(latestRound, selectedTeam, selectedRound, lastUpdated) {
    const timestamp = lastUpdated
        ? `${formatDate(lastUpdated)} \u00E0s ${formatTime(lastUpdated)}`
        : 'Aguardando dados';

    return `
        <div class="header">
            <div class="header-content">
                <div class="header-title">
                    <h1>\u26BD Brasileir\u00E3o S\u00E9rie A</h1>
                    <span class="subtitle">Temporada ${appState.season} \u2022 Dashboard Interativo</span>
                </div>
                <div class="header-controls">
                    <select class="select-team" id="teamFilter">
                        <option value="Todos os times">Todos os times</option>
                    </select>
                    <button class="theme-toggle" id="themeToggle" title="Alternar tema">${document.documentElement.getAttribute('data-theme') === 'light' ? '\u2600\uFE0F' : '\uD83C\uDF19'}</button>
                </div>
            </div>
            <div class="header-timestamp">Atualizada em ${timestamp}</div>
        </div>
    `;
}

/**
 * Renderiza dois KPI cards globais do campeonato.
 * Sempre os mesmos independente do time selecionado.
 */
function renderKPIs(standings, allMatches) {
    if (!standings || standings.length === 0) {
        return `<div class="kpi-grid kpi-empty-wrapper">
            <div class="kpi-empty">Nenhum dado carregado. Os dados s\u00E3o atualizados automaticamente todos os dias.</div>
        </div>`;
    }

    const kpi = (label, value, detail = '', color = '') =>
        `<div class="kpi-card">
            <div class="kpi-label">${label}</div>
            <div class="kpi-value small">${value}</div>
            ${detail ? `<div class="kpi-detail" style="color:${color || 'var(--text-secondary)'}">${detail}</div>` : ''}
        </div>`;

    const selectedTeam = appState.selectedTeam;

    // ── KPIs por time selecionado ────────────────────────────────
    if (selectedTeam !== 'Todos os times') {
        const t = standings.find(s => s.name === selectedTeam);
        if (!t) return '';

        const maxPts = t.played * 3 || 1;
        const aprov = Math.round(t.points / maxPts * 100);
        const aprovColor = aprov >= 60 ? 'var(--accent-green)' : aprov >= 40 ? 'var(--accent-yellow)' : 'var(--accent-red)';
        const sg = t.goalsFor - t.goalsAgainst;
        const sgStr = sg > 0 ? `+${sg}` : String(sg);
        const sgColor = sg > 0 ? 'var(--accent-green)' : sg < 0 ? 'var(--accent-red)' : 'var(--text-secondary)';

        // Sequência atual
        const sorted = [...t.matches].sort((a, b) => new Date(b.date) - new Date(a.date));
        let streakType = '', streakCount = 0;
        for (const m of sorted) {
            const res = m.score > m.conceded ? 'V' : m.score === m.conceded ? 'E' : 'D';
            if (!streakType) { streakType = res; streakCount = 1; }
            else if (res === streakType) streakCount++;
            else break;
        }
        const streakLabel = streakCount > 0 ? `${streakCount}${streakType}` : '-';
        const streakColor = streakType === 'V' ? 'var(--accent-green)' : streakType === 'D' ? 'var(--accent-red)' : 'var(--accent-yellow)';

        const homePts = t.homeWins * 3 + t.homeDraws;
        const awayPts = t.awayWins * 3 + t.awayDraws;

        return `
            <div class="kpi-grid">
                ${kpi('Pontos', t.points, `${t.played} jogos \u2022 ${t.wins}V ${t.draws}E ${t.losses}D`)}
                ${kpi('Aproveitamento', `${aprov}%`, `${t.points} de ${t.played * 3} poss\u00EDveis`, aprovColor)}
                ${kpi('Posi\u00E7\u00E3o', `${t.position}\u00BA`, `de 20 times`)}
                ${kpi('Sequ\u00EAncia Atual', streakLabel, `\u00FAltimos resultados`, streakColor)}
            </div>
            <div class="kpi-grid" style="margin-top:0">
                ${kpi('Gols', `${t.goalsFor} / ${t.goalsAgainst}`, 'pr\u00F3 / contra')}
                ${kpi('Saldo de Gols', sgStr, `${t.goalsFor} GP \u2022 ${t.goalsAgainst} GC`, sgColor)}
                ${kpi('Casa', `${homePts} pts`, `${t.homeWins}V ${t.homeDraws}E ${t.homeLosses}D`, 'var(--accent-blue)')}
                ${kpi('Fora', `${awayPts} pts`, `${t.awayWins}V ${t.awayDraws}E ${t.awayLosses}D`, 'var(--accent-blue)')}
            </div>
        `;
    }

    // ── KPIs globais da liga ─────────────────────────────────────
    const finished   = allMatches.filter(m => m.intHomeScore !== null && m.intHomeScore !== undefined && m.intHomeScore !== '').length;
    const totalGoals = allMatches.reduce((s, m) =>
        s + (parseInt(m.intHomeScore) || 0) + (parseInt(m.intAwayScore) || 0), 0);
    const avgGoals   = finished > 0 ? (totalGoals / finished).toFixed(2).replace('.', ',') : '0,0';

    const leader      = standings[0];
    const bestAttack  = standings.reduce((max, t) => t.goalsFor > max.goalsFor ? t : max);
    const bestDefense = standings.reduce((min, t) => t.goalsAgainst < min.goalsAgainst ? t : min);

    let bestStreak = { team: '', streak: 0 };
    standings.forEach(team => {
        const sorted = [...team.matches].sort((a, b) => new Date(b.date) - new Date(a.date));
        let streak = 0;
        for (const m of sorted) { if (m.score > m.conceded) streak++; else break; }
        if (streak > bestStreak.streak) bestStreak = { team: team.name, streak };
    });

    const topHomeTeam = standings.reduce((max, t) =>
        (t.homeWins * 3 + t.homeDraws) > (max.homeWins * 3 + max.homeDraws) ? t : max);
    const topAwayTeam = standings.reduce((max, t) =>
        (t.awayWins * 3 + t.awayDraws) > (max.awayWins * 3 + max.awayDraws) ? t : max);

    return `
        <div class="kpi-grid">
            ${kpi('Jogos Realizados', finished, `${totalGoals} gols no total`)}
            ${kpi('M\u00E9dia de Gols', avgGoals, 'por partida')}
            ${kpi('L\u00EDder', leader.name, `${leader.points} pts \u2022 ${leader.played} J`)}
            ${kpi('Maior Sequ\u00EAncia', bestStreak.streak > 0 ? `${bestStreak.streak}V` : '-', bestStreak.team, 'var(--accent-green)')}
        </div>
        <div class="kpi-grid" style="margin-top:0">
            ${kpi('Melhor Ataque', bestAttack.name, `${bestAttack.goalsFor} gols marcados`, 'var(--accent-green)')}
            ${kpi('Melhor Defesa', bestDefense.name, `${bestDefense.goalsAgainst} gols sofridos`, 'var(--accent-green)')}
            ${kpi('Melhor Mandante', topHomeTeam.name, `${topHomeTeam.homeWins * 3 + topHomeTeam.homeDraws} pts em casa`, 'var(--accent-blue)')}
            ${kpi('Melhor Visitante', topAwayTeam.name, `${topAwayTeam.awayWins * 3 + topAwayTeam.awayDraws} pts fora`, 'var(--accent-blue)')}
        </div>
    `;
}

/**
 * Renderiza a tabela de classificação com zonas coloridas (sem bullets).
 * Zonas indicadas apenas pela borda esquerda da linha.
 *
 * @param {Array<TeamStats>} standings - Classificação ordenada
 * @param {Object} teamBadges - Mapa de escudos (não usado, mantido para compatibilidade)
 * @param {string} selectedTeam - Time selecionado para highlight
 * @returns {string} HTML da tabela
 */
function renderStandings(standings, teamBadges, selectedTeam) {
    if (!standings || standings.length === 0) {
        return `<div class="standings-wrapper"><div class="standings-empty">Sem dados dispon\u00EDveis.</div></div>`;
    }

    let html = `<div class="standings-wrapper"><table class="standings-table"><thead><tr>
        <th>#</th><th></th><th>Time</th><th class="th-center">P</th><th class="th-center">J</th><th class="th-center">V</th><th class="th-center">E</th><th class="th-center">D</th><th class="th-center">GP</th><th class="th-center">GC</th><th class="th-center">SG</th><th class="th-center">\u00DAlt. 5</th><th class="th-center">\u00DAltimo</th>
    </tr></thead><tbody>`;

    standings.forEach(team => {
        // Zona de classificação 2026 (apenas classe CSS para borda esquerda)
        let zoneClass = '';
        if (team.position <= 4)       zoneClass = 'zone-libertadores';
        else if (team.position === 5) zoneClass = 'zone-pre-libertadores';
        else if (team.position <= 11) zoneClass = 'zone-sudamericana';
        else if (team.position >= 17) zoneClass = 'zone-rebaixamento';

        const highlighted = selectedTeam !== 'Todos os times' && team.name === selectedTeam
            ? 'highlighted' : '';

        // Últimas 5 partidas (form dots)
        const last5 = [...team.matches]
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 5)
            .reverse();

        let formHtml = '<div class="form-dots">';
        last5.forEach(m => {
            if (m.score > m.conceded)      formHtml += '<div class="form-dot win" title="Vit\u00F3ria"></div>';
            else if (m.score === m.conceded) formHtml += '<div class="form-dot draw" title="Empate"></div>';
            else                            formHtml += '<div class="form-dot loss" title="Derrota"></div>';
        });
        formHtml += '</div>';

        const gd = team.goalsFor - team.goalsAgainst;
        const gdClass = gd >= 0 ? 'positive' : 'negative';
        const lastDate = team.lastMatchDate ? formatDateShort(team.lastMatchDate) : '-';

        html += `<tr class="${zoneClass} ${highlighted}">
            <td class="position-cell">${team.position}</td>
            <td><img src="${team.badge || ''}" alt="${team.name}" class="team-logo" onerror="this.style.display='none'"></td>
            <td class="team-cell"><span class="team-name">${team.name}</span></td>
            <td class="points-cell">${team.points}</td>
            <td class="stat-cell">${team.played}</td>
            <td class="stat-cell">${team.wins}</td>
            <td class="stat-cell">${team.draws}</td>
            <td class="stat-cell">${team.losses}</td>
            <td class="stat-cell">${team.goalsFor}</td>
            <td class="stat-cell">${team.goalsAgainst}</td>
            <td class="goal-diff ${gdClass}">${gd > 0 ? '+' : ''}${gd}</td>
            <td class="stat-cell">${formHtml}</td>
            <td class="last-match-date">${lastDate}</td>
        </tr>`;
    });

    html += `</tbody></table>
        <div class="zone-legend">
            <div class="zone-legend-item"><div class="zone-legend-dot" style="background:var(--zone-lib)"></div><span>Libertadores (1\u20134)</span></div>
            <div class="zone-legend-item"><div class="zone-legend-dot" style="background:var(--zone-pre-lib)"></div><span>Pr\u00E9-Libertadores (5)</span></div>
            <div class="zone-legend-item"><div class="zone-legend-dot" style="background:var(--zone-sul)"></div><span>Sul-Americana (6\u201311)</span></div>
            <div class="zone-legend-item"><div class="zone-legend-dot" style="background:var(--zone-rel)"></div><span>Rebaixamento (17\u201320)</span></div>
        </div></div>`;
    return html;
}



function renderEstatisticasContent() {
    const standings = appState.standings || [];
    const team = appState.selectedTeam;
    const isAll = team === 'Todos os times';
    let html = '';

    if (isAll) {
        // ── KPIs da liga ──────────────────────────────────────────
        const playedMatches = appState.allMatches.filter(m =>
            m.intHomeScore !== null && m.intHomeScore !== undefined && m.intHomeScore !== ''
        );
        const totalGoals = playedMatches.reduce((s, m) =>
            s + (parseInt(m.intHomeScore)||0) + (parseInt(m.intAwayScore)||0), 0);
        const avgGoals = playedMatches.length > 0
            ? (totalGoals / playedMatches.length).toFixed(2) : '—';
        const homeWins = playedMatches.filter(m =>
            (parseInt(m.intHomeScore)||0) > (parseInt(m.intAwayScore)||0)).length;
        const homePct  = playedMatches.length > 0
            ? Math.round(homeWins / playedMatches.length * 100) : 0;
        const latestRound = standings.length > 0
            ? Math.max(...standings.map(t => t.played || 0)) : 0;
        const cleanSheets = playedMatches.filter(m =>
            (parseInt(m.intAwayScore)||0) === 0).length +
            playedMatches.filter(m => (parseInt(m.intHomeScore)||0) === 0).length;

        html += `<div class="kpi-grid" style="margin-bottom:24px">
            <div class="kpi-card">
                <div class="kpi-label">Rodada Atual</div>
                <div class="kpi-value">${latestRound}</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Total de Gols</div>
                <div class="kpi-value">${totalGoals}</div>
                <div class="kpi-detail">${avgGoals} por jogo</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Vitória Mandante</div>
                <div class="kpi-value">${homePct}%</div>
                <div class="kpi-detail">${homeWins} de ${playedMatches.length} jogos</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Clean Sheets</div>
                <div class="kpi-value">${cleanSheets}</div>
                <div class="kpi-detail">Gols sofridos = 0</div>
            </div>
        </div>`;

        // ── Artilheiros + Assistentes ─────────────────────────────
        const playerStats = window.BRASILEIRAO_DATA?.player_stats || [];
        const scorers   = playerStats.filter(p => p.cat === 'goalsLeaders').sort((a,b) => b.goals - a.goals);
        const assisters = playerStats.filter(p => p.cat === 'assistsLeaders').sort((a,b) => b.assists - a.assists);

        const playerTable = (players, valueKey, valueLabel) => {
            if (!players.length) return '<div style="color:var(--text-muted);font-size:12px;padding:8px">Sem dados dispon\u00EDveis.</div>';
            return `<div class="market-table-wrapper"><table class="market-table">
                <thead><tr><th>#</th><th>Jogador</th><th class="th-center">J</th><th class="th-center">${valueLabel}</th></tr></thead>
                <tbody>${players.slice(0,15).map((p,i) => `<tr>
                    <td class="market-rank">${i+1}</td>
                    <td style="font-weight:500">${p.name}</td>
                    <td class="stat-cell">${p.matches}</td>
                    <td style="text-align:center;font-weight:700;color:var(--accent-green)">${p[valueKey]}</td>
                </tr>`).join('')}</tbody>
            </table></div>`;
        };

        html += `<div class="charts-grid" style="margin-bottom:24px">
            <div class="chart-wrapper"><h3 class="chart-title">⚽ Artilheiros</h3>${playerTable(scorers,'goals','Gols')}</div>
            <div class="chart-wrapper"><h3 class="chart-title">🎯 Assistentes</h3>${playerTable(assisters,'assists','Assist.')}</div>
        </div>`;

        // ── Melhor ataque / Melhor defesa ─────────────────────────
        const topAttack  = [...standings].sort((a,b) => b.goalsFor - a.goalsFor).slice(0,8);
        const topDefense = [...standings].sort((a,b) => a.goalsAgainst - b.goalsAgainst).slice(0,8);

        const rankTable = (teams, col, label, colorFn) =>
            `<div class="market-table-wrapper"><table class="market-table">
                <thead><tr><th>#</th><th>Time</th><th class="th-center">J</th><th class="th-center">${label}</th></tr></thead>
                <tbody>${teams.map((t,i) => `<tr>
                    <td class="market-rank">${i+1}</td>
                    <td style="font-weight:500">${t.name}</td>
                    <td class="stat-cell">${t.played}</td>
                    <td style="text-align:center;font-weight:700;color:${colorFn(t)}">${t[col]}</td>
                </tr>`).join('')}</tbody>
            </table></div>`;

        html += `<div class="charts-grid" style="margin-bottom:24px">
            <div class="chart-wrapper">
                <h3 class="chart-title">🔥 Melhor Ataque</h3>
                ${rankTable(topAttack,'goalsFor','GP', t => 'var(--accent-green)')}
            </div>
            <div class="chart-wrapper">
                <h3 class="chart-title">🛡️ Melhor Defesa</h3>
                ${rankTable(topDefense,'goalsAgainst','GC', t => t.goalsAgainst <= 5 ? 'var(--accent-green)' : t.goalsAgainst <= 10 ? 'var(--accent-yellow)' : 'var(--accent-red)')}
            </div>
        </div>`;

    } else {
        // ── Visão específica do time selecionado ──────────────────
        const t = standings.find(s => s.name === team);
        if (!t) return `<div class="historico-empty">Time "${team}" não encontrado nos dados.</div>`;

        const maxPts   = t.played * 3 || 1;
        const aprov    = Math.round(t.points / maxPts * 100);
        const sg       = t.goalsFor - t.goalsAgainst;
        const sgStr    = sg > 0 ? `+${sg}` : String(sg);
        const sgColor  = sg > 0 ? 'var(--accent-green)' : sg < 0 ? 'var(--accent-red)' : 'var(--text-secondary)';
        const aprovColor = aprov >= 60 ? 'var(--accent-green)' : aprov >= 40 ? 'var(--accent-yellow)' : 'var(--accent-red)';

        // Form dots
        const last5 = [...(t.matches||[])].sort((a,b) => new Date(b.date)-new Date(a.date)).slice(0,5).reverse();
        const formDots = last5.map(m => {
            const r = m.score > m.conceded ? 'win' : m.score === m.conceded ? 'draw' : 'loss';
            return `<div class="form-dot ${r}" title="${m.opponent}"></div>`;
        }).join('');

        html += `<div class="kpi-grid" style="margin-bottom:24px">
            <div class="kpi-card">
                <div class="kpi-label">Pontos</div>
                <div class="kpi-value">${t.points}</div>
                <div class="kpi-detail">${t.played} jogos</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Aproveitamento</div>
                <div class="kpi-value" style="color:${aprovColor}">${aprov}%</div>
                <div class="kpi-detail">${t.wins}V ${t.draws}E ${t.losses}D</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Gols</div>
                <div class="kpi-value">${t.goalsFor}<span style="font-size:14px;color:var(--text-muted)"> / ${t.goalsAgainst}</span></div>
                <div class="kpi-detail">Pró / Contra</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-label">Saldo de Gols</div>
                <div class="kpi-value" style="color:${sgColor}">${sgStr}</div>
                <div class="kpi-detail">Posição: ${t.position}º</div>
            </div>
        </div>`;

        // Forma recente
        html += `<div class="charts-grid" style="margin-bottom:24px">
            <div class="chart-wrapper">
                <h3 class="chart-title">Forma Recente — Últimas 5</h3>
                <div style="display:flex;gap:8px;margin-bottom:16px">${formDots}</div>
                <div class="market-table-wrapper"><table class="market-table">
                    <thead><tr><th>Adversário</th><th class="th-center">Placar</th><th class="th-center">Resultado</th></tr></thead>
                    <tbody>${last5.map(m => {
                        const res = m.score > m.conceded ? 'V' : m.score === m.conceded ? 'E' : 'D';
                        const col = m.score > m.conceded ? 'var(--accent-green)' : m.score === m.conceded ? 'var(--accent-yellow)' : 'var(--accent-red)';
                        const where = m.isHome ? '🏠' : '✈️';
                        return `<tr>
                            <td>${where} ${m.opponent}</td>
                            <td class="stat-cell">${m.score} × ${m.conceded}</td>
                            <td style="text-align:center;font-weight:700;color:${col}">${res}</td>
                        </tr>`;
                    }).join('')}
                    </tbody></table></div>
            </div>
            <div class="chart-wrapper">
                <h3 class="chart-title">Casa vs Fora</h3>
                <div class="market-table-wrapper"><table class="market-table">
                    <thead><tr><th>Local</th><th class="th-center">J</th><th class="th-center">V</th><th class="th-center">E</th><th class="th-center">D</th><th class="th-center">GP</th><th class="th-center">GC</th><th class="th-center">Pts</th></tr></thead>
                    <tbody>
                        <tr>
                            <td style="font-weight:600">🏠 Casa</td>
                            <td class="stat-cell">${t.homeWins+t.homeDraws+t.homeLosses}</td>
                            <td class="stat-cell">${t.homeWins}</td>
                            <td class="stat-cell">${t.homeDraws}</td>
                            <td class="stat-cell">${t.homeLosses}</td>
                            <td class="stat-cell">${t.homeGoalsFor}</td>
                            <td class="stat-cell">${t.homeGoalsAgainst}</td>
                            <td class="points-cell">${t.homeWins*3+t.homeDraws}</td>
                        </tr>
                        <tr>
                            <td style="font-weight:600">✈️ Fora</td>
                            <td class="stat-cell">${t.awayWins+t.awayDraws+t.awayLosses}</td>
                            <td class="stat-cell">${t.awayWins}</td>
                            <td class="stat-cell">${t.awayDraws}</td>
                            <td class="stat-cell">${t.awayLosses}</td>
                            <td class="stat-cell">${t.awayGoalsFor}</td>
                            <td class="stat-cell">${t.awayGoalsAgainst}</td>
                            <td class="points-cell">${t.awayWins*3+t.awayDraws}</td>
                        </tr>
                    </tbody></table></div>
            </div>
        </div>`;
    }

    return html;
}

/**
 * Renderiza os gráficos de classificação (gols e aproveitamento).
 * Retorna HTML e dados para inicialização posterior do Chart.js.
 *
 * @param {Array<TeamStats>} standings - Classificação
 * @returns {{ html: string, goalsData: Object, performanceData: Object }}
 */
function renderCharts(standings) {
    const top10 = standings.slice(0, 10);

    const goalsData = {
        labels: top10.map(t => t.name),
        datasets: [
            { label: 'Gols Marcados', data: top10.map(t => t.goalsFor), backgroundColor: '#059669', borderRadius: 4 },
            { label: 'Gols Sofridos', data: top10.map(t => t.goalsAgainst), backgroundColor: '#dc2626', borderRadius: 4 }
        ]
    };

    const performanceData = {
        labels: standings.map(t => t.name),
        datasets: [{
            label: 'Aproveitamento (%)',
            data: standings.map(t => {
                const p = t.played * 3;
                return p > 0 ? Math.round((t.points / p) * 100) : 0;
            }),
            backgroundColor: standings.map(t => {
                const p = t.played * 3;
                const perc = p > 0 ? (t.points / p) * 100 : 0;
                return perc >= 70 ? '#059669' : perc >= 50 ? '#d97706' : '#dc2626';
            }),
            borderRadius: 4
        }]
    };

    // Tabela de forma (últimas 5 para todos os times)
    let formTableHtml = `<div class="chart-wrapper" style="grid-column:1/-1">
        <h3 class="chart-title">Forma Recente \u2014 \u00DAltimas 5 Partidas</h3>
        <div class="form-table">
        <table class="standings-table"><thead><tr>
            <th>#</th><th>Time</th><th class="th-center">P</th><th class="th-center">J</th>
            <th class="th-center">Aprv.</th><th class="th-center">Forma</th>
        </tr></thead><tbody>`;
    standings.forEach(team => {
        const poss  = team.played > 0 ? Math.round(team.points / (team.played * 3) * 100) : 0;
        const color = poss >= 60 ? 'var(--accent-green)' : poss >= 40 ? 'var(--accent-yellow)' : 'var(--accent-red)';
        const last5 = [...team.matches]
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 5).reverse();
        const formDots = last5.map(m => {
            const res = m.score > m.conceded ? 'win' : m.score === m.conceded ? 'draw' : 'loss';
            return `<div class="form-dot ${res}"></div>`;
        }).join('');
        let zone = '';
        if (team.position <= 4)       zone = 'zone-libertadores';
        else if (team.position === 5) zone = 'zone-pre-libertadores';
        else if (team.position <= 11) zone = 'zone-sudamericana';
        else if (team.position >= 17) zone = 'zone-rebaixamento';
        formTableHtml += `<tr class="${zone}">
            <td class="position-cell">${team.position}</td>
            <td class="team-cell"><span class="team-name">${team.name}</span></td>
            <td class="points-cell">${team.points}</td>
            <td class="stat-cell">${team.played}</td>
            <td class="stat-cell" style="font-weight:700;color:${color}">${poss}%</td>
            <td class="stat-cell"><div class="form-dots">${formDots}</div></td>
        </tr>`;
    });
    formTableHtml += `</tbody></table></div></div>`;

    return {
        html: `
        <div class="charts-grid charts-grid--wide">
            ${formTableHtml}
        </div>
        <div class="charts-grid charts-grid--wide">
            <div class="chart-wrapper chart-wrapper--wide"><h3 class="chart-title">Evolu\u00E7\u00E3o de Pontos por Rodada (Top 6)</h3><div class="chart-container chart-container--tall"><canvas id="pointsProgressionChart"></canvas></div></div>
        </div>
        <div class="charts-grid">
            <div class="chart-wrapper"><h3 class="chart-title">Gols por Rodada</h3><div class="chart-container"><canvas id="goalsPerRoundChart"></canvas></div></div>
            <div class="chart-wrapper"><h3 class="chart-title">Resultados: Casa vs Fora</h3><div class="chart-container"><canvas id="homeAwayChart"></canvas></div></div>
        </div>
        <div class="charts-grid">
            <div class="chart-wrapper"><h3 class="chart-title">Gols Marcados vs Sofridos (Top 10)</h3><div class="chart-container"><canvas id="goalsChart"></canvas></div></div>
            <div class="chart-wrapper"><h3 class="chart-title">Performance Casa vs Fora (pts)</h3><div class="chart-container"><canvas id="homeAwayPtsChart"></canvas></div></div>
        </div>`,
        goalsData,
        performanceData
    };
}

/**
 * Renderiza a aba de valores de mercado com KPIs, filtros, tabela e gráficos.
 *
 * @returns {string} HTML completo da aba
 */
function renderMarketValues() {
    const allPlayers = MARKET_VALUES_DATA.players;

    if (!allPlayers || allPlayers.length === 0) {
        return `<div class="market-empty">
            <div class="market-empty-icon">\uD83D\uDCB0</div>
            <div class="market-empty-title">Valores de Mercado</div>
            <div style="font-size:13px">Dados sendo carregados. Em breve!</div>
        </div>`;
    }

    // Aplicar filtro de time do header
    const headerTeam = appState.selectedTeam;
    const players    = headerTeam !== 'Todos os times'
        ? allPlayers.filter(p => p.team === headerTeam)
        : allPlayers;

    if (players.length === 0) {
        return `<div class="market-empty">
            <div class="market-empty-icon">\uD83D\uDD0D</div>
            <div class="market-empty-title">${headerTeam}</div>
            <div style="font-size:13px">Nenhum jogador encontrado para este time no dataset.</div>
        </div>`;
    }

    const sorted = [...players].sort((a, b) => {
        const col = appState.mercadoSort || 'value';
        const dir = appState.mercadoSortDir === 'asc' ? 1 : -1;
        const va = a[col] ?? '';
        const vb = b[col] ?? '';
        if (typeof va === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb), 'pt-BR') * dir;
    });
    const teams = [...new Set(allPlayers.map(p => p.team))].sort();
    const positions = [...new Set(players.map(p => p.position))].sort();

    // KPIs de mercado — dinâmicos com base no filtro
    const mostValuable = [...players].sort((a, b) => b.value - a.value)[0];
    const totalValue = players.reduce((s, p) => s + p.value, 0);
    const avgAge = players.length > 0 ? (players.reduce((s, p) => s + p.age, 0) / players.length).toFixed(1).replace('.', ',') : '-';

    let kpiHtml;
    if (headerTeam !== 'Todos os times') {
        // KPIs do time selecionado
        kpiHtml = `<div class="kpi-grid">
            <div class="kpi-card"><div class="kpi-label">Jogador Mais Valioso</div><div class="kpi-value small">${mostValuable.name}</div><div class="kpi-detail" style="color:var(--accent-green)">${formatMarketValue(mostValuable.value)}</div></div>
            <div class="kpi-card"><div class="kpi-label">Valor do Elenco</div><div class="kpi-value small">${formatMarketValue(totalValue)}</div><div class="kpi-detail">${formatMarketValueBRL(totalValue)}</div></div>
            <div class="kpi-card"><div class="kpi-label">M\u00E9dia de Idade</div><div class="kpi-value">${avgAge}</div><div class="kpi-detail">anos</div></div>
            <div class="kpi-card"><div class="kpi-label">Jogadores</div><div class="kpi-value">${players.length}</div></div>
        </div>`;
    } else {
        // KPIs globais da liga
        const teamValues = {};
        allPlayers.forEach(p => { teamValues[p.team] = (teamValues[p.team] || 0) + p.value; });
        const teamValArr = Object.entries(teamValues).sort((a, b) => b[1] - a[1]);
        const totalLeagueValue = allPlayers.reduce((s, p) => s + p.value, 0);
        kpiHtml = `<div class="kpi-grid">
            <div class="kpi-card"><div class="kpi-label">Jogador Mais Valioso</div><div class="kpi-value small">${mostValuable.name}</div><div class="kpi-detail" style="color:var(--accent-green)">${formatMarketValue(mostValuable.value)} \u2022 ${mostValuable.team}</div></div>
            <div class="kpi-card"><div class="kpi-label">Elenco Mais Valioso</div><div class="kpi-value small">${teamValArr[0][0]}</div><div class="kpi-detail" style="color:var(--accent-green)">${formatMarketValue(teamValArr[0][1])}</div></div>
            <div class="kpi-card"><div class="kpi-label">Valor Total da Liga</div><div class="kpi-value small">${formatMarketValue(totalLeagueValue)}</div></div>
            <div class="kpi-card"><div class="kpi-label">Jogadores Cadastrados</div><div class="kpi-value">${allPlayers.length}</div></div>
        </div>`;
    }
    let html = kpiHtml;

    // Filtros
    html += `<div class="market-controls">
        <input type="text" class="market-search" id="playerSearch" placeholder="Buscar jogador...">
        <select class="market-select" id="positionFilter"><option value="">Todas as posi\u00E7\u00F5es</option>${positions.map(p => `<option value="${p}">${p}</option>`).join('')}</select>
        <select class="market-select" id="marketTeamFilter"><option value="">Todos os times</option>${teams.map(t => `<option value="${t}">${t}</option>`).join('')}</select>
    </div>`;

    // Tabela de jogadores
    html += `<div class="market-table-wrapper"><table class="market-table" id="marketTable"><thead><tr>
        <th>#</th>
        <th class="sort-th" data-col="name">Jogador <span class="sort-icon">↕</span></th>
        <th class="sort-th th-center" data-col="team">Time <span class="sort-icon">↕</span></th>
        <th class="sort-th th-center" data-col="position">Pos <span class="sort-icon">↕</span></th>
        <th class="sort-th th-center" data-col="age">Idade <span class="sort-icon">↕</span></th>
        <th class="sort-th th-center" data-col="value">Valor (EUR) <span class="sort-icon">↕</span></th>
        <th class="th-center">Valor (BRL)</th>
    </tr></thead><tbody>`;

    sorted.forEach((p, i) => {
        html += `<tr data-name="${p.name.toLowerCase()}" data-team="${p.team}" data-position="${p.position}">
            <td class="market-rank">${i + 1}</td>
            <td style="font-weight:500">${p.name}</td>
            <td class="stat-cell">${p.team}</td>
            <td class="stat-cell"><span class="market-position-badge">${p.position}</span></td>
            <td class="stat-cell">${p.age}</td>
            <td class="market-value-cell">${formatMarketValue(p.value)}</td>
            <td class="market-value-brl">${formatMarketValueBRL(p.value)}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
    const rateNote = MARKET_VALUES_DATA.eur_brl_rate
        ? `C\u00E2mbio EUR/BRL: R$ ${MARKET_VALUES_DATA.eur_brl_rate.toFixed(2)}`
        : `C\u00E2mbio fixo: R$ ${EUR_TO_BRL.toFixed(2)}`;
    html += `<div class="market-source">Fonte: ${MARKET_VALUES_DATA.source} | Atualizado em ${MARKET_VALUES_DATA.last_updated || MARKET_VALUES_DATA.lastUpdated} | ${rateNote}</div>`;

    // Gráficos
    html += `<div class="market-grid" style="margin-top:24px">
        <div class="chart-wrapper"><h3 class="chart-title">Valor do Elenco por Time</h3><div class="chart-container"><canvas id="teamValuesChart"></canvas></div></div>
        <div class="chart-wrapper"><h3 class="chart-title">Distribui\u00E7\u00E3o por Posi\u00E7\u00E3o</h3><div class="chart-container"><canvas id="positionValuesChart"></canvas></div></div>
    </div>`;

    return html;
}

/**
 * Renderiza a aba dedicada de um time selecionado.
 * Inclui: header do time, KPIs, elenco, resultados, casa/fora, próximos jogos, gráfico evolução.
 */
function renderTimeContent() {
    const teamName = appState.selectedTeam;
    if (teamName === 'Todos os times') return '';

    const standings = appState.standings || [];
    const t = standings.find(s => s.name === teamName);
    if (!t) return `<div class="historico-empty">Time "${teamName}" n\u00E3o encontrado.</div>`;

    let html = '';

    // ── A. Header do time ────────────────────────────────────────
    let zoneName = '', zoneColor = '';
    if (t.position <= 4)       { zoneName = 'Libertadores'; zoneColor = 'var(--zone-lib)'; }
    else if (t.position === 5) { zoneName = 'Pr\u00E9-Libertadores'; zoneColor = 'var(--zone-pre-lib)'; }
    else if (t.position <= 11) { zoneName = 'Sul-Americana'; zoneColor = 'var(--zone-sul)'; }
    else if (t.position >= 17) { zoneName = 'Rebaixamento'; zoneColor = 'var(--zone-rel)'; }
    else                       { zoneName = 'Meio da tabela'; zoneColor = 'var(--text-muted)'; }

    html += `<div class="time-header">
        <div class="time-header-info">
            <img src="${t.badge || ''}" alt="${t.name}" class="time-header-badge" onerror="this.style.display='none'">
            <div>
                <h2 class="time-header-name">${t.name}</h2>
                <div class="time-header-meta">
                    <span class="time-position-badge" style="background:${zoneColor}">${t.position}\u00BA</span>
                    <span style="color:${zoneColor}">${zoneName}</span>
                </div>
            </div>
        </div>
        <button class="time-voltar" id="timeVoltarBtn">\u2190 Voltar</button>
    </div>`;

    // ── B. KPIs do time ──────────────────────────────────────────
    const maxPts    = t.played * 3 || 1;
    const aprov     = Math.round(t.points / maxPts * 100);
    const sg        = t.goalsFor - t.goalsAgainst;
    const sgStr     = sg > 0 ? `+${sg}` : String(sg);
    const sgColor   = sg > 0 ? 'var(--accent-green)' : sg < 0 ? 'var(--accent-red)' : 'var(--text-secondary)';
    const aprovColor = aprov >= 60 ? 'var(--accent-green)' : aprov >= 40 ? 'var(--accent-yellow)' : 'var(--accent-red)';

    html += `<div class="kpi-grid" style="margin-bottom:24px">
        <div class="kpi-card"><div class="kpi-label">Pontos</div><div class="kpi-value">${t.points}</div><div class="kpi-detail">${t.played} jogos</div></div>
        <div class="kpi-card"><div class="kpi-label">Aproveitamento</div><div class="kpi-value" style="color:${aprovColor}">${aprov}%</div><div class="kpi-detail">${t.wins}V ${t.draws}E ${t.losses}D</div></div>
        <div class="kpi-card"><div class="kpi-label">Gols</div><div class="kpi-value">${t.goalsFor}<span style="font-size:14px;color:var(--text-muted)"> / ${t.goalsAgainst}</span></div><div class="kpi-detail">Pr\u00F3 / Contra</div></div>
        <div class="kpi-card"><div class="kpi-label">Saldo de Gols</div><div class="kpi-value" style="color:${sgColor}">${sgStr}</div><div class="kpi-detail">Posi\u00E7\u00E3o: ${t.position}\u00BA</div></div>
    </div>`;

    // ── C. Gráfico de Gols por Jogo ────────────────────────────────
    html += `<div class="charts-grid" style="margin-bottom:24px">
        <div class="chart-wrapper" style="grid-column:1/-1">
            <h3 class="chart-title">Gols por Jogo</h3>
            <div class="chart-container"><canvas id="timeGoalsPerMatchChart"></canvas></div>
        </div>
    </div>`;

    // ── D. Resultados (todos os jogos disputados) ────────────────
    const allMatchesForTeam = appState.allMatches.filter(m =>
        (m.strHomeTeam === teamName || m.strAwayTeam === teamName)
        && m.intHomeScore !== null && m.intHomeScore !== undefined && m.intHomeScore !== ''
    ).sort((a, b) => parseInt(a.intRound) - parseInt(b.intRound));

    if (allMatchesForTeam.length > 0) {
        html += `<h3 class="section-title">Resultados</h3>`;
        html += `<div class="charts-grid" style="margin-bottom:24px">
            <div class="chart-wrapper" style="grid-column:1/-1">
                <div class="market-table-wrapper"><table class="market-table">
                    <thead><tr><th class="th-center">R</th><th class="th-center">Data</th><th>Advers\u00E1rio</th><th class="th-center">Local</th><th class="th-center">Placar</th><th class="th-center">Res.</th></tr></thead>
                    <tbody>${allMatchesForTeam.map(m => {
                        const isHome = m.strHomeTeam === teamName;
                        const opponent = isHome ? m.strAwayTeam : m.strHomeTeam;
                        const opBadge = isHome ? m.strAwayTeamBadge : m.strHomeTeamBadge;
                        const hs = parseInt(m.intHomeScore) || 0;
                        const as = parseInt(m.intAwayScore) || 0;
                        const teamGoals = isHome ? hs : as;
                        const oppGoals = isHome ? as : hs;
                        const res = teamGoals > oppGoals ? 'V' : teamGoals === oppGoals ? 'E' : 'D';
                        const resColor = res === 'V' ? 'var(--accent-green)' : res === 'E' ? 'var(--accent-yellow)' : 'var(--accent-red)';
                        const where = isHome ? '\uD83C\uDFE0' : '\u2708\uFE0F';
                        return `<tr>
                            <td class="stat-cell">${m.intRound}</td>
                            <td class="stat-cell">${formatDateShort(m.dateEvent)}</td>
                            <td><div style="display:flex;align-items:center;gap:6px"><img src="${opBadge || ''}" class="team-logo" onerror="this.style.display='none'"><span>${opponent}</span></div></td>
                            <td class="stat-cell">${where}</td>
                            <td class="stat-cell" style="font-weight:600">${teamGoals} \u00D7 ${oppGoals}</td>
                            <td style="text-align:center;font-weight:700;color:${resColor}">${res}</td>
                        </tr>`;
                    }).join('')}</tbody>
                </table></div>
            </div>
        </div>`;
    }

    // ── E. Casa vs Fora ──────────────────────────────────────────
    html += `<div class="charts-grid" style="margin-bottom:24px">
        <div class="chart-wrapper">
            <h3 class="chart-title">Casa vs Fora</h3>
            <div class="market-table-wrapper"><table class="market-table">
                <thead><tr><th>Local</th><th class="th-center">J</th><th class="th-center">V</th><th class="th-center">E</th><th class="th-center">D</th><th class="th-center">GP</th><th class="th-center">GC</th><th class="th-center">Pts</th></tr></thead>
                <tbody>
                    <tr>
                        <td style="font-weight:600">\uD83C\uDFE0 Casa</td>
                        <td class="stat-cell">${t.homeWins+t.homeDraws+t.homeLosses}</td>
                        <td class="stat-cell">${t.homeWins}</td>
                        <td class="stat-cell">${t.homeDraws}</td>
                        <td class="stat-cell">${t.homeLosses}</td>
                        <td class="stat-cell">${t.homeGoalsFor}</td>
                        <td class="stat-cell">${t.homeGoalsAgainst}</td>
                        <td class="points-cell">${t.homeWins*3+t.homeDraws}</td>
                    </tr>
                    <tr>
                        <td style="font-weight:600">\u2708\uFE0F Fora</td>
                        <td class="stat-cell">${t.awayWins+t.awayDraws+t.awayLosses}</td>
                        <td class="stat-cell">${t.awayWins}</td>
                        <td class="stat-cell">${t.awayDraws}</td>
                        <td class="stat-cell">${t.awayLosses}</td>
                        <td class="stat-cell">${t.awayGoalsFor}</td>
                        <td class="stat-cell">${t.awayGoalsAgainst}</td>
                        <td class="points-cell">${t.awayWins*3+t.awayDraws}</td>
                    </tr>
                </tbody></table></div>
        </div>
        <div class="chart-wrapper">
            <h3 class="chart-title">Evolu\u00E7\u00E3o de Pontos</h3>
            <div class="chart-container chart-container--tall"><canvas id="timePointsChart"></canvas></div>
        </div>
    </div>`;

    // ── F. Próximos jogos ────────────────────────────────────────
    html += renderProximosJogos(appState.allMatches, teamName);

    return html;
}

/**
 * Inicializa os gráficos da aba Time (evolução de pontos + gols por jogo).
 */
function initTimeChart() {
    // Gráfico de gols por jogo
    const goalsCtx = document.getElementById('timeGoalsPerMatchChart');
    if (goalsCtx && !goalsCtx._chartInit) {
        goalsCtx._chartInit = true;
        const teamName = appState.selectedTeam;
        const matches = appState.allMatches.filter(m =>
            (m.strHomeTeam === teamName || m.strAwayTeam === teamName)
            && m.intHomeScore !== null && m.intHomeScore !== undefined && m.intHomeScore !== ''
        ).sort((a, b) => parseInt(a.intRound) - parseInt(b.intRound));

        const labels = matches.map(m => `R${m.intRound}`);
        const goalsFor = matches.map(m => {
            const isHome = m.strHomeTeam === teamName;
            return isHome ? parseInt(m.intHomeScore) || 0 : parseInt(m.intAwayScore) || 0;
        });
        const goalsAgainst = matches.map(m => {
            const isHome = m.strHomeTeam === teamName;
            return isHome ? parseInt(m.intAwayScore) || 0 : parseInt(m.intHomeScore) || 0;
        });

        appState.chartInstances.push(new Chart(goalsCtx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    { label: 'Gols Marcados', data: goalsFor, backgroundColor: '#10b981', borderRadius: 3 },
                    { label: 'Gols Sofridos', data: goalsAgainst, backgroundColor: '#ef4444', borderRadius: 3 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { labels: { color: '#8b949e', font: { family: "'Inter'", size: 11 } } } },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#8b949e', font: { size: 10 } } },
                    y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 } }, beginAtZero: true }
                }
            }
        }));
    }

    // Gráfico de evolução de pontos
    const ctx = document.getElementById('timePointsChart');
    if (!ctx || ctx._chartInit) return;
    ctx._chartInit = true;

    const teamName = appState.selectedTeam;
    const standings = appState.standings || [];
    const leader = standings[0];
    if (!leader) return;

    const { rounds, series } = buildPointsProgression(appState.allMatches);
    const teamSeries = series[teamName] || [];
    const leaderSeries = series[leader.name] || [];

    appState.chartInstances.push(new Chart(ctx, {
        type: 'line',
        data: {
            labels: rounds.map(r => `R${r}`),
            datasets: [
                {
                    label: teamName,
                    data: teamSeries,
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16,185,129,0.1)',
                    borderWidth: 2.5,
                    pointRadius: 4,
                    pointBackgroundColor: '#10b981',
                    fill: true,
                    tension: 0.3,
                },
                ...(leader.name !== teamName ? [{
                    label: `${leader.name} (L\u00EDder)`,
                    data: leaderSeries,
                    borderColor: '#6b7280',
                    borderWidth: 1.5,
                    borderDash: [5, 3],
                    pointRadius: 2,
                    pointBackgroundColor: '#6b7280',
                    fill: false,
                    tension: 0.3,
                }] : [])
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { font: { family: "'Inter', sans-serif", size: 11 }, color: '#8b949e' } }
            },
            scales: {
                x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 } } },
                y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 } }, beginAtZero: true }
            }
        }
    }));
}

/**
 * Renderiza seção de próximos jogos agendados.
 */
function renderProximosJogos(allMatches, selectedTeam) {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    let proximos = allMatches.filter(m =>
        (m.intHomeScore === null || m.intHomeScore === undefined || m.intHomeScore === '')
        && new Date(m.dateEvent + 'T23:59:59') >= hoje
    );

    if (selectedTeam !== 'Todos os times') {
        proximos = proximos.filter(m =>
            m.strHomeTeam === selectedTeam || m.strAwayTeam === selectedTeam
        );
    }

    proximos.sort((a, b) => new Date(a.dateEvent) - new Date(b.dateEvent));
    proximos = proximos.slice(0, 10);

    if (proximos.length === 0) return '';

    let html = '<h3 class="section-title">Pr\u00F3ximos Jogos</h3><div class="rodada-wrapper"><div class="rodada-list">';
    proximos.forEach(m => {
        const rodada = m.intRound ? `R${m.intRound}` : '';
        const data = formatDateShort(m.dateEvent);
        html += `<div class="rodada-match">
            <div class="rodada-team rodada-team--home">
                <span>${m.strHomeTeam}</span>
                <img src="${m.strHomeTeamBadge || ''}" alt="" class="team-logo" onerror="this.style.display='none'">
            </div>
            <span class="rodada-date">${rodada} \u2022 ${data}</span>
            <div class="rodada-team rodada-team--away">
                <img src="${m.strAwayTeamBadge || ''}" alt="" class="team-logo" onerror="this.style.display='none'">
                <span>${m.strAwayTeam}</span>
            </div>
        </div>`;
    });
    html += '</div></div>';
    return html;
}


/**
 * Renderiza resultados de uma rodada específica.
 */
function renderResultadosRodada(allMatches, latestRound) {
    const played = allMatches.filter(m =>
        m.intHomeScore !== null && m.intHomeScore !== undefined && m.intHomeScore !== ''
    );
    if (played.length === 0) return '';

    const rounds = [...new Set(played.map(m => parseInt(m.intRound)))].sort((a, b) => a - b);
    const currentRound = latestRound || rounds[rounds.length - 1];

    let options = rounds.map(r =>
        `<option value="${r}" ${r === currentRound ? 'selected' : ''}>Rodada ${r}</option>`
    ).join('');

    const roundMatches = allMatches.filter(m => parseInt(m.intRound) === currentRound);

    let matchesHtml = '';
    roundMatches.forEach(m => {
        const hs = m.intHomeScore !== null && m.intHomeScore !== '' ? parseInt(m.intHomeScore) : null;
        const as_ = m.intAwayScore !== null && m.intAwayScore !== '' ? parseInt(m.intAwayScore) : null;
        const played_ = hs !== null;
        const scoreHtml = played_
            ? `<span class="rodada-score">${hs} \u2013 ${as_}</span>`
            : `<span class="rodada-date">${formatDateShort(m.dateEvent)}</span>`;

        matchesHtml += `<div class="rodada-match">
            <div class="rodada-team rodada-team--home">
                <span>${m.strHomeTeam}</span>
                <img src="${m.strHomeTeamBadge || ''}" class="team-logo" onerror="this.style.display='none'">
            </div>
            ${scoreHtml}
            <div class="rodada-team rodada-team--away">
                <img src="${m.strAwayTeamBadge || ''}" class="team-logo" onerror="this.style.display='none'">
                <span>${m.strAwayTeam}</span>
            </div>
        </div>`;
    });

    return `<h3 class="section-title" style="display:flex;align-items:center;gap:12px">
        Resultados
        <select class="select-team" id="roundSelector" style="font-size:12px;padding:4px 8px">${options}</select>
    </h3>
    <div class="rodada-wrapper"><div class="rodada-list">${matchesHtml}</div></div>`;
}

/**
 * Renderiza ranking de aproveitamento com barras visuais.
 */
function renderRankingAproveitamento(standings) {
    if (!standings || standings.length === 0) return '';

    const sorted = [...standings].sort((a, b) => {
        const pa = a.played > 0 ? a.points / (a.played * 3) : 0;
        const pb = b.played > 0 ? b.points / (b.played * 3) : 0;
        return pb - pa;
    });

    let rows = sorted.map((t, i) => {
        const pct = t.played > 0 ? Math.round(t.points / (t.played * 3) * 100) : 0;
        const color = pct >= 60 ? 'var(--accent-green)' : pct >= 40 ? 'var(--accent-yellow)' : 'var(--accent-red)';
        return `<tr>
            <td class="position-cell">${i + 1}</td>
            <td class="team-cell"><span class="team-name">${t.name}</span></td>
            <td class="stat-cell">${t.played}</td>
            <td class="stat-cell">${t.points}</td>
            <td class="stat-cell" style="min-width:120px">
                <div style="display:flex;align-items:center;gap:8px">
                    <div style="flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden">
                        <div style="width:${pct}%;height:100%;background:${color};border-radius:3px"></div>
                    </div>
                    <span style="font-weight:700;color:${color};min-width:36px;text-align:right">${pct}%</span>
                </div>
            </td>
        </tr>`;
    }).join('');

    return `<div class="chart-wrapper" style="grid-column:1/-1">
        <h3 class="chart-title">Ranking de Aproveitamento</h3>
        <div class="market-table-wrapper"><table class="standings-table">
            <thead><tr><th>#</th><th>Time</th><th class="th-center">J</th><th class="th-center">P</th><th class="th-center">Aproveitamento</th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div>
    </div>`;
}

/**
 * Renderiza heatmap de resultados (rodada × time).
 */
function renderHeatmap(standings, allMatches) {
    if (!standings || standings.length === 0) return '';

    const played = allMatches.filter(m =>
        m.intHomeScore !== null && m.intHomeScore !== undefined && m.intHomeScore !== ''
    );
    const rounds = [...new Set(played.map(m => parseInt(m.intRound)))].sort((a, b) => a - b);
    if (rounds.length === 0) return '';

    // Build result map: team -> round -> {result, opponent, score}
    const resultMap = {};
    standings.forEach(t => { resultMap[t.name] = {}; });
    played.forEach(m => {
        const r = parseInt(m.intRound);
        const hs = parseInt(m.intHomeScore) || 0;
        const as_ = parseInt(m.intAwayScore) || 0;
        const homeRes = hs > as_ ? 'V' : hs === as_ ? 'E' : 'D';
        const awayRes = hs < as_ ? 'V' : hs === as_ ? 'E' : 'D';
        if (resultMap[m.strHomeTeam]) {
            resultMap[m.strHomeTeam][r] = { res: homeRes, opp: m.strAwayTeam, score: `${hs}-${as_}` };
        }
        if (resultMap[m.strAwayTeam]) {
            resultMap[m.strAwayTeam][r] = { res: awayRes, opp: m.strHomeTeam, score: `${as_}-${hs}` };
        }
    });

    let headerCells = rounds.map(r => `<th class="heatmap-th">${r}</th>`).join('');
    let bodyRows = standings.map(t => {
        let cells = rounds.map(r => {
            const d = resultMap[t.name][r];
            if (!d) return '<td class="heatmap-cell"></td>';
            const cls = d.res === 'V' ? 'heatmap-win' : d.res === 'E' ? 'heatmap-draw' : 'heatmap-loss';
            return `<td class="heatmap-cell ${cls}" title="${t.name} ${d.score} ${d.opp}">${d.res}</td>`;
        }).join('');
        return `<tr><td class="heatmap-team">${t.name}</td>${cells}</tr>`;
    }).join('');

    return `<div class="chart-wrapper" style="grid-column:1/-1">
        <h3 class="chart-title">Mapa de Resultados</h3>
        <div class="heatmap-wrapper"><table class="heatmap-table">
            <thead><tr><th class="heatmap-team-th">Time</th>${headerCells}</tr></thead>
            <tbody>${bodyRows}</tbody>
        </table></div>
    </div>`;
}

/** Renderiza tela de carregamento */
function renderLoading() {
    return '<div class="loading-container"><div class="spinner"></div><div class="loading-text">Carregando dados do Brasileir\u00E3o...</div></div>';
}

/**
 * Renderiza tela de erro com botão de retry.
 * @param {string} message - Mensagem de erro
 */
function renderError(message) {
    return `<div class="error-container"><div class="error-message">
        <div class="error-icon">\u26A0\uFE0F</div>
        <div class="error-title">Erro ao Carregar Dados</div>
        <div class="error-text">${message}</div>
        <button class="btn-retry" id="retryBtn">Tentar Novamente</button>
    </div></div>`;
}


/* ============================================================================
 * SEÇÃO 5: INICIALIZAÇÃO DE GRÁFICOS
 * ============================================================================ */

/**
 * Configuração base compartilhada por todos os gráficos Chart.js.
 * @type {Object}
 */
const BASE_CHART_OPTIONS = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: {
            labels: {
                font: { family: "'Inter', sans-serif", size: 11 },
                color: '#8b949e'
            }
        }
    },
    scales: {
        x: {
            grid: { color: '#21262d', drawBorder: false },
            ticks: { color: '#8b949e', font: { family: "'Inter', sans-serif", size: 10 } }
        },
        y: {
            grid: { display: false },
            ticks: { color: '#8b949e', font: { family: "'Inter', sans-serif", size: 10 } }
        }
    }
};

/**
 * Inicializa os gráficos da aba de valores de mercado.
 * Usa flag _chartInit no canvas para evitar duplicação.
 */
function initMarketCharts() {
    const players = MARKET_VALUES_DATA.players;
    if (!players || players.length === 0) return;

    // Valor por time
    const teamValues = {};
    players.forEach(p => { teamValues[p.team] = (teamValues[p.team] || 0) + p.value; });
    const teamValArr = Object.entries(teamValues).sort((a, b) => b[1] - a[1]);

    // Valor por posição
    const posValues = {};
    players.forEach(p => { posValues[p.position] = (posValues[p.position] || 0) + p.value; });
    const posValArr = Object.entries(posValues).sort((a, b) => b[1] - a[1]);

    const tvCtx = document.getElementById('teamValuesChart');
    if (tvCtx && !tvCtx._chartInit) {
        tvCtx._chartInit = true;
        appState.chartInstances.push(new Chart(tvCtx, {
            type: 'bar',
            data: {
                labels: teamValArr.map(t => t[0]),
                datasets: [{ data: teamValArr.map(t => t[1]), backgroundColor: '#059669', borderRadius: 4 }]
            },
            options: {
                ...BASE_CHART_OPTIONS,
                plugins: { legend: { display: false } },
                scales: {
                    ...BASE_CHART_OPTIONS.scales,
                    x: {
                        ...BASE_CHART_OPTIONS.scales.x,
                        ticks: {
                            ...BASE_CHART_OPTIONS.scales.x.ticks,
                            callback: v => v >= 1e6 ? (v / 1e6).toFixed(0) + 'M' : v
                        }
                    }
                }
            }
        }));
    }

    const pvCtx = document.getElementById('positionValuesChart');
    if (pvCtx && !pvCtx._chartInit) {
        pvCtx._chartInit = true;
        const colors = ['#059669', '#2563eb', '#d97706', '#dc2626', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1'];
        appState.chartInstances.push(new Chart(pvCtx, {
            type: 'doughnut',
            data: {
                labels: posValArr.map(p => p[0]),
                datasets: [{ data: posValArr.map(p => p[1]), backgroundColor: colors.slice(0, posValArr.length) }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: { font: { family: "'Inter', sans-serif", size: 11 }, color: '#8b949e' }
                    }
                }
            }
        }));
    }
}


/* ============================================================================
 * SEÇÃO 6: RENDER PRINCIPAL E EVENT LISTENERS
 * ============================================================================ */

/**
 * Anexa listeners de ordenação e filtro à tabela do Mercado.
 * Pode ser chamada após render() e ao trocar de aba.
 */
function attachMercadoSortListeners() {
    const playerSearch = document.getElementById('playerSearch');
    const posFilter    = document.getElementById('positionFilter');
    const mktTeamFilter = document.getElementById('marketTeamFilter');

    if (playerSearch) {
        const filterMarket = () => {
            const query = playerSearch.value.toLowerCase();
            const pos   = posFilter.value;
            const team  = mktTeamFilter.value;
            document.querySelectorAll('#marketTable tbody tr').forEach(tr => {
                const nameMatch = !query || tr.dataset.name.includes(query);
                const posMatch  = !pos  || tr.dataset.position === pos;
                const teamMatch = !team || tr.dataset.team === team;
                tr.style.display = (nameMatch && posMatch && teamMatch) ? '' : 'none';
            });
        };
        playerSearch.addEventListener('input', filterMarket);
        posFilter.addEventListener('change', filterMarket);
        mktTeamFilter.addEventListener('change', filterMarket);
    }

    document.querySelectorAll('.sort-th').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (appState.mercadoSort === col) {
                appState.mercadoSortDir = appState.mercadoSortDir === 'desc' ? 'asc' : 'desc';
            } else {
                appState.mercadoSort    = col;
                appState.mercadoSortDir = col === 'name' || col === 'team' || col === 'position' ? 'asc' : 'desc';
            }
            const tabDiv = document.getElementById('tab-mercado');
            if (tabDiv) {
                tabDiv.innerHTML = renderMarketValues();
                attachMercadoSortListeners();
            }
        });
    });
}

/**
 * Função principal de renderização.
 * Monta todo o HTML do dashboard, injeta no DOM e configura event listeners.
 * Chamada após carregamento de dados e ao mudar filtros.
 */
function render() {
    const appDiv = document.getElementById('app');
    const { selectedTeam, selectedRound: selRound, activeTab } = appState;
    const selectedRound = selRound || 1;
    const latestRound = appState.allMatches.length > 0
        ? Math.max(...appState.allMatches.map(m => parseInt(m.intRound)))
        : 1;

    // === MONTAGEM DO HTML ===
    let html = renderHeader(latestRound, selectedTeam, selectedRound, appState.lastUpdated);

    // Tab bar
    const timeLabel = selectedTeam !== 'Todos os times' ? selectedTeam : 'Time';
    html += `<div class="tab-bar"><div class="tab-bar-inner">
        <button class="tab-btn ${activeTab === 'tabela' ? 'active' : ''}" data-tab="tabela">Tabela</button>
        <button class="tab-btn ${activeTab === 'estatisticas' ? 'active' : ''}" data-tab="estatisticas">Estat\u00EDsticas</button>
        <button class="tab-btn ${activeTab === 'mercado' ? 'active' : ''}" data-tab="mercado">Mercado</button>
        <button class="tab-btn ${activeTab === 'time' ? 'active' : ''}" data-tab="time">${timeLabel}</button>
    </div></div>`;

    html += '<div class="container">';

    // Tab: Tabela (KPIs globais + classificação)
    html += `<div class="tab-content ${activeTab === 'tabela' ? 'active' : ''}" id="tab-tabela">`;
    html += renderKPIs(appState.standings, appState.allMatches);
    html += renderProximosJogos(appState.allMatches, appState.selectedTeam);
    html += '<h3 class="section-title">Classifica\u00E7\u00E3o</h3>';
    html += renderStandings(appState.standings, {}, selectedTeam);
    html += renderResultadosRodada(appState.allMatches, appState.selectedRound);
    html += '</div>'; // tab-tabela


    // Tab: Estatísticas (KPIs + artilheiros + gráficos)
    html += `<div class="tab-content ${activeTab === 'estatisticas' ? 'active' : ''}" id="tab-estatisticas">`;
    html += renderEstatisticasContent();
    const chartsRender = renderCharts(appState.standings);
    html += chartsRender.html;
    html += `<div class="charts-grid charts-grid--wide">${renderRankingAproveitamento(appState.standings)}</div>`;
    html += `<div class="charts-grid charts-grid--wide">${renderHeatmap(appState.standings, appState.allMatches)}</div>`;
    html += '</div>'; // tab-estatisticas

    // Tab: Mercado
    html += `<div class="tab-content ${activeTab === 'mercado' ? 'active' : ''}" id="tab-mercado">`;
    html += renderMarketValues();
    html += '</div>';

    // Tab: Time
    html += `<div class="tab-content ${activeTab === 'time' ? 'active' : ''}" id="tab-time">`;
    if (selectedTeam !== 'Todos os times') {
        html += renderTimeContent();
    } else {
        html += `<div class="standings-empty" style="padding:60px 20px">
            <div style="font-size:32px;opacity:0.3;margin-bottom:12px">\uD83C\uDFDF\uFE0F</div>
            <div style="font-size:15px;font-weight:600;color:var(--text-secondary);margin-bottom:6px">Selecione um time</div>
            <div style="font-size:12px;color:var(--text-muted)">Clique em um time na tabela de classifica\u00E7\u00E3o ou use o filtro no topo.</div>
        </div>`;
    }
    html += '</div>';

    html += `<div class="footer">Dados: <a href="https://www.espn.com.br" target="_blank" rel="noopener">ESPN</a> &bull; <a href="https://github.com/dcaribou/transfermarkt-datasets" target="_blank" rel="noopener">Transfermarkt (dcaribou)</a> | Brasileir\u00E3o S\u00E9rie A ${appState.season || 2026}</div>`;
    html += '</div>'; // container

    appDiv.innerHTML = html;

    // === EVENT LISTENERS ===

    // Filtro de time
    const teamSelect = document.getElementById('teamFilter');
    (appState.standings || []).forEach(team => {
        const opt = document.createElement('option');
        opt.value = team.name;
        opt.textContent = team.name;
        teamSelect.appendChild(opt);
    });
    teamSelect.value = appState.selectedTeam;
    teamSelect.addEventListener('change', e => {
        appState.selectedTeam = e.target.value;
        render();
    });



    // Toggle tema
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme') || 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('theme', next);
            themeBtn.textContent = next === 'light' ? '\u2600\uFE0F' : '\uD83C\uDF19';
        });
    }

    // Seletor de rodada
    const roundSelector = document.getElementById('roundSelector');
    if (roundSelector) {
        roundSelector.addEventListener('change', e => {
            const round = parseInt(e.target.value);
            const container = document.querySelector('.rodada-list');
            if (!container) return;
            // Re-render só a seção de rodada
            const matches = appState.allMatches.filter(m => parseInt(m.intRound) === round);
            container.innerHTML = matches.map(m => {
                const hs = m.intHomeScore !== null && m.intHomeScore !== '' ? parseInt(m.intHomeScore) : null;
                const as_ = m.intAwayScore !== null && m.intAwayScore !== '' ? parseInt(m.intAwayScore) : null;
                const played_ = hs !== null;
                const scoreHtml = played_
                    ? `<span class="rodada-score">${hs} \u2013 ${as_}</span>`
                    : `<span class="rodada-date">${formatDateShort(m.dateEvent)}</span>`;
                return `<div class="rodada-match">
                    <div class="rodada-team rodada-team--home"><span>${m.strHomeTeam}</span><img src="${m.strHomeTeamBadge || ''}" class="team-logo" onerror="this.style.display='none'"></div>
                    ${scoreHtml}
                    <div class="rodada-team rodada-team--away"><img src="${m.strAwayTeamBadge || ''}" class="team-logo" onerror="this.style.display='none'"><span>${m.strAwayTeam}</span></div>
                </div>`;
            }).join('');
        });
    }

    // Click em time na tabela → aba Time
    document.querySelectorAll('.standings-table tbody tr').forEach(row => {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
            const nameEl = row.querySelector('.team-name');
            if (nameEl) {
                appState.selectedTeam = nameEl.textContent;
                appState.activeTab = 'time';
                render();
            }
        });
    });

    // Botão voltar na aba Time
    const voltarBtn = document.getElementById('timeVoltarBtn');
    if (voltarBtn) {
        voltarBtn.addEventListener('click', () => {
            appState.selectedTeam = 'Todos os times';
            appState.activeTab = 'tabela';
            render();
        });
    }

    // Troca de abas (sem re-render, apenas toggle de classes)
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            const tab = e.target.dataset.tab;
            appState.activeTab = tab;
            document.querySelectorAll('.tab-btn').forEach(b =>
                b.classList.toggle('active', b.dataset.tab === tab));
            document.querySelectorAll('.tab-content').forEach(c =>
                c.classList.toggle('active', c.id === 'tab-' + tab));
            if (tab === 'mercado') { initMarketCharts(); attachMercadoSortListeners(); }
            if (tab === 'estatisticas') {
                setTimeout(() => initEstatisticasCharts(chartsRender), 50);
            }
            if (tab === 'time') {
                setTimeout(() => initTimeChart(), 50);
            }
        });
    });

    // Filtros e ordenação do Mercado
    attachMercadoSortListeners();

    // === GRÁFICOS ===

    // Destruir instâncias anteriores para evitar memory leak
    appState.chartInstances.forEach(c => c.destroy());
    appState.chartInstances = [];

    // Inicializar gráficos com pequeno delay para garantir que o DOM está pronto
    setTimeout(() => {
        // Somente inicializa charts de estatísticas se a aba estiver ativa
        if (activeTab === 'estatisticas') initEstatisticasCharts(chartsRender);

        // Gráficos de mercado se aba ativa
        if (activeTab === 'mercado') initMarketCharts();

        // Gráfico de evolução na aba Time
        if (activeTab === 'time') initTimeChart();
    }, 100);
}

/**
 * Inicializa os gráficos da aba Estatísticas.
 * Separado do render() para poder ser chamado ao trocar de aba.
 */
function initEstatisticasCharts(chartsRender) {
    const goalsCtx = document.getElementById('goalsChart');
        if (goalsCtx) {
            appState.chartInstances.push(new Chart(goalsCtx, {
                type: 'bar',
                data: chartsRender.goalsData,
                options: BASE_CHART_OPTIONS
            }));
        }

        const perfCtx = document.getElementById('performanceChart');
        if (perfCtx) {
            appState.chartInstances.push(new Chart(perfCtx, {
                type: 'bar',
                data: chartsRender.performanceData,
                options: {
                    ...BASE_CHART_OPTIONS,
                    plugins: { legend: { display: false } },
                    scales: {
                        ...BASE_CHART_OPTIONS.scales,
                        x: { ...BASE_CHART_OPTIONS.scales.x, max: 100 }
                    }
                }
            }));
        }

        // Evolução de pontos
        const ppCtx = document.getElementById('pointsProgressionChart');
        if (ppCtx && !ppCtx._chartInit && appState.allMatches.length > 0) {
            ppCtx._chartInit = true;
            const filtered = getFilteredMatches();
            const { rounds, series } = buildPointsProgression(filtered);
            const top6 = (appState.standings || []).slice(0, 6).map(t => t.name);
            const colors = ['#059669','#2563eb','#d97706','#dc2626','#8b5cf6','#ec4899'];
            appState.chartInstances.push(new Chart(ppCtx, {
                type: 'line',
                data: {
                    labels: rounds.map(r => `R${r}`),
                    datasets: top6.map((name, i) => ({
                        label: name,
                        data: series[name] || [],
                        borderColor: colors[i],
                        backgroundColor: colors[i] + '22',
                        borderWidth: 2,
                        pointRadius: 3,
                        tension: 0.3,
                        fill: false,
                    }))
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { labels: { font: { family: "'Inter',sans-serif", size: 11 }, color: '#8b949e' } } },
                    scales: {
                        x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 } } },
                        y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 } }, beginAtZero: true }
                    }
                }
            }));
        }

        // Gols por rodada
        const gprCtx = document.getElementById('goalsPerRoundChart');
        if (gprCtx && !gprCtx._chartInit && appState.allMatches.length > 0) {
            gprCtx._chartInit = true;
            const filtered = getFilteredMatches();
            const rounds = [...new Set(filtered.map(m => parseInt(m.intRound)))].sort((a,b) => a-b);
            const goalsPerRound = rounds.map(r =>
                filtered.filter(m => parseInt(m.intRound) === r)
                    .reduce((s, m) => s + (parseInt(m.intHomeScore)||0) + (parseInt(m.intAwayScore)||0), 0)
            );
            appState.chartInstances.push(new Chart(gprCtx, {
                type: 'bar',
                data: {
                    labels: rounds.map(r => `R${r}`),
                    datasets: [{ label: 'Gols', data: goalsPerRound, backgroundColor: '#059669', borderRadius: 4 }]
                },
                options: { ...BASE_CHART_OPTIONS, indexAxis: 'x', plugins: { legend: { display: false } } }
            }));
        }

        // Casa vs Fora
        const haCtx = document.getElementById('homeAwayChart');
        if (haCtx && !haCtx._chartInit && appState.allMatches.length > 0) {
            haCtx._chartInit = true;
            const filtered = getFilteredMatches();
            const homeW = filtered.filter(m => (parseInt(m.intHomeScore)||0) > (parseInt(m.intAwayScore)||0)).length;
            const draws = filtered.filter(m => (parseInt(m.intHomeScore)||0) === (parseInt(m.intAwayScore)||0)).length;
            const awayW = filtered.filter(m => (parseInt(m.intHomeScore)||0) < (parseInt(m.intAwayScore)||0)).length;
            appState.chartInstances.push(new Chart(haCtx, {
                type: 'doughnut',
                data: {
                    labels: [`Vitória Mandante (${homeW})`, `Empate (${draws})`, `Vitória Visitante (${awayW})`],
                    datasets: [{ data: [homeW, draws, awayW], backgroundColor: ['#059669','#d97706','#2563eb'] }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { font: { family: "'Inter',sans-serif", size: 11 }, color: '#8b949e' } } }
                }
            }));
        }

        // Performance casa vs fora (pts) — top 10
        const hapCtx = document.getElementById('homeAwayPtsChart');
        if (hapCtx && !hapCtx._chartInit && (appState.standings || []).length > 0) {
            hapCtx._chartInit = true;
            const top10 = (appState.standings || []).slice(0, 10);
            appState.chartInstances.push(new Chart(hapCtx, {
                type: 'bar',
                data: {
                    labels: top10.map(t => t.name),
                    datasets: [
                        { label: 'Pts Casa', data: top10.map(t => t.homeWins * 3 + t.homeDraws), backgroundColor: '#059669', borderRadius: 3 },
                        { label: 'Pts Fora',  data: top10.map(t => t.awayWins * 3 + t.awayDraws), backgroundColor: '#2563eb', borderRadius: 3 },
                    ]
                },
                options: {
                    ...BASE_CHART_OPTIONS,
                    plugins: { legend: { labels: { font: { family: "'Inter',sans-serif", size: 11 }, color: '#8b949e' } } },
                }
            }));
        }

}




/* ============================================================================
 * SEÇÃO 8: CARREGAMENTO E ATUALIZAÇÃO DE DADOS
 * ============================================================================ */

/**
 * Carrega os JSONs gerados pelos scripts Python e renderiza o dashboard.
 * Exibe tela "sem dados" se os arquivos ainda não existirem.
 */
async function loadData() {
    const appDiv = document.getElementById('app');
    try {
        appDiv.innerHTML = renderLoading();

        const [brRes, mktRes] = await Promise.all([
            fetch(DATA_BRASILEIRAO),
            fetch(DATA_MARKET).catch(() => null),
        ]);

        if (brRes.status === 404 || !brRes.ok) {
            if (IS_STATIC) {
                // GitHub Pages — dados devem existir; mostra estado vazio
                appState.season        = new Date().getFullYear();
                appState.allMatches    = [];
                appState.standings     = [];
                appState.selectedRound = 1;
                appState.lastUpdated   = null;
                window.MARKET_VALUES_DATA = { players: [], source: '', last_updated: '' };
                render();
                return;
            }
            // Local (Flask) — inicia coleta automaticamente
            appDiv.innerHTML = `<div class="loading-container">
                <div class="spinner"></div>
                <div class="loading-text">Buscando dados pela primeira vez&hellip;</div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:8px">Isso pode levar cerca de 30 segundos.</div>
            </div>`;
            startUpdate();
            return;
        }

        const brData = await brRes.json();
        window.BRASILEIRAO_DATA   = brData;
        window.MARKET_VALUES_DATA = (mktRes?.ok)
            ? await mktRes.json()
            : { players: [], source: '', last_updated: '' };

        if (window.MARKET_VALUES_DATA.eur_brl_rate) {
            EUR_TO_BRL = window.MARKET_VALUES_DATA.eur_brl_rate;
        }

        const matches = brData.matches || [];

        appState.season        = brData.season || new Date().getFullYear();
        appState.allMatches    = matches;
        appState.selectedRound = brData.latest_round || 1;
        appState.lastUpdated   = brData.last_updated
            ? new Date(brData.last_updated)
            : new Date();

        if (matches.length > 0) {
            const { standings, teamBadges } = calculateStandings(matches);
            standings.forEach(team => { team.badge = teamBadges[team.name]; });
            appState.standings = standings;
        } else {
            appState.standings = [];
        }

        render();
    } catch (error) {
        console.warn('Dados não encontrados, abrindo dashboard vazio:', error.message);
        appState.season        = new Date().getFullYear();
        appState.allMatches    = [];
        appState.standings     = [];
        appState.selectedRound = 1;
        appState.lastUpdated   = null;
        window.MARKET_VALUES_DATA = { players: [], source: '', last_updated: '' };
        render();
    }
}


/* ============================================================================
 * SEÇÃO 8: PIPELINE DE ATUALIZAÇÃO (SSE)
 * ============================================================================ */

/**
 * Abre o overlay de progresso e inicia a coleta de dados via SSE
 * (endpoint GET /update no servidor Flask).
 */
function startUpdate() {
    const overlay = document.getElementById('updateOverlay');
    overlay.classList.remove('hidden');

    const bar     = document.getElementById('progressBar');
    const pctEl   = document.getElementById('progressPct');
    const msgEl   = document.getElementById('updateMessage');
    const closeBtn = document.getElementById('updateCloseBtn');

    if (IS_STATIC) {
        // GitHub Pages — dados atualizados via GitHub Actions
        bar.style.width      = '100%';
        bar.style.background = 'var(--accent-green)';
        pctEl.textContent    = '✓';
        msgEl.textContent    = 'Dados atualizados automaticamente via GitHub Actions (diariamente às 07h BRT).';
        closeBtn.classList.remove('hidden');
        return;
    }

    bar.style.width      = '0%';
    bar.style.background = 'var(--accent-green)';
    pctEl.textContent    = '0%';
    msgEl.textContent    = 'Iniciando...';
    closeBtn.classList.add('hidden');

    const evtSource = new EventSource('/update');

    evtSource.onmessage = (e) => {
        const data = JSON.parse(e.data);
        const pct  = Math.max(0, data.progress);

        msgEl.textContent    = data.message;
        bar.style.width      = `${pct}%`;
        pctEl.textContent    = `${pct}%`;

        if (data.step === 'done') {
            evtSource.close();
            setTimeout(() => {
                overlay.classList.add('hidden');
                loadData();
            }, 1500);
        }
        if (data.step === 'error') {
            evtSource.close();
            bar.style.background = 'var(--accent-red)';
            closeBtn.classList.remove('hidden');
        }
    };

    evtSource.onerror = () => {
        evtSource.close();
        msgEl.textContent    = 'Erro de conex\u00E3o. O servidor est\u00E1 rodando em localhost:5000?';
        bar.style.background = 'var(--accent-red)';
        closeBtn.classList.remove('hidden');
    };
}

/* ============================================================================
 * INICIALIZAÇÃO
 * ============================================================================ */

// Inicializar tema (claro/escuro)
(function initTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
}());

// Injetar overlay de atualização no body
(function injectUpdateOverlay() {
    const overlay = document.createElement('div');
    overlay.id        = 'updateOverlay';
    overlay.className = 'update-overlay hidden';
    overlay.innerHTML = `
        <div class="update-modal">
            <div class="update-title">\u23F3 Atualizando Dados</div>
            <div class="update-message" id="updateMessage">Iniciando...</div>
            <div class="progress-bar-track">
                <div class="progress-bar" id="progressBar" style="width:0%"></div>
            </div>
            <div class="progress-pct" id="progressPct">0%</div>
            <button class="btn-close hidden" id="updateCloseBtn">Fechar</button>
        </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('updateCloseBtn').addEventListener('click', () => {
        overlay.classList.add('hidden');
    });
}());

loadData();
