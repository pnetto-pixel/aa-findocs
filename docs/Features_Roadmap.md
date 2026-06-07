# Features Roadmap — aa-findocs

> **Ver também:** [`docs/CONTEXT.md`](./CONTEXT.md) — contexto completo do projeto, stack, decisões técnicas e regras de operação do Claude.

## ✅ Concluídos
- Holdings card compacto: 2 linhas por ativo, separador fino, estilo Yahoo Finance
- **Item 3** (mai/2026): Fix overlap legendas eixo X — `angle={-45}`, `textAnchor="end"`, `height={60}`, ticks calculados por `computeXAxis()` alinhados a fronteiras de calendário
- **Item 4** (mai/2026): Renomeado "Portfolio Value" / "Current Value" → "Net Worth" em toda a tab Performance
- **Item 5** (mai/2026): Título do gráfico adicionado — dinâmico: "Net Worth Growth" (modo USD) ou "Portfolio VS S&P 500" (modo comparação)
- **Item 6** (mai/2026): Tooltip do gráfico com data completa via `labelFormatter` (ex: "May 1, 2024")
- **Item 7** (mai/2026): Seção Diagnostics removida do Performance.jsx
- **Item 2** (mai/2026): Eye Toggle em Performance — prop `valuesHidden` do App.jsx. Oculta só Net Worth e tooltip; percentuais sempre visíveis. Eixo Y colapsa de 64→16px quando oculto.
- **Item 9** (mai/2026): Eye Toggle em Transactions — prop `valuesHidden` do App.jsx. Oculta colunas Price e Fee na tabela.
- **Item 10** (mai/2026): Scroll horizontal isolado na tabela de Transactions — wrapper `overflowX: auto` + `minWidth: 760px`. Header renomeado "Tkr"→"Ticker". Padding Notes corrigido (2→10px).
- **Item 1** (mai/2026): Tabela "Position Performance" em `Performance.jsx` — PR30→35. Avg cost + gain/loss por ticker a partir de transações × preço atual. Ativos BR incluídos via fxRate. 8 colunas clicáveis com sort (default: Current Value desc). Linha TOTAL fixa no topo. Coluna Ticker sticky. "Group by class" com subtotais e grupos colapsáveis. Asset class lida das próprias transações.
- **Import preview editável** (jun/2026): Preview do ImportModal (CSV + Fidelity) com checkbox por linha (default: todas marcadas), header checkbox select/deselect all, inline edit por double-click, botão mostra "Import X of Y rows", só linhas marcadas são importadas.
- **Item 14** (jun/2026 — PR #37): ETFs Fixed Income → auto-classificar como `Bonds`. Lista `FIXED_INCOME_ETFS` (25 tickers) em `Transactions.jsx`. Aplicado em 4 lugares: form, parser CSV, parser Fidelity, backfill on load.
- **Item 15** (jun/2026 — PR #37): REITs e ETFs Real Estate → auto-classificar como `Real Estate`. Lista `REAL_ESTATE_ETFS` (10 tickers). Mesma função `inferAssetClass()` do item 14.
- **Item 16** (jun/2026 — PR #37 + #39): Todos asset classes no Performance exceto Cash. `INCLUDED_CLASSES` expandido para incluir `Bonds`, `Bank Bonds`, `BRA Fixed Income`. Tickers sem candles ignorados silenciosamente. Cache bumped v10→v11. Net Worth KPI unificado com fonte live de Position Performance.
- **Item 13** (jun/2026): US Bank Bonds live — pesquisa de API gratuita por CUSIP/ticker concluída. Implementado.
- **Item 11** (jun/2026 — PRs #41–#50): BRA Fixed Income (Tesouro Direto) — tentativas de live pricing via Brapi `/treasury` (403 pago), tesourodireto.com.br (410 descontinuado), CKAN datastore (400 desativado). Pivotou para **entrada manual em BRL com conversão automática para USD**. Holdings `BRA Fixed Income` aceitam `manualCurrency: "BRL"`, convertido via `usdBrlRate` (`GET /api/price?fx=USDBRL`, cascata Finnhub → open.er-api → Frankfurter, cacheado em localStorage). Seletor USD/BRL no form de add/edit. Tickers `tesouro-*` e classe `BRA Fixed Income` pulam validação de ticker.
- **Item 12** (jun/2026 — PRs #41–#50): `BRA Fixed Income` como asset class BR para Tesouro/CDB — holdings manuais com suporte a valor em BRL. CDB Banco Guanabara permanece manual em BRL até vencimento (out/2028).
- **Bug fix — Performance não reage a mudanças em Transactions** (jun/2026): Cache Redis de `perf-history` usava key fixa por usuário, ignorando mudanças nas transactions. Fix: cache key agora inclui FNV-1a hash das transactions elegíveis (`id|date|side|ticker|qty|price`). Qualquer adição, remoção ou edição gera hash diferente → cache miss → recalcula automaticamente. Cache bumped v11→v12.
- **Bug fix — "Bank Bonds" ausente na mensagem de erro de classe elegível** (jun/2026): Mensagem "No transactions in eligible asset classes" em Performance.jsx não listava Bank Bonds. Corrigido.
- **Fix — Disclaimer Performance.jsx** (jun/2026): Texto "Excludes fixed income & unallocated assets" já estava corrigido no código para "Excludes Cash and Unallocated assets". Roadmap e CONTEXT.md atualizados para refletir.
- **Pesquisa de fontes de dados — Tab Dividends** (jun/2026 — PR #58): Probe validou fontes. Yahoo `chart?events=div` para US (keyless, gratuito); brapi `dividends=true` rejeitado (HTTP 403, feature paga); Finnhub `/stock/dividend` rejeitado (premium). BRA Stocks, BRA Fixed Income e Bank Bonds → entrada manual. Income model: `totalReceived` direto. Storage: `portfolio:<storageKey>:income-manual`.
- **Item 17** (jun/2026): Income History — card colapsavel com KPIs (All Time / YTD / This Month) e bar chart com seletor de view `Month | Quarter | Half | Year`. Implementado em `src/Dividends.jsx`.
- **Item 18** (jun/2026): Bar chart com agrupamentos por periodo (Month/Quarter/Half/Year) dentro do Income History card. Implementado junto com item 17.
- **Item 25** (jun/2026): Calculadora de aporte mensal → split quinzenal. Inputs: valor fixo mensal, proventos do mes anterior, venda DELL, entradas extras. Total ÷ 2 = 1a e 2a quinzena. Implementado em `src/AporteQuinzenal.jsx`.
- **Item 26** (jun/2026): Realizado vs Planejado — registro do aporte realizado por quinzena, mostra pendente vs planejado. Implementado em `src/AporteQuinzenal.jsx`.
- **Item 27** (jun/2026): Historico de aportes — bar chart de evolucao dos aportes (mesmo seletor de view `Year | 6M | Quarter | Month`). Implementado em `src/AporteQuinzenal.jsx`.
- **Item 19 — y/y nos KPIs do Income History** (jun/2026 — PR #62): KpiCard YTD e This Month exibem variacao percentual ano-a-ano abaixo do valor principal. `priorYtd` e `priorMonth` calculados no useMemo `kpis`. Nota: grafico mes anterior vs atual (parte original do item 19) ainda pendente.
- **Dropdown de anos no Income History** (jun/2026 — PR #62): Substituiu inputs de date range (From/To) por `<select>` de anos. Opcoes: "All years" + anos presentes nos dados em ordem decrescente. Simplifica o filtro para selecao de ano inteiro.
- **Group by Asset Class em Position Dividends** (jun/2026 — PR #62): Toggle "By Ticker" / "By Asset Class" na tabela Position Dividends. Quando "By Asset Class": agrega dividendos por classe (Stocks, Real Estate, etc.) derivando a classe das transactions. Header sticky muda de "Ticker" para "Class".
- **Item 19 (restante) — Comparador Mes Anterior vs Mes Atual** (jun/2026 — PR #64): Bloco "Month vs Month" inserido no topo do card "Income History" em `Dividends.jsx`. Dois cards lado a lado — "Prev Month" (mes anterior completo) e "This Month" (acumulado ate hoje) — com delta percentual MoM centralizado (verde/vermelho) e nomes dos meses por extenso. Oculto quando o usuario filtra por ano historico diferente do corrente. Reutiliza `useMemo kpis` existente sem nenhum novo fetch ou mudanca de API.
- **Item 24 — Comparador Y/Y por mes com diferenca por asset** (jun/2026 — PR #65): `buildYoyData(events)` agrupa eventos de dividendos por ticker e mes para o ano atual vs ano anterior. `YearVsYearTable` — card colapsavel abaixo do Income History com tickers como linhas, meses como colunas; cada celula exibe valor do ano atual + valor do ano anterior (muted) + indicador de delta (tri/tri + %) em verde/vermelho. Linha TOTAL no rodape, scroll horizontal no mobile, mensagem de empty state. Apenas `src/Dividends.jsx` alterado.

---

## 🔲 Pendentes

### Roadmap — Validacao de tickers
- **Novo item**: Validacao de slug/ticker ao adicionar transacao — lookup na API antes de salvar, para evitar typos em tickers `tesouro-*` e outros ativos live. ⚠️ *Deferred — adicionar quando Tab Events for implementada*

### Tab Performance
- **Item 8**: Grafico adicional: retorno total incluindo dividendos recebidos

### Tab Aporte Quinzenal
- **Item 28**: *Futuro:* verificar aportes automaticamente a partir do log de Transactions (reconciliacao plano × realizado)

### Tab Events (nova)
- **Item 20**: Calendario de ex-div, earnings e special events (split, grouping, payout)
- **Item 21**: Exibir ultimo mes + proximos 3 meses, em ordem cronologica
- **Item 22**: Filtro por tipo de evento
