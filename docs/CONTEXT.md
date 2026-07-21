# CONTEXT.md — aa-findocs

> **Repo público:** <https://github.com/pnetto-pixel/aa-findocs>
> **App live:** <https://aa-findocs.vercel.app>
> **Owner / Admin:** [pnetto@gmail.com](mailto:pnetto@gmail.com)
> **Usuários ativos:** Pedro + 1 amigo

> **Ver também:** [`docs/Features_Roadmap.md`](./Features_Roadmap.md) — backlog completo de features pendentes e concluídas.

-----

## 🧠 Regras de Operação do Claude

Estas regras valem pra toda interação. Releia antes de propor mudanças.

1. **Leia o repo antes de afirmar qualquer coisa sobre o código.** Não chute nomes de função, posições de linha, estrutura de arquivo, ou o que existe/não existe. Se não conseguir ler, pare e peça.
1. **Distinga fato de hipótese.** "No `App.jsx` linha 320 tem X" exige ter lido. "Acho que…" / "provavelmente…" é hipótese — sinalize.
1. **Não assuma estado externo.** Não afirme "Google está publicado", "env var X existe no Vercel", "feature Y já está deployada" sem confirmação na conversa atual.
1. **Pergunte quando não souber.** Melhor 1 pergunta agora do que 5 idas-e-voltas depois.
1. **Confirme antes de mudanças destrutivas.** Delete, rename, refactor grande → checar antes.
1. **Não invente APIs/libs/métodos.** Se não tem certeza que existe, valide nas docs ou pergunte.
1. **Respeite o constraint iPhone-only.** Soluções que exigem terminal, Mac, ou admin access estão fora.
1. **Limitação honesta:** não dá pra garantir 100% zero alucinação — é limite do modelo. As regras acima reduzem drasticamente, mas o usuário deve sempre validar mudanças críticas.
1. **Modelo default: Sonnet 4.6.** Sugerir Opus apenas ao descrever tarefa que seja: arquitetura nova complexa cruzando vários arquivos, debug difícil que Sonnet não resolve, ou refactor grande estrutural.
1. **CONTEXT.md e Features_Roadmap.md vivem no repo em `docs/`.** Atualizá-los diretamente via Claude Code ao final de cada session relevante — commitar junto com o PR da feature ou num PR separado de docs.

-----

## 📌 Identidade

- **Nome:** aa-findocs (Portfolio Tracker / Asset Allocation Dashboard)
- **Objetivo:** Dashboard pessoal de investimentos — asset allocation, preços live (US + B3), rebalance, tracking unificado (auto + manual), log de transações, gráfico de performance vs benchmark. Substitui workflow fragmentado de Excel + StatusInvest + Google Finance.

-----

## 🧱 Stack (resumo — detalhes no `package.json`)

- **Frontend:** React 18.3 + Vite 5.4 + recharts 2.12. `App.jsx` monolítico para a tela de Holdings; `Transactions.jsx` separado para o log de transações; `Performance.jsx` separado para o dashboard de performance.
- **Backend:** Vercel Serverless Functions (Node.js)
- **Storage:** Redis (Vercel Marketplace, TCP via `ioredis` 5.4)
- **Auth:** Google Identity Services (JWT) + password fallback
- **Hospedagem:** Vercel (Hobby/Free)
- **APIs externas:** Finnhub (US + Forex), brapi.dev (B3), open.er-api + Frankfurter (FX fallback), Google OAuth
- **Libs notáveis:** `papaparse` 5.4 (CSV import em Transactions), `lucide-react` 0.383 (ícones), `recharts` 2.12 (gráfico em Performance)

-----

## 🚧 Constraints (não negociáveis)

- **iPhone-only:** sem PC com admin, sem Mac. Tudo via Claude Code web + GitHub mobile app + Vercel app.
- **iOS smart quotes quebram código:** nunca paste em arquivos.
- **App.jsx monolítico:** ~4800 linhas. Transactions.jsx e Performance.jsx ficaram separados pra reduzir risco de deploy parcial em App.jsx.
- **Sem TypeScript:** simplicidade > type safety pra projeto pessoal.

-----

## 🗺️ Layout do App

Single page com view switcher no topo:

- Tab **HOLDINGS** (id interno `dashboard`): dashboard original (asset allocation, rebalance, Cash, Manage Users).
- Tab **DIVIDENDS** (id interno `dividends`): income history, position dividends, Y/Y comparison, dividend history. Carregado lazy.
- Tab **EVENTS** (id interno `events`): calendario de eventos corporativos — ex-div, payout, earnings, splits. Carregado lazy. Posicionado entre Dividends e Transactions.
- Tab **TRANSACTIONS** (id interno `transactions`): log de transações (carregado lazy ao clicar).
- Tab **PERFORMANCE (TEST ONLY)** (id interno `performance`): gráfico de performance (carregado lazy ao clicar). Marcado TEST ONLY pra sinalizar MVP a usuários compartilhados.

O switcher fica logo abaixo do H1 dinâmico. State `activeView` em `PortfolioTracker`.

No header do app há um **ícone de notificação global (Bell)** com badge de contagem (splits pendentes + alertas não lidos). Clicar abre o **painel de Alerts** (dividendos pagos hoje, earnings hoje, bond maturities ≤7d, splits pendentes). A revisão/aprovação de splits em si vive na Tab Transactions (card "Splits / Groupings"). Ver "Feature: Split Detection & Approval".

-----

## 💼 Feature: Transactions (Fase 1 completa)

Tab nova, separada do Dashboard. Storage isolado.

### Storage

