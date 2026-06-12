# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Docs (read these first)

- **[`docs/CONTEXT.md`](docs/CONTEXT.md)** — Identidade do projeto, stack, constraints, decisões técnicas, regras de operação do Claude, deploy pattern, diagnóstico e lições aprendidas. **Leia antes de propor qualquer mudança.**
- **[`docs/Features_Roadmap.md`](docs/Features_Roadmap.md)** — Backlog completo: features concluídas (com PR de referência) e pendentes (Dividends, Aporte Quinzenal, Events).

> **Atualizar esses dois arquivos** ao final de sessions que mudam features ou decisões técnicas — commitar junto com o PR da feature ou num PR separado de docs.

## Deploy Pattern

**Merge direto no main** — não usar PR. O usuário não tem como fazer preview funcional antes do merge (constraint iPhone-only). Workflow:

1. Implementar na branch de feature
2. Build verde confirmado (`npm run build`)
3. `git checkout -B main origin/main` → `git merge --no-ff <branch>` → `git push origin main`
4. Vercel rebuilda automaticamente em ~1-2 min

**Não criar PR** a menos que o usuário peça explicitamente.

## Commands

```bash
# Local dev (Vite only — no API functions)
npm run dev

# Local dev with Vercel serverless functions
npm run vercel-dev        # requires `vercel` CLI linked to a project

# Build
npm run build

# Tests (no test runner — plain Node ESM)
node test/perf-history.test.mjs
```

There is no linter configured. No other test files exist.

## Architecture

**Stack:** Vite + React 18 SPA (frontend) + Vercel serverless functions (backend). No framework router — view switching is a single `activeView` state in `App.jsx`. All inline styles; no CSS files or Tailwind.

### Frontend (`src/`)

- `main.jsx` — Vite entry, mounts `<App />`
- `App.jsx` — Root component (~4800 lines). Owns all state: auth, holdings, sync, UI modals/toasts. Renders one of three views based on `activeView`: `"dashboard"`, `"transactions"`, `"performance"`.
- `Transactions.jsx` — Standalone transactions log view; receives `auth` + `knownTickers` as props.
- `Performance.jsx` — Lazy-loaded (`React.lazy`). Shows a USD value chart by default; "Compare vs S&P 500" toggle switches to TWR % lines. Fetches its own data independently from the holdings state.

**Holding types** (stored in Redis as JSON array):
- `type: "auto"` — ticker-backed, price fetched from Finnhub/brapi
- `type: "manual"` — user-entered value or qty×price. `manualMode: "value"` | `"qty_price"`. Cash accounts are manual holdings with `assetClass: "Cash"` and are displayed in a separate section.

**BRA Fixed Income (Tesouro Direto):** there is no viable public price source — brapi's Tesouro endpoint requires a paid plan (403), and the official `tesourodireto.com.br` JSON (410) and Tesouro Transparente CKAN datastore APIs (400, disabled) are gone. So these are **manual** holdings. When `assetClass === "BRA Fixed Income"` (value mode), the amount can be entered in **BRL** (`manualCurrency: "BRL"`, e.g. a Nubank balance) and is converted to USD via a live `usdBrlRate`. The rate comes from `GET /api/price?fx=USDBRL` (cascade: Finnhub forex → open.er-api → Frankfurter), is cached in `localStorage`, and refreshes on load and "Refresh all". Tickers matching `tesouro-*` and the `BRA Fixed Income` class are skipped by the Transactions ticker-resolution check (no price source to validate against).

**Auth state shape** (persisted in `localStorage`):
```js
{ kind: "google", googleToken, email, name, picture }
{ kind: "password", password }
```
Passed as `auth` prop everywhere; `authHeaders(auth)` builds the HTTP headers.

### Backend (`api/`)

Vercel serverless functions (Node.js ESM). Each file exports a default `async function handler(req, res)`.

| Route | Purpose |
|---|---|
| `api/holdings.js` | GET/PUT portfolio holdings (Redis) |
| `api/transactions.js` | GET/POST/DELETE transaction log (Redis) |
| `api/price.js` | Real-time quote for one ticker |
| `api/index-quote.js` | SPY day quote (for dashboard benchmark badge) |
| `api/perf-history.js` | POST `{ transactions }` → TWR series + portfolioUSD series |
| `api/users.js` | Admin: list/invite/remove allowlist emails |

### Shared libraries (`lib/`)

- `lib/auth.js` — `authenticate(req)` returns `{ ok, storageKey, email, admin, … }`. Verifies Google JWTs manually (no library) using Google's JWKS endpoint. Also checks `ALLOWED_EMAILS` env + Redis allowlist set + `ADMIN_EMAILS` env.
- `lib/redis.js` — Singleton `ioredis` client from `REDIS_URL` env.

### Redis key scheme

```
portfolio:email:<sha256(email)[0:16]>:holdings        — holdings JSON
portfolio:email:<sha256(email)[0:16]>:transactions    — transactions JSON
portfolio:email:<sha256(email)[0:16]>:perf-history:vN — perf cache
portfolio:pwd:<sha256(password)[0:16]>:holdings       — password-auth variant
portfolio:allowlist                                    — SET of allowed emails
```

**Cache versioning:** `perf-history` cache includes a version suffix (`v11` currently). Bump the version whenever the response shape changes — old cached responses will be ignored automatically.

### Performance algorithm (`api/perf-history.js`)

`computePerformance({ transactions, candles, spyCandles, firstDate, todayDate })` is a pure function (exportable, tested directly). It:
1. Filters transactions to `INCLUDED_CLASSES = { Stocks, BRA Stocks, Alternative, Real Estate }`.
2. Replays transactions day-by-day to track positions.
3. Computes Time-Weighted Return (TWR): daily return = `Σ(prevQty × todayPrice) / Σ(prevQty × yesterdayPrice)`, chained multiplicatively. New buys on day N don't inflate that day's return — only subsequent price appreciation counts.
4. Returns parallel arrays: `dates[]`, `portfolio[]` (TWR % from inception, base=0), `portfolioUSD[]` (absolute USD value), `spy[]` (SPY TWR %).

Price sources for history:
- **US tickers:** Twelve Data primary (`TWELVEDATA_API_KEY` env), Yahoo Finance fallback (no key needed, low concurrency).
- **BRA tickers (B3):** brapi.dev (`BRAPI_API_KEY` env). Pattern: 4 letters + 1–2 digits (e.g. `BBSE3`).
- **FX (BRL→USD):** Frankfurter API.
- **SPY:** Yahoo Finance.
- All history cached 24h in Redis.

Price sources for real-time quotes (`api/price.js`):
- **US stocks:** Finnhub (`FINNHUB_API_KEY` env) — quote + company profile.
- **BRA stocks:** brapi.dev — BRL price + USD/BRL FX for conversion.

### Required environment variables

```
REDIS_URL              — Upstash Redis (or any ioredis-compatible URL)
FINNHUB_API_KEY        — real-time US quotes
TWELVEDATA_API_KEY     — historical US price series
BRAPI_API_KEY          — Brazilian B3 prices
GOOGLE_CLIENT_ID       — Google OAuth client ID (for token verification)
APP_PASSWORD           — fallback password auth
ALLOWED_EMAILS         — comma-separated list of allowed Google emails
ADMIN_EMAILS           — comma-separated list of admin emails
```

### Design tokens

All components share the same dark-theme palette defined locally as `const T = { bg, card, cardElev, border, … }` and the same font variables `FONT_DISPLAY` (Fraunces), `FONT_BODY` (Manrope), `FONT_MONO` (JetBrains Mono). These are duplicated across files by design — no shared theme file.
