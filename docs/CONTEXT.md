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
- Tab **TRANSACTIONS** (id interno `transactions`): log de transações (carregado lazy ao clicar).
- Tab **PERFORMANCE (TEST ONLY)** (id interno `performance`): gráfico de performance (carregado lazy ao clicar). Marcado TEST ONLY pra sinalizar MVP a usuários compartilhados.

O switcher fica logo abaixo do H1 dinâmico. State `activeView` em `PortfolioTracker`.

-----

## 💼 Feature: Transactions (Fase 1 completa)

Tab nova, separada do Dashboard. Storage isolado.

### Storage

- Chave Redis: `portfolio:<auth>:transactions` (paralela ao `:holdings`, sem refator do existente).
- Endpoint: `api/transactions.js` (GET / PUT, mesmo padrão de `api/holdings.js`).
- Storage key é derivada de `auth.storageKey` substituindo `:holdings` por `:transactions`.

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
  - `date` → Date range From/To
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

Modal `ImportModal` com 2 tabs:

- **Upload CSV** (default): file picker, parser genérico com:
  - Auto-detect de delimitador (`,` `;` `\t` `|`)
  - Auto-detect de header (aliases PT/EN)
  - Decimal handling: prompt amarelo se vírgula detectada em campos numéricos → re-parse tratando como decimal BR
  - `fixBRSplitRow`: structural break heurística
  - Preview com tabela: contadores `N valid · M errors · X need class`, modo Append vs Replace
  - needsAssetClass: dropdown completo no preview pra resolver linha por linha
  - Sides aceitas: buy/sell/compra/venda/c/v
- **Fidelity** (`parseFidelityCSV`): parser dedicado para o "Accounts History" CSV nativo da Fidelity:
  - Pula BOM + 2 linhas em branco iniciais
  - Acha header pela presença de "Run Date" + "Action"
  - Importa **só** `YOU BOUGHT` e `YOU SOLD`
  - `YOU SOLD` com quantidade negativa → `side="sell"`, qty = abs
  - **Datas MDY** (americano) — override do default DMY
  - Todas as transações entram como USD + assetClass via `inferAssetClass()`

**Preview editável:**
- Checkbox por linha no preview — todas marcadas por default
- Header checkbox = select/deselect all
- **Double-click numa linha** → inline edit. Enter salva, Esc cancela.
- Botão de import mostra `Import X of Y rows`
- Só linhas marcadas são importadas

**Tab Paste foi removida.**

**Export CSV** (botão Download): gera `transactions-YYYY-MM-DD.csv`.

-----

## 📈 Feature: Performance (MVP — TEST ONLY)

Tab nova, separada. Lê do log de transações. Marcada **(TEST ONLY)** em badge gold.

### Storage

- Endpoint: `api/perf-history.js` (POST)
- Cache Redis: `portfolio:<storageKey>:perf-history`, TTL até próximo fechamento do mercado US (~21:00 UTC = 16h ET), **versão v11**
- Auth: mesmo padrão de `api/transactions.js`

### Lógica server-side