- Chave Redis: `portfolio:<auth>:transactions` (paralela ao `:holdings`, sem refator do existente).
- Endpoint: `api/transactions.js` (GET / PUT, mesmo padrão de `api/holdings.js`).
- Storage key é derivada de `auth.storageKey` substituindo `:holdings` por `:transactions`.
- Blob: `{ transactions, bondIncome, splitEvents, savedAt }`. `bondIncome` (PR #87) é o store separado de pagamentos reais de juros de Bank Bonds — fica fora do array de transações, então não entra na matemática de posição. `splitEvents` (commit 4e66bd9) registra splits/groupings já aplicados ao histórico (`applied`/`dismissed`) — ver "Feature: Split Detection & Approval". PUT preserva `bondIncome` E `splitEvents` quando o body os omite (read-modify-write única).

### Modelo de transação

```js
{
  id,           // crypto.randomUUID()
  date,         // "YYYY-MM-DD"
  side,         // "buy" | "sell"
  ticker,       // uppercase string (AAPL, BBSE3, 949764WE0...)
  assetClass,   // 1 dos 9 ids abaixo
  qty,          // number
  price,        // number (na currency nativa)
  currency,     // "USD" | "BRL" — derivada do assetClass
  fee,          // number (default 0)
  notes,        // string opcional
  createdAt     // ISO timestamp
}
```

### Asset Classes (fixos, ordem alfabética no UI)

|ID              |Currency|
|----------------|--------|
|Alternative     |USD     |
|Bank Bonds      |USD     |
|Bonds           |USD     |
|BRA Fixed Income|BRL     |
|BRA Stocks      |BRL     |
|Real Estate     |USD     |
|Stocks          |USD     |
|Unallocated BRL |BRL     |
|Unallocated USD |USD     |

Helpers: `currencyForAssetClass(id)`, `normalizeAssetClass(rawStr)`, `ASSET_CLASS_IDS`.

### Auto-inferência (PR #37 — jun/2026)

Função `inferAssetClass()` em `Transactions.jsx`. Prioridade de lookup:

1. `FIXED_INCOME_ETFS` (25 tickers: BND, AGG, SCHZ, IAGG, BNDX, VCIT, VCSH, LQD, HYG, TLT, IEF, SHY, GOVT, MUB, VTEB, BSV, BIV, BLV, VGSH, VGIT, VGLT, SPTL, SPIB, SPAB, FBND) → `Bonds`
2. `REAL_ESTATE_ETFS` (10 tickers: VNQ, XLRE, IYR, SCHH, RWR, USRT, FREL, REM, MORT, KBWY) → `Real Estate`
3. Regex `tesouro-*` → `BRA Fixed Income` (adicionado PR #41–#50)
4. Regex CUSIP → `Bank Bonds`
5. Regex B3 `^[A-Z]{4}\d{1,2}$` → `BRA Stocks`
6. Regex US `^[A-Z]{1,5}$` → `Stocks`
7. Outros → ambíguo, pede manual no preview

Tickers `tesouro-*` e classe `BRA Fixed Income` **pulam validação de ticker** (sem alerta de ticker inválido).

Aplicada em 4 lugares: form de nova transação (auto-fill ao digitar ticker), parser CSV genérico, parser Fidelity, backfill on load de transações antigas sem `assetClass`.

### Backfill on load

Transações antigas sem `assetClass` recebem classe via `inferAssetClass()` no momento do load. Migração lazy.

### Form New (TransactionForm)

Add form com campos: date, side (buy/sell), ticker (com autocomplete de tickers conhecidos), qty, price, assetClass (select), fee, notes.

**Validacao de ticker (PR #107):** no onBlur do campo Ticker, `validateTickerViaAPI(ticker, auth)` chama `GET /api/price?ticker=X` e exibe erro inline (`tickerError`) se a API retornar resposta negativa explicita. Falha de rede e silenciosa (nao bloqueia o submit). `shouldSkipValidation(ticker, assetClass)` pula a validacao para: tickers `tesouro-*`, classe `BRA Fixed Income`, classe `Bank Bonds`, e CUSIPs (9 chars alfanumericos). `handleSubmit` tambem guarda enquanto `tickerValidating` estiver true.

### Tabela (responsiva, cabe em iPhone ~380px)

Layout fixo (`tableLayout: fixed`) com colgroup. Wrapper com `overflowX: auto` + `WebkitOverflowScrolling: touch` para scroll horizontal isolado. `minWidth: 760px` na tabela. Colunas:

```
[☐] Date  B/S  Class  Ticker  Qty  Price  Fee  Notes  [✏️🗑️]
```

- Side abreviado a `B`/`S`
- Price/Fee com prefixo `$` (USD) ou `R$ ` (BRL) via `fmtPrice()`; mascarados por `valuesHidden`
- Notes truncado com `...` e tooltip nativo (`title`)
- Sem coluna Currency (deduzida do assetClass)
- Header "Tkr" renomeado para "Ticker"
- Padding horizontal da coluna Notes: 10px

### Header unificado (Sort + Filter num popover só)

Click em qualquer header abre `HeaderPopover` ancorado naquela coluna, com:

- Seção **Sort**: 2 botões `↑ Asc` / `↓ Desc` (sempre presente)
- Seção **Filter** (quando aplicável):
  - `date` → Seletor de ano+mes derivado dos dados. Anos em ordem decrescente com `+/-` para expandir/colapsar meses com transacoes. Click num ano = range `YYYY-01-01` a `YYYY-12-31`; click num mes = `YYYY-MM-01` a `YYYY-MM-lastDay`. Single-select com highlight dourado; botao "Clear" limpa a selecao. `expandedYears` (Set) local ao `HeaderPopover`; `dateOptions` (Map) via `useMemo` no `TransactionTable`. (Antes: inputs manuais `From`/`To` — substituidos no Item 44, jun/2026.)
  - `side` → checkboxes "B (Buy)" / "S (Sell)"
  - `assetClass` → checkboxes com classes presentes nos dados
  - `ticker` → checkboxes com tickers presentes
  - `qty`, `price`, `fee`, `notes` → **só sort**

Indicadores visuais no header: label dourado + seta `↑↓` se sort ativo, `•` discreto se filter ativo.

### Bulk operations

- Checkbox por linha + checkbox no header ("select all visible")
- Toolbar dourada aparece quando `selected.size > 0`:
  - `[N selected]` `[Change class ▾]` `[Delete]` `[X]`
- "Change class" abre dropdown com as classes → aplica em todas selecionadas
- "Delete" abre modal de **confirmação** vermelho antes de apagar

### Inline edit

- **Double-click numa linha** OU **lápis** → entra modo edit
- Linha vira dourada com 8 inputs: date, side (dropdown B/S), assetClass (dropdown), ticker, qty, price, fee, notes
- **Enter salva**, **Esc cancela**, botões **✓ verde** e **X cinza** na coluna de actions
- Validações: ticker e assetClass obrigatórios, qty > 0, price ≥ 0

### Import / Export

Modal `ImportModal` com 2 tabs — abre por default na aba **Fidelity** (mudado no PR #90):

- **Upload CSV**: file picker, parser genérico com:
  - Auto-detect de delimitador (`,` `;` `\t` `|`)
  - Auto-detect de header (aliases PT/EN)
  - Decimal handling: prompt amarelo se vírgula detectada em campos numéricos → re-parse tratando como decimal BR
  - `fixBRSplitRow`: structural break heurística
  - Preview com tabela: contadores `N valid · M errors · X need class`, modo Append vs Replace
  - needsAssetClass: dropdown completo no preview pra resolver linha por linha
  - Sides aceitas: buy/sell/compra/venda/c/v
- **Fidelity** (`parseFidelityCSV`): parser dedicado para o "Accounts History" CSV nativo da Fidelity. Tab **default** do modal (PR #90):
  - File picker aceita **multiplos arquivos** — resultados mergeados, deduplicados cross-arquivo via `dupKey` e ordenados por data (PR #90)
  - Pula BOM + 2 linhas em branco iniciais
  - Acha header pela presença de "Run Date" + "Action"
  - Importa **só** `YOU BOUGHT` e `YOU SOLD`
  - `YOU SOLD` com quantidade negativa → `side="sell"`, qty = abs
  - **Datas MDY** (americano) — override do default DMY
  - Todas as transações entram como USD + assetClass via `inferAssetClass()`
  - **Dividendos (PR #95):** linhas `DIVIDEND RECEIVED` / `CASH DIV` (exceto `REINVEST`) capturadas como `incomeEvents` com `kind: "dividend"`, `source: "fidelity"`, `{ id, date, ticker, amount }` — armazenadas em `bondIncome` (mesmo store de interest payments) e enviadas a `/api/dividends` no body. UI de import exibe contagem separada: "N bond interest + M stock dividend payments detected."
  - **Foreign tax withheld em ADRs — caso TSM/VALE (jul/2026):** linhas `FOREIGN TAX PAID`/`FOREIGN TAX WITHHELD` (Fidelity as reporta separadas da linha de dividendo, mesmo dia) capturadas como `incomeEvents` com `kind: "tax"`, `amount` = magnitude positiva do valor retido. Guard dedicado, checado **antes** do bloco de dividendo (mesma licao do PR #95 abaixo). `BondIncomeAudit` (painel de auditoria em Transactions) e o toast de resumo do import ganham contagem/total separados para "tax". Ver `api/dividends.js` para como isso vira o array `foreignTax` na resposta.

**Import inteligente (item 34):**
- **Reuso de classe conhecida:** `parseRow` e `parseFidelityCSV` recebem `knownClassByTicker` (Map ticker→assetClass das transações salvas). Prioridade de classe: coluna explícita → histórico → `inferAssetClass()` → manual. Flag `classFromHistory` + chip "N class reused".
- **Detecção de duplicata:** `dupKey(tx)` = `ticker|side|qty|date`; linhas que batem com transações salvas ganham `r.duplicate = true`, vêm **desmarcadas por default**, fundo vermelho + label "Duplicate". `r.ok` continua true — usuário pode re-marcar pra forçar import. Chip "N duplicate".
- **Toggle ALL / NON-DUP / DUP no preview (PR #127 — jul/2026):** segmented control, so visivel quando `duplicateCount > 0`. State `dupFilter` ("all" | "non-dup" | "dup", default "all"). Filtro puramente visual (early-return no `.map` da tabela de preview) — nao muda os indices usados por `checkedRows`/`editingIdx`, e nao afeta o que e realmente importado (`handleConfirm` segue os checkboxes marcados, nao o filtro visual selecionado).

**Preview editável:**
- Checkbox por linha no preview — todas marcadas por default (exceto duplicatas)
- Header checkbox = select/deselect all
- **Double-click numa linha** → inline edit. Enter salva, Esc cancela.
- Botão de import mostra `Import X of Y rows`
- Só linhas marcadas são importadas

**Tab Paste foi removida.**

**Export CSV** (botão Download): gera `transactions-YYYY-MM-DD.csv`.

### Bond Income Audit Panel (jun/2026)

Painel colapsavel "Import History — Bond Income" no rodape da Tab Transactions (`src/Transactions.jsx`). Exibe todos os entries de `bondIncome` armazenados no Redis, ordenados mais-recente-primeiro. Colunas: Date, Ticker, Kind, Source, Amount. Cada entry tem delete em dois passos (trash → confirmar) que faz PUT imediato no Redis. Permite auditar e remover entries stale ou mal capturados (ex: DISTRIBUTION rows capturados erroneamente antes do fix do parser) sem acesso direto ao Redis.

-----

## 📈 Feature: Performance (MVP — TEST ONLY)

Tab nova, separada. Lê do log de transações. Marcada **(TEST ONLY)** em badge gold.

### Storage

- Endpoint: `api/perf-history.js` (POST)
- Cache Redis: `portfolio:<storageKey>:perf-history`, TTL até próximo fechamento do mercado US (~21:00 UTC = 16h ET), **versão v14**
- Auth: mesmo padrão de `api/transactions.js`

### Lógica server-side

1. Recebe `{ transactions, allTransactions? }` no body. `allTransactions` (jul/2026, feature Composition Evolution) é opcional — quando ausente, faz fallback para `transactions`. Usado **exclusivamente** para computar o campo `composition` da resposta (ver "Composition Evolution" abaixo); o cálculo de TWR continua usando só `transactions` (o subconjunto já filtrado pela UI, se algum filtro de Asset Class/Ticker estiver ativo). Reaproveita o mesmo POST existente — evita uma segunda chamada de rede.
2. **Filtra** (`INCLUDED_CLASSES`): `Stocks`, `BRA Stocks`, `Alternative`, `Real Estate`, `Bonds`, `Bank Bonds`, `BRA Fixed Income`
   - `Cash`, `Unallocated USD`, `Unallocated BRL` **excluídos**
   - Tickers sem candles disponíveis (ex: CDs, Tesouro) são ignorados silenciosamente — sem quebrar o cálculo
3. Ordena por data → `startDate` = primeira transação válida
4. Busca candles diários:
   - US: Finnhub `/stock/candle?resolution=D`
   - B3: brapi.dev `/api/quote/{TICKER}?range=5y&interval=1d`
   - SPY: Finnhub candles
   - FX USD/BRL diário: open.er-api time series
5. Calcula portfolio value diário desde `startDate`
6. Normaliza: `retorno[d] = (valor[d] / valor[startDate] - 1) × 100`
7. Response: série TWR + portfolioUSD (valor absoluto)

### UI (`Performance.jsx`)

Elementos principais:

- **Page title:** "Performance" + badge **TEST ONLY** (gold)
- **Disclaimer:** "Excludes Cash and Unallocated assets. Updated daily after US market close. Total Return includes US dividends only (BRA and fixed income excluded)."
- **Period selector:** botões `1M | 6M | YTD | 1Y | 5Y | MAX`
- **Toggle:** "Compare vs S&P 500" ↔ "← Net Worth" — controla a exibição de Portfolio + S&P 500 + Alpha
- **Toggle independente "Show Total Return"** (jul/2026, commit `a60bb9f`): controla a linha/KPI de Total Return separadamente de "Compare vs S&P 500" — pode ser ligado junto ou sozinho. Default (ambos off) reproduz o comportamento visual anterior (pré-feature), sem regressão.
- **Filtros Asset Class + Ticker** (jul/2026, commit `a60bb9f`): dois chips multi-select acima do card de performance (componente `FilterChip`, envolve o `TickerFilterPopover` já existente — reuso, não duplicação). Asset Class usa `PERF_ELIGIBLE_CLASSES` (8 classes, ver "Cache/lógica server-side" abaixo) intersectado com as classes presentes nas transactions do usuário; Ticker depende do Asset Class já aplicado e é podado automaticamente ao trocar o Asset Class (evita combinação permanentemente vazia). Filtro restringe as `transactions`/`divEvents` enviadas ao `POST /api/perf-history` — 100% client-side, sem mudança no backend (cache v12 já cobre o subconjunto filtrado via hash). KPI "Net Worth" vira "Net Worth (filtered)" com valor de `positionRows` filtrados quando algum filtro está ativo. Botão "Clear filters" sempre visível/clicável quando algum filtro está ativo, mesmo com resultado filtrado vazio. Refetch só ao fechar o popover do filtro, não a cada clique de checkbox.
- **Card colapsável "Portfolio Performance & Net Worth"** (PR #38): mesmo padrão visual do card "Rebalance Suggestions" da aba Holdings — botão full-width, label gold, ícone ChevronDown rotativo. Mostra "as of [data]" no header assim que dados carregam.
- **KPI cards:**
  - **Net Worth** (ou **Net Worth (filtered)** quando algum filtro está ativo) — soma ao vivo de `positionRows` (preços Finnhub live, mesma fonte da Position Performance)
  - **Portfolio {period}** — TWR % do portfólio no período selecionado
  - **Total Return {period}** — TWR % + dividendos US acumulados no período / valor inicial; visível quando o toggle "Show Total Return" está ligado (antes: só em modo comparação); BRA e fixed income excluídos (PR #68)
  - **S&P 500 {period}** — TWR % do SPY (só em modo comparação)
  - **Alpha** — diferença Portfolio − SPY (só em modo comparação)
- **Chart title** dinâmico por modo ("Net Worth Growth" / "Portfolio VS S&P 500")
- **Gráfico (`recharts <LineChart>`):** XAxis com ticks de calendário, tooltip com data completa, Eye Toggle integrado. Cada linha agora é controlada independentemente pelo seu próprio toggle: Portfolio (azul) + S&P 500 (laranja) + Alpha via "Compare vs S&P 500"; Total Return (verde `T.green`, PR #68) via "Show Total Return" — as duas podem estar ligadas juntas ou separadas
- **Eye Toggle:** oculta Net Worth (USD absoluto) e tooltip; percentuais sempre visíveis; eixo Y colapsa 64→16px quando oculto
- **Fallback de compatibilidade:** `effectiveComparing = comparing || !hasUSD`

### Card colapsável "Composition Evolution" (jul/2026, ajustado jul/2026)

Inserido **depois** do card "Position Performance" em `Performance.jsx` (ordem final: Portfolio Performance & Net Worth → Position Performance → Composition Evolution). Mostra a evolução histórica da composição do portfólio por asset class como stacked area chart normalizado a 100% (`recharts`, `stackOffset="expand"`).

- **Filtros de Asset Class e Ticker no topo** (acima do filtro de período — ordem trocada jul/2026 a pedido do usuário), no mesmo formato dropdown (`FilterChip` + `TickerFilterPopover`) usado pelo filtro "Asset Class"/"Ticker" do card "Portfolio Performance & Net Worth" — mas com estado independente (`compAssetClassFilter`/`compTickerFilter`, separado de `assetClassFilter`/`tickerFilter`).
- **Filtro de período** (`COMPOSITION_PERIODS`: 1Y/2Y/5Y/All — array distinto do `PERIODS` do gráfico principal, que é 1M/6M/YTD/1Y/5Y/MAX) abaixo dos filtros de Asset Class/Ticker. Pills com preenchimento sólido dourado quando ativo (`background: T.gold`, `color: T.bg`) — mesmo design do seletor de período do card "Income History" em `Dividends.jsx` (`PERIOD_OPTIONS`). O filtro de período do card "Portfolio Performance & Net Worth" (`PERIODS`) recebeu o mesmo tratamento visual (antes ambos usavam um estilo azul translúcido).
- Ocultar uma classe/ticker via esses filtros restringe os dados na origem (client-side, ver "Filtragem 100% client-side" abaixo); como consequência, o stack renormaliza a 100% só entre o que resta.
- Eixo X: usa a mesma lógica de ticks por fronteira de calendário do gráfico de TWR principal (`computeXAxis`, chamada com o período do card) — não as datas reais de transação (que deixavam os rótulos com espaçamento desigual). `computeXAxis` ganhou suporte aos períodos "2Y" (ticks trimestrais) e "All" (tratado como o "MAX" existente).
- Legenda paginada custom (`CompositionLegend`, setas prev/next) — as ~7 classes não cabem numa linha só.
- **Classes incluídas** (`COMPOSITION_CLASSES` em `api/perf-history.js`): `INCLUDED_CLASSES` menos `BRA Fixed Income` — ou seja, Stocks, BRA Stocks, Alternative, Real Estate, Bonds, Bank Bonds, Unallocated USD. `BRA Fixed Income` é excluída (sem preço de mercado disponível, sem fallback flat). `Unallocated BRL` não está incluída, mantendo consistência com `PERF_ELIGIBLE_CLASSES`.
- **Bank Bonds:** o accrued interest que já existia hardcoded em `Date.now()` dentro de `positionRows` foi extraído e generalizado no helper puro `computeBankBondsValueAt(transactions, asOfISO)` em `src/Performance.jsx` — aceita qualquer data de referência. Reusado tanto em `positionRows` (asOfISO = hoje) quanto no card novo (uma chamada por data histórica do range), agora sobre `compFilteredTransactions`.
- **Texto de rodapé** simplificado para apenas "Excludes BRA Fixed Income".
- **Filtragem 100% client-side (bugfix de performance, jul/2026):** a primeira versão refetchava `/api/perf-history` a cada mudança no filtro de Asset Class/Ticker do card, o que levava 1-2s (fetch ao vivo de candles no Twelve Data/brapi quando o novo subconjunto de tickers não estava em cache) — UX ruim para algo que devia ser instantâneo. Fix: `computeCompositionSeries` (backend) passou a retornar granularidade **por ticker** (`{ dates, tickerValues: { [ticker]: number[] }, tickerClass: { [ticker]: assetClass } }`) em vez de já agregado por classe (`classValues`), sempre para o portfólio inteiro (`allTransactions`). O fetch (**Effect C** em `Performance.jsx`) roda **uma única vez** por carregamento de página (depende só de `transactions`, não mais do filtro do card). O filtro de Asset Class/Ticker é aplicado inteiramente no cliente (`filteredComposition`, `useMemo`): soma `tickerValues` só dos tickers que passam no filtro, por classe — troca instantânea, sem round-trip de rede. `compFilteredTransactions` continua existindo apenas para o cálculo local (sem rede) do accrual de Bank Bonds. **Cache bump v13→v14** (mudança de shape do campo `composition`).
- **Toggle Class/Ticker (jul/2026):** `SegmentedToggle` (novo componente 2-opções, mesma linha do filtro de período, alinhado à direita) alterna `viewBy` entre `"class"` (default) e `"ticker"`. No modo Ticker, o card usa `mergedTickerComposition` em vez de `mergedComposition` — mesma forma `{ dates, classValues }` esperada por `getCompositionWindow`, mas com chaves de ticker em vez de asset class (reaproveita a granularidade por ticker que já vem do backend desde o fix de performance client-side). Ordem das séries no modo Ticker: por contribuição total decrescente na janela visível (não há uma ordem fixa como `COMPOSITION_CLASS_ORDER`). Cores no modo Ticker vêm de `TICKER_PALETTE` (array cíclico), já que não há um mapa fixo de cor por ticker como `COMPOSITION_COLORS`. Bank Bonds no modo Ticker: `computeBankBondsValueAt(...).byTicker` sobrepõe o valor de cada CUSIP individualmente (a função já retornava essa granularidade, usada agora pela primeira vez).
- **Toggle Area/River (jul/2026):** `SegmentedToggle` alterna `chartStyle` entre `"area"` (default, `stackOffset="expand"`, eixo Y 0-100%) e `"river"` (streamgraph, `stackOffset="wiggle"`, eixo Y oculto, grid horizontal oculto — só as linhas verticais de data permanecem). Ambos os controles (Class/Ticker e Area/River) ficam na mesma linha do filtro de período, alinhados à direita da linha (pedido do usuário, referência visual: um "theme river" chart anexado no chat).
- **Débito técnico conhecido (não-bloqueante):** `CompositionCard` duplica estilos inline (`cardHeaderStyle`/`cardBodyStyle`) por estar fora do closure de `PerformanceView` (forçado por escopo). Campos `pos.lastBuyDate`/`pos.lastBuyNotes` em `positionRows` ficaram mortos (calculados mas não mais lidos) após a extração do helper — limpeza cosmética pendente. Testes formais para `computeCompositionSeries`/`computeBankBondsValueAt` ainda não existem em `test/perf-history.test.mjs` (validado com sanity-checks ad-hoc, não incorporados ao suite).

### Tabela: Position Performance

Card colapsável "Position Performance" (PR #38), mesmo padrão visual. Toggle "By Class / By Ticker" posicionado no header do card, alinhado a direita (PR #93). `e.stopPropagation()` no handler do toggle impede colapso acidental do card.

**Colunas (10, todas clicáveis com sort asc/desc):**

```
Ticker (sticky) | Avg Cost | Price | Qty | Total Cost | Current Value | Total Gain/Loss | Gain/Loss % | Div TTM | YoC %
```

- Default sort: Current Value desc
- Linha **TOTAL** fixa no topo
- **Group by class:** subtotais por asset class, grupos colapsáveis com chevron
- Ativos BR incluídos via `h.fxRate` (fallback: `h.originalPrice / h.price`)
- Asset class lida de `tx.assetClass`
- Eye toggle: mascara valores em $; % sempre visível
- **Div TTM** (PR #67): dividendos recebidos nos ultimos 365 dias, em USD. Mascarado por `valuesHidden`. Tickers sem dados exibem `--`.
- **YoC %** (PR #67): yield on cost = Div TTM / Total Cost x 100. Sempre visivel (nao mascarado). Linha TOTAL usa media ponderada: `sum(ttm) / sum(totalCost)`.
- Dados de dividendos via fetch paralelo de `POST /api/dividends` com `Promise.allSettled` — falha silenciosa, nao quebra a tab.
- `minWidth` da tabela: 1060px (era 860px antes do PR #67).
- **Filtro multi-select de ticker (PR #126, draft):** icone `Filter` sempre visivel no `<th>` Ticker (`e.stopPropagation()` para nao acionar o sort da coluna), abre `TickerFilterPopover` local com checkboxes. `tickerFilter` (Set, vazio = sem filtro) aplicado em `sortedRows`, na linha TOTAL (`aggFromRows`) e nos `classGroups`. `allTickers` do popover sempre derivado das rows nao filtradas. State efemero, independente da mesma feature em Position Dividends (`Dividends.jsx`).

### Cache versioning

| Versão | Motivo do bump |
|--------|----------------|
| v10    | Adicionou `portfolioUSD` à resposta |
| v11    | `INCLUDED_CLASSES` expandido (PR #37 + #39) |
| v12    | Cache key inclui hash das transactions — invalida automaticamente quando transactions mudam |
| v13    | Adicionou o campo `composition` à resposta (feature Composition Evolution, jul/2026) — mudança de shape |
| v14    | `composition` passou de `classValues` (agregado por classe) para `tickerValues`+`tickerClass` (por ticker) — permite filtro de Asset Class/Ticker 100% client-side no card Composition Evolution (jul/2026) |

### Estados especiais

Loading / erro / vazio com mensagens específicas por `meta.reason`.

### Limitações conhecidas (MVP)

- **Finnhub free tier:** ~1 ano de histórico diário
- **Fixed income sem preço de mercado:** CDs e Tesouro ignorados silenciosamente no cálculo do gráfico (aparecem na Position Performance via preço manual)
- **TWR** escolhido vs benchmark; MWR/IRR fica pra Fase 2
- **Position Performance usa câmbio atual** para ativos BR
- **Cache v14** com hash de transactions — invalida automaticamente quando transactions mudam (antes, cache de `perf-history` ficava stale após edições); bump v12→v13 foi pelo campo novo `composition` (Composition Evolution, jul/2026); bump v13→v14 foi a mudança de `classValues` para `tickerValues`/`tickerClass` (filtro client-side, jul/2026)
- **Composition Evolution exclui `BRA Fixed Income`** — sem preço de mercado disponível, sem fallback flat (mesma limitação de Tesouro/CDs no gráfico de TWR)

-----

## 🏠 Feature: Holdings (resumo)

- **Layout:** lista compacta — cada holding é um `HoldingRow` com linha principal e painel colapsável
- **Holdings manuais:** `ManualHoldingRow`
- **Cash:** ID permanente `CASH_ID = "cash-permanent"`, garantido por `ensureCashAccount()`
- **Badge B3:** visível para holdings com `market === "B3"`
- **Eye Toggle (`valuesHidden`):** state global em `App.jsx`, persiste em `localStorage`. Prop passado para `<TransactionsView>` e `<PerformanceView>`.
- **Manage Users:** seção colapsável no dashboard, visível apenas para `isAdmin`
- **Como adicionar holdings (PR #84 — jun/2026):** O formulario "Add Live Asset" foi removido. Tickers `type: "auto"` sao criados/atualizados exclusivamente via sync com o log de Transactions (item 32/33). Apenas o form "Add Manual Asset" permanece na tab Holdings — para holdings manuais e Cash.
- **Delete de auto holdings bloqueado na UI (PR #114 — jun/2026):** Botao Trash2 removido do `HoldingRow` (`type: "auto"`). Para remover um auto holding, o usuario deve deletar as transacoes correspondentes na tab Transactions. Holdings manuais puros (`type: "manual"`, sem `derivedFromTransactions`) continuam com botao de delete disponivel. Funcao `removeHolding` permanece (usada por `ManualHoldingRow`).
- **Bulk Import de Asset Allocation via CSV (PR #115 — jun/2026):** Botao "Import Allocation Targets" abre modal de 2 steps (Upload -> Preview). CSV de 2 colunas: `ticker, target %`. 3 actions no preview: "Update target" (ticker ja existe), "From transactions" (cria holding auto-style com asset class das transactions), "New holding" (ticker novo, exige dropdown de asset class + validacao async via `GET /api/price`). Holdings novos criados com `qty: 0` e `fromCSVImport: true` — compativeis com `applyTxQty`. `HoldingRow` mostra botao delete e dropdown de asset class para `fromCSVImport: true`; ambos desaparecem quando o ticker ganhar transactions. Bank Bonds nao criavel via CSV (aviso inline).
- **Botao movido para fora do card Holdings (jul/2026 — commit c8c891f, merged em main):** o botao "Import Allocation Targets" (antes acoplado ao header `SectionLabel` "Holdings", so visivel com `filteredHoldings.length > 0`) agora vive em um `<section>` proprio, sempre visivel, posicionado imediatamente acima do card "Add Manual Asset" em `src/App.jsx`. Estilo replica o card "Add Manual Asset" (mesmo card style + tipografia mono dourada uppercase + icone). Puro reposicionamento visual — logica de import (handler, `ImportModal`, `csvImportStep`, `csvImportRows`, `showCSVImport`) inalterada.
- **SectionLabel com acento dourado (PR #113 — jun/2026):** Componente `SectionLabel` em `src/App.jsx` recebeu um `<div>` de acento — gradiente `linear-gradient(to right, ${T.gold}, transparent)`, `height: 2px`, `position: "absolute"`, `top: 0`, `left: 0`, `right: 0` — como primeiro filho do wrapper. Wrapper ganhou `position: "relative"` e `overflow: "hidden"`. `fontSize` do label: `9` → `12`. Usado em exatamente 2 lugares na tab Holdings: "Your Holdings" e "Cash & Fixed Income". Padrao visual identico ao dos cards de destaque da tab Contributions.
- **Auto-hide de holdings zerados sem target allocation (PR #117 — jun/2026):** Holdings com qty/value zero e sem `target > 0` sao ocultados visualmente em `filteredHoldings` (useMemo em `App.jsx`) — nao sao deletados do Redis. Helper module-level `isZeroHolding(h)` cobre os 3 modos: manual qty_price (`qty === 0`), manual value (`manualValue === 0`), auto (`qty === 0`). Regra: `isZeroHolding(h) && !(h.target > 0)` → suprimido. Holdings com target definido permanecem visiveis (placeholders intencionais de rebalance). Denominador do `SectionLabel of={}` usa o mesmo filtro para manter contagem consistente. Cash accounts nao sao afetados (`isCash` roda antes do filtro).

### Holdings manuais — Bank Bonds (PR #93 — jun/2026)

Holdings com `assetClass.includes("Bank Bonds") || derivedFromTransactions === true` sao protegidos de edicao parcial no modal de edicao (`ManualHoldingRow`):
- Input de valor, input de asset class, botao remove e popup de class edit sao ocultados/desabilitados (guard `isBankBonds`).
- `saveEdit` pula patch de `manualValue`, `assetClass`, `assetClassOverride` quando `isBankBonds`.
- Target% permanece editavel normalmente.
- Razao: o holding `bank-bonds-aggregate` e derivado de Transactions (item 37) — permitir edicao manual criaria divergencia entre o holding e o calculo de principal.

### Holdings manuais — BRA Fixed Income (PR #49 — jun/2026)

Holdings com `assetClass === "BRA Fixed Income"` aceitam valor em BRL (`manualCurrency: "BRL"`):
- Seletor **USD / R$ BRL** nos forms de adicionar/editar
- Valor exibido: BRL ao lado do USD convertido na linha do holding
- Conversão via `usdBrlRate` — buscado em `GET /api/price?fx=USDBRL` (cascata Finnhub → open.er-api → Frankfurter), cacheado em localStorage, atualizado no load e no "Refresh all"
- Tesouro Direto sem fonte live gratuita — mantido manual em BRL (ver Lições Aprendidas)
- CDB Banco Guanabara (`121,50% CDI, venc. out/2028`) — manual em BRL até vencimento; não será renovado

-----

## 💵 Feature: Contributions (Tab Aporte Quinzenal — PR #112 — jun/2026)

Tab para planejamento e acompanhamento de aportes quinzenais. Arquivo `src/AporteQuinzenal.jsx`.

### Logica de rollover de quinzena (Chunk A — frontend puro)

- `planTotal` = total do mes fixo (entrada manual: Fixed + Dividends + DELL + Extras).
- 1a quinzena: meta = `halfPlanned = planTotal / 2`; realizado = `half1Auto` (derivado de Transactions via `computeHalfInvested`).
- 2a quinzena: meta = `half2Target = halfPlanned + max(0, halfPlanned - half1Auto)`. Deficit da 1a rola; excesso na 1a reduz a meta da 2a. Total do mes nunca muda.
- UI: sufixo "+R$X rollover" na card da 2a quinzena quando ha deficit.
- Linha totalizadora "Month total / Invested / Remaining for month" = `max(0, planTotal - (half1Auto + half2Auto))`. Exibe estado "Month Done" em verde quando quitado.

### Historico de capacidade de aporte (Chunk B — Redis)

#### Storage

- Chave Redis: `portfolio:<auth.storageKey com :holdings substituido por :contributions-history>:contributions-history` — objeto JSON mapeando `"YYYY-MM"` para snapshot.
- Formato do snapshot: `{ monthlyFixed, dividends, dellSale, extras, planTotal, invested, savedAt }`.
- **Sem versionamento `vN`:** e um store de upsert proprio, nao um cache de calculo. Snapshots sao permanentes; o mes corrente e sobrescrito a cada load (idempotente).
- Endpoint: `api/contributions-history.js` (GET + PUT). `authenticate(req)` de `lib/auth.js`. `getRedis()` de `lib/redis.js`. PUT e read-modify-write: le o objeto existente, faz merge do mes corrente, grava de volta — preserva meses passados.
- **Arquivo tambem serve uma segunda rota nao relacionada a Contributions (PR #128, jul/2026):** `?resource=alerts-read` (funcao `handleAlertsRead`) sincroniza o estado "lido" do painel de Alerts (Bell) — consolidado aqui em vez de um arquivo `api/alerts-read.js` novo por causa do limite de 12 Serverless Functions do Vercel Hobby plan. Ver "Painel de Alerts" e Decisoes Tecnicas.

#### Auto-snapshot

A cada load do componente, o mes corrente e enviado via PUT com os valores atuais. Meses passados nunca sao sobrescritos.

#### Tabela "Contribution Capacity History"

Renderizada em `src/AporteQuinzenal.jsx`. Colunas: Month, Fixed, Dividends, DELL, Extras, Planned, Invested, Balance. Scroll horizontal com `overflowX: auto` + `WebkitOverflowScrolling: touch` para iPhone. Valores mascarados por `valuesHidden`. Ordenada mais-recente-primeiro. Celulas sem dado (meses anteriores ao primeiro uso) exibem `--`.

#### Limitacao conhecida

Meses anteriores ao primeiro uso da feature nao possuem `monthlyFixed`/extras gravados no Redis — o historico so existe a partir da primeira vez que o usuario carregou a tab apos o deploy do PR #112. O historico se acumula organicamente daqui para frente.

#### Restore de `extras` a partir do snapshot Redis (bug fix — PR #118 — jul/2026)

O auto-snapshot do Redis **nao e write-only**: ele tambem serve como rede de seguranca de leitura. Bug original: usuario adicionava uma extra label no card "Monthly Plan" (ex: "BRK.B Sale - $3500") e ela sumia ao reabrir o app no dia seguinte, porque `localStorage["aporteConfig"]` era a unica fonte de verdade para `config.extras` e podia ser perdido (ex: Safari iOS limpando site storage).

Fix: `useMemo` `currentMonthSnapshot` le `capacityHistory[currentMonthKey()]`; `useEffect` de restore one-time (guard via ref `seededExtras`, mesmo padrao ja usado por `seededFixed` para `monthlyFixed`) repopula `config.extras` a partir do snapshot Redis do mes corrente **somente quando** o array local esta vazio E o snapshot tem `extras.length > 0` — nunca sobrescreve edicoes feitas pelo usuario apos o load inicial. Mapeia o shape do Redis (`{name, amount}`) de volta para o shape do estado local (`{label, value}`).

**Nao repetir:** qualquer novo campo de `aporteConfig` (localStorage) que tambem seja snapshotted no Redis deve seguir esse mesmo padrao de restore one-time — caso contrario o snapshot fica write-only e nao protege contra perda de localStorage. Limitacao que permanece: `aporteConfig` ainda nao tem month-scoping real (blob global no localStorage), e se o PUT do snapshot falhar silenciosamente antes do localStorage ser perdido, os dados sao irrecuperaveis.

-----

## 💰 Feature: Dividends (em construção)

Tab nova, arquivo separado (`src/Dividends.jsx`), lazy-loaded como Performance. **US assets only** — income manual foi descartado (decisão jun/2026): a tab cobre apenas dividendos de ativos US via Yahoo. Tesouro/Bank Bonds/BRA Stocks ficam fora por ora.

### Storage

- **Auto income** (US Stocks/ETFs): calculado server-side por `api/dividends.js`, cache Redis versionado. Sem storage manual.
- **Fidelity dividend import (PR #95):** linhas `DIVIDEND RECEIVED`/`CASH DIV` capturadas por `parseFidelityCSV` e armazenadas em `bondIncome` (campo `bondIncome` no blob de `/api/transactions`, mesmo store de interest payments). Campo `kind: "dividend"` distingue de interest (`kind: "interest"`). Enviadas a `/api/dividends` no POST body como fonte autoritativa para os tickers cobertos.

### Fontes de dados (validadas via probe PR #58)

| Asset class | Fonte | Metodo |
|---|---|---|
| US Stocks, ETFs, REITs, Bonds ETFs | Yahoo `chart?events=div` | Auto server-side |
| Bank Bonds (CDs/bonds) | Pagamentos reais (Fidelity "INTEREST") + accrual estimado no gap | Frontend-only; income real no campo `bondIncome` de `/api/transactions` |
| BRA Stocks / BRA Fixed Income | Sem API gratuita | Fora do escopo atual |

### `api/dividends.js` (POST)

- Recebe `{ transactions, bondIncome?, todayISO? }` — `todayISO` documentado no item de timezone abaixo
- Filtra tickers US (non-B3) em `AUTO_CLASSES` (`Stocks`, `Real Estate`, `Alternative`, `Bonds`, `BRA Stocks`)
- **Bank Bonds (CUSIP) nao passam por este endpoint** — income e calculado no frontend (accrual estimado + pagamentos reais do campo `bondIncome`, itens 36/follow-up, PR #86 + #87)
- **Fidelity dividend import (PR #95):** eventos `kind: "dividend"` de `bondIncome` usados como fonte autoritativa — `totalReceived` exato (sem reconstrução por $/share × qty). Tickers cobertos por Fidelity pulam Yahoo e Finnhub inteiramente. Cache key inclui hash dos eventos Fidelity (`fd:${hash}`).
- Para tickers NÃO cobertos por Fidelity: busca `chart?events=div` via Yahoo para cada ticker (mesmo host de `perf-history.js`), concorrencia 3
- **Fallback Finnhub:** quando Yahoo retorna null ou objeto vazio (`{}`), chama `fetchFinnhubDividends(ticker, apiKey)` via Finnhub `/stock/dividend`. Finnhub inclui `payDate` diretamente — lookup Polygon e pulado para esses eventos. Reutiliza `FINNHUB_API_KEY`. Confirmado necessario para ADRs US-listados como VALE (NYSE). (PR #94)
- Calcula `qtyHeld` na pay-date cruzando com transactions; ignora eventos com qty <= 0
- Retorna `{ events: [{ date, ticker, assetClass, incomeType: "dividend", amountPerShare, qtyHeld, totalReceived, currency: "USD", source: "api"|"fidelity", payDateUncertain? }], foreignTax: [{ date, ticker, assetClass, incomeType: "tax", totalReceived (negativo), currency: "USD", source: "fidelity" }], meta }`
- **Per-(ticker, month) dedup de Fidelity (jun/2026):** Antes, qualquer import Fidelity que cobrisse um ticker o excluia completamente do fetch Yahoo para todos os meses. Corrigido: dedup usa Set `fidelityCoveredMonths` com chave `ticker|YYYY-MM`. Apenas os meses realmente cobertos pelo import ignoram o Yahoo; demais meses do mesmo ticker continuam buscando historico normal.
- **Fix pay-date de ADRs sem cobertura Polygon — caso TSM (jul/2026, merge `d0054d4`):** quando um evento vindo do Yahoo (ex-date + amount) nao resolve pay-date via Polygon, um segundo lookup lazy-por-ticker e disparado via Finnhub `/stock/dividend` (cache Redis dedicado `dividends:paydates:finnhub:v1:{TICKER}`, TTL 7 dias, separado do cache Polygon `dividends:paydates:v1:{TICKER}`) — caminho ADICIONAL que coexiste com o fallback Finnhub do PR #94 sem duplicar eventos. Se nem Polygon nem Finnhub resolvem o pay-date, o evento **nao e descartado**: a ex-date continua sendo usada como `date` (comportamento anterior preservado), mas o evento `source: "api"` ganha `payDateUncertain: true` — requisito nao-negociavel do usuario de nunca mais ter um fallback silencioso pra ex-date. Eventos `source: "fidelity"` e `source: "estimated"` (accrual de Bank Bonds) nao recebem esse campo (nao se aplica). Novo contador `meta.payDatesResolvedViaFinnhub`. Sem `FINNHUB_API_KEY`, degrada graciosamente pra `payDateUncertain: true` sem quebrar. `CACHE_VERSION` `v7 → v8` (shape do evento mudou).
- **$/share e qty derivados tambem para eventos Fidelity (jul/2026, `v8 → v9`):** antes sempre `null` (exibido "—"). Agora `qty = qtyAtDate(transactions, ticker, date)` (mesmo helper dos eventos API) e `amountPerShare = fe.amount / qty` — aproximacao (entitlement e tecnicamente na ex-date, que o export da Fidelity nao da; usamos a data de credito), mas correta no caso comum.
- **Foreign tax withheld em dividendos de ADR — caso TSM/VALE (jul/2026, `v9 → v10`):** linhas `"FOREIGN TAX PAID"` do extrato Fidelity (antes descartadas silenciosamente pelo parser) agora sao capturadas como `bondIncome` `kind: "tax"` e retornadas num array `foreignTax` **separado** de `events` — a linha de dividendo continua com o valor bruto exatamente como a Fidelity reportou (nunca subtraido no proprio endpoint). API mantem a separacao por design (evento de dividendo = fato bruto, imutavel); quem decide onde/como netear e a UI.
  - **Correcao (jul/2026, mesmo dia):** a primeira versao do frontend mergeava `foreignTax` **so** na tabela Dividend History, sob a suposicao errada de que o valor do dividendo ja vinha liquido. Conferido contra um export real da Fidelity: o valor **e bruto** (ex: TSM $8.45 bate exatamente com a taxa oficial $/ADS × qty). Fix: `foreignTax` agora e mergeado direto no `allEvents` de `Dividends.jsx` e `Performance.jsx` (nao mais so na tabela de auditoria) — abate automaticamente de KPIs (All Time/YTD/Month), Income History chart, Position Dividends, Y/Y, Total Return e Div TTM/Total/YoC de Position Performance. `AporteQuinzenal.jsx` (KPI "dividends last month") tambem passou a netear. **Fora do escopo:** o painel de Alerts em `App.jsx` (badge "Dividend paid: $X" de hoje) usa `api/events.js`, um pipeline separado que nao consome `bondIncome`/dados da Fidelity — continua mostrando o valor ao vivo do Yahoo/Polygon, sem tax.
- **Fix — "hoje" usava UTC do servidor em vez do dia local do usuario (jul/2026, `v10 → v11`):** `api/dividends.js` computava `todayISO` via `new Date().toISOString().slice(0,10)` (relogio UTC do Vercel), usado no guard `if (date > todayISO) continue` que exclui dividendos ainda nao pagos. Pra timezones de offset negativo (US Central, Brasil, etc), o UTC vira o dia seguinte horas antes da meia-noite local — caso real confirmado: as 22h50 CDT de 14/jul (UTC ja em 15/jul), a Tab Dividends inteira ja contava um dividendo datado 15/jul como recebido, um dia inteiro adiantado pro usuario. Fix: endpoint agora aceita `body.todayISO` opcional (valida formato `YYYY-MM-DD`) e usa no lugar do UTC do servidor quando presente; sem fallback quebrado (usa UTC se o cliente nao mandar). Os 3 callers (`Dividends.jsx`, `Performance.jsx`, `AporteQuinzenal.jsx`) passaram a enviar `localTodayISO()` — mesmo helper/padrao ja usado em `App.jsx` (Alerts) e `Events.jsx` (agrupamento cronologico, PR #128). `CACHE_VERSION` `v10 → v11` pra invalidar respostas cacheadas com o corte errado.
- Cache Redis versionado (`:dividends:v11:<txHash>`), TTL ate proximo fechamento do mercado US

### UI (`src/Dividends.jsx`)

- **Income History card** (mesmo design do "Portfolio Performance & Net Worth"): titulo + KPIs (All Time / YTD / This Month) **dentro** do card. Bar chart com views `Month | Quarter | Half | Year`.
  - **Filtro por ano** (PR #62): dropdown `<select>` com "All years" + anos presentes nos dados (ordem decrescente). Substituiu os inputs de date range From/To.
  - **Filtros de ticker e asset class no bar chart** (PR #89): originalmente dois dropdowns single-select acima do bar chart (opcoes derivadas dos eventos carregados, indicador de borda dourada quando filtro ativo). **Evoluidos para multi-select via popover custom no PR #124 — ver abaixo.**
  - **Redesign visual do bloco de filtros do grafico (PR #119, jul/2026):** so reorganizacao de layout, sem mudanca de logica/dados. Seletor de granularidade (era botoes "Month"/"Quarter"/"Half"/"Year") agora mostra labels curtos **M / Q / H / Y** (texto completo continua acessivel via `title` no hover/long-press) e foi movido para ficar colado imediatamente acima do grafico. Ordem final das secoes de filtro: Year filter -> Ticker/Asset Class filter (selects) -> seletor M/Q/H/Y. O bloco de texto descritivo ("US dividends only...") e o espacamento abaixo do grafico foram removidos.
  - **Filtros Year/Ticker/Asset Class viram multi-select com popover custom (PR #121-#124, jul/2026):** continuacao do PR #119, mesmo arquivo. **PR #121:** Year virou multi-select via `<select multiple>` nativo. **PR #122:** opcao "All years" removida; botao "Clear" dedicado adicionado. **PR #123:** botao Clear movido para um "x" sobreposto no canto superior direito de cada seletor. **PR #124 (final):** `<select multiple>` nativo abre um bottom-sheet OS-controlado no iOS/WebKit sem hooks de customizacao (sem como injetar um botao Clear no header nativo, que so tem setas de navegacao + um X que apenas fecha, sem resetar selecao) — os 3 selects nativos (Year, Ticker, Asset Class) foram substituidos por um componente proprio `FilterMultiSelect`: chip-trigger que abre um popover proprio (nao nativo) com checkboxes e header "Clear" + "x" lado a lado, controle total do visual. Ticker e Asset Class tambem viraram multi-select (antes single-select com opcao "All ..."). Labels dos triggers mostram "Years"/"Tickers"/"Classes" quando nada esta selecionado (antes "All tickers"/"All asset classes"). Resultado: tres chips lado a lado acima do grafico, cada um abrindo popover custom de checkboxes; seletor M/Q/H/Y (PR #119) permanece colado ao grafico logo abaixo. Ver Decisoes Tecnicas e Licoes Aprendidas para o motivo tecnico da migracao.
  - **Y/Y nos KPIs YTD e This Month** (PR #62): variacao percentual ano-a-ano exibida abaixo do valor principal. `priorYtd` e `priorMonth` calculados no useMemo `kpis`.
  - **Comparador Mes Anterior vs Mes Atual** (PR #64): bloco "Month vs Month" no topo do card. Dois cards lado a lado — "Prev Month" (mes anterior completo) e "This Month" (acumulado ate hoje) — com delta percentual MoM (verde/vermelho) e nomes dos meses por extenso. Campos adicionados ao useMemo `kpis`: `prevCalMonth`, `momDelta`, `thisMonthLabel`, `prevMonthLabel`. Bloco oculto quando filtro de ano e historico (diferente do ano corrente). Zero novo fetch.
  - **Bank Bonds interest em todos os cards (PR #86 + #87 + #88, item 36; bugfix jul/2026 — commit d93cd87, merge b96922a):** `buildBondEvents(transactions, bondIncome)` no frontend gera eventos no **mesmo shape** dos dividendos de acoes — pagamentos reais (`source: "fidelity"`, do campo `bondIncome` importado do Fidelity "INTEREST") + accrual estimado (`source: "estimated"`, ACT/365, preenchendo so o gap apos o ultimo pagamento real, sem double-count). **Accrual dimensionado pela frequencia real calibrada do bond** — `freqByCusip[cusip]` (calibrada por >=2 pagamentos reais) -> fallback `couponFreq` do parser Fidelity -> fallback `"monthly"` so na ausencia total de dado — nao mais por blocos de calendario mensal fixo; bonds trimestrais/semestrais so geram "EST" no mes em que ha cupom real. Um evento "EST" so e emitido quando o periodo de accrual esta **inteiramente decorrido** dentro de `[accrueFrom, endISO)` — o periodo corrente incompleto nunca vira uma estimativa "paga" datada arbitrariamente em "hoje". `accrueFrom = ultimoPagamentoReal + 1 dia` (nao mais o proprio dia do pagamento) elimina o "coto" residual sobreposto ao pagamento recem-importado. O array `allEvents` (acoes + bonds) alimenta **todos** os cards: KPIs (subtitulo adaptativo "est. bond interest" / "bond interest (real + est.)" / "bond interest"), bar chart, Position Dividends (YoC/Recovered de CUSIPs via cost basis), Dividend History (badge "EST" nas linhas estimadas, "—" em $/Share e Qty) e tabela Y/Y. Comparacoes Y/Y % excluem eventos estimados (sem contraparte no ano anterior). `freqByCusip` calibrado tambem alimenta o sub-header do card Bond Projections (PR #107). Ver "Bug fix — Bond Interest estimate gerava pagamentos fantasma" em Decisoes Tecnicas e Licoes Aprendidas.
- **Dividends Monthly Map** (jul/2026, merge `bfe852c`): card colapsavel (fechado por default, `mapOpen` state), posicionado logo apos "Income History" e antes de "Position Dividends". Heatmap ano x mes do total de dividendos recebidos por mes — soma de `totalReceived` de `allEvents` (mesmo dado ja usado pelos KPIs: stock dividends + bond interest + foreign tax negativo, valor liquido). Escala de cor single-hue dourada (`heatColorAmount`, baseada em `T.gold`), intensidade proporcional ao valor do mes. Coluna "Total" por ano = soma simples dos 12 meses (nao TWR/compounding). Meses sem eventos ficam com celula transparente, sem "0". Anos em ordem decrescente. 100% derivado de dados ja carregados no client — sem chamada de API nova.
- **Position Dividends** (card no padrao de "Position Performance"): colunas Ticker (sticky) · Total · YTD · Y/Y YTD · YoC · Recovered. Sortavel, linha TOTAL no topo. **YoC** = dividendos TTM / cost basis (yield on cost convencional). **Recovered** = dividendos acumulados / cost basis (quanto do custo ja voltou via proventos). Y/Y YTD = este ano vs mesmo periodo ano anterior.
  - **Toggle By Ticker / By Asset Class** (PR #62, movido para header PR #93): toggle posicionado no header do card, alinhado a direita; `e.stopPropagation()` impede colapso acidental. Quando "By Asset Class", agrega dividendos por classe derivando a classe das transactions. Header sticky muda de "Ticker" para "Class".
  - **By Class colapsavel com chevron (PR #92):** modo "By Asset Class" agora exibe grupos colapsaveis identico ao `YearVsYearTable`. `buildClassGroups()` computa subtotais; `collapsedClasses` state (Set) + `toggleClass()` handler; `renderGroupHeaderRow()` com ChevronDown rotacionado -90deg quando collapsed. Default: todos os grupos fechados ao montar com `groupMode === "class"` (via `useEffect`). Ao expandir, exibe tickers individuais ordenados por total desc. Funcao `buildAssetClassRows` (modo flat legado) foi removida.
  - **Filtro multi-select de ticker (PR #126, draft):** mesmo padrao de `TickerFilterPopover` da Position Performance (icone `Filter` no header Ticker, popover custom com checkboxes) — componente duplicado localmente neste arquivo, state independente. Aplicado em `displayRows`, na linha TOTAL (`aggPositions`) e em `buildClassGroups`.
- **Dividend History** (auditoria): tabela colapsavel com todo historico de pagamentos (Date · Ticker · $/Share · Qty · Total), ordenada por data desc, scroll vertical. Quarto card — apos "Dividends Monthly Y/Y".
  - **Badge "EX-DATE" (jul/2026, merge `d0054d4`):** exibido na coluna Ticker quando `e.payDateUncertain === true` — cor ambar `#e0a458` (mesmo padrao visual do badge "EST" de bond interest estimado, mas cor/texto distintos para nao confundir as duas semanticas: "EST" = valor estimado, "EX-DATE" = data incerta). Tooltip complementar explica que a data exibida e a ex-date, nao a pay-date real confirmada. Agregados (Income History chart, KPIs All Time/YTD, Position Dividends) foram deixados intocados de proposito — o `totalReceived` e o mes de bucketing continuam corretos mesmo quando a granularidade exata do dia e incerta; so a UI de detalhe (Dividend History) precisa do aviso.
  - **Foreign tax withheld — badge "TAX" + breakdown gross/tax/net (jul/2026):** o array `foreignTax` retornado por `api/dividends.js` e mergeado direto no `allEvents` (ver acima) — visivel em toda a tab, nao so aqui. Nesta tabela, linhas de imposto aparecem com badge vermelho "TAX", `$/Share`/`Qty` = "—", `Total` negativo em vermelho. Quando ha ao menos uma linha de imposto visivel, uma barra de resumo Gross/Foreign Tax/Net aparece acima da tabela — o `TOTAL` row ja soma tudo automaticamente (dividendos + impostos negativos = liquido), sem calculo extra.

### Dividends Monthly Y/Y (ex-"Year vs Year Table", itens 29/41/42/43 — jun/2026)

- `buildYoyData(events)` — funcao pura fora do componente, chamada via `useMemo`. Agrupa eventos por ticker e mes para o ano corrente vs ano anterior.
- **Card "Dividends Monthly Y/Y"** (renomeado de "Year vs Year"): colapsavel, posicionado na ordem (1) Income History, (2) Position Dividends, (3) Dividends Monthly Y/Y, (4) Dividend History.
- **Month selector:** dropdown com todos os meses com dados (CY ou PY). Default = mes corrente (`new Date().getMonth() + 1`) se presente nos dados; caso contrario, ultimo mes com dados.
- **Tabela:** linhas = assets, colunas = PY (muted) · CY · Delta $ · Delta %. Linha TOTAL fixa no topo. Scroll horizontal no mobile. Empty state por mes.
- **Headers sortaveis (jul/2026 — commit `0ecde97`):** click no header de qualquer coluna ordenavel alterna asc/desc (`sortCol`/`sortDir` state), com indicador visual `↕` (inativo) / `↑`/`↓` (ativo) — mesmo padrao do `PositionDividendsTable` no mesmo arquivo. Default `sortCol: "cy"`, `sortDir: "desc"` (antes: sort fixo por `cy+py` combinado, sem toggle). Ordenaveis: nome (string, `localeCompare`), PY, CY, Delta $ (`cy-py`), Delta % (`py>0 ? (cy/py-1)*100 : null`, nulls sempre no fim). Aplicado nos 3 niveis (classGroups, tickers dentro de grupo, tickerRows flat); linha TOTAL fica fora do sort.
- **Group by Asset Class colapsavel (item 43):** state `collapsedClasses` (Set), `toggleClass`, `classGroups` useMemo, `renderGroupHeaderRow` com ChevronDown rotacionado. Default collapsed ao ativar "By Class" — todos os grupos fechados, mostrando so a linha de subtotal do grupo. `useEffect` com `[groupMode]` dep re-colapsa grupos ao trocar para "By Class" (PR #93). Ao expandir, exibe tickers individuais da classe. Toggle "By Ticker" retorna para view flat. Toggle posicionado no header do card, alinhado a direita (PR #93). Mesmo padrao visual do Position Performance.
- Nota de UX: quando um ticker pagou no ano anterior mas nao pagou no mes do ano atual, o indicador "tri 100%" nao e exibido — aceitavel para agora, pendente de polish futuro.

### Card Bond Projections (5º card — commit d6dc43b, estendido PR #107)

Card colapsável adicionado como 5º card na tab. Função pura `buildBondProjections(transactions, bondIncome, freqByCusip, todayISO, nMonths=12)`:

- **Forward-only:** a partir do último pagamento real (de `bondIncome`), avança pelo intervalo de frequência até `min(maturityISO, today+12m)`.
- **Frequência calibrada:** usa `freqByCusip[cusip]` (calibrado pelos pagamentos reais do Fidelity); fallback: `tx.couponFreq` → `"monthly"`.
- **intervalDays fixo por frequência:** `monthly=30`, `quarterly=91`, `semi-annual=182`, `annual=365` — aproximação ACT, não dia exato do calendário.
- **Valor estimado:** `principal × couponPct/100 × intervalDays/365`.
- **CUSIPs excluídos:** `principal=0` ou `maturity` já passada.
- **UI:** sub-header por bond exibe frequencia calibrada + coupon rate + maturity date (ex: "Monthly · 5.45% · Matures Mar 2027") — renderizacao adicionada no PR #107. Tabela Date | Est. Amount, total por bond, badge "EST". Valores mascarados por `valuesHidden`.
- **`FREQ_DAYS` module-level compartilhada (bugfix jul/2026 — commit d93cd87):** o mapa frequencia→dias, que so `buildBondProjections` usava corretamente, foi promovido a constante module-level em cada arquivo (`Dividends.jsx`, `Performance.jsx`) e passou a ser reaproveitado tambem por `buildBondEvents` (accrual do Income History), que antes ignorava a frequencia calibrada e fatiava sempre por mes de calendario — ver "Bug fix — Bond Interest estimate gerava pagamentos fantasma" abaixo.

-----

## 📅 Feature: Events (commit aecef28 — jun/2026)

Tab nova, arquivo separado (`src/Events.jsx`), lazy-loaded como Performance e Dividends. **US tickers only** — BRA Stocks excluidos (sem API gratuita de earnings/splits para B3). Apenas tickers US (non-B3, non-CUSIP, non-tesouro-*) extraidos das Transactions do usuario sao enviados ao endpoint.

### Endpoint `api/events.js`

- `POST { tickers }`, auth obrigatoria (mesmo padrao de `api/dividends.js`)
- Janela server-side: `hoje-30d` a `hoje+90d`, resultados ordenados por data asc
- Cache Redis **GLOBAL** (sem storageKey): chave `events:v1:{hash(tickers_ordenados)}`, TTL ate proximo fechamento do mercado US — eventos de calendario sao fatos publicos; usuarios com os mesmos tickers compartilham cache
- Falhas por ticker/fonte sao silenciosas: campo `meta.tickersFailed` acumula erros; resposta nunca derruba por falha parcial

### Tipos de evento

| Tipo | Fonte primaria | Fallback |
|---|---|---|
| `ex_dividend` | Yahoo `chart?events=div` | Finnhub `/stock/dividend` (para ADRs) |
| `payout` | Gerado quando payDate (Polygon cache) difere da ex-date | — |
| `split` / `reverse_split` | Yahoo `chart?events=split` | Polygon `v3/reference/splits` |
| `earnings` | Finnhub `/calendar/earnings` | Yahoo `chart?events=earn` |

- `payout` reutiliza o cache Polygon de pay dates ja warm pela Tab Dividends (`dividends:paydates:v1:{ticker}`) — sem custo adicional de API
- `meta.earningsSource` reporta de onde vieram os earnings (`finnhub` | `yahoo`)
- Eventos `split` com `denominator > numerator` = reverse split

### UI `src/Events.jsx`

- Export default `EventsView({ auth, onAuthFail, valuesHidden })` — `valuesHidden` mascara os valores em $ de dividendo (jul/2026; antes recebido mas nao usado, ver item abaixo)
- Busca `GET /api/transactions` ao montar (tambem le `bondIncome`, jul/2026), extrai tickers US elegiveis (exclui B3 via `isBrazilianTicker`, CUSIPs, `tesouro-*`), entao `POST /api/events`
- Filtro client-side por tipo: pills All | Ex-Div | Payout | Earnings | Split — sem novo fetch ao mudar o filtro
- Agrupamento cronologico: "Last 7 Days", "Last Month", "Today", "This Week", "Next Week", depois buckets mensais "Mon YYYY"
- Eventos passados com `opacity: 0.55`; eventos futuros em destaque normal
- Badges: ex_dividend/payout dourado, earnings `#60a5fa`, split `#a978a9`
- Estados: loading / erro / vazio com mensagens especificas
- Sem recharts; inline styles com tokens `T` e `FONT_*` (mesmo padrao das outras tabs)
- **Earnings beat/miss (jun/2026):** `EventDetail` para tipo `earnings` exibe, quando `epsActual` esta disponivel: "Est: $X -> Reported: $Y" com indicador colorido beat (verde) / miss (vermelho) / in-line (neutro). Eventos futuros (so `epsEstimate`) continuam inalterados — sem regressao.
- **Beat/miss vira badge colorido + valor $ de dividendo pago/estimado (jul/2026):** duas mudancas. **(1)** O indicador beat/miss deixou de ser texto inline e virou um pill colorido (`BeatMissPill`, mesmo padrao visual do `TypeBadge`) — mais proximo do peso visual do painel de Alerts. **(2)** Cards `ex_dividend`/`payout` ganharam uma linha de valor em $ (nao so $/share): usa o valor exato importado da Fidelity (`bondIncome`, `kind:"dividend"`, ja liquido de `kind:"tax"` do mesmo ticker+data — mesma fonte/netting do badge de Alerts e da Tab Dividends) quando disponivel; senao estima via `qty atual do ticker × $/share`. Rotulo "Dividend paid: $X" pra eventos passados/hoje (`ev.date <= todayISO`), "Estimated dividend to be paid: $X" pra eventos futuros; quando a estimativa nao vem de import real, ganha sufixo "(est.)". `ex_dividend` so mostra essa linha quando nao ha `payDate` conhecido (i.e., nao existira um card `payout` separado pra carregar o valor) — evita duplicar o valor nos dois cards do mesmo dividendo. `netQty` (qty atual, mesma simplificacao do Alerts — nao qty-na-ex-date) e `fidelityAmountByKey` (Map `TICKER|YYYY-MM-DD` -> valor liquido) calculados via `useMemo` no componente principal. `valuesHidden` (recebido mas nunca usado antes) agora mascara esses valores em $.
- **Bug fix — timezone incorreto no agrupamento cronologico (PR #128, jul/2026):** o calculo de "hoje" usava `new Date().toISOString().slice(0,10)` (UTC), classificando eventos errado no agrupamento Today/Last 7 Days e no `isPast` (opacity de eventos passados) para usuarios em timezone negativo (Brasil, UTC-3) perto da virada do dia UTC. Substituido por `localTodayISO(d)` (ajusta pelo offset de timezone do browser). Mesmo helper duplicado em `src/App.jsx` para o painel de Alerts — ver "Painel de Alerts".

### Limitacoes conhecidas / pendencias de validacao em producao

- **Yahoo `events=earn`** pode retornar apenas earnings passados dependendo do ticker/janela — se confirmado, earnings futuros dependem exclusivamente de `FINNHUB_API_KEY`. Comportamento nao validado em producao (hosts bloqueados no sandbox de implementacao).
- **Splits sem Polygon:** se `POLYGON_API_KEY` estiver ausente, o fallback de splits nao funciona — apenas o Yahoo e suficiente para a maioria dos casos.
- **BRA Stocks fora do escopo:** sem API gratuita de earnings/splits para tickers B3.
- **Filtro net qty > 0:** `extractEligibleTickers` exclui tickers com posição líquida ≤ 0 — sells totais ou posições zeradas não geram chamadas à API. (commit d6dc43b)

-----

## 🔔 Feature: Split Detection & Approval (commit 4e66bd9 — jun/2026)

Sistema que detecta automaticamente splits/groupings ja ocorridos (dados Yahoo/Polygon) ainda **nao refletidos** no historico de transacoes, sinaliza com icone de sino (Bell) + badge no header do app, e oferece um fluxo de aprovacao. Estende o item 35 (SplitModal manual) com deteccao automatica.

### Endpoint `api/split-detect.js`

- `POST { tickers }`, auth obrigatoria.
- Busca **TODOS** os splits historicos (Yahoo `chart?events=split` com `range=10y`, **sem** filtro de janela; fallback Polygon `v3/reference/splits`), concorrencia 3.
- Cache Redis **GLOBAL** proprio: chave `splitdetect:v1:{hash(tickers)}`, TTL ate o fechamento do mercado US.
- **Endpoint separado de `api/events.js`** (que filtra janela -30d/+90d) porque a deteccao precisa do historico completo de splits desde a 1a transacao — ver Decisoes Tecnicas.

### Modelo de dados `splitEvents`

Array no blob de `/api/transactions` (espelha `bondIncome`):

```js
{ ticker, date, numerator, denominator, status: "applied" | "dismissed", appliedAt }
```

- `PUT /api/transactions` agora faz **uma unica leitura read-modify-write** que preserva `bondIncome` E `splitEvents` quando o body os omite. Payload final: `{ transactions, bondIncome, splitEvents, savedAt }`.

### Helper `applySplitToTransactions` (exportado, `src/Transactions.jsx`)

`applySplitToTransactions(transactions, { ticker, date, numerator, denominator })` — module-level, ajusta `qty × (num/den)`, `price × (den/num)`, grava audit trail (`splitAdjusted`, `originalQty`, `originalPrice`, `splitDate`), guard rigoroso `tx.date < splitDate`. `SplitModal.handleApply` foi refatorado para usa-lo (o caminho manual agora tambem grava `splitDate`). `saveTransactionsToServer` ganhou 4o arg opcional `splitEvents`.

### UI e fluxo (atualizado nos PRs #105/#106)

- Funcao pura `detectPendingSplits(transactions, detectedSplits, splitEvents)` (idempotente via decided-set + guard `splitAdjusted && splitDate`). `refreshPendingSplits` (POST nao-bloqueante, failure-silent) dispara no load e apos `handleTransactionsChange`.
- **Revisao de splits vive na Tab Transactions** (PR #105): card colapsavel "Splits / Groupings" (`src/Transactions.jsx`, abaixo da toolbar, acima do form de nova tx) com seção **Pending** (preview por split: qty→nova, preco→novo, total invariante; botoes Approve/Dismiss) e seção **History** colapsavel (`splitEvents` decididos). `TransactionsView` recebe `pendingSplits`, `splitEvents`, `splitActionInFlight`, `onApproveSplit`, `onDismissSplit` como props de `App.jsx`. O botão "Split" manual antigo foi removido da toolbar (`SplitModal` permanece no arquivo só para exportar `applySplitToTransactions`).
- **Approve** (`approveSplit` em `App.jsx`): aplica o ajuste via `applySplitToTransactions`, grava entry `status: "applied"` + data do split, persiste (omite `bondIncome` → servidor preserva), dispara cascade via `handleTransactionsChange` → `applyTxQty` → cache perf-history v12 invalidado. `splitActionInFlight` (key do split) desabilita os botoes + mostra spinner enquanto in-flight.
- **Dismiss** (`dismissSplit`): grava `status: "dismissed"`, persiste, some da lista. Importante porque dados Fidelity geralmente ja vem split-adjusted — o usuario decide por split.

### Painel de Alerts (Bell no header — PRs #105/#106)

O icone Bell deixou de ser especifico de splits e virou um **painel de Alerts** multi-propósito. Tipos de alerta:
- **Split/Grouping pendente** → linha clicável que navega para a Tab Transactions (onde fica o card de revisão).
- **Dividend paid today** → evento `payout` de `/api/events` do dia; calcula o valor pago `qtyHeld × $/share` (`computeNetQty` + `ev.amount`), exibe "Dividend paid: $X" + detalhe "N sh × $Y/sh", respeitando `valuesHidden`. **Override Fidelity (jul/2026):** quando ha um import Fidelity (`bondIncome`, `kind: "dividend"`) para o mesmo ticker+data de hoje, o valor exato substitui a estimativa Yahoo/Finnhub (caso real: badge da AMT mostrava $91.29 de uma estimativa Yahoo desatualizada — $1.79/sh — enquanto o import real da Fidelity, e a Tab Dividends, tinham $71.60). `$/share` do detalhe e re-derivado do valor real (`total ÷ qty`) pra ficar consistente. Foreign tax retido no mesmo dia (`kind: "tax"`) tambem e abatido, mesmo padrao do resto do app — mas so contra um ticker que ja tem linha de dividendo hoje (duas passadas, order-independent, pra uma linha de tax isolada nunca virar override negativo sozinha). `refreshAlerts(txs, bondIncome)` — `bondIncome` agora tambem retornado por `fetchTransactionsForSync(auth, true)`.
- **Earnings released today** → evento `earnings` de `/api/events` do dia.
- **Bond maturity em ≤7 dias** → derivado localmente das transactions (sem API).

`refreshAlerts(txs, bondIncome)` faz merge dos alertas detectados num **log rolante persistido em `localStorage`** (`alertLog`, cap `MAX_ALERT_LOG=50`, exibe os últimos `ALERT_DISPLAY_COUNT=10`). Cada alerta tem `id` estável (`tipo|ticker|data`), `sentDate` (data de detecção) e `read`. O painel agrupa os 10 últimos por `sentDate` via `groupAlertsByDate()` + `formatAlertDate()` ("Today"/"Yesterday"/"Mon D, YYYY"). Read state: `markAlertRead(id)` (botão check por alerta) + `markAllAlertsRead()` (botão no header); lidos ficam dimmed. Badge do Bell = `pendingSplits + alertas nao lidos`.

**`mergeAlerts` atualiza entradas existentes, nao so adiciona novas (jul/2026):** antes, dedup era so por `id` — um alerta ja gravado no `alertLog` (localStorage) nunca era atualizado, mesmo que uma correcao de fonte de dado (ex: o fix acima, Yahoo estimate → valor real Fidelity) mudasse o valor calculado. Caso real: o badge da AMT continuou preso em $91.29 mesmo apos o fix do valor, porque o alerta do dia ja existia no log com o numero antigo. Fix: ao reprocessar, se um alerta detectado tem o mesmo `id` de um ja existente mas payload diferente (`message`/`detail`/`total`/`amount`/etc.), o conteudo e atualizado in-place — preservando `sentDate` original e `read` state (nao reaparece como nao-lido).

**Reconciliacao de alertas de dividendo independente de data (jul/2026):** o fix acima nao bastou sozinho — `mergeAlerts` so recebe alertas *recem-detectados*, e o loop de deteccao em `refreshAlerts` so processa eventos de `/api/events` com `ev.date === todayISO` (evento de hoje). Um alerta gravado no dia em que o dividendo pagou fica fora desse loop em qualquer carregamento posterior (a data ja nao e mais "hoje"), entao nunca mais era reprocessado — mesmo apos importar o extrato real da Fidelity depois. Caso real: badge da AMT continuou em $91.29 mesmo apos os dois fixes anteriores, porque na hora do fix o pay date de 13/jul ja nao era mais "hoje". Fix: `refreshAlerts` ganhou um segundo passo, independente do loop de deteccao — a cada carregamento, reconcilia **todos** os alertas `type:"dividend"` ja gravados (qualquer data, extraida do proprio `id`) contra um mapa completo `bondIncome` (ticker+data → dividendo liquido de tax), corrigindo `total`/`amount`/`message`/`detail` in-place sempre que o valor real disponivel divergir do que esta salvo.

**alertLog scoped por usuario (PR #109):** a chave do localStorage e derivada por `alertLogKey(auth)` — `alertLog:g:<email>` para Google ou `alertLog:p:<senha[:8]>` para password auth. Migra one-time da chave legada `"alertLog"` no mount para preservar historico existente. Sem scoping, dois usuarios no mesmo browser contaminavam os estados de leitura um do outro.

**Bug fix — dep array do useEffect de persistencia do alertLog (jun/2026):** `auth` adicionado ao dependency array do `useEffect` que escreve `alertLog` no localStorage em `src/App.jsx`. Sem `auth` no array, a closure capturava a chave de armazenamento do mount inicial; se `auth` mudasse (ex: refresh de token Google), a escrita continuava usando a chave antiga enquanto a leitura ja usava a nova, causando alertas re-aparecendo como nao lidos.

**Sincronizacao cross-device do estado "lido" via servidor (PR #128, jul/2026):** `alertLog` continua a fonte primaria em `localStorage` (scoped por usuario, PR #109), mas o campo `read` agora tambem e sincronizado com o servidor para cobrir o caso de dois devices (ex: marcar como lido no PC, abrir 1h depois no iPhone). Rota `?resource=alerts-read` dentro de `api/contributions-history.js` (GET/PUT), chave Redis `portfolio:email:<hash>:alerts-read`. No load inicial, `fetchAlertsReadFromServer` busca `readIds` do servidor e sobrescreve `read: true` nos alertas ja carregados do localStorage; `markAlertRead`/`markAllAlertsRead` continuam com update local otimista, mas agora tambem disparam `saveAlertsReadToServer` (fire-and-forget) em background.

**Fix de timezone no calculo de "hoje" (PR #128, jul/2026):** `new Date().toISOString().slice(0,10)` usa UTC, nao a data local do device — em qualquer timezone negativo (ex: usuario reportou o bug estando em Austin, TX — US Central, UTC-5/-6), a noite de domingo local ja e segunda-feira em UTC, podendo marcar um dividendo como "pago hoje" incorretamente. Helper `localTodayISO(d)` le o offset de timezone do proprio browser/device (`getTimezoneOffset()`, nao hardcoded a nenhum fuso especifico) antes de fatiar a data — substitui as comparacoes de "hoje" no painel de Alerts. Ver tambem "Feature: Events" (mesmo fix aplicado la). **Nao assumir que o usuario esta no Brasil so porque o app tem features BRL/B3** — confirmado que ele usa o app de fora do Brasil tambem (Austin, TX).

### Fora do escopo

- B3/CUSIP (sem API gratuita de splits), undo de approve, validacao de ticker.

### Pendencia de validacao em producao

- Reachability Yahoo/Polygon do `api/split-detect.js` **nao validada em producao** (hosts externos bloqueados no sandbox de implementacao).

-----

## 🖱️ Feature: Scroll Hint (indicador de swipe horizontal em tabelas — jul/2026, commit `cfb5d3b`, merge `0e4f9b0`, merged em main)

Feature puramente visual/client-side, inspirada no statusinvest.com.br: tabelas cujo conteudo nao cabe na tela do iPhone (scroll horizontal necessario) ganham um indicador ensinando que da pra arrastar.

### Componente `ScrollHintTable`

Duplicado module-level (sem shared module entre arquivos `src/`, mesma convencao ja adotada por `TickerFilterPopover`/`FilterMultiSelect`/`cardHeaderStyle`/`CardTitle`) em 5 arquivos: `src/Transactions.jsx`, `src/Performance.jsx`, `src/Dividends.jsx`, `src/AporteQuinzenal.jsx`, `src/App.jsx`.

Dois elementos visuais independentes:

1. **Fade de borda persistente** (esquerda/direita) — gradiente sutil sinalizando conteudo cortado. Sempre visivel quando `scrollWidth > clientWidth` (checado via `ResizeObserver`), **independente** de qualquer flag de dismiss. Prop `fadeBg` ajusta a cor do gradiente para bater com o fundo real de cada card (`T.bg`/`T.card`/`T.cardElev`). Prop `leftFadeOffset` (usa a constante `TICKER_COL_WIDTH = 92px`) evita que o fade esquerdo fique escondido atras de colunas `Ticker` com `position: sticky`.
2. **Pill "Swipe" animado, one-shot** — texto + 2 icones `ChevronRight` (lucide-react) com oscilacao `translateX` em loop continuo (via `setInterval` + `transition` inline, sem `@keyframes` novo) **enquanto o usuario nao interagir** — chama atencao indefinidamente ate o gesto acontecer (ajuste jul/2026: removido o timeout automatico de ~4s da v1, que fazia o hint sumir sozinho antes do usuario notar). Dispensado **somente** por scroll horizontal real (`scrollLeft > 4`), com fade-out suave. Persistencia via `localStorage.setItem("scrollHintSeen", "1")` — **flag global**, sem escopo por usuario/conta: uma vez dispensado em qualquer tabela, nao aparece mais em nenhuma tabela/sessao futura. Respeita `prefers-reduced-motion` (desativa so a animacao, mantem o pill visivel estatico ate o dismiss por scroll).

### Call sites (11)

Tabela principal de Transactions, Position Performance, Position Dividends, Contribution Capacity History, Dividends Monthly Y/Y, Dividend History, Bond Income Audit Panel, Fidelity Import staged review, Splits/Groupings preview, Bond Projections payments, preview do modal "Import Allocation Targets" (`App.jsx`).

### Fora de escopo (por pedido explicito do usuario)

Graficos (`recharts`), tab bar do view switcher (`App.jsx`), pills de filtro de Events (`Events.jsx`), `SplitModal` (componente morto, nunca renderizado).

### Notas

100% client-side/visual — nenhuma mudanca em `api/`, `lib/`, contratos de dados, cache ou Redis. Auditoria aprovou sem bloqueadores; 2 achados cosmeticos de baixissima severidade registrados como nao-bloqueantes (ver "Lições Aprendidas"). Pendencia: validacao visual em iPhone real ainda nao feita (ver "Estado Externo" abaixo).

-----

### SimpleFin Feed — Fidelity automation, Fase 1 (jul/2026)

Plano completo em [`docs/plans/simplefin-fidelity-feed.md`](./plans/simplefin-fidelity-feed.md) (ver §6 pra fases, §2 pro shape do payload real). Fase 0 (probe) entregou o dump do payload real; esta fase entrega o mapper + staging + UI.

- **`lib/simplefin-map.js` (módulo puro, novo arquivo em `lib/` — não `src/lib/`):** `mapSimplefinPayload(payload)` filtra por `isFidelityOrg` (org.name/domain contendo "fidelity" — obrigatório, uma conexão SimpleFin traz todas as instituições linkadas) e retorna `{ transactions, bondIncome, balanceCandidates, unmapped }`. Reconhece por regex sobre `description`, na ordem: ciclo INTEREST EARNED CASH/REINVESTMENT CASH (excluído), DISTRIBUTION (excluído), FOREIGN TAX (checado antes de DIVIDEND), DIVIDEND (exceto REINVEST), INTEREST (bond/CD — vira `bondIncome`), REDEMPTION PAYOUT (vira `sell` de Bank Bonds, qty=amount/1000, price=1000, ticker = texto da description já que o feed não traz CUSIP), YOU BOUGHT/SOLD (heurística, mas SimpleFin só reporta `amount` total sem qty/price estruturados — vai pra `unmapped`, nunca inventa números), qualquer outra coisa → `unmapped`. `balanceCandidates`: Cash de `account['available-balance']` (fallback pro holding sintético `CASH`); Bank Bonds soma `market_value` de holdings com `symbol === "" && description !== "CASH"`. 16 testes em `test/simplefin-map.test.mjs` (fixtures sintéticas, sem dados reais do usuário).
- **`api/fidelity-pending.js` estendido** (sem arquivo novo — limite de 12 functions do Vercel Hobby): `POST ?resource=sync` (admin-only) faz o fetch real, mapeia, e faz merge/dedupe no `:fidelity-pending` — dedupe forte por `simplefinId` nativo + fallback `dupKey`/`bondKey` contra live (`:transactions`) e o que já está staged; throttle de 6h via `lastSyncAttempt` gravado no próprio blob (aplica mesmo em falha, pra nunca martelar o Bridge). `GET ?resource=status` expõe `{ connected, lastSync, lastError, nextSyncAt }` sem fazer fetch. Novo `PUT` (parcial — só substitui os arrays presentes no body, preserva `lastSync`/`lastError`) é como o client remove linhas aprovadas/dispensadas do staging sem zerar o resto.
- **Card "Fidelity Import" (`src/Transactions.jsx`) virou um grupo de 4 seções:** Trades (já existia), **Income** (dividend/interest/tax — ganhou checkboxes + Approve/Discard própria; antes era aprovado junto com trades sem listagem visível), **Balance Updates** (Cash/Bank Bonds propostos vs atuais, Approve/Dismiss por linha), **Unmapped** (somente leitura — nunca descartado silenciosamente). Botão "Sync Fidelity" + "Last sync" só pra admin (`isUserAdmin`, mesmo gate do card "SimpleFin Probe" da Fase 0).
- **Balance Updates:** Approve de Cash grava direto em `manualValue` do holding `cash-permanent` (efeito imediato no Dashboard). Approve de Bank Bonds grava `marketValueOverride`/`marketValueOverrideAsOf` no holding `bank-bonds-aggregate` — campo aditivo, porque `manualValue` daquele holding é recalculado a cada mudança de transação por `applyBankBondsHolding` (App.jsx) a partir do principal derivado das transações, e sobrescreveria qualquer valor de mercado gravado ali.
- **`src/App.jsx`:** `TransactionsView` ganhou os props `holdings`, `onApproveFidelityBalance`, `onDismissFidelityBalance`. Nova função `applyFidelityBalanceUpdate(candidate)` aplica Cash/Bank Bonds aprovados ao state `holdings` (que já auto-salva via o efeito debounced existente).
- Build + as 4 suites de teste (analytics + fidelity-parser + perf-history + simplefin-map, 70/70) verdes.

-----

### SimpleFin Feed — Fidelity automation, Fase 2: exibicao do `marketValueOverride` (jul/2026, merge `eecf52c`, v1.3.1)

Fecha a lacuna deixada pela Fase 1: o campo `marketValueOverride`/`marketValueOverrideAsOf` (gravado no holding `bank-bonds-aggregate` quando o usuario faz Approve de um Balance Update de Bank Bonds no card "Fidelity Import") era persistido mas nao lido em lugar nenhum. Agora e exibido.

- **`src/App.jsx`, componente `ManualHoldingRow`:** novas variaveis derivadas (~linha 5978-5997) — `hasMarketValueOverride` (`holding.marketValueOverride != null`), `marketValueDelta` (`marketValueOverride - value`, onde `value` e o principal derivado de transacoes), `marketValueDeltaColor` (verde/vermelho por sinal, mesmo padrao visual de `dayColor`) e `marketValueAsOf` (parse robusto de `marketValueOverrideAsOf`, aceita `YYYY-MM-DD` ou ISO timestamp completo).
- **Decisao de UX:** exibicao vive dentro do accordion expandido do holding (`driftOpen`, ~linha 6198-6221) — "Market Value (SimpleFin)" + valor mascaravel (`valuesHidden`/`maskMoney`) + delta colorido + data "as of" — nao no card compacto/fechado. Escolhido por ser informacao secundaria de reconciliacao, nao um numero primario do Dashboard; so aparece quando o campo esta setado (hoje so `bank-bonds-aggregate` grava).
- **Decisao tecnica:** o delta **nao reusa o prop `deltaColor`** ja existente no componente (usado pro drift de rebalanceamento) — semantica diferente ("valor de mercado SimpleFin vs. principal" vs. "peso atual vs. peso alvo"). `marketValueDeltaColor` e uma variavel local nova, mesmo padrao visual (verde/vermelho por sinal) mas calculo e fonte de dado independentes, evitando acoplar dois conceitos nao relacionados.
- Escopo puramente de exibicao — sem endpoint/schema/cache novo, `package.json` bumpado `1.3.0 -> 1.3.1` (patch).
- Fora do escopo (permanece pendente): resolucao de CUSIP individual por bond (feed SimpleFin nao traz CUSIP — reconciliacao agregada e decisao de design permanente, nao uma limitacao temporaria); Fase 3 (heartbeat de sync no Bell, deprecar `api/ingest-fidelity.js` + `docs/plans/scraper/`); Fase 4 (multi-usuario / claim de setup token).

-----

## 🎯 Decisões Técnicas + POR QUÊ

|Decisão|Razão|
|---|---|
|Redis em vez de DB relacional|~5KB por usuário, suficiente|
|`ioredis` em vez de `@upstash/redis`|Integração Vercel Marketplace só dá `REDIS_URL` TCP, não REST|
|Profile cache 30 dias (server + client)|Reduz drasticamente chamadas Finnhub (free tier 60 req/min)|
|Refresh em batches de 3, delay 800ms|Evita 429 do Finnhub|
|**Yahoo para B3 rejeitado**|429 frequente vindos dos IPs do Vercel|
|**Frankfurter para USD/BRL real-time rejeitado**|BCE atualiza 1x/dia (EOD), parecia travado|
|**SnapTrade/Plaid/Yodlee rejeitados**|Custo alto, complexidade, risco de credenciais|
|Cash em seção separada|Manual asset com class "Cash" → fora de rebalance/sort|
|Cash permanente (`CASH_ID`)|Holding sempre presente via `ensureCashAccount()`|
|Default sort = Underweight → Overweight|Alinha com lógica do Rebalance|
|Auth dupla (Google + password)|Google primary, password backup; storage isolado por método|
|Allowlist em camadas|`ALLOWED_EMAILS` env + Redis set + `ADMIN_EMAILS`|
|**Transactions em arquivo separado**|Reduz risco de deploy parcial em App.jsx|
|**Performance em arquivo separado**|Mesma razão de Transactions|
|**Holdings ↔ Transactions paralelos**|Zero refator do existente; pode divergir — assumido|
|**Performance lê de Transactions, não de Holdings**|Performance histórica precisa de log de eventos|
|**recharts em vez de Chart.js**|API React-friendly, menos boilerplate|
|**TWR em vez de MWR**|Comparação justa contra benchmark|
|**Cache versionado em `perf-history`**|Permite invalidar formato antigo silenciosamente|
|**TTL alinhado ao fechamento do mercado (PR #38)**|Cache expira ~21:00 UTC (16h ET) — dados sempre refletem último pregão|
|**Net Worth usa soma live de positionRows (PR #39)**|KPI e Position Performance usam mesma fonte (Finnhub live); elimina inconsistência com série histórica cacheada|
|**Cache `perf-history` usa hash das transactions (v12)**|Cache key = storageKey + FNV-1a hash de `id\|date\|side\|ticker\|qty\|price` de cada tx elegível. Qualquer mudança nas transactions invalida automaticamente o cache sem precisar de bypass manual.|
|**`inferAssetClass()` com lookup prioritário (PR #37)**|ETFs Fixed Income e Real Estate identificados antes da heurística genérica de ticker|
|**`INCLUDED_CLASSES` expandido (PR #37)**|Bonds, Bank Bonds, BRA Fixed Income agora entram no cálculo; tickers sem candles já eram ignorados silenciosamente|
|**Cache bump v10→v11 (PR #39)**|`INCLUDED_CLASSES` expandido muda o `portfolioUSD` calculado; cache antigo daria Net Worth incorreto|
|**Cards colapsáveis em Performance (PR #38)**|Mesmo padrão visual do card "Rebalance Suggestions" em Holdings — consistência visual, reduz density na tab|
|**Sonnet 4.6 como modelo default**|Gap com Opus encolheu. Sonnet resolve 95% dos casos|
|**Claude Code web como workflow de deploy**|Cria PR automático, revisão pelo GitHub mobile, merge → Vercel auto-deploya|
|**Tesouro Direto = manual em BRL (PR #49)**|Brapi `/treasury` é pago (403); tesourodireto.com.br descontinuado (410); CKAN desativado (400). Nenhuma fonte gratuita viável.|
|**BRA Fixed Income aceita `manualCurrency: "BRL"` (PR #49)**|Tesouro e CDB são mantidos no NuBank em BRL — entrada natural é BRL, conversão automática via usdBrlRate|
|**CONTEXT.md + Features_Roadmap.md em `docs/` no repo**|Docs versionados junto com código; Claude Code atualiza diretamente sem intermediário via Chat|
|**Dividendos US via Yahoo `chart?events=div` (Tab Dividends)**|Finnhub `/stock/dividend` é premium (free tier retorna 403). Yahoo retorna histórico completo de dividendos keyless, mesmo endpoint já usado por `perf-history.js` para candles.|
|**Finnhub como fallback de dividendos para ADRs (PR #94)**|Yahoo retorna HTTP 200 com `dividends: {}` vazio para alguns ADRs US-listados (VALE NYSE confirmado). `fetchFinnhubDividends` usa o mesmo `FINNHUB_API_KEY` já presente; Finnhub inclui `payDate` diretamente, dispensando lookup Polygon. `CACHE_VERSION` v4→v5 para invalidar caches vazios anteriores.|
|**brapi `dividends=true` rejeitado para BRA Stocks (Tab Dividends)**|HTTP 403 `FEATURE_NOT_AVAILABLE` — dados de dividendos são feature paga na brapi. VALE3 funciona só por ser ação de teste com acesso irrestrito.|
|**BRA Stocks dividendos = manual (Tab Dividends)**|Sem API gratuita confirmada. Entrada manual no form da Tab Dividends, mesmo padrão de Tesouro/CDB nos Holdings.|
|**Income model: `totalReceived` direto (Tab Dividends)**|Tesouro IPCA e Bank Bonds pagam cupom cujo valor depende do PU corrigido — mais natural lançar o total recebido do que qty × amountPerUnit.|
|**Snapshot Redis de Contributions restaura `extras` no localStorage (PR #118)**|`localStorage["aporteConfig"]` era a unica fonte de verdade e podia ser perdido (Safari iOS). Restore one-time a partir de `capacityHistory[currentMonthKey()]` (guard `seededExtras`, mesmo padrao de `seededFixed`) torna o auto-snapshot uma rede de seguranca de leitura tambem, nao so write-only.|
|**`Promise.allSettled` para fetch secundario em Performance (PR #67)**|Dividends fetch e perf-history fetch rodam em paralelo; falha no dividends nao deve derrubar a tab. `allSettled` garante degradacao silenciosa — a tab carrega mesmo sem dados de dividendos.|
|**YoC% agregado = media ponderada, nao media aritmetica (PR #67)**|`sum(ttm) / sum(totalCost)` e matematicamente correto pois pondera pelo custo de cada posicao. Media aritmetica dos YoC% individuais daria resultado distorcido por posicoes pequenas com alto yield.|
|**API dividends retorna `totalReceived`, nao `amount` (PR #67)**|Campo relevante para calculo de TTM e para o YoC e `e.totalReceived`. `amountPerShare` e `qtyHeld` ficam disponiveis mas nao sao usados na Performance tab.|
|**`divEvents` (array bruto) coexiste com `divByTicker` (PR #68)**|`divByTicker` tem totais agregados sem granularidade de data; para `totalReturn` por periodo, precisa de `divEvents` com `date` por evento. Guardar ambos quando o dado bruto tiver uso futuro.|
|**`undefined` em dataKey recharts para pontos sem dado (PR #68)**|`null` e renderizado como zero; `undefined` faz recharts pular o ponto silenciosamente no grafico e no tooltip. Usar `undefined` em series onde ausencia deve ser invisivel.|
|**`lastTotalReturn = null` (nao `undefined`) para KPI (PR #68)**|Helpers como `fmt(null)` retornam `"--"` corretamente. Estados que alimentam KPI cards devem ser `null` quando ausentes, nao `undefined`.|
|**Filtro de periodo em dividendos com string ISO (PR #68)**|`e.date >= startDate && e.date <= d.date` como strings ISO-8601 e order-preserving — valido sem parsear para `Date`.|
|**Dividend History: sort + filter por header + TOTAL row (PR #71, item 30)**|Mesmo padrão de HeaderPopover da tab Transactions (DivHistPopover local). Filtros: Date (date range), Ticker (checkboxes). Outras colunas: sort only. TOTAL row fixa no topo, soma só linhas visíveis pós-filtragem. Contador no header muda pra "X / Y payments" quando filtrado.|
|**Dividendos bucket por pay date via Polygon.io (PR #73)**|Yahoo `chart?events=div` retorna só a ex-dividend date — cash landing usa pay date. `api.nasdaq.com` tentado e rejeitado: Akamai bloqueia IPs de datacenter do Vercel (403). Polygon.io (`v3/reference/dividends`) é API de servidor (keyed, funciona da cloud). qtyHeld continua calculado na ex-date (entitlement correto). Rate limit (5/min free tier) resolvido com cache permanente por ticker no Redis (chave global, imutável, TTL 7 dias), warm de 5 tickers frios por request. Cache resultado por-usuário só persiste quando todos os tickers estão warm.|
|**`api.nasdaq.com` bloqueado do Vercel (Akamai)**|Mesmo com User-Agent de browser, IPs de datacenter (AWS/Vercel) são identificados e bloqueados com 403. Confirmar reachability de qualquer nova API antes de implementar a partir de IPs cloud.|
|**Dividendos com pay date futura são descartados (item 39)**|Yahoo lista dividendos recém-declarados cuja ex-date já passou (entitlement travado, qty > 0) mas cujo pay date ainda está no futuro. Esse cash não caiu — não é income recebido. Guard `if (date > todayISO) continue;` em `api/dividends.js` filtra eventos não-pagos antes de montar o array. Server-side cobre Dividend History, KPIs e Total Return da Performance num só ponto. `>` estrito: pay date de hoje continua incluído. Cache (TTL até próximo fechamento) re-inclui o evento quando a pay date chega.|
|**Import: classe do histórico tem prioridade sobre `inferAssetClass()` (item 34)**|A classe que o usuário já registrou para um ticker é fonte de verdade mais confiável que a heurística genérica. Coluna explícita do CSV ainda vence (o usuário a digitou agora). Evita conflito de classe para o mesmo ticker entre imports.|
|**Dedupe não bloqueia, só desmarca (item 34)**|Duplicata mantém `r.ok = true` e só vem desmarcada — usuário pode forçar (ex.: dois buys legítimos idênticos no mesmo dia). Marcar `ok: false` impediria o import mesmo com o checkbox marcado.|
|**Auto-detecção de formato de data no import CSV (PR #77)**|`detectDateFormat()` varre todos os valores de `date` antes de parsear: `A > 12` em `A/B/YYYY` → DMY; `B > 12` → MDY. Default MDY (US/Excel) quando ambíguo — a maioria dos CSVs processados vem de fontes US. Sem seleção manual.|
|**Datas ISO não dependem do `fmt` (PR #77)**|`parseDate` trata `YYYY-MM-DD` no primeiro ramo, antes de checar `fmt`. O parâmetro `fmt` só é consultado para datas `A/B/YYYY` ambíguas — ISO sempre correto independente do que `detectDateFormat` retornar.|
|**NET QTY row sobre linhas visíveis, não todas (PR #77)**|`tfoot` calcula `sum(buy) − sum(sell)` sobre `visible` (pós-filtro/sort). Filtrar por ticker mostra posição líquida daquele ativo especificamente.|
|**Qty de auto holdings derivada de Transactions, não editada manualmente (PR #81)**|Três helpers module-level em `App.jsx`: `fetchTransactionsForSync(auth)`, `computeNetQty(transactions)`, `applyTxQty(holdings, netQty)`. Sync em três momentos: load inicial, Refresh All (em paralelo com preços), e live via callback `onTransactionsChange` de `TransactionsView`. Holdings sem nenhuma transação ficam intactos — compatível com dados antigos.|
|**`onTransactionsChange` callback de TransactionsView → App.jsx (PR #81)**|`persist()` em `Transactions.jsx` é o único ponto de saída de todas as mutações (add, edit, delete, bulk delete, bulk class, import). Adicionar `onTransactionsChange?.(nextList)` ali cobre os 6 casos com um único hook. App.jsx passa `handleTransactionsChange` como prop — sem lifting de state, sem contexto global.|
|**`applyTxQty` usa `type !== "manual"`, não `type === "auto"` (PR #82)**|Holdings legados criados antes do campo `type` existir têm `type: undefined`. A convenção do app inteiro é `h.type === "manual"` para excluir manuais — todo o resto é tratado como auto. Usar `h.type !== "auto"` em `applyTxQty` excluía silenciosamente esses holdings legados. Regra: nunca condicionar comportamento de auto holdings em `type === "auto"`.|
|**Form "Add Live Asset" removido — auto holdings entram exclusivamente via Transactions (PR #84)**|Com item 32 concluido, o form manual de adicionar ticker + qty ficou obsoleto e era fonte potencial de inconsistencia (usuario poderia criar holding com qty errada, divergindo do saldo real em Transactions). Remover o form elimina o vetor de inconsistencia e simplifica a UX: um unico fluxo (Transactions) alimenta auto holdings.|
|**Responsividade via state + resize listener, sem CSS media queries (PR #85)**|Constraint de inline-styles-only e sem Tailwind/CSS files. Padrao adotado: `windowWidth` state com lazy init `window.innerWidth`, `useEffect` com listener de `resize` e cleanup no unmount. Dimensoes responsivas derivadas inline (ex: clamp de `donutSize` entre 140 e 220). Compativel com SSR defensivo.|
|**`maxWidth` do container expandido de 640 para 1200 (PR #85)**|640px deixava o conteudo numa faixa estreita centralizada em monitores. 1200px cobre a maioria dos monitores. Mobile (<640px) identico ao anterior. O layout de 2 colunas tentado em commit c09a595 foi revertido em commit c50fcf1 — Holdings e sempre single-column empilhado.|
|**DonutChart aceita prop `size` com geometria derivada (PR #85)**|Raios (`rOuter`, `rInner`) e font-sizes calculados proporcionalmente a partir de `size`. Permite escalar o grafico em qualquer contexto sem duplicar o componente. Default 140 preserva comportamento anterior.|
|**Qty E preco Fidelity Bank Bonds corrigidos no parser (PR #86 + PR #87, item 40)**|Fidelity reporta a Quantity de CDs/bonds como valor de face em dolares (1000 = um CD de $1.000) **e** o Price ($) como percent-of-face (100.00 = 100% de $1.000). Correcao final (PR #87): `tx.qty = qtyAbs / 1000` **e** `tx.price = priceN * 10`, ambas so quando `assetClass === "Bank Bonds"` (CUSIP). Ex: qty=1000/price=100.00 → qty=1/price=1000 → $1.000. `rawNumbers` guarda os brutos. O PR #86 aplicou so `price * 10` (incompleto) — transacoes importadas antes do PR #87 devem ser apagadas e re-importadas.|
|**Metadados de bond extraidos no parser (PR #87, item 40)**|Para Bank Bonds, `parseFidelityCSV` extrai do Symbol Description campos dedicados: `couponRate` (number), `maturityDate` (ISO), `bondType` (Treasury/Agency/CD/Corporate por keywords do issuer), `shortName`, `couponFreq` (default `monthly` para todos por decisao de produto). `parseBondNotes` (Dividends) prefere esses campos e cai de volta no formato legado `notes` "5.45% \| 03/15/2027" — transacoes antigas continuam acruando sem re-import.|
|**Income real de Bank Bonds em store separado (PR #87, item 36 follow-up)**|Pagamentos de juros detectados no import (Action contem "INTEREST" + Symbol e CUSIP) sao guardados no campo `bondIncome` do blob `/api/transactions`, **fora** do array de transacoes — nunca entram em `computeNetQty`/`dupKey` (cumpre a decisao de nao criar `side: "income"`). PUT preserva `bondIncome` quando o body o omite (read-modify-write), entao saves normais de transacao nao o apagam. `buildBondEvents(transactions, bondIncome)` (PR #88, ex-`computeBankBondsAccrual`) mescla pagamentos reais (no mes real) com accrual estimado preenchendo **so o gap apos o ultimo pagamento real** (sem double-count); calibra `couponFreq` pela cadencia (`freqByCusip`, computado mas ainda nao renderizado). Sem bump de cache (calculo no frontend).|
|**Redemption Fidelity = sell do CUSIP (PR #88)**|Linhas REDEMPTION/REDEEMED do Account History com Symbol CUSIP viram transacoes `side: "sell"` com `redemption: true` — maturity do bond devolve o principal, zerando a posicao comprada (holding agregado vai a zero; accrual para na data). Price em branco no CSV cai para `Amount/units/10` (percent-of-face), depois par (100). Quantity ausente cai para Amount (face em dolares). Redemption de symbol non-CUSIP continua skipped (acoes nao tem maturity).|
|**Bond interest como eventos unificados em allEvents (PR #88)**|Em vez de buckets mensais separados (`byMonth`), `buildBondEvents` emite eventos no shape dos dividendos da API (`{ date, ticker, assetClass: "Bank Bonds", incomeType: "interest", totalReceived, source }`). `allEvents = [...events, ...bondEvents]` alimenta todos os cards da tab Dividends sem logica separada por card. Eventos estimados: `source: "estimated"`, 1 por mes, datados no ultimo dia do mes (capado em hoje), `amountPerShare`/`qtyHeld` null (renderizam "—").|
|**Holding Bank Bonds agregado por principal liquido (PR #86, item 37)**|Um unico holding `id: "bank-bonds-aggregate"` por usuario (nao um por CUSIP). Principal = Sigma(buy qty*price) - Sigma(sell qty*price), floored em 0. Mesmo padrao de sync de 3 pontos do item 32 (load, Refresh All, onTransactionsChange). Mantido como `manualMode: "value"` + `derivedFromTransactions: true` — nao e um auto holding (sem ticker live), mas o valor e derivado automaticamente.|
|**Income Bank Bonds = accrual estimado no frontend, sem tocar endpoints (PR #86, item 36)**|Sem API gratuita de pagamentos historicos por CUSIP. Solucao: accrual pro-rata ACT/365 calculado em `src/Dividends.jsx` a partir de buy/sell + cupom%/maturidade no campo `notes`. Rotulado "est." na UI. Sem bump de cache (dividends v3, perf-history v12). KPIs Y/Y comparam so dividendos reais — accrual somado apenas nos KPIs de valor absoluto (All Time, YTD, This Month).|
|**Transacoes Bank Bonds sem notas de cupom/maturidade ignoradas no accrual (PR #86)**|Se `notes` nao tiver o padrao "X.XX% \| MM/DD/YYYY", `parseBondNotes` retorna null e a transacao e ignorada no calculo de accrual. Silencioso por design — bond sem dados de cupom nao pode contribuir com estimativa.|
|**Toggle "By Class / By Ticker" no header do card, nao no corpo (PR #93)**|Toggle no corpo do card ocupava espaco visual e ficava deslocado do contexto do header. Mover para o header (alinhado a direita, mesmo nivel do titulo) e o padrao de controle de view de cards — consistente com outros controles inline no header. `e.stopPropagation()` obrigatorio para que o click no toggle nao propague para o `<button>` do header colapsavel.|
|**`isBankBonds` guard em `ManualHoldingRow` (PR #93)**|Holdings `bank-bonds-aggregate` derivados de Transactions (item 37) nao devem ter valor/classe editados manualmente — editaria um campo que o sync de Transactions vai sobrescrever na proxima sincronizacao. Ocultar os inputs e ignorar os campos no `saveEdit` evita divergencia de dados sem precisar de logica de merge.|
|**Fidelity dividends como fonte autoritativa, pulando Yahoo/Finnhub (PR #95)**|Yahoo retorna `{}` para alguns ADRs (VALE confirmado); Finnhub funciona mas e ponto de falha. Quando o usuario ja importou dividendos reais do Fidelity CSV, esses valores sao os dados definitivos — nao ha razao para tentar reconstrui-los via API. Tickers cobertos por `bondIncome[kind=dividend]` pulam completamente o fetch externo; `totalReceived` exato e usado direto. Unico pre-requisito: usuario deve reimportar o CSV Fidelity para capturar linhas de dividendo.|
|**`CACHE_VERSION` v5→v6 em `api/dividends.js` (PR #95)**|Cache key inclui hash dos eventos Fidelity (`fd:${simpleHash(...)}`). Bump v5→v6 invalida caches anteriores que nao tinham Fidelity dividends — sem o bump, usuario veria cache vazio mesmo apos reimportar o CSV.|
|**`computeHalfInvested` derivada ao vivo de Transactions, sem persistencia (PR #98)**|Valor realizado de aporte por quinzena nao e persistido em localStorage nem em Redis — calculado no `useMemo([transactions, usdBrlRate])` a cada render. Mesmo padrao de `buildChartData` e `buildPositionRows`: funcao pura fora do componente + useMemo por dentro. Elimina o vetor de divergencia entre o dado manual salvo e o log de Transactions, que e a fonte de verdade.|
|**`POST /api/dividends` reutilizado em `AporteQuinzenal` para preencher "Dividends (last month)" automaticamente (PR #99)**|O endpoint ja era chamado por Performance e Dividends. Em `AporteQuinzenal`, apos o load das transactions, dispara o mesmo POST e filtra eventos cujo `date` cai no mes anterior, somando `totalReceived`. Falha silenciosa (catch retorna 0) — o Monthly Plan continua funcional mesmo sem dados de dividendos. O campo "DELL sale" e preenchido pela funcao pura `computeDellSale` (sells de DELL no mes corrente das transactions), seguindo o mesmo padrao de derivacao ao vivo.|
|**Cache de eventos GLOBAL por hash de tickers, sem storageKey (commit aecef28, Tab Events)**|Eventos de calendario corporativo (ex-div, earnings, splits) sao fatos publicos — nao dependem do portfolio individual do usuario. Cache `events:v1:{hash(tickers_ordenados)}` e compartilhado entre qualquer usuario que tenha os mesmos tickers. Mesmo racional do cache de pay dates Polygon (`dividends:paydates:v1:{ticker}`): dado imutavel/publico nao deve ser recomputado por usuario.|
|**Reutilizacao do cache Polygon de pay dates entre Tab Dividends e Tab Events (commit aecef28)**|`api/events.js` busca pay dates usando a chave `dividends:paydates:v1:{ticker}` — a mesma chave gerada por `api/dividends.js`. Se a Tab Dividends ja esquentou o cache para um ticker, Tab Events aproveita sem custo adicional de API. Rate limit de 5/min do Polygon free tier nao e problema quando os caches ja estao warm.|
|**Payout como evento separado do ex_dividend quando as datas diferem (commit aecef28)**|Yahoo retorna apenas ex-date; Polygon fornece pay date. Quando payDate != exDate, `api/events.js` gera dois eventos distintos: `ex_dividend` na ex-date (entitlement) e `payout` na pay date (cash landing). O usuario ve os dois momentos distintos no calendario — mais util do que colapsar em um unico evento com data ambigua.|
|**Audit trail em splits (commit d6dc43b)**|`splitAdjusted: true` + `originalQty` + `originalPrice` preservados na transaction mutada — permite implementar "Undo Split" no futuro sem re-importar o CSV.|
|**`buildBondProjections` usa intervalDays fixo por frequência (commit d6dc43b)**|30/91/182/365 dias por pagamento — aproximação suficiente para estimativa; dia exato do calendário (ex: todo dia 15) adicionaria complexidade sem ganho para uso pessoal.|
|**Endpoint `api/split-detect.js` separado de `api/events.js` (commit 4e66bd9)**|Detecção precisa de TODOS os splits históricos desde a 1ª transação; events.js filtra janela -30d/+90d em 2 pontos + cache key sem modo. Endpoint dedicado isola blast radius, tem cache próprio e só busca splits.|
|**`splitEvents` no blob de transactions, não em chave Redis separada (commit 4e66bd9)**|Acoplado às transactions (registra splits já aplicados ao histórico); approve deve gravar qtys ajustadas E o split atomicamente. Chave separada arriscaria divergência em escrita não-atômica. Read-modify-write espelha o padrão testado de bondIncome.|
|**Dismiss de split persiste (commit 4e66bd9)**|Dados Fidelity geralmente já vêm split-adjusted — split detectado pode já estar no cost basis. Persistir o dismiss evita re-sinalizar a cada load; usuário decide por split.|
|**`alertLogKey(auth)` para chave localStorage do alertLog (PR #109)**|Chave `alertLog` sem sufixo de usuario causava contaminacao cruzada quando dois usuarios alternavam login no mesmo browser — alertas lidos de um reapareciam como nao lidos para o outro. Derivar a chave da identidade do usuario (`alertLog:g:<email>` / `alertLog:p:<senha[:8]>`) isola o estado de leitura por conta, replicando no frontend o padrao ja adotado nas chaves Redis do backend.|
|**Bank Bond rollovers excluídos do aporte quinzenal via net qty por período (PR #108)**|`computeHalfInvested` e `buildChartData` em `AporteQuinzenal.jsx` calculam net qty de Bank Bonds por período (compras − redemptions) em vez de somar buys brutos. Rolagem de bond vencido (redeem + recompra no mesmo período) não infla o aporte. Fix subsequente (commit fa48b02): campo "Dividends (last month)" soma também `bondIncome` com `kind: "interest"` diretamente no frontend — `POST /api/dividends` só devolve `kind: "dividend"`, omitindo juros de bonds.|
|**`:contributions-history` sem versionamento `vN` (PR #112)**|E um store de upsert de dados do usuario (snapshots de capacidade de aporte), nao um cache de calculo — nunca e invalidado ou descartado. Cache de calculo (como `perf-history:vN`) precisa de versao para descartar formato antigo; dados de usuario persistidos devem ser preservados indefinidamente. PUT usa read-modify-write para mesclar o mes corrente sem apagar meses anteriores.|
|**Rollover de quinzena como calculo puro no frontend, sem backend (PR #112)**|`half2Target = halfPlanned + max(0, halfPlanned - half1Auto)` e determinístico dado `planTotal` e `half1Auto`. Nao ha ambiguidade de estado — o valor do rollover muda em tempo real a medida que Transactions mudam. Persistir no Redis introduziria complexidade de sincronizacao sem beneficio; calcular no `useMemo` e suficiente.|
|**Desktop polish: IIFE para side-by-side condicional (commit c09a595)**|Allocation + Rebalance envolvidos em IIFE que computa `sideBySide = windowWidth >= 1024 && showAlloc && showRebal` — a flag é falsa se qualquer seção não está visível, evitando coluna vazia no layout. `flex: sideBySide ? "1 1 0" : undefined` em cada seção, `marginBottom`/`marginTop` condicionais. Donut size reformulado: `allocSectionW = sideBySide ? (containerW - 20) / 2 - 32 : containerW - 32` para refletir coluna mais estreita no modo lado a lado. AporteQuinzenal segue o mesmo padrão de `windowWidth` já estabelecido em App.jsx (PR #85).|
|**Layout 2 colunas Holdings revertido para single-column (commit c50fcf1)**|`sideBySide` removido de `App.jsx`. Wrapper da seção Holdings agora sempre `display: "block"` — layout linear empilhado em qualquer largura. `marginBottom` fixo em 20px, `marginTop` fixo em 28px, sem condicionais. `allocSectionW = containerW - 32` sempre (donuts ocupam largura total). Razão: preferencia de UX — single-column e mais legivel em qualquer tamanho de tela. `windowWidth` state e `containerW` permanecem para clamp de donuts e font scaling.|
|**Merge direto no main sem PR (constraint iPhone-only)**|Usuário não tem acesso a preview funcional antes do merge — não há staging e o Vercel só deploya do main. Workflow adotado: implementar na branch de feature → build verde → `git checkout -B main origin/main` + `git merge --no-ff` + `git push origin main`. Registrado no CLAUDE.md.|
|**`SectionLabel` com acento dourado como padrao de destaque de secao (PR #113)**|Cards de destaque na tab Contributions ja usavam linha dourada no topo. Aplicar o mesmo elemento (gradiente `T.gold → transparent`, 2px, `position: absolute`) no `SectionLabel` unifica o padrao visual entre tabs sem criar um componente novo. Modificacao cirurgica: wrapper ganha `position: relative` + `overflow: hidden`, elemento absoluto inserido como primeiro filho.|
|**Auto holdings sem botao de delete na UI (PR #114)**|Holdings `type: "auto"` sao derivados de Transactions — permitir delete direto criaria divergencia entre o holding exibido e o saldo real calculado pelo sync. O fluxo correto e apagar as transacoes, que desaparecera o holding automaticamente. Holdings manuais puros continuam com delete disponivel porque nao tem contrapartida em Transactions. `ManualHoldingRow` ja bloqueava delete para `isBankBonds`/`derivedFromTransactions` (PR #93); o PR #114 cobre o caminho `HoldingRow` (`type: "auto`).|
|**Holdings criados via CSV Import com `qty: 0` e `fromCSVImport: true` (PR #115)**|CSV de asset allocation importa apenas ticker + target%; nao ha informacao de quantidade. `qty: 0` com `type` de auto-style e compativel com `applyTxQty` — quando o usuario adicionar a primeira transacao para o ticker, o sync de Transactions preenchera a qty corretamente. Flag `fromCSVImport: true` distingue holdings novos via CSV de outros auto holdings, permitindo mostrar botao delete e dropdown de asset class (que desaparecem ao ganhar transactions).|
|**`shouldSkipValidationCSV` e `validateTickerForCSV` duplicadas em `App.jsx` (PR #115)**|O projeto nao tem imports cross-src por design (App.jsx e Transactions.jsx sao arquivos separados e autonomos). As funcoes de validacao de ticker existentes em `Transactions.jsx` foram duplicadas como helpers module-level em `App.jsx` para o CSV Import de Holdings. Padrao intencional — sem shared module.|
|**Bank Bonds nao criavel via CSV Import de Holdings (PR #115)**|Holdings de Bank Bonds sao derivados automaticamente de Transactions via holding agregado `bank-bonds-aggregate` (item 37). Permitir criacao via CSV criaria um holding manual paralelo incompativel com o holding derivado. Aviso inline no modal quando o usuario seleciona Bank Bonds como asset class de um novo ticker.|
|**Dedup Fidelity import por (ticker, month), nao por ticker (jun/2026)**|Import parcial de um mes nao deve silenciar o historico Yahoo de outros meses do mesmo ticker. `fidelityCoveredMonths` Set com chave `ticker|YYYY-MM` garante que apenas os meses efetivamente cobertos pelo import pulam o fetch externo. Cache bumped `v6 -> v7`.|
|**`distributionEvents` purge list para auto-healing de entries mal capturados (jun/2026)**|Linhas DISTRIBUTION do CSV Fidelity contem "DIVIDEND" no nome do ETF mas nao sao pagamentos de dividendo. Em vez de tentar distinguir no momento do parse, adicionar ao `distributionEvents` purge list — entries sao removidos de `bondIncome` pelo composite key `date|ticker|amount` no proximo re-import. Desfaz silenciosamente importacoes erradas anteriores.|
|**Bond Income Audit Panel em Transactions, nao numa tab separada (jun/2026)**|`bondIncome` e um store auxiliar que complementa as transactions — faz sentido estar acessivel no mesmo contexto. Painel colapsavel no rodape da Tab Transactions evita criar uma tab nova para funcionalidade de auditoria/cleanup que e usada ocasionalmente.|
|**Auto-hide de holdings zerados via useMemo, nao delete do Redis (PR #117)**|Holdings totalmente vendidos (qty=0, sem target) sao artefatos normais do ciclo de vida — o usuario pode re-comprar o ticker no futuro. Ocultar visualmente via `filteredHoldings` preserva o historico no Redis sem poluir a UI. Holdings com `target > 0` ficam visiveis mesmo zerados porque sao placeholders intencionais de rebalance.|
|**`FilterMultiSelect` custom (popover proprio) em vez de `<select multiple>` nativo (PR #124)**|`<select multiple>` no iOS/WebKit abre um bottom-sheet controlado pelo SO, sem hooks de customizacao via HTML/CSS/JS — impossivel injetar um botao "Clear" no header nativo (que so tem setas de navegacao + um X que fecha sem resetar a selecao). Componente proprio (chip-trigger + popover com checkboxes + header "Clear"+"x") da controle total do visual. Padrao a reutilizar em qualquer filtro multi-select futuro no app (constraint iPhone-only).|
|**`TickerFilterPopover` duplicado por arquivo, `<thead>` sempre montado mesmo com resultados vazios (PR #126)**|Novo filtro de ticker em Position Performance/Position Dividends segue a convencao ja estabelecida (`DivHistPopover`, `FilterMultiSelect`) de duplicar componentes visuais por arquivo em vez de importar entre `Performance.jsx`/`Dividends.jsx`. State Set-based, efemero (sessao), independente por tabela. O `<thead>` que ancora o icone de filtro deve permanecer sempre montado mesmo quando o filtro zera todas as linhas — empty-state vive dentro do `<tbody>`, nunca substitui a tabela inteira.|
|**Novo endpoint consolidado dentro de arquivo existente via query param, nao arquivo novo em `api/` (PR #128)**|`api/` esta no limite de 12 Serverless Functions do Vercel Hobby plan. Criar `api/alerts-read.js` como arquivo separado levou o total a 13 e quebrou o Preview Deployment (`errorCode: exceeded_serverless_functions_per_deployment`). Fix: deletar o arquivo e implementar a rota como uma segunda funcao dentro de `api/contributions-history.js`, dispatched via `?resource=alerts-read` (`handleAlertsRead` ao lado de `handleContributionsHistory`). Estrategia a repetir para qualquer endpoint novo enquanto `api/` estiver no limite: consolidar via query param, ou remover/mergear um endpoint existente antes.|
|**`localTodayISO(d)` em vez de `new Date().toISOString().slice(0,10)` para "hoje" (PR #128)**|`toISOString()` usa UTC. Para usuarios em timezone negativo (Brasil, UTC-3), a noite de domingo local ja e segunda-feira em UTC — comparacoes de "hoje" (Alerts, agrupamento cronologico da Tab Events) classificavam eventos no dia errado perto da virada UTC. `localTodayISO(d)` ajusta pelo offset de timezone do browser antes de fatiar a data. Duplicado em `src/App.jsx` e `src/Events.jsx` — sem shared module entre arquivos `src/` (padrao ja estabelecido).|
|**Pipeline `/feature-workflow` passa a mergear direto no main, sem PR (jul/2026, decisao explicita do usuario)**|O pipeline de 4 agentes (`feature-planner` → `feature-coder` → `feature-auditor` → `docs-updater`) abria PR e parava, esperando revisao humana no GitHub mobile ("portao humano"). O usuario pediu para alinhar esse fluxo ao "Deploy Pattern" ja documentado no CLAUDE.md (merge direto no main, sem PR, ja usado manualmente antes do pipeline existir). `feature-auditor` agora faz `git checkout -B main origin/main` + `git merge --no-ff` + `git push origin main` direto apos aprovar a auditoria e o build — sem abrir PR nem esperar aprovacao. O unico gate remanescente e build verde + a propria auditoria do `feature-auditor`; se qualquer um falhar, ele para e nao empurra pra main. Arquivos atualizados: `.claude/commands/feature-workflow.md`, `.claude/agents/feature-auditor.md`, `.claude/agents/docs-updater.md`.|
|**Sort de headers em "Dividends Monthly Y/Y" reaproveita o padrao ja existente em `PositionDividendsTable` (jul/2026 — commit `0ecde97`)**|`YearVsYearTable` e `PositionDividendsTable` vivem no mesmo arquivo (`src/Dividends.jsx`); `PositionDividendsTable` ja tinha handler de sort com toggle asc/desc + indicador `↕`/`↑`/`↓` e comparador com nulls empurrados pro fim. Replicar o mesmo padrao em vez de desenhar um novo evita inconsistencia de UX entre as duas tabelas do mesmo card family e reduz codigo a revisar.|
|**Bug fix — Bond Interest estimate gerava pagamentos fantasma (jul/2026 — commit d93cd87, merge b96922a)**|`buildBondEvents`/`accrueSegmentAsEvents` (renomeada `accrueByFreqAsEvents`) em `Dividends.jsx` e `Performance.jsx` sempre fatiavam o accrual em blocos de calendario mensal fixo, ignorando `freqByCusip` ja calibrado pelos pagamentos reais — bonds trimestrais/semestrais mostravam "EST" todo mes mesmo sem cupom real vencendo. Fix: sizing do accrual passa a usar `freqByCusip[cusip]` -> fallback `couponFreq` -> fallback `"monthly"` so na ausencia total de dado. `FREQ_DAYS` (ja usado corretamente por `buildBondProjections`) promovido a constante module-level e reaproveitado. Efeito esperado e desejado: menos eventos "EST"; totais de Income History/KPIs caem para bonds nao-mensais que estavam super-contados.|
|**Bug fix — accrual estimado nunca deve cobrir o periodo corrente incompleto (jul/2026 — commit d93cd87, merge b96922a)**|O accrual sempre gerava um evento para o mes/periodo corrente ainda em curso, datado em "hoje - 1 dia" — data arbitraria (dia em que a pagina foi aberta), nao a data real do proximo pagamento. Todo bond em aberto exibia uma estimativa "paga" na mesma data. Fix: evento "EST" so e emitido quando o periodo esta inteiramente decorrido dentro de `[accrueFrom, endISO)`; o periodo corrente incompleto fica fora do historico (pertence ao card Bond Projections, nao ao Income History).|
|**Bug fix — `accrueFrom` deve avancar `ultimoPagamentoReal + 1 dia` (jul/2026 — commit d93cd87, merge b96922a)**|Sem avancar a data apos um pagamento real, o accrual seguinte reabria no mesmo dia do pagamento, gerando um "coto" residual sobreposto/duplicado ao valor ja importado do Fidelity. Fix: `accrueFrom = lastRealDate + 1 dia` (era `lastRealDate` sem avancar).|
|**Filtros de Performance aplicados client-side, sem tocar `api/perf-history.js` (jul/2026 — commit a60bb9f)**|O cache Redis v12 ja usa hash do conteudo das transactions elegiveis como parte da chave. Enviar um subconjunto filtrado de `transactions` do cliente automaticamente produz uma chave de cache diferente e correta — nao precisou de parametro de filtro no backend nem de bump de versao de cache.|
|**Toggle "Show Total Return" desacoplado de "Compare vs S&P 500" (jul/2026 — commit a60bb9f)**|Antes um unico toggle controlava 3 linhas simultaneamente (Portfolio, Total Return, SPY); usuario queria ver Total Return sem necessariamente ativar a comparacao com SPY. Estado default (ambos off) preserva o comportamento visual anterior — zero regressao para quem nao usa os toggles novos.|
|**`useEffect` de carregamento de Performance dividido em dois, guardado por `transactionsLoaded` explicito (jul/2026 — commit a60bb9f)**|Efeito A `[auth]` carrega dados brutos nao filtrados; Efeito B `[auth, filteredTransactions]` dispara o POST filtrado. Guard por `transactions.length` (em vez de um flag booleano) travaria em loading infinito para contas com zero transacoes, pois `length` nunca deixa de ser 0.|
|**Refetch do filtro de Performance so ao fechar o popover (jul/2026 — commit a60bb9f)**|Disparar `POST /api/perf-history` a cada clique de checkbox geraria uma chamada de rede por toggle; agrupar o refetch no fechamento do popover (`FilterChip`) reduz chamadas sem prejudicar a UX de selecao multipla.|
|**`allTransactions` no body do `POST /api/perf-history` em vez de endpoint novo (jul/2026, Composition Evolution)**|O card precisa do portfolio inteiro (sem os filtros de UI aplicados ao TWR), mas criar um segundo endpoint/segunda chamada de rede duplicaria fetch de candles/FX ja feito pelo mesmo POST. Body ganhou campo opcional `allTransactions` (fallback para `transactions` quando ausente) — o handler usa `transactions` pro TWR (respeita filtro de UI) e `allTransactions` so para `computeCompositionSeries`. Uniao de tickers dos dois conjuntos alimenta o fetch de candles, garantindo preco mesmo para classes fora do filtro ativo.|
|**Composition Evolution tem filtro proprio de Asset Class/Ticker, independente dos filtros globais da pagina (jul/2026, revisado jul/2026)**|Decisao original: o card ignorava os filtros globais e so tinha um toggle visual local de classe. Ajuste posterior: o card ganhou seu proprio par de filtros dropdown (`FilterChip`, mesmo componente do filtro global), incluindo Ticker — que agora restringem `compFilteredTransactions` na origem (enviado como `allTransactions`), nao so a renderizacao. Mantem a independencia do filtro global (o usuario nao perde a visao macro ao filtrar o TWR para outra finalidade), mas com UI/semantica consistente com o resto da pagina.|
|**Eixo X do Composition Evolution usa `computeXAxis` (calendario), nao mais as datas reais de transacao (jul/2026, ajuste)**|Ticks nas datas reais de transacao deixavam o espacamento visualmente desigual quando as transacoes nao eram uniformemente distribuidas no tempo. `computeXAxis` (mesma funcao do grafico de TWR) foi generalizada para aceitar os periodos "2Y" (ticks trimestrais) e "All" (tratado como "MAX"), e o card passou a usa-la — ticks sempre em fronteiras de calendario, consistentes com o grafico principal.|
|**`BRA Fixed Income` excluida de `COMPOSITION_CLASSES` (jul/2026)**|Mesma limitacao estrutural do grafico de TWR: Tesouro/CDs nao tem preco de mercado disponivel (ver "BRA Fixed Income" nas Constraints) e nao ha fallback flat razoavel para uma serie historica de composicao. `COMPOSITION_CLASSES = INCLUDED_CLASSES - BRA Fixed Income`.|
|**`computeBankBondsValueAt(transactions, asOfISO)` generalizado a partir do accrual hardcoded em `Date.now()` (jul/2026)**|`positionRows` ja calculava o valor accrued de Bank Bonds mas hardcoded pra "hoje" (`Date.now()`). Composition Evolution precisa do mesmo calculo em N datas historicas do range selecionado. Extrair um helper puro parametrizado por data evita duplicar a logica de accrual entre os dois usos.|
|**Cache bump v12→v13 (jul/2026, Composition Evolution)**|Campo novo `composition` na resposta e mudanca de shape — cache antigo nao teria o campo, quebrando o card silenciosamente sem o bump.|
|**Cache bump v13→v14 (jul/2026, bugfix performance Composition Evolution)**|`composition.classValues` (agregado por classe) trocado por `tickerValues`+`tickerClass` (por ticker), pra permitir filtro de Asset Class/Ticker do card 100% client-side (sem refetch a cada toggle, que levava 1-2s). Mudanca de shape exige bump.|
|**`ScrollHintTable` duplicado module-level em 5 arquivos (jul/2026)**|Mesma convencao ja adotada no projeto para componentes pequenos (`TickerFilterPopover`, `FilterMultiSelect`, `cardHeaderStyle`, `CardTitle`) — sem shared module entre arquivos `src/` por design.|
|**Fade de borda sempre visivel via `ResizeObserver`, independente do dismiss do pill (jul/2026)**|Sinaliza overflow real de conteudo (fato objetivo do DOM), diferente do pill educativo que so precisa aparecer uma vez. Acoplar os dois ao mesmo flag esconderia a pista visual permanentemente apos o primeiro dismiss, mesmo em tabelas novas que o usuario nunca viu.|
|**Flag `scrollHintSeen` global no localStorage, sem escopo por usuario/conta (jul/2026)**|E uma dica de UI generica ("da pra arrastar"), nao um dado de conta — nao precisa do padrao de scoping por email/senha usado em `alertLog`/`alertLogKey`. Uma vez o usuario aprende o gesto, nao precisa reaprender por tabela ou por conta.|
|**Animacao do pill "Swipe" via `setInterval` + `transition` inline, sem `@keyframes` novo (jul/2026)**|Projeto e inline-styles-only (sem CSS files/Tailwind) — `@keyframes` exigiria injetar um `<style>` tag ou CSS-in-JS novo. Oscilacao de `translateX` via state + `setInterval` (3 ciclos ~700ms) reusa o mesmo padrao de transicoes inline ja usado no resto do app.|
|**`leftFadeOffset` usa `TICKER_COL_WIDTH` (92px) no `ScrollHintTable` (jul/2026)**|Varias tabelas tem coluna `Ticker` com `position: sticky` cobrindo a borda esquerda — sem o offset, o fade esquerdo ficaria renderizado atras da coluna sticky e invisivel.|
|**Todo caminho que resulta em `date = exDate` por falta de pay-date deve setar `payDateUncertain: true`, nunca fallback silencioso (jul/2026, merge `d0054d4`, caso TSM)**|Requisito nao-negociavel do usuario apos o bug do TSM (dividendo pago em 09/jul/2026 mas exibido como 11/jun/2026, a ex-date, sem nenhum aviso). O fix nao troca a logica de fallback existente (`date = payDate \|\| exDate` continua) — adiciona um segundo lookup via Finnhub e, quando mesmo assim nao ha pay-date confirmado, marca o evento com `payDateUncertain: true` em vez de deixa-lo indistinguivel de um evento com data confirmada. Verificado linha a linha pelo feature-auditor para garantir zero gaps nesse contrato.|
|**Cache de pay-date via Finnhub em chave Redis separada da do Polygon (jul/2026, merge `d0054d4`)**|`dividends:paydates:finnhub:v1:{TICKER}` (TTL 7 dias) fica isolado de `dividends:paydates:v1:{TICKER}` (Polygon) porque sao fontes de dados diferentes com taxas de erro/cobertura diferentes — misturar as duas na mesma chave impediria invalidar/diagnosticar uma fonte sem afetar a outra.|
|**Concorrencia otimista nos PUTs de holdings/transactions via `expectedSavedAt` (jul/2026, hardening batch)**|Os PUTs sobrescreviam o blob inteiro sem checagem — com o app usado em iPhone + desktop, duas sessoes abertas podiam se clobberar silenciosamente (perda de historico). O cliente agora envia `expectedSavedAt` (o `savedAt` que leu por ultimo); o servidor responde `409` se outro device salvou no meio. Cliente NAO atualiza o marker no 409 (saves seguintes continuam falhando ate reload) — atualizar automaticamente derrotaria a protecao no proximo save. Campo opcional: cliente antigo que omite mantem o comportamento antigo.|
|**Cache global de quotes 60s no Redis + batch `?tickers=` em `api/price.js` (jul/2026, hardening batch)**|Refresh All fazia 1 request serverless + 1 chamada Finnhub por holding. Agora: cache Redis GLOBAL por ticker (quotes sao dado publico — um usuario esquenta o cache do outro) e endpoint batch que resolve ate 60 tickers numa invocacao (concorrencia 4, FX USD/BRL prefetchado uma vez pros tickers B3). Cliente usa 2 chamadas batch (grupo quoteOnly + grupo full) com fallback pro loop legado de 3-em-3 se o batch falhar (ex: durante um deploy com server antigo).|
|**Parser Fidelity/CSV extraido para `src/lib/parsing.js` (jul/2026, hardening batch)**|O parser teve ~8 rodadas de bugfix (cada uma corrupcao silenciosa de dado financeiro) e vivia intestavel dentro de `Transactions.jsx`. Movido para modulo puro (sem React/DOM) importado pelo componente; `test/fidelity-parser.test.mjs` (25 casos) codifica cada bug historico como regressao. Excecao consciente a convencao "sem shared module entre arquivos src/": vale para componentes de UI, nao para logica pura que precisa rodar em Node.|
|**Rate limit de senha por IP + comparacao constant-time (jul/2026, hardening batch)**|`x-app-password` era comparada com `!==` (timing attack teorico) e sem limite de tentativas (brute-force livre). Agora `constantTimeEqual` (movido de `ingest-fidelity.js` para `lib/auth.js`) + contador Redis por IP (10 falhas / 15 min → 429). Fail-open: Redis indisponivel nao bloqueia login.|
|**Remocao de usuario deleta TODAS as chaves do prefixo via SCAN (jul/2026, hardening batch)**|`DELETE /api/users` apagava so `:holdings`, deixando `:transactions`, caches e snapshots orfaos no Redis — retencao indevida + re-convite herdava historico antigo. Agora SCAN `portfolio:email:<hash>:*` + DEL de tudo.|
|**CI no GitHub Actions com `npm install`, nao `npm ci` (jul/2026, hardening batch)**|`package-lock.json` esta no `.gitignore` por decisao do projeto — `npm ci` exige lockfile. O workflow roda build + todos os `test/*.test.mjs` em cada push; e o unico check automatico possivel no constraint iPhone-only (resultado visivel no GitHub mobile).|
|**Snapshot mensal de Net Worth TOTAL em vez de reconstruir historico de Cash/Tesouro (jul/2026, analytics batch)**|Cash, Unallocated e BRA Fixed Income nao tem serie de preco historica — o grafico de TWR os exclui por necessidade. Em vez de procurar API, o app grava 1 snapshot/mes do `totalValue` live (rota `?resource=networth-history`, mesmo arquivo pelo teto de 12 functions). O valor do mes = net worth no ultimo load do app naquele mes. Historico acumula organicamente; meses anteriores ao deploy nao existem (mesma filosofia do PR #112).|
|**Analytics (XIRR/vol/Sharpe/beta/drawdown/heatmap/invested) 100% client-side em `src/lib/analytics.js` (jul/2026, analytics batch)**|Tudo deriva da serie diaria que `POST /api/perf-history` ja retorna + do log de transactions — zero fetch novo, zero endpoint novo, e o modulo puro roda em Node (`test/analytics.test.mjs`, 18 casos). Metricas calculadas SINCE INCEPTION, desacopladas do seletor de periodo do grafico — escopos mistos confundem a leitura.|
|**XIRR/Invested: cashflows BRL convertidos pela taxa FX ATUAL do ticker, nao a historica (jul/2026, analytics batch)**|O cliente nao tem serie historica de FX (so o backend tem, no perf-history). Aproximacao consciente: usa `priceMap[ticker].fxRate` (live); transacoes BRL sem taxa disponivel sao puladas e contadas no rodape do card ("N BRL transactions skipped"). Precisao suficiente pro proposito (ordem de grandeza do gap TWR vs XIRR), documentada na UI.|
|**Treemap de holdings lazy-loaded (`src/TreemapCard.jsx`) pra manter recharts fora do bundle principal (jul/2026, analytics batch)**|A tab Holdings (App.jsx, chunk principal) nao usa recharts em nenhum outro lugar — os donuts sao SVG custom. Importar `<Treemap>` direto no App.jsx puxaria ~370KB de recharts pro chunk inicial. `React.lazy` + `Suspense` (mesmo padrao das tabs) isola o componente num chunk proprio (~24KB) que so carrega ao abrir o card "Portfolio Map".|
|**Filtros dos cards de analytics: classe/ticker via chips globais da pagina, periodo por card (jul/2026, follow-up)**|Os cards Risk/Monthly/Invested derivam TUDO de `rawData`, que ja nasce de `filteredTransactions` (os chips globais de Asset Class/Ticker) — dar a cada card seu proprio filtro de classe/ticker exigiria um POST /api/perf-history por card por combinacao. So o **periodo** e per-card (`ANALYTICS_PERIODS` = 6M/YTD/1Y/5Y/MAX, helper `sliceByPeriod` + `PeriodPills`), computado client-side por slice da serie. **XIRR permanece since-inception** independente da janela — money-weighted em janela parcial exigiria um cashflow sintetico de abertura e viraria outra metrica (rotulado "Since Inception" no KPI).|
|**Cache de sessao module-level para POSTs de Performance/Dividends (jul/2026, follow-up de performance)**|Trocar de tab desmonta o componente lazy (conditional render por `activeView`) — cada revisita refazia POST /api/perf-history (x2) e /api/dividends e re-exibia o spinner. Fix: `Map` em escopo de modulo (sobrevive a remounts, morre no reload) keyed por hash FNV do payload — mudanca em transactions muda a chave, entao hit stale e impossivel dentro da sessao. Revisita de tab agora e instantanea e com zero rede.|
|**Warmup de caches + preload de chunks no load do app (jul/2026, follow-up de performance)**|`warmUpTabCaches` (App.jsx, once-per-session, 3s apos o load inicial pra nao competir com os quotes): faz `import()` dos chunks lazy (Performance/Dividends/Events) e dispara fire-and-forget os MESMOS bodies de POST que as tabs enviam no mount — o Redis do servidor (candles, dividends, composition) ja esta quente na primeira visita. Os dois POSTs de perf-history rodam em sequencia de proposito: o primeiro aquece o cache de candles compartilhado, evitando fetches externos duplicados enquanto ambos estao frios.|
|**Indicador de versao no header — v1: `VERCEL_GIT_COMMIT_SHA` (jul/2026), substituido no v2 (mesmo dia)**|Primeira tentativa: label `commit · data-do-build` via `VERCEL_GIT_COMMIT_SHA` injetado pelo Vite, zero manutencao manual. Substituido a pedido do usuario por semver legivel (`v0.0.0`) — ver entrada abaixo.|
|**Indicador de versao no header — v2: semver `v0.0.0` a partir de `package.json`, bump manual obrigatorio (jul/2026)**|Apos um push direto no `main` "nao rolar" o deploy (causa nao diagnosticada; resolvido abrindo e mergeando um PR pela UI do GitHub), o header ganhou um numero de versao legivel — formato `v0.0.0` (semver), nao hash de commit. Fonte: `define: { __APP_VERSION__ }` em `vite.config.js`, lendo `"version"` de `package.json` em build-time (`readFileSync` + `JSON.parse`, sem dependencia nova). **Trade-off consciente:** ao contrario do hash de commit (automatico, impossivel esquecer), o semver exige bump manual do `package.json` antes de cada merge — documentado como passo obrigatorio no Deploy Pattern do CLAUDE.md. Se uma session esquecer de bumpar, o numero no header fica desatualizado silenciosamente (nenhum erro de build) — mitigar revisando o Deploy Pattern a cada sessao, nao com automacao (bump automatico por commit seria ilegivel/nao-semantico).|
|**Filtro de asset class do Portfolio Map: dropdown unico em vez de chips (jul/2026, ajuste de UX)**|Primeira versao do treemap usava um chip por classe (linha horizontal, uma por classe presente). Trocado para um unico dropdown multi-select (`ClassFilterDropdown`, mesmo padrao visual/interacao do `FilterMultiSelect` de `Dividends.jsx` — trigger + popover com checkboxes + Clear — duplicado localmente por convencao). Motivo: portfolios com muitas classes deixavam a linha de chips longa/quebrando linha; um dropdown fica compacto independente do numero de classes.|

-----

## 🌐 Estado Externo (precisa validação periódica)

- **Google App:** ✅ **Publicado** (saiu do modo Testing — confirmado em 21/mai/2026)
- **Env vars no Vercel:** ⚠️ **Verificação pendente.** Lista esperada: `APP_PASSWORD`, `FINNHUB_API_KEY`, `BRAPI_API_KEY`, `REDIS_URL`, `GOOGLE_CLIENT_ID`, `VITE_GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`, `ADMIN_EMAILS`, `VITE_ADMIN_EMAILS`, `POLYGON_API_KEY`.
- **Tab Events — Yahoo `events=earn` em producao:** ⚠️ **Nao validado.** Hosts externos estavam bloqueados no sandbox de implementacao. Comportamento esperado: Yahoo pode retornar apenas earnings passados dependendo do ticker/janela. Se confirmado, earnings futuros dependem exclusivamente de `FINNHUB_API_KEY`. Validar com um ticker de earnings proximo (ex: AAPL pre-earnings) apos o primeiro deploy.
- **Split Detection — reachability Yahoo/Polygon do `api/split-detect.js`:** ⚠️ **Nao validado.** Hosts externos estavam bloqueados no sandbox de implementacao (commit 4e66bd9). O endpoint busca splits historicos via Yahoo `chart?events=split` (primario) e Polygon `v3/reference/splits` (fallback). Validar a deteccao com um ticker que teve split recente apos o primeiro deploy.
- **Scroll Hint — validacao visual em iPhone real:** ⚠️ **Nao validado.** Feature 100% client-side (fade de borda + pill animado nas tabelas com scroll horizontal, commit `cfb5d3b`/merge `0e4f9b0`, jul/2026) implementada com build verde, mas o ambiente de dev nao tem acesso a browser/dispositivo pra conferir visualmente. Validar apos o rebuild automatico do Vercel: posicionamento do fade perto de colunas `Ticker` sticky, timing da animacao do pill "Swipe", e comportamento com `prefers-reduced-motion` ativado.
- **Cobertura Finnhub de pay-date para ADRs 20-F (caso TSM) — reachability nao validada em sandbox:** ⚠️ **Nao validado.** Fix mergeado em `d0054d4` (branch `claude/tsm-dividend-discrepancy-7nj5bs`, commit `69385e2`) adiciona lookup Finnhub `/stock/dividend` como segunda tentativa de pay-date quando o Polygon nao cobre um ticker. O sandbox de dev bloqueia `finnhub.io` por politica de rede (403/`connect_rejected` confirmado via proxy), entao a cobertura real da Finnhub para ADRs 20-F (ex: TSM) nao pode ser testada durante a implementacao. **Validar pos-deploy:** olhar `meta.payDatesResolvedViaFinnhub` numa resposta real de `POST /api/dividends` que inclua TSM. Se `payDateUncertain: true` persistir mesmo apos o deploy, significa que nem Polygon nem Finnhub cobrem esse ADR — o badge "EX-DATE" na UI e o comportamento esperado, nao um bug.
- **Admin atual:** `pnetto@gmail.com`
- **Usuários ativos:** Pedro + 1 amigo

-----

## 📦 O Que Tem no Código (não duplico aqui — leia o repo)

- Frontend Holdings: `src/App.jsx`
- Frontend Transactions: `src/Transactions.jsx`
- Frontend Performance: `src/Performance.jsx`
- Frontend Events: `src/Events.jsx`
- Endpoints: `api/holdings.js`, `api/transactions.js`, `api/perf-history.js`, `api/price.js`, `api/index-quote.js`, `api/users.js`, `api/events.js`, `api/split-detect.js`, `api/contributions-history.js`
- Auth + Redis: `lib/auth.js`, `lib/redis.js`
- **`api/` esta no limite de 12 arquivos (Vercel Hobby plan, jul/2026 — ver Decisoes Tecnicas).** Antes de criar um endpoint novo, checar `ls api/*.js` — se ja estiver em 12, consolidar a rota nova dentro de um arquivo existente via query param dispatch (padrao usado em `api/contributions-history.js?resource=alerts-read`), nao criar arquivo novo.

**Endpoints (resumo):**

| Endpoint | Função |
|---|---|
| `GET /api/holdings` | Retorna `{ exists, holdings, savedAt, method, email, admin }` |
| `PUT /api/holdings` | Salva array de holdings; body aceita `expectedSavedAt` opcional → `409` se outro device salvou depois da ultima leitura (concorrencia otimista) |
| `GET /api/transactions` | Retorna `{ exists, transactions, bondIncome, splitEvents, savedAt, method, email, admin }` |
| `PUT /api/transactions` | Salva `{ transactions, bondIncome?, splitEvents? }`; quando `bondIncome` e/ou `splitEvents` sao omitidos, preserva os valores existentes (read-modify-write unica); aceita `expectedSavedAt` opcional → `409` em conflito cross-device |
| `GET /api/price` | Quote real-time de um ticker (Finnhub para US, brapi para B3); `?fx=USDBRL` retorna taxa de câmbio; `?tickers=A,B,C` (max 60) retorna `{ quotes }` em batch; cache Redis global 60s por ticker |
| `GET /api/index-quote` | Quote do SPY |
| `POST /api/perf-history` | Recebe `{ transactions, allTransactions? }`, retorna série TWR + portfolioUSD + `composition` (por ticker: `tickerValues`/`tickerClass`, agregação por classe é client-side) (cache Redis v14) |
| `GET/POST /api/users` | Admin: listar/convidar/remover emails no allowlist Redis |
| `POST /api/events` | Recebe `{ tickers }`, retorna eventos corporativos (ex_dividend, payout, earnings, split) janela -30d/+90d; cache Redis GLOBAL por hash de tickers, TTL ate proximo fechamento de mercado |
| `POST /api/split-detect` | Recebe `{ tickers }`, retorna TODOS os splits historicos (Yahoo `chart?events=split` range=10y, fallback Polygon) para deteccao de splits nao refletidos no historico; cache Redis GLOBAL `splitdetect:v1:{hash}`, TTL ate proximo fechamento de mercado |
| `GET /api/contributions-history` | Retorna snapshot do mes corrente + historico de meses anteriores (`{ history: { "YYYY-MM": { monthlyFixed, dividends, dellSale, extras, planTotal, invested, savedAt } } }`) |
| `PUT /api/contributions-history` | Upsert idempotente do mes corrente; preserva meses passados (read-modify-write). Body: `{ month, monthlyFixed, dividends, dellSale, extras, planTotal, invested }` |
| `GET /api/contributions-history?resource=alerts-read` | Rota secundaria (PR #128) dentro do mesmo arquivo — retorna `{ exists, readIds, savedAt }` do log de leitura dos Alerts (Bell), pra sincronizacao cross-device do estado "lido" |
| `PUT /api/contributions-history?resource=alerts-read` | Body `{ add: string[] }`; read-modify-write com uniao dos ids, capado em 200 |
| `GET /api/contributions-history?resource=networth-history` | Terceira rota do mesmo arquivo (jul/2026) — `{ exists, history: { "YYYY-MM": { value, savedAt } } }`: snapshots mensais do net worth TOTAL (incluindo Cash/Unallocated/BRA Fixed Income) |
| `PUT /api/contributions-history?resource=networth-history` | Body `{ month: "YYYY-MM", value }`; read-modify-write que sobrescreve o mes e preserva os demais. App.jsx dispara automaticamente no load (debounce 5s apos o totalValue assentar) |

-----

## 🚀 Próximas Features (ver [`docs/Features_Roadmap.md`](./Features_Roadmap.md) para lista completa)

**Deferred indefinidamente:**
- Auto-refresh silencioso de token Google
- DELL sell/buy timing agent
- Refactor `api/price.js` e `api/index-quote.js` pro novo contrato de auth
- Import automático Fidelity via email parsing
- Estimativa fixed income via SELIC/IPCA pro-rata

**Rejeitados pra sempre:**
- Integração automática Fidelity (SnapTrade/Plaid/Yodlee)
- Tab Paste no bulk import
- Agentes LLM para tarefas determinísticas
- Tesouro Direto live pricing (todas as fontes gratuitas inviáveis — ver Decisões Técnicas)

-----

## 🚢 Deploy Pattern (iPhone-only)

**Workflow padrão:**

1. Abre **Claude Code** no app do iPhone
2. **Create session** → repo `pnetto-pixel/aa-findocs` → branch `main` → **Sonnet** → descreve a tarefa
3. Claude Code cria branch + faz mudança + abre **PR automaticamente**
4. Abre PR no **GitHub mobile app** → **Files changed** → revisa
5. **Merge pull request** → Confirm merge
6. Vercel rebuilda automático em ~1-2 min

**Regras do Claude Code:**

- **Sonnet default** — Opus só quando Sonnet falhar ou tarefa for estruturalmente complexa
- **Sempre revisar Files changed antes de mergear**
- **Uma tarefa por session** — Bug fix = nova session
- **Agrupar mudanças do mesmo arquivo numa session**
- Não tocar em `lib/auth.js`, `api/holdings.js`, `api/transactions.js` sem revisão cuidadosa
- **Atualizar `docs/CONTEXT.md` e/ou `docs/Features_Roadmap.md`** ao final de sessions que mudam features ou decisões técnicas
- **Bumpar `"version"` em `package.json` antes de todo merge/deploy** (patch/minor/major — ver CLAUDE.md "Versionamento"). O app exibe essa versão no header (`v0.0.0`, ao lado do "Refresh all") — é como o usuário confirma visualmente qual deploy está de fato no ar. Esquecer o bump não quebra o build, só deixa o número velho — checar sempre.

**Validação de build (ainda válida se necessário):**

1. Two-step: esbuild parse check primeiro
2. Depois `vite build` completo em `/tmp/testbuild/` com node_modules pré-instalados

-----

## 🔍 Diagnóstico (problemas conhecidos)

|Sintoma|Onde olhar|
|---|---|
|**401 em `/api/holdings`, `/api/transactions`, `/api/perf-history`**|DevTools → Network → Response. Mensagens: `"No auth provided"`, `"Email not allowed"`, `"Invalid Google token"`, `"Invalid audience"`|
|**Performance: "No eligible transactions found"**|`INCLUDED_CLASSES` em `api/perf-history.js` — deve aceitar `Stocks`, `BRA Stocks`, `Alternative`, `Real Estate`, `Bonds`, `Bank Bonds`, `BRA Fixed Income`|
|**Performance: gráfico vazio ou só com SPY**|Provável 429 do Finnhub. Conferir Network tab. Cache v11 deveria evitar.|
|**Performance: toggle Compare travado**|Cache antigo v<11. Limpar cache Redis → key `perf-history`.|
|**Performance: Net Worth inconsistente com Position Performance**|Corrigido no PR #39 — KPI agora usa soma live de `positionRows`. Se persistir, verificar se cache v11 propagou.|
|**Position Performance: ticker BR com valor errado em USD**|`h.fxRate` nulo → derivado como `h.originalPrice / h.price`. Atualizar holding corrige.|
|**Position Performance: ticker não aparece**|Ticker sem holding com preço atual, ou qty líquida ≤ 0.|
|**Manage Users não aparece**|DevTools → Console: comparar `auth.email` com meta `admin-emails`|
|**Vercel servindo versão antiga**|Deployments → último → ••• → Redeploy → desmarcar "Use existing Build Cache"|
|**Reset total de dados**|Vercel → Storage → Data Browser → chaves `portfolio:`|
|**Bulk import CSV BR `175,50` vira 2 colunas**|Esperado — prompt vermelho "Column mismatch detected" → "Yes, reparse"|
|**Fidelity CSV: 0 transações importadas**|Conferir se header tem `Run Date,Account,Account Number,Action,Symbol,...`|
|**PR do Claude Code veio com mudanças extras**|Não mergear. Fechar PR, reformular prompt, nova session.|
|**BRA Fixed Income mostrando valor errado em USD**|`usdBrlRate` nulo — verificar se `/api/price?fx=USDBRL` retorna corretamente. Checar Network tab.|

-----

## 🎓 Lições Aprendidas (não repetir)

- **Sempre chamar helpers de "garantia" (`ensureCashAccount`) em TODOS os caminhos de load.**
- **Mudar contrato de função compartilhada quebra callers antigos.**
- **Headers customizados em Node chegam lowercase.**
- **Env vars novas exigem redeploy.**
- **Build validation em 2 passos** (esbuild parse + vite build completo).
- **Features grandes em chunks (1A/1B/1C)** — entregar incremental, validar entre chunks.
- **Arquivo separado pra feature grande** — App.jsx só ganha 1 import + 1 prop por feature.
- **Claude Code: revisar Files changed antes de mergear sempre.**
- **Timers `setTimeout` de dismiss one-shot devem ser rastreados e limpos no unmount.** Achado cosmético não-bloqueante da auditoria do Scroll Hint (jul/2026): o `setTimeout` que dispensava o pill "Swipe" após ~4s não era guardado em `useRef`/limpo explicitamente em `useEffect` cleanup — sem efeito prático observado, mas o padrão correto é sempre limpar. **Obsoleto (jul/2026, ajuste de UX):** esse `setTimeout` de auto-dismiss foi removido — o usuário pediu que a animação continuasse chamando atenção indefinidamente até o swipe real acontecer, então não há mais timer nenhum a limpar nesse componente. Achado relacionado (também não-bloqueante, ainda válido): cenário teórico de `setInterval` double-invoke em React StrictMode (dev only) não afeta build de produção — vale considerar ao revisar código com timers/intervals que rodam em mount.
- **Claude Code: bug fix = nova session.**
- **Padrao de auth divergente entre handlers = endpoint publico silencioso (jul/2026, hardening batch).** `api/price.js` e `api/index-quote.js` usavam `const auth = await authenticate(req, res); if (!auth) return;` — mas `authenticate()` sempre retorna um objeto (truthy, mesmo em falha), entao o guard nunca disparava e os dois endpoints ficaram meses acessiveis sem token. Bug invisivel a build/teste manual (o app sempre manda headers validos). Licao: o check de auth deve ser IDENTICO em todos os handlers (`if (!auth.ok) return res.status(auth.status)...`); qualquer variacao no padrao e suspeita de bug, nao estilo.
- **Achados nao-bloqueantes do fix TSM/pay-date (jul/2026, merge `d0054d4`), registrados como follow-up conhecido, nao como bugs urgentes:** (1) `allWarm` nao distingue falha transitoria do Finnhub de falta de cobertura real — um evento pode ficar cacheado como `payDateUncertain: true` por ate ~24h mesmo que tenha sido so um blip momentaneo da API; efeito e conservador (mostra aviso a mais, nunca esconde um problema real). (2) Quando Finnhub ja foi fonte primaria (Yahoo retornou vazio, fallback do PR #94), o codigo pode re-buscar os mesmos dados do Finnhub que ja estavam em memoria — desperdicio de quota, nao e bug funcional. (3) `meta.payDatesResolvedViaFinnhub` e so um contador agregado — eventos individuais nao registram qual fonte resolveu a pay date, dificultando um pouco a validacao granular em producao.
- **Claude Code: atualizar `docs/CONTEXT.md` + `docs/Features_Roadmap.md` ao final de sessions relevantes.**
- **Sonnet 4.6 é suficiente pra 95% das tarefas.**
- **GitHub mobile app obrigatório para revisar PRs.**
- **Cálculo histórico precisa de cache agressivo + versionado** — versão no cache key permite invalidar formato antigo silenciosamente.
- **`<select multiple>` nativo é inviável para UI custom no iOS Safari (PR #124).** Abre um picker/bottom-sheet controlado pelo sistema operacional (WebKit) — não há como injetar um botão "Clear" ou qualquer outro controle dentro dele via HTML/CSS/JS; o header nativo só tem setas de navegação e um X que apenas fecha o picker, sem resetar a seleção. Para qualquer filtro multi-select que precise de UX customizada (botão Clear, contagem de selecionados, etc.), pular direto para um componente próprio (chip-trigger + popover custom com checkboxes) em vez de tentar adaptar o `<select multiple>` nativo — evita 3 PRs de iteração (like #121-#123) até chegar na solução certa.
- **Versionar cache em vez de quebrar UX** — bumpar versão + escrever fallback que aceita ambos.
- **Feature grande em PRs iterativos é mais seguro.**
- **Coluna sticky essencial em tabelas largas no mobile.**
- **fxRate defensivo** — nunca assumir campo presente em dados antigos.
- **Asset class da transação é fonte de verdade do custo histórico.**
- **Import preview editável** — checkbox + inline edit antes de importar evita garbage data.
- **TTL de cache alinhado ao mercado** (PR #38) — TTL fixo em horas pode servir dados do dia anterior após o fechamento; alinhar ao fechamento (~21:00 UTC) garante atualização diária no momento certo.
- **KPI e tabela devem usar mesma fonte de dados** (PR #39) — KPI "Net Worth" e Position Performance divergiam porque usavam fontes diferentes (série histórica vs live). Unificar em soma live elimina a inconsistência.
- **`inferAssetClass()` com lookup prioritário** (PR #37) — lista explícita de ETFs conhecidos antes da heurística genérica evita classificações erradas (ex: TLT sendo classificado como Stocks).
- **Expandir `INCLUDED_CLASSES` exige bump de cache** — dados calculados mudam; versão antiga do cache retornaria Net Worth incorreto.
- **Disclaimer desatualizado é dívida técnica** — "Excludes fixed income" ficou errado após PR #37; corrigir junto com próxima mudança em Performance.jsx.
- **Cards colapsáveis em Performance** (PR #38) — consistência com padrão visual de Holdings reduz curva de aprendizado do usuário.
- **Tesouro Direto: validar fonte antes de implementar** (PR #41–#50) — Brapi `/treasury` é pago (403); endpoints oficiais descontinuados; CKAN desativado. Sempre checar disponibilidade real da API antes de desenhar a solução.
- **Fallback para manual é sempre válido** — quando não há fonte live gratuita, entrada manual em moeda nativa (BRL) + conversão automática é solução pragmática e suficiente para uso pessoal.
- **Validar API com endpoint de diagnóstico antes de implementar** — probe temporário confirmou: Yahoo `chart?events=div` funciona para US, brapi `dividends=true` é pago (403) para BRA Stocks. Economizou implementar a solução errada.
- **Ler o componente inteiro antes de codar** (PR #65) — o coder encontrou `buildYoyData` e `YearVsYearTable` quase completamente implementados no arquivo. Leitura previa do arquivo-alvo evita re-implementar logica existente. Padrao a seguir: pure functions fora do componente + `useMemo` por dentro, igual a `buildChartData` / `buildPositionRows`.
- **`Promise.allSettled` e o padrao correto para fetches secundarios** (PR #67) — quando um fetch adicional nao deve bloquear a UI principal, usar `allSettled` em vez de `all`. Falha silenciosa + exibir `--` nas colunas e melhor UX do que toast de erro ou tab quebrada.
- **YoC% agregado exige media ponderada** (PR #67) — somar TTM e dividir pelo custo total agregado, nao tirar media dos percentuais individuais. Erro sutil que distorce o indicador em portfolios com posicoes de tamanhos muito diferentes.
- **Campo da API: `totalReceived`, nao `amount`** (PR #67) — ao integrar com `api/dividends.js`, o campo relevante e `e.totalReceived`. Documentar o shape real da API no CONTEXT evita confusao para futuros integradores.
- **Ex-date ≠ pay date — sempre usar pay date para bucketing** (PR #73) — Yahoo retorna só ex-date; cash landing é na pay date. Bucket por ex-date desalinha Income History / Y/Y / Total Return com o extrato da corretora.
- **"Validar que está correto" não é o mesmo que "varrer todos os caminhos" (item 39)** — a validação inicial confirmou que `qtyAtDate` usava ex-date corretamente e fechou o item como "sem mudança de código". Mas a feature tinha um segundo bug não coberto pelos cenários descritos: dividendos com pay date futura (ex-date já passada) entravam no histórico como income recebido. Lição: ao validar uma feature de income/datas, conferir também o limite superior (futuro), não só a regra de entitlement. Um item de "validação" pode esconder bug adjacente — rodar o caminho real no app, não só ler a função citada.
- **Confirmar reachability de API nova a partir de IPs de datacenter antes de implementar** (PR #73) — `api.nasdaq.com` dá 403 do Vercel (Akamai bloqueia datacenters). APIs keyless/scrape-like são suspeitas de bloqueio; APIs de servidor com key (Polygon, Finnhub, etc.) funcionam.
- **PR base errada → commit órfão** — PR #72 foi baseado na branch do PR #71. Quando #71 foi mergeado, #72 ficou órfão e nunca chegou ao main. Sempre basear PRs de fix em `main`, não em outra feature branch.
- **Cache por taxa/datas imutáveis = global, não por usuário** — pay dates da Polygon são fatos públicos. Cache com chave `dividends:paydates:v1:{ticker}` (sem storageKey do usuário) é warm uma única vez por ticker para todos os usuários.
- **Auto-detecção de formato de data: varrer o conjunto antes de parsear (PR #77)** — detectar MDY vs DMY linha a linha não funciona quando ambos os campos são ≤ 12. Varrer todas as datas do arquivo e buscar evidência unambígua (campo > 12) resolve o problema sem precisar de input do usuário. Default MDY quando ambíguo, pois a fonte principal é Fidelity/Excel US.
- **Ramos de parsing em sequência eliminam dependência do `fmt` para casos simples (PR #77)** — `parseDate` trata ISO YYYY-MM-DD no primeiro `if` e retorna imediatamente; o `fmt` só importa para o segundo ramo (`A/B/YYYY`). Estrutura de early-return evita que mudança de default quebre formatos unambíguos.
- **Prop ignorada silenciosamente em JSX (PR #85)** — passar uma prop para um componente que nao a declara/consome e silenciosamente ignorado pelo React: o build passa, nenhum warning, a feature simplesmente nao funciona em runtime. Ao adicionar uma prop nova a um componente existente, verificar que o componente realmente a destrutua e usa internamente — nao apenas que o call-site a passa.
- **Padrao de responsividade sem CSS neste codebase (PR #85)** — state `windowWidth` + listener `resize` com cleanup e o padrao adotado. Derivar dimensoes inline via clamp/IIFE. Confirmar que `window` e acessado de forma defensiva (lazy init ou guard `typeof window !== "undefined"`) para compatibilidade com SSR futuro.
- **Ao refatorar funcao de transform, carregar todas as propriedades usadas downstream (PR #92)** — `buildClassGroups` inicialmente omitiu a propriedade `ticker: cls` que `sortRows` dependia para ordenar. O sort falhou silenciosamente (sem erro, resultado errado). Regra: ao criar funcao equivalente a outra, comparar os campos retornados um a um com os que o restante do codigo consome — nao apenas os campos que o novo codigo produz.
- **Remover codigo morto imediatamente apos refactor (PR #92)** — `buildAssetClassRows` ficou orphan apos `buildClassGroups` substituir seu uso. Codigo nao referenciado deve ser apagado na mesma session que o refactor, nao deixado para "cleanup depois".
- **Ler o arquivo antes de implementar evita retrabalho (PR #93)** — Task 1 (DIV TTM/YoC% para Bank Bonds) estava completamente implementada; nenhum codigo precisou ser escrito. Verificar o arquivo alvo antes de codar e mais rapido do que implementar algo que ja existe. Isso vale especialmente para features que foram entregues em PRs diferentes mas no mesmo arquivo.
- **Yahoo Finance retorna HTTP 200 com `dividends: {}` vazio para alguns ADRs — falha silenciosa (PR #94)** — VALE (NYSE) confirmado. Nenhum erro é lançado, o campo simplesmente vem vazio. Qualquer pipeline que depende de Yahoo para dividendos de ADRs deve ter fallback explícito para esse caso (null-check + objeto vazio). Finnhub `/stock/dividend` funciona como fallback keyed e já estava disponível via `FINNHUB_API_KEY`. Sempre ter fallback para tickers esperados a pagar dividendos.
- **Parser Fidelity descartava linhas de dividendo explicitamente com `else continue` (PR #95)** — A linha `else continue; // skip dividends` foi adicionada intencionalmente no parser original para ignorar tudo que não fosse `YOU BOUGHT`/`YOU SOLD`/`INTEREST`. Isso descartava silenciosamente todas as linhas `DIVIDEND RECEIVED` sem aviso. A lição: ao auditar um parser que "não captura X", procurar `continue` / `break` com comentário skip antes de assumir que o dado nunca chegou ao parser. Solução defensiva: capturar dividendos **antes** do bloco de side-detection, num guard dedicado, com `continue` explícito que documenta a intenção.
- **Dado real do usuário (Fidelity import) supera dado de API quando disponível** — Para dividendos recebidos, o extrato da corretora tem o valor exato creditado. APIs externas (Yahoo, Finnhub) recalculam qty × $/share, o que pode divergir por arredondamento, splits não reportados, ou falha silenciosa (VALE Yahoo vazio). Padrão: se `bondIncome` contiver eventos para um ticker, usá-los diretamente e pular o fetch externo. Custo: usuário precisa manter o CSV Fidelity importado.
- **Chaves de localStorage sem sufixo de usuario causam contaminacao cruzada (PR #109)** — `alertLog` flat era sobrescrito pelo segundo usuario a fazer login no mesmo browser, fazendo alertas ja lidos reaparecerem. Regra: qualquer estado client-side persistido em localStorage que seja especifico de conta DEVE ter a chave derivada da identidade do usuario autenticado. Usar `alertLogKey(auth)` como modelo: `alertLog:g:<email>` (Google) ou `alertLog:p:<senha[:8]>` (password). O backend ja fazia isso nas chaves Redis — o frontend deve seguir o mesmo padrao.
- **`POST /api/dividends` não retorna juros de bonds — apenas dividendos de ações (PR #108 fix)** — O endpoint filtra `bondIncome` por `kind: "dividend"` (Fidelity stock dividends) e ignora `kind: "interest"` (coupon de bonds). A Tab Dividends não depende do endpoint para bonds (calcula via `buildBondEvents` no frontend), mas a Tab Contributions usava o total do endpoint para preencher "Dividends (last month)" — ficava incorreto quando havia juros de bonds no período. Fix: após o fetch, somar `bondIncome` com `kind: "interest"` (ou sem `kind`, legado) do mês alvo diretamente no frontend.
- **Merge direto no main sem PR — constraint iPhone-only (commit c09a595)** — Usuário não tem preview funcional antes do merge: não há staging, Vercel só deploya do main, e não é possível abrir o app num browser diferente do iPhone para validar. Workflow correto: feature branch → `npm run build` verde → `git checkout -B main origin/main && git merge --no-ff <branch> && git push origin main`. O `checkout -B main origin/main` é necessário porque o `main` local pode divergir do remoto na managed remote execution environment.
- **`useEffect` de persistencia no localStorage deve incluir `auth` no dep array (jun/2026)** — Se o `useEffect` usa `alertLogKey(auth)` para derivar a chave de escrita mas `auth` nao esta no dep array, a closure captura a chave do mount inicial. Qualquer mudanca de `auth` posterior (refresh de token, logout/login) faz a leitura usar a chave nova enquanto a escrita ainda usa a antiga — estado split invisivel. Regra: toda vez que a chave de storage for derivada de `auth`, `auth` deve estar no dep array do `useEffect` que escreve.
- **`saveHoldingsToServer` no apply de CSV pode gravar estado stale — padrao aceito (PR #115)** — No modal de CSV Import, ao aplicar as mudancas, `saveHoldingsToServer` e chamado diretamente apos `setHoldings`. Como `setHoldings` e async no React, ha uma janela onde o estado lido pelo save pode ser o anterior ao `set`. Esse comportamento ja e aceito no restante do app (debounce de 1.5s em outros editores) e nao e problema critico aqui porque o usuario pode sempre dar Refresh All para resincronizar. Regra: nao tentar "ler o state apos set" — ou usar o valor novo calculado localmente ou aceitar o padrao de debounce.
- **Fidelity CSV: campo Action pode ter metadados ex-div colados no inicio (PR #116)** — Acoes recebidas como ex-dividend aparecem no CSV Fidelity com Action como "YOU BOUGHT EX-DIV DATE..." em vez de exatamente "YOU BOUGHT". `startsWith("YOU BOUGHT")` e `startsWith("YOU SOLD")` falhavam silenciosamente, descartando essas transacoes. Fix: usar `includes("YOU BOUGHT")` e `includes("YOU SOLD")`. Regra: ao checar o campo Action do CSV Fidelity, preferir `includes` a `startsWith` — o campo pode ter prefixos ou sufixos de metadados.
- **`bondTotal` em AporteQuinzenal deve filtrar apenas `kind === "interest"`, nunca `!e.kind` (PR #116)** — O filtro original era `e.kind === "interest" || !e.kind`, que incluia entradas sem `kind` (shape legado) no total de bonds — causando double-count com `apiTotal` (dividendos de acoes retornados pelo endpoint). Fix: `e.kind === "interest"` explicito, sem a clausula `|| !e.kind`. Regra: ao filtrar `bondIncome` por tipo, nunca usar `!e.kind` como alias de "interest" — o campo pode estar ausente por razoes de dados legados mas a intencao deve ser sempre explicita.
- **Bloco de dividendo no parser Fidelity DEVE checar `!includes("YOU BOUGHT") && !includes("YOU SOLD")` (jun/2026)** — ETF names como "ProShares S&P 500 Dividend Aristocrats" (NOBL) e "Schwab US Dividend Equity ETF" (SCHD) contem a palavra "DIVIDEND". Sem os guards, linhas de buy/sell de ETFs com esse nome caem no path de captura de dividendo, criando falso income. O guard duplo `!upper.includes("YOU BOUGHT") && !upper.includes("YOU SOLD")` deve estar imediatamente antes de qualquer codigo que identifique dividendos pelo campo Action do CSV Fidelity.
- **Linhas DISTRIBUTION no CSV Fidelity contem "DIVIDEND" no nome do ETF — purgar, nao capturar (jun/2026)** — Action "DISTRIBUTION" e uma operacao de distribuicao de ETF, nao um pagamento de dividendo ao titular. Contem a palavra DIVIDEND porque o nome do ETF aparece no campo. Tratamento correto: adicionar ao `distributionEvents` (purge list) no momento do import — entries stale sao removidos de `bondIncome` pelo composite key `date|ticker|amount` na proxima re-importacao. Nao tentar capturar como income.
- **Import parcial de Fidelity nao deve silenciar historico Yahoo de outros meses do mesmo ticker (jun/2026)** — Dedup por ticker inteiro (`fidelityTickers` Set) exclui todos os meses do Yahoo se qualquer mes foi importado. Correto: dedup por `(ticker, month)` via Set `fidelityCoveredMonths` com chave `ticker|YYYY-MM`. Apenas os meses efetivamente presentes no import ignoram o Yahoo; outros meses buscam normalmente.
- **Juros de core-cash/sweep da Fidelity (INTEREST EARNED CASH, symbol 9 digitos numericos) nao sao bond income (jun/2026)** — Linhas "INTEREST EARNED CASH" com symbol como `315994103` batem na regex de CUSIP (9 chars alfanumericos) mas representam juros do saldo de caixa da conta (sweep account), nao cupom de instrumento de renda fixa. Excluir do capture de bondIncome e adicionar ao purge list. Regra: alem da regex CUSIP, verificar se o action contem "INTEREST EARNED CASH" e tratar como sweep.
- **Estado local (`bi`) deve ser usado diretamente quando disponivel, nao o estado React (`bondIncome`) (jun/2026)** — Em `Dividends.jsx`, `bondIncome` state estava vazio durante o fetch async inicial porque o `useEffect` capturava a closure com o valor inicial (`[]`). A variavel local `bi` retornada do fetch ja tinha o valor correto. Regra: em `useEffect` com fetch, usar a variavel local retornada pelo fetch para qualquer logica subsequente no mesmo callback — nao ler do state React que ainda nao foi atualizado.
- **`HeaderPopover` de data usa seletor de ano+mes derivado dos dados, nao inputs manuais (Item 44, jun/2026)** — Inputs `From`/`To` livres eram propensos a erros de digitacao e nao comunicavam quais anos/meses tinham dados. Substituir por `dateOptions` (Map computado via `useMemo` a partir das transacoes carregadas) e derivar o seletor a partir dos dados reais elimina o erro de input e facilita a navegacao por periodo. Estado `expandedYears` (Set) fica local ao `HeaderPopover` — sem necessidade de elevar ao `TransactionTable` ou ao `App.jsx`.
- **Um snapshot Redis que so grava (write-only) nao protege contra perda do localStorage (PR #118, jul/2026)** — O auto-snapshot de Contributions ja existia desde o PR #112, mas so era usado para popular a tabela de historico; `config.extras` continuava dependendo 100% de `localStorage["aporteConfig"]`. Quando o Safari iOS limpava o site storage, a extra label do usuario sumia mesmo com o dado ja salvo no Redis. Regra: se um dado tem um snapshot server-side, adicionar tambem um restore one-time no mount (guard por ref, dispara so quando o estado local esta vazio) — nao deixar o snapshot ser so um log historico.
- **Filtro que pode esvaziar resultados deve manter a UI de controle sempre visivel (PR #126, jul/2026)** — Round 1 do `TickerFilterPopover` (Position Performance/Position Dividends) escondia o `<thead>` inteiro quando o filtro zerava as linhas visiveis — o icone `Filter` que abre o popover ficava junto, travando o usuario sem forma de limpar a selecao. Fix: manter o `<thead>` sempre montado e mover o empty-state ("No tickers match the selected filter.") para uma linha dentro do `<tbody>`. Regra: qualquer controle de filtro (icone, botao, chip) deve viver fora do bloco condicional que esconde o conteudo filtrado.
- **Vercel Hobby plan limita `api/` a 12 Serverless Functions — checar `ls api/*.js` antes de criar arquivo novo (PR #128, jul/2026)** — Criar `api/alerts-read.js` como 13o arquivo quebrou o Preview Deployment (`errorCode: exceeded_serverless_functions_per_deployment`, confirmado via `mcp__Vercel__get_deployment`). Foi deletado e a rota consolidada dentro de `api/contributions-history.js` via query param `?resource=alerts-read`. Regra: sempre que uma feature precisar de endpoint novo, primeiro checar a contagem atual de arquivos em `api/`; se ja estiver em 12, consolidar via query param dispatch dentro de um arquivo existente relacionado, em vez de criar arquivo novo.
- **`toISOString()` para "data de hoje" e um bug de timezone silencioso (PR #128, jul/2026)** — `new Date().toISOString().slice(0,10)` sempre usa UTC, nunca a data local do device. Para usuarios em timezone negativo (Brasil, UTC-3), qualquer comparacao de "hoje" feita assim erra perto da virada do dia UTC (ex: domingo a noite local ja e segunda em UTC). Qualquer novo calculo de "hoje"/"data local" no frontend deve usar um helper que ajuste pelo offset de timezone do browser (`localTodayISO`), nunca `toISOString()` puro.
- **Replicar o padrao de sort ja existente no mesmo arquivo, nao reinventar (jul/2026, commit `0ecde97`)** — Ao tornar os headers de `YearVsYearTable` sortaveis em `src/Dividends.jsx`, o padrao de `handleSort`/indicador `↕`/`↑`/`↓`/comparador com nulls no fim ja existia em `PositionDividendsTable` no mesmo arquivo. Reaproveitar em vez de desenhar um novo mecanismo evitou inconsistencia de UX entre tabelas irmas e reduziu a superficie de codigo novo. Regra: antes de implementar sort/filter/toggle numa tabela nova, checar se um componente vizinho no mesmo arquivo ja resolveu o mesmo problema.
- **Um metadado calibrado so conta como "usado" se TODOS os pontos de consumo o lerem, nao so a UI de exibicao (jul/2026, commit d93cd87)** — `freqByCusip` (frequencia real calibrada por pagamentos Fidelity) ja existia desde o PR #87/#107 e ja alimentava corretamente `buildBondProjections` (commit d6dc43b) e o sub-header do Bond Projections (PR #107). Mas `buildBondEvents` — o accrual que gera o historico "EST" do Income History — nunca foi atualizado para usa-lo no *sizing* do periodo, continuando a fatiar sempre por mes de calendario fixo. Regra: ao auditar se um dado calibrado "ja e usado", listar TODOS os consumidores da funcao/feature (nao so o mais visivel) antes de considerar o gap fechado.
- **Accrual estimado nunca deve gerar um evento "pago" para um periodo ainda em curso (jul/2026, commit d93cd87)** — o bug incluia sempre o periodo corrente incompleto no historico, datado em "hoje - 1 dia" (a data em que o usuario abriu a pagina, nao uma data de pagamento real). Isso fazia todo bond em aberto exibir uma estimativa na mesma data arbitraria, mudando a cada acesso. Regra: eventos de accrual/estimativa so devem ser emitidos para periodos inteiramente decorridos; projecao de periodo futuro/corrente pertence a um card de "projections", nao ao historico de pagamentos.
- **Ao encadear segmentos de accrual apos um pagamento real, o proximo segmento comeca em `dataDoPagamento + 1 dia`, nunca no mesmo dia (jul/2026, commit d93cd87)** — sem avancar a data, o accrual reabria e sobrepunha o dia do pagamento real recem-importado, criando um "coto" de estimativa que duplicava parte de um valor ja contabilizado como real. Reportado pelo usuario: em 8/jul viu 4 CUSIPs "EST" quando o import real (Fidelity accounts history) so tinha 2 pagamentos reais naquele dia. Regra geral (reforca a licao do PR #87 sobre store separado de `bondIncome`): qualquer boundary entre "dado real importado" e "estimativa calculada" precisa de um teste mental explicito do dia seguinte ao evento real, nao so do proprio dia.
- **Guard de loading por `transactions.length` falha para contas com zero transacoes (jul/2026, commit a60bb9f)** — o `useEffect` de fetch filtrado em `Performance.jsx` usava `transactions.length` como proxy de "dados carregados"; contas sem nenhuma transacao nunca saiam do estado de loading porque `length` permanece 0 mesmo apos o fetch completar com sucesso. Regra: usar um flag booleano explicito de "fetch concluido" (`transactionsLoaded`), nunca o tamanho de um array que pode legitimamente ser zero. Pego na rodada 1 de auditoria do feature-auditor, corrigido antes do merge.
- **Sanity-checks ad-hoc do auditor nao substituem teste formal no suite (jul/2026, Composition Evolution)** — o auditor escreveu e rodou 3 casos manuais para `computeCompositionSeries` (agregacao por classe, conversao FX BRA, candle ausente, input vazio) fora de `test/perf-history.test.mjs`; todos passaram mas nao ficaram no repo. Gap conhecido, nao bloqueante: qualquer regressao futura em `computeCompositionSeries`/`computeBankBondsValueAt` nao sera pega pelo `node test/perf-history.test.mjs` ate que os casos sejam formalizados. Regra: ao validar uma funcao pura nova, preferir adicionar o caso ao suite existente em vez de rodar script descartavel — o custo marginal e baixo e fecha o gap de cobertura de forma permanente.
- **Filtros que podem esvaziar resultados devem manter a barra de controle sempre renderizada, independente do dataset filtrado (jul/2026, commit a60bb9f)** — a barra de filtros Asset Class/Ticker do grafico Performance dependia de `rawData.length > 0` para renderizar; uma combinacao de filtros que zerasse os resultados escondia os proprios controles (incluindo o botao "Clear filters"), travando o usuario num estado vazio irrecuperavel sem forma de resetar via UI. Mesma familia de bug do PR #126 (thead escondido em Position Performance/Position Dividends). Regra reforcada: qualquer UI de filtro (chip, popover, botao Clear) deve viver fora de blocos condicionados ao dataset ja filtrado. Pego na rodada 1 de auditoria, corrigido antes do merge.

-----

## 📝 Como Atualizar Este Documento

`docs/CONTEXT.md` e `docs/Features_Roadmap.md` vivem no repo. Atualizá-los via Claude Code diretamente — commitar junto com o PR da feature ou num PR separado de docs.

**Prompt padrão para Claude Code:**
> "Atualize `docs/CONTEXT.md` e/ou `docs/Features_Roadmap.md` refletindo o que foi feito nesta session. Commitar no mesmo PR ou abrir PR separado de docs."

**Não criar `Handoff-v4`, `Handoff-v5`…** — GitHub já versiona.
