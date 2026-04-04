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
    turno:          'todos',
    mandoCampo:     'todos',
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
        : 'Sem dados \u2014 clique em \u21BB Atualizar Dados';

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
                    <select class="select-turno" id="turnoFilter">
                        <option value="todos" ${appState.turno === 'todos' ? 'selected' : ''}>Todos os turnos</option>
                        <option value="primeiro" ${appState.turno === 'primeiro' ? 'selected' : ''}>1\u00BA Turno (R1\u201319)</option>
                        <option value="segundo" ${appState.turno === 'segundo' ? 'selected' : ''}>2\u00BA Turno (R20\u201338)</option>
                    </select>
                    <button class="btn-update" id="updateBtn">\u21BB Atualizar Dados</button>
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
            <div class="kpi-empty">Nenhum dado carregado. Clique em <strong>\u21BB Atualizar Dados</strong> para baixar os dados do Brasileir\u00E3o.</div>
        </div>`;
    }

    const finished   = allMatches.filter(m => m.strStatus === 'Match Finished').length;
    const totalGoals = allMatches.reduce((s, m) =>
        s + (parseInt(m.intHomeScore) || 0) + (parseInt(m.intAwayScore) || 0), 0);
    const avgGoals   = finished > 0 ? (totalGoals / finished).toFixed(2).replace('.', ',') : '0,0';

    const leader      = standings[0];
    const bestAttack  = standings.reduce((max, t) => t.goalsFor > max.goalsFor ? t : max);
    const bestDefense = standings.reduce((min, t) => t.goalsAgainst < min.goalsAgainst ? t : min);
    const mostWins    = standings.reduce((max, t) => t.wins > max.wins ? t : max);

    // Maior sequência de vitórias atual
    let bestStreak = { team: '', streak: 0 };
    standings.forEach(team => {
        const sorted = [...team.matches].sort((a, b) => new Date(b.date) - new Date(a.date));
        let streak = 0;
        for (const m of sorted) { if (m.score > m.conceded) streak++; else break; }
        if (streak > bestStreak.streak) bestStreak = { team: team.name, streak };
    });

    // Times com mais empates e mais derrotas
    const mostDraws  = standings.reduce((max, t) => t.draws > max.draws ? t : max);
    const topHomeTeam = standings.reduce((max, t) =>
        (t.homeWins * 3 + t.homeDraws) > (max.homeWins * 3 + max.homeDraws) ? t : max);
    const topAwayTeam = standings.reduce((max, t) =>
        (t.awayWins * 3 + t.awayDraws) > (max.awayWins * 3 + max.awayDraws) ? t : max);

    const kpi = (label, value, detail = '', color = '') =>
        `<div class="kpi-card">
            <div class="kpi-label">${label}</div>
            <div class="kpi-value small">${value}</div>
            ${detail ? `<div class="kpi-detail" style="color:${color || 'var(--text-secondary)'}">${detail}</div>` : ''}
        </div>`;

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
        return `<div class="standings-wrapper"><div class="standings-empty">Sem dados. Clique em \u21BB Atualizar Dados.</div></div>`;
    }

    let html = `<div class="standings-wrapper"><table class="standings-table"><thead><tr>
        <th>#</th><th></th><th>Time</th><th class="th-center">P</th><th class="th-center">J</th><th class="th-center">V</th><th class="th-center">E</th><th class="th-center">D</th><th class="th-center">GP</th><th class="th-center">GC</th><th class="th-center">SG</th><th class="th-center">\u00DAlt. 5</th><th class="th-center">\u00DAltimo</th>
    </tr></thead><tbody>`;

    standings.forEach(team => {
        // Zona de classificação (apenas classe CSS para borda esquerda)
        let zoneClass = '';
        if (team.position <= 4)       zoneClass = 'zone-libertadores';
        else if (team.position <= 6)  zoneClass = 'zone-sudamericana';
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
            <div class="zone-legend-item"><div class="zone-legend-dot" style="background:var(--accent-green)"></div><span>Libertadores (1\u20134)</span></div>
            <div class="zone-legend-item"><div class="zone-legend-dot" style="background:var(--accent-blue)"></div><span>Sul-Americana (5\u20136)</span></div>
            <div class="zone-legend-item"><div class="zone-legend-dot" style="background:var(--accent-red)"></div><span>Rebaixamento (17\u201320)</span></div>
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
            if (!players.length) return '<div style="color:var(--text-muted);font-size:12px;padding:8px">Sem dados. Clique em ↻ Atualizar Dados.</div>';
            return `<div class="market-table-wrapper"><table class="market-table">
                <thead><tr><th>#</th><th>Jogador</th><th class="th-center">J</th><th class="th-center">${valueLabel}</th></tr></thead>
                <tbody>${players.slice(0,15).map((p,i) => `<tr>
                    <td class="market-rank">${i+1}</td>
                    <td><div style="display:flex;align-items:center;gap:8px">
                        <img src="${p.photo}" alt="" style="width:26px;height:26px;border-radius:50%;object-fit:cover;background:var(--bg-hover)" onerror="this.style.display='none'">
                        <span style="font-weight:500">${p.name}</span>
                    </div></td>
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
        else if (team.position <= 6)  zone = 'zone-sudamericana';
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

    // KPIs de mercado (sempre globais)
    const mostValuable = sorted[0];
    const teamValues = {};
    allPlayers.forEach(p => { teamValues[p.team] = (teamValues[p.team] || 0) + p.value; });
    const teamValArr = Object.entries(teamValues).sort((a, b) => b[1] - a[1]);
    const totalValue = allPlayers.reduce((s, p) => s + p.value, 0);

    let html = `<div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-label">Jogador Mais Valioso</div><div class="kpi-value small">${mostValuable.name}</div><div class="kpi-detail" style="color:var(--accent-green)">${formatMarketValue(mostValuable.value)} \u2022 ${mostValuable.team}</div></div>
        <div class="kpi-card"><div class="kpi-label">Elenco Mais Valioso</div><div class="kpi-value small">${teamValArr[0][0]}</div><div class="kpi-detail" style="color:var(--accent-green)">${formatMarketValue(teamValArr[0][1])}</div></div>
        <div class="kpi-card"><div class="kpi-label">Valor Total da Liga</div><div class="kpi-value small">${formatMarketValue(totalValue)}</div></div>
        <div class="kpi-card"><div class="kpi-label">Jogadores Cadastrados</div><div class="kpi-value">${players.length}</div></div>
    </div>`;

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
        <th class="sort-th" data-col="team">Time <span class="sort-icon">↕</span></th>
        <th class="sort-th" data-col="position">Pos <span class="sort-icon">↕</span></th>
        <th class="sort-th" data-col="age">Idade <span class="sort-icon">↕</span></th>
        <th class="sort-th" data-col="value">Valor (EUR) <span class="sort-icon">↕</span></th>
        <th>Valor (BRL)</th>
    </tr></thead><tbody>`;

    sorted.forEach((p, i) => {
        html += `<tr data-name="${p.name.toLowerCase()}" data-team="${p.team}" data-position="${p.position}">
            <td class="market-rank">${i + 1}</td>
            <td style="font-weight:500">${p.name}</td>
            <td style="font-size:11px;color:var(--text-secondary)">${p.team}</td>
            <td><span class="market-position-badge">${p.position}</span></td>
            <td style="text-align:center">${p.age}</td>
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
    html += `<div class="tab-bar">
        <button class="tab-btn ${activeTab === 'tabela' ? 'active' : ''}" data-tab="tabela">Tabela</button>
        <button class="tab-btn ${activeTab === 'estatisticas' ? 'active' : ''}" data-tab="estatisticas">Estat\u00EDsticas</button>
        <button class="tab-btn ${activeTab === 'mercado' ? 'active' : ''}" data-tab="mercado">Mercado</button>
    </div>`;

    html += '<div class="container">';

    // Tab: Tabela (KPIs globais + classificação)
    html += `<div class="tab-content ${activeTab === 'tabela' ? 'active' : ''}" id="tab-tabela">`;
    html += renderKPIs(appState.standings, appState.allMatches);
    html += '<h3 class="section-title">Classifica\u00E7\u00E3o</h3>';
    html += renderStandings(appState.standings, {}, selectedTeam);
    html += '</div>'; // tab-tabela


    // Tab: Estatísticas (KPIs + artilheiros + gráficos)
    html += `<div class="tab-content ${activeTab === 'estatisticas' ? 'active' : ''}" id="tab-estatisticas">`;
    html += renderEstatisticasContent();
    const chartsRender = renderCharts(appState.standings);
    html += chartsRender.html;
    html += '</div>'; // tab-estatisticas

    // Tab: Mercado
    html += `<div class="tab-content ${activeTab === 'mercado' ? 'active' : ''}" id="tab-mercado">`;
    html += renderMarketValues();
    html += '</div>';

    html += `<div class="footer">Dados: <a href="https://www.thesportsdb.com" target="_blank" rel="noopener">TheSportsDB</a> &bull; <a href="https://github.com/dcaribou/transfermarkt-datasets" target="_blank" rel="noopener">Transfermarkt (dcaribou)</a> | Brasileir\u00E3o S\u00E9rie A ${appState.season || 2026}</div>`;
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

    // Filtro de turno
    const turnoSelect = document.getElementById('turnoFilter');
    if (turnoSelect) {
        turnoSelect.addEventListener('change', e => {
            appState.turno = e.target.value;
            applyFilters();
        });
    }

    // Botão atualizar (aciona pipeline de coleta via SSE)
    document.getElementById('updateBtn').addEventListener('click', startUpdate);

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
