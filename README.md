# Brasileirão Série A 2026 — Dashboard

Dashboard interativo do Campeonato Brasileiro Série A com classificação, estatísticas e valores de mercado dos jogadores.

**[Acessar o Dashboard](https://fexndev.github.io/brasileirao-dashboard/)**

## Funcionalidades

- **Tabela de classificação** com zonas (Libertadores, Sulamericana, rebaixamento) e últimos 5 jogos
- **Estatísticas** — KPIs da liga, gols por time, desempenho casa/fora, evolução por rodada
- **Mercado** — valores de mercado dos jogadores (Transfermarkt), ordenável por nome, time, posição, idade e valor
- **Atualização automática diária** via GitHub Actions (07h BRT)

## Fontes de dados

| Fonte | Dados |
|---|---|
| [ESPN](https://www.espn.com.br) | Partidas, resultados, rodadas |
| [Transfermarkt](https://www.transfermarkt.com) | Valores de mercado dos jogadores |

## Como rodar localmente

```bash
pip install -r scripts/requirements.txt
python3 scripts/server.py
# Abrir: http://localhost:8000
```

## Tecnologias

- HTML, CSS, JavaScript (sem frameworks)
- Chart.js para gráficos
- Python + Flask (servidor local)
- GitHub Actions (atualização automática)
