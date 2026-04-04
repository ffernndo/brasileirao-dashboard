# Dashboard Futebol Brasil — Contexto do Projeto

## Objetivo
Criar um dashboard interativo, gratuito e sem dependências pagas, que concentre informações sobre clubes do futebol brasileiro: rodadas, classificação, jogadores, métricas de resultado, performance e dados financeiros/mercado.

## Escopo

### Clubes
- Todos os clubes do futebol brasileiro (foco inicial: Série A do Brasileirão)
- O usuário poderá filtrar por clube no dashboard

### Competições cobertas
- **Brasileirão Série A** (prioridade principal)
- **Copa do Brasil**
- **Copa Libertadores da América**

### Métricas e seções planejadas

#### 1. Visão Geral / KPIs
- Posição na tabela, pontos, aproveitamento (%)
- Sequência de resultados (últimos 5 jogos)
- Próximo jogo (adversário, data, competição)

#### 2. Resultados e Rodadas
- Tabela de classificação completa (com filtro por turno)
- Resultados rodada a rodada
- Histórico de confrontos diretos

#### 3. Performance
- Gols marcados vs. sofridos (total e por competição)
- Posse de bola, finalizações, escanteios (se disponível na API)
- Desempenho casa vs. fora
- Mapa de calor de resultados por rodada

#### 4. Jogadores
- Artilheiros e assistentes por competição
- Cartões (amarelos/vermelhos)
- Minutagem e titularidade

#### 5. Dados Financeiros / Mercado (fase futura)
- Valor de mercado do elenco (Transfermarkt como referência)
- Movimentações (contratações e saídas)
- Comparativo de investimento vs. desempenho

---

## Arquitetura Técnica

### Tecnologia do Dashboard
- **HTML + CSS + JavaScript puro** (arquivo único, abre em qualquer navegador)
- Gráficos com **Chart.js** (CDN, sem instalação)
- Layout responsivo com CSS Grid/Flexbox
- Filtros interativos (clube, competição, temporada)
- Sem backend — dados consumidos diretamente via fetch() das APIs

### Fontes de Dados (APIs Gratuitas)

#### Fonte principal: TheSportsDB (ATIVA)
- **Plano gratuito**: sem API key, sem limite de requisições por dia
- **Cobertura**: Brasileirão Série A, Copa do Brasil e outras ligas
- **Dados disponíveis**: temporada atual (2026) em tempo real
- **Base URL**: `https://www.thesportsdb.com/api/v1/json/3/`
- **Endpoints utilizados**:
  - `lookuptable.php?l={id}&s={season}` — classificação (limitado a 5 times no free)
  - `eventsround.php?id={id}&r={round}&s={season}` — jogos por rodada (completo, 10 jogos)
  - `eventsnextleague.php?id={id}` — próximos jogos
- **IDs das ligas**:
  - Brasileirão Série A: 4351
  - Copa do Brasil: 4725
- **Estratégia**: como a tabela free retorna apenas 5 times, a classificação completa (20 times) é calculada a partir dos resultados de todas as rodadas
- **URL**: https://www.thesportsdb.com/

#### Fonte secundária: API-Football (api-sports.io) — RESERVA
- **Plano gratuito**: 100 requests/dia, acesso a todos os endpoints
- **Limitação**: temporadas 2022-2024 apenas (não tem 2025/2026 no free)
- **API Key**: cadastrada no dashboard.api-football.com
- **Cobertura**: Brasileirão (71), Copa do Brasil (73), Libertadores (13)
- **Docs**: https://www.api-football.com/documentation-v3
- **Uso futuro**: se fizer upgrade, pode substituir TheSportsDB com dados mais ricos (estatísticas detalhadas, artilheiros, etc.)

### Estratégia de dados
- **Cálculo local**: classificação construída a partir dos resultados rodada a rodada
- **Paralelismo**: rodadas 1-15 buscadas em paralelo via Promise.all
- **Cache em memória**: dados armazenados em variáveis JS (por sessão)
- **Escudos**: coletados automaticamente dos dados de cada jogo (strHomeTeamBadge/strAwayTeamBadge)

---

## Estrutura de Arquivos (planejada)

```
Dashboard Futebol/
├── CONTEXT.md              ← este arquivo
├── index.html              ← dashboard principal (HTML + CSS + JS em arquivo único)
├── data/
│   ├── teams.json          ← dados estáticos dos times (nome, escudo, cores)
│   └── config.json         ← IDs de ligas, temporada atual, chaves de API
└── assets/
    └── escudos/            ← fallback local de escudos (opcional)
```

---

## Identidade Visual (sugestão)

- **Fundo**: escuro (#0f1923 ou #1a1a2e)
- **Cards**: cinza escuro (#16213e ou #1e293b) com bordas sutis
- **Destaque primário**: verde (#10b981) — remete ao futebol brasileiro
- **Destaque secundário**: amarelo (#f59e0b) — identidade nacional
- **Texto principal**: branco (#f1f5f9)
- **Texto secundário**: cinza claro (#94a3b8)
- **Fonte**: Inter ou sistema (sem dependência externa)
- **Estilo**: limpo, profissional, inspirado em dashboards de BI

---

## Regras e Premissas

1. **Custo zero**: nenhuma ferramenta ou serviço pago
2. **Arquivo único**: o dashboard deve funcionar abrindo um único HTML no navegador
3. **Responsivo**: funcionar em desktop e mobile
4. **Dados reais**: usar APIs reais, não dados mockados (exceto na fase de prototipação)
5. **Cache inteligente**: minimizar chamadas à API para respeitar limites
6. **Progressivo**: começar pelo essencial (classificação + resultados) e evoluir

---

## Fases de Desenvolvimento

### Fase 1 — MVP (prioridade)
- [ ] Registro na API-Football e obtenção da chave
- [ ] Estrutura HTML/CSS do dashboard (layout, cores, responsividade)
- [ ] Classificação do Brasileirão Série A (tabela interativa)
- [ ] Resultados por rodada
- [ ] Filtro por clube
- [ ] Cache em localStorage

### Fase 2 — Expansão
- [ ] Adicionar Copa do Brasil e Libertadores
- [ ] Seção de jogadores (artilheiros, cartões)
- [ ] Estatísticas de performance (gols, casa vs. fora)
- [ ] Próximos jogos e calendário

### Fase 3 — Avançado
- [ ] Dados financeiros/mercado (pode exigir scraping manual ou CSV)
- [ ] Comparativo entre clubes
- [ ] Gráficos avançados (radar, heatmap de resultados)
- [ ] Exportação de dados (CSV/PDF)

---

## Notas para o Assistente (Claude)

- O usuário é um profissional de dados e BI — pode usar terminologia técnica
- Priorizar soluções práticas, aplicáveis e bem estruturadas
- O dashboard é em HTML/JS puro — não usar frameworks como React ou Vue
- Manter o código limpo, comentado e organizado
- Ao evoluir o dashboard, preservar a estrutura existente
- Idioma do dashboard: Português do Brasil
- Formato de datas: DD/MM/AAAA
- Separador decimal: vírgula (ex: 75,5%)