1. Recebe `{ transactions }` no body
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
- **Disclaimer:** "Excludes Cash and Unallocated assets. Updated daily after US market close." (correto — Cash e Unallocated são os únicos excluídos)
- **Period selector:** botões `1M | 6M | YTD | 1Y | 5Y | MAX`
- **Toggle:** "Compare vs S&P 500" ↔ "← Net Worth"
- **Card colapsável "Portfolio Performance & Net Worth"** (PR #38): mesmo padrão visual do card "Rebalance Suggestions" da aba Holdings — botão full-width, label gold, ícone ChevronDown rotativo. Mostra "as of [data]" no header assim que dados carregam.
- **KPI cards:**
  - **Net Worth** — soma ao vivo de `positionRows` (preços Finnhub live, mesma fonte da Position Performance)
  - **Portfolio {period}** — TWR % do portfólio no período selecionado
  - **S&P 500 {period}** — TWR % do SPY (só em modo comparação)
  - **Alpha** — diferença Portfolio − SPY (só em modo comparação)
- **Chart title** dinâmico por modo ("Net Worth Growth" / "Portfolio VS S&P 500")
- **Gráfico (`recharts <LineChart>`):** XAxis com ticks de calendário, tooltip com data completa, Eye Toggle integrado
- **Eye Toggle:** oculta Net Worth (USD absoluto) e tooltip; percentuais sempre visíveis; eixo Y colapsa 64→16px quando oculto
- **Fallback de compatibilidade:** `effectiveComparing = comparing || !hasUSD`

### Tabela: Position Performance

Card colapsável "Position Performance" (PR #38), mesmo padrão visual. Toggle "Group by class" movido para dentro do corpo do card.

**Colunas (8, todas clicáveis com sort asc/desc):**

```
Ticker (sticky) | Avg Cost | Price | Qty | Total Cost | Current Value | Total Gain/Loss | Gain/Loss %
```

- Default sort: Current Value desc
- Linha **TOTAL** fixa no topo
- **Group by class:** subtotais por asset class, grupos colapsáveis com chevron
- Ativos BR incluídos via `h.fxRate` (fallback: `h.originalPrice / h.price`)
- Asset class lida de `tx.assetClass`
- Eye toggle: mascara valores em $; % sempre visível

### Cache versioning

| Versão | Motivo do bump |
|--------|----------------|
| v10    | Adicionou `portfolioUSD` à resposta |
| v11    | `INCLUDED_CLASSES` expandido (PR #37 + #39) |
| v12    | Cache key inclui hash das transactions — invalida automaticamente quando transactions mudam |

### Estados especiais

Loading / erro / vazio com mensagens específicas por `meta.reason`.

### Limitações conhecidas (MVP)

- **Finnhub free tier:** ~1 ano de histórico diário
- **Fixed income sem preço de mercado:** CDs e Tesouro ignorados silenciosamente no cálculo do gráfico (aparecem na Position Performance via preço manual)
- **TWR** escolhido vs benchmark; MWR/IRR fica pra Fase 2
- **Position Performance usa câmbio atual** para ativos BR
- **Cache v12** com hash de transactions — invalida automaticamente quando transactions mudam (antes, cache de `perf-history` ficava stale após edições)

-----

## 🏠 Feature: Holdings (resumo)

- **Layout:** lista compacta — cada holding é um `HoldingRow` com linha principal e painel colapsável
- **Holdings manuais:** `ManualHoldingRow`
- **Cash:** ID permanente `CASH_ID = "cash-permanent"`, garantido por `ensureCashAccount()`
- **Badge B3:** visível para holdings com `market === "B3"`
- **Eye Toggle (`valuesHidden`):** state global em `App.jsx`, persiste em `localStorage`. Prop passado para `<TransactionsView>` e `<PerformanceView>`.
- **Manage Users:** seção colapsável no dashboard, visível apenas para `isAdmin`

### Holdings manuais — BRA Fixed Income (PR #49 — jun/2026)

Holdings com `assetClass === "BRA Fixed Income"` aceitam valor em BRL (`manualCurrency: "BRL"`):
- Seletor **USD / R$ BRL** nos forms de adicionar/editar
- Valor exibido: BRL ao lado do USD convertido na linha do holding
- Conversão via `usdBrlRate` — buscado em `GET /api/price?fx=USDBRL` (cascata Finnhub → open.er-api → Frankfurter), cacheado em localStorage, atualizado no load e no "Refresh all"
- Tesouro Direto sem fonte live gratuita — mantido manual em BRL (ver Lições Aprendidas)
- CDB Banco Guanabara (`121,50% CDI, venc. out/2028`) — manual em BRL até vencimento; não será renovado

-----

## 💰 Feature: Dividends (em construção)

Tab nova, arquivo separado (`src/Dividends.jsx`), lazy-loaded como Performance.

### Storage

- **Auto income** (US Stocks/ETFs): calculado server-side por `api/dividends.js`, cache Redis versionado.
- **Manual income** (BRA Stocks, BRA Fixed Income, Bank Bonds): `portfolio:<storageKey>:income-manual` (array JSON, mesmo padrão de `:transactions`). Endpoint: `api/income-manual.js` (GET/PUT).

### Modelo de income-manual

```js
{
  id,             // crypto.randomUUID()
  date,           // "YYYY-MM-DD" — data do pagamento
  ticker,         // "tesouro-ipca-2035", "BBSE3", "949764WE0"...
  assetClass,     // "BRA Fixed Income" | "Bank Bonds" | "BRA Stocks" | ...
  incomeType,     // "coupon" | "dividend" | "jcp"
  totalReceived,  // valor total recebido (não por unidade — mais natural para Tesouro/Bonds)
  currency,       // "USD" | "BRL"
  notes,          // opcional
  createdAt       // ISO timestamp
}
```

### Fontes de dados (validadas via probe PR #58)

| Asset class | Fonte | Método |
|---|---|---|
| US Stocks, ETFs | Yahoo `chart?events=div` | Auto server-side |
| BRA Stocks | Sem API gratuita (brapi pago) | Manual |
| BRA Fixed Income (Tesouro IPCA) | Sem API | Manual |
| Bank Bonds | Sem API | Manual |

### `api/dividends.js` (POST)

- Recebe `{ transactions }`
- Filtra tickers US (non-B3)
- Busca `chart?events=div` via Yahoo para cada ticker (mesmo host de `perf-history.js`)
- Calcula `qtyHeld` na pay-date cruzando com transactions
- Retorna array de `{ date, ticker, assetClass, incomeType: "dividend", amountPerShare, qtyHeld, totalReceived, currency: "USD", source: "api" }`
- Cache Redis versionado (TTL diário)

### UI — itens do roadmap

- **Item 17**: Gráfico de barras (Year | 6M | Quarter | Month) — consolida auto + manual
- **Item 18**: Tabela mês × ano
- **Item 19**: Mês anterior vs mês atual (+ a receber)
- **Item 24**: Comparador y/y por mês e asset
- **Form manual**: add/edit/delete income entries (date, ticker, assetClass, incomeType, totalReceived, currency, notes)

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
|**brapi `dividends=true` rejeitado para BRA Stocks (Tab Dividends)**|HTTP 403 `FEATURE_NOT_AVAILABLE` — dados de dividendos são feature paga na brapi. VALE3 funciona só por ser ação de teste com acesso irrestrito.|
|**BRA Stocks dividendos = manual (Tab Dividends)**|Sem API gratuita confirmada. Entrada manual no form da Tab Dividends, mesmo padrão de Tesouro/CDB nos Holdings.|
|**Income model unificado: `totalReceived` direto (Tab Dividends)**|Tesouro IPCA e Bank Bonds pagam cupom cujo valor depende do PU corrigido — mais natural lançar o total recebido do que qty × amountPerUnit.|

-----

## 🌐 Estado Externo (precisa validação periódica)

- **Google App:** ✅ **Publicado** (saiu do modo Testing — confirmado em 21/mai/2026)
- **Env vars no Vercel:** ⚠️ **Verificação pendente.** Lista esperada: `APP_PASSWORD`, `FINNHUB_API_KEY`, `BRAPI_API_KEY`, `REDIS_URL`, `GOOGLE_CLIENT_ID`, `VITE_GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`, `ADMIN_EMAILS`, `VITE_ADMIN_EMAILS`.
- **Admin atual:** `pnetto@gmail.com`
- **Usuários ativos:** Pedro + 1 amigo

-----

## 📦 O Que Tem no Código (não duplico aqui — leia o repo)

- Frontend Holdings: `src/App.jsx`
- Frontend Transactions: `src/Transactions.jsx`
- Frontend Performance: `src/Performance.jsx`
- Endpoints: `api/holdings.js`, `api/transactions.js`, `api/perf-history.js`, `api/price.js`, `api/index-quote.js`, `api/users.js`
- Auth + Redis: `lib/auth.js`, `lib/redis.js`

**Endpoints (resumo):**

| Endpoint | Função |
|---|---|
| `GET /api/holdings` | Retorna `{ exists, holdings, savedAt, method, email, admin }` |
| `PUT /api/holdings` | Salva array de holdings |
| `GET /api/transactions` | Retorna `{ exists, transactions, savedAt, method, email, admin }` |
| `PUT /api/transactions` | Salva array de transações |
| `GET /api/price` | Quote real-time de um ticker (Finnhub para US, brapi para B3); `?fx=USDBRL` retorna taxa de câmbio |
| `GET /api/index-quote` | Quote do SPY |
| `POST /api/perf-history` | Recebe `{ transactions }`, retorna série TWR + portfolioUSD (cache Redis v11) |
| `GET/POST /api/users` | Admin: listar/convidar/remover emails no allowlist Redis |

-----

## 🚀 Próximas Features (ver [`docs/Features_Roadmap.md`](./Features_Roadmap.md) para lista completa)

**Próximas sessions:**
- Fix disclaimer Performance.jsx ("Excludes fixed income" desatualizado)
- Tab Dividends (itens 17–19, 24)
- Tab Aporte Quinzenal (itens 25–28) ⭐
- Tab Events (itens 20–22)
- Validação de slug/ticker ao adicionar transação (deferred)

**Deferred indefinidamente:**
- Auto-refresh silencioso de token Google
- DELL sell/buy timing agent
- Refactor `api/price.js` e `api/index-quote.js` pro novo contrato de auth
- Derivação automática de holdings a partir do log de transações
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
- **Claude Code: bug fix = nova session.**
- **Claude Code: atualizar `docs/CONTEXT.md` + `docs/Features_Roadmap.md` ao final de sessions relevantes.**
- **Sonnet 4.6 é suficiente pra 95% das tarefas.**
- **GitHub mobile app obrigatório para revisar PRs.**
- **Cálculo histórico precisa de cache agressivo + versionado** — versão no cache key permite invalidar formato antigo silenciosamente.
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
- **Validar API com endpoint de diagnóstico antes de implementar** — probe temporário (`api/dividends-probe.js`, PR #58) confirmou: Yahoo `chart?events=div` funciona para US, brapi `dividends=true` é pago (403) para BRA Stocks fora do quarteto de teste. Economizou implementar a solução errada.

-----

## 📝 Como Atualizar Este Documento

`docs/CONTEXT.md` e `docs/Features_Roadmap.md` vivem no repo. Atualizá-los via Claude Code diretamente — commitar junto com o PR da feature ou num PR separado de docs.

**Prompt padrão para Claude Code:**
> "Atualize `docs/CONTEXT.md` e/ou `docs/Features_Roadmap.md` refletindo o que foi feito nesta session. Commitar no mesmo PR ou abrir PR separado de docs."

**Não criar `Handoff-v4`, `Handoff-v5`…** — GitHub já versiona.
