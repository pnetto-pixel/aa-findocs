# Plano — Feed SimpleFin → Fidelity (evolução do item 38)

> Status: **PLANO** (nada implementado). Assessment feito em 21/jul/2026.
> Contexto novo: o usuário criou uma conta no **SimpleFin Bridge** e já consegue puxar
> dados da conta Fidelity dele (tem um *access URL* ativo). Este plano substitui o
> caminho "scraper Playwright + TOTP em GitHub Actions" do
> [`item-38-fidelity-export-automation.md`](./item-38-fidelity-export-automation.md)
> por um fetch direto na API do SimpleFin — sem credenciais da Fidelity armazenadas,
> sem scraping, sem zona cinzenta de ToS.
>
> Execução prevista: **feature-workflow com Sonnet**, em fases pequenas e auditáveis.

---

## 1. O que JÁ existe no repo (reaproveitar, não reconstruir)

O item 38 deixou um pipeline de staging + aprovação **implementado e dormente** que serve
quase inteiro para o SimpleFin:

| Peça | Onde | Estado |
|---|---|---|
| Endpoint de ingestão (service-token, escreve só em `:fidelity-pending`, dedupe vs live + pending, suporta `transactions` + `bondIncome`) | `api/ingest-fidelity.js` | Dormente (inerte sem `INGEST_TOKEN`) |
| Endpoint user-auth de leitura/limpeza do staging | `api/fidelity-pending.js` | Ativo |
| Card dourado "Fidelity Import — N new" com checkboxes, aprovação seletiva, merge via `persist()` (sync Holdings automático) | `src/Transactions.jsx` (~linha 4460) | Ativo (aparece quando há staged) |
| Parser Fidelity puro e testado (25 casos): BOUGHT/SOLD, bonds qty/1000 price×10, INTEREST, DIVIDEND, FOREIGN TAX, REDEMPTION | `src/lib/parsing.js` + `test/fidelity-parser.test.mjs` | Ativo |
| Scraper Playwright + runbook | `docs/plans/scraper/`, `item-38-activation-runbook.md` | Nunca ativado |

**Conclusão central do assessment:** o trabalho novo é (a) um *fetcher/mapper* SimpleFin →
modelo do app, (b) estender o staging/aprovação para cobrir também **updates de valor**
(Cash, Bank Bonds), que hoje não existem no pipeline (só transações + income). O resto é fio.

---

## 2. SimpleFin — o que é e o que muda

- **SimpleFin Bridge** (bridge.simplefin.org): agregador pago pelo próprio usuário
  (~US$1,50/mês). O usuário conecta a Fidelity no site do Bridge; o app recebe um
  **access URL** (credenciais embutidas, HTTP Basic) e faz
  `GET {accessUrl}/accounts?start-date=…&end-date=…` → JSON com contas, saldos,
  transações e (para contas de investimento, dependendo da instituição) `holdings`.
- **Setup token é one-time claim**: o token que o usuário copia do Bridge só pode ser
  trocado pelo access URL **uma vez**; o access URL resultante é o segredo durável.
- Dados são atualizados pelo agregador tipicamente ~1×/dia. Polling educado: 1–4×/dia
  no máximo; sync on-demand ao abrir o app é suficiente (sem cron).
- O que muda vs o plano do item 38: **elimina** senha da Fidelity + segredo TOTP + repo
  privado + GitHub Actions + fragilidade de seletores. O risco de ToS sai da Fidelity e
  vira uma relação suportada (agregador).

### ✅ Incerteza nº 1 — resolvida via probe real (jul/2026, 2 rodadas)

Duas rodadas reais do probe (Fase 0) contra a conta Fidelity do usuário — a segunda com a
conta Fidelity retornando a lista **completa** de holdings/transactions (não mais amostra).
Achados (sem dados sensíveis reais neste documento — só o shape estrutural, com exemplos
ilustrativos genéricos em vez dos valores/tickers reais do usuário):

1. **Cash → resolvido, mapeamento direto (2 fontes redundantes).** O campo
   `available-balance` da conta Fidelity é o core/cash sweep. O array `holdings` também
   traz um item sintético com `description: "CASH"`, `symbol: ""`, `market_value` igual ao
   `available-balance` — mesma informação, duas formas de chegar nela. `balance` é o valor
   total da conta (títulos + cash), não confundir com Cash.
2. **Bank Bonds → resolvido, com uma correção importante.** O array `holdings` traz
   `market_value` calculado por posição, inclusive para CDs/Treasuries (`shares` = valor de
   face em dólares, `market_value` = valor de mercado atual — direto, sem a conversão
   `qty/1000`/`price×10` que o parser do CSV precisa fazer). **Não tem CUSIP**
   (`symbol: ""`) — mas como o holding `bank-bonds-aggregate` do app já é agregado (não
   rastreia CUSIP individual na UI), basta somar `market_value` de todo holding com
   `symbol === ""`. **Correção:** o holding sintético `"CASH"` (achado do item 1) *também*
   tem `symbol: ""` — a regra de identificação precisa ser
   `symbol === "" && description !== "CASH"`, senão o saldo em dinheiro entra na soma dos
   bonds por engano.
3. **Dividendos/interest → resolvido, alta reutilização.** `description` reproduz quase
   literalmente as Actions do CSV Fidelity: `"DIVIDEND RECEIVED <empresa> (<TICKER>)
   (Cash)"`, `"INTEREST <emissor do CD/bond> (Cash)"` (às vezes com prefixo
   `"INTEREST as of YYYY-MM-DD ..."`). Ticker extraível via regex simples
   (`\(([A-Z]{1,5})\)` antes do `(Cash)` final). Confirmados também, com o mesmo texto já
   tratado em `src/lib/parsing.js`: `"INTEREST EARNED CASH (<9 dígitos>) (Cash)"` pareado
   com `"REINVESTMENT CASH (<mesmos 9 dígitos>) (Cash)"` (mesmo valor, sinal oposto — ciclo
   de juros do sweep, já excluído no parser CSV) e `"DISTRIBUTION <fundo> (Cash)"` (valor
   pode ser negativo — mesma categoria de "purge" já existente no parser CSV).
4. **Bond redemption/maturity → confirmado.** `"REDEMPTION PAYOUT <descrição do bond>
   (Cash)"`, `amount` = valor de face pago (ex: 1000.00 para um CD/Treasury de $1.000).
   Resolve a metade "maturity" do alvo 5 — vira uma transação `sell` equivalente, mesma
   lógica que o parser CSV já aplica pra `REDEMPTION`/`REDEEMED`.
5. **Buy/sell de ações → ainda sem exemplo real, mas alta confiança.** A conta do usuário
   não teve nenhuma compra/venda de ação nos últimos ~90 dias (só dividendos, juros,
   redemptions e reinvestimento de cash) — não há como confirmar o texto exato com um
   exemplo real. Dado o alto grau de fidelidade de todos os outros padrões observados ao
   vocabulário de Activity da própria Fidelity (`DIVIDEND RECEIVED`, `REDEMPTION PAYOUT`,
   `DISTRIBUTION`, `INTEREST EARNED CASH`), é uma aposta segura que um trade apareça como
   `"YOU BOUGHT <empresa> (<TICKER>) (Cash)"` / `"YOU SOLD ..."` — mas a Fase 1 deve tratar
   isso como heurística, não fato: implementar o reconhecimento por esse padrão, e jogar
   qualquer `description` de transação não reconhecida (não bate com nenhum padrão
   conhecido) num bucket `unmapped` visível na UI, nunca descartar silenciosamente.
6. **`amount`/`posted`/`transacted_at` confirmados.** `amount` é string decimal assinada
   (negativo = saída), `posted`/`transacted_at` são unix seconds. Sem campo `pending`
   observado. Compra/venda de bonds (não só redemption) ainda não observada — mesma
   heurística defensiva do item 5 se aplica.

**🔒 Achado de segurança/privacidade (não estava previsto no plano original):** uma
conexão SimpleFin retorna **todas** as instituições que o usuário linkou no Bridge, não só
a que motivou a criação daquele "Setup Token"/app. No caso real: 22 contas vieram no
payload, sendo 21 pessoais (Chase, Capital One — cartão de crédito, conta corrente,
financiamento) e só 1 Fidelity. Ou seja, **criar uma connection separada pra aa-findocs
isola a credencial (revogação/auditoria), mas não isola os dados** — o app sempre vai
receber a lista completa de contas linkadas. Consequência obrigatória pro mapper (Fase 1)
e já aplicada ao probe: **filtrar por `org.domain`/`org.name` contendo "fidelity"
é mandatório**, não opcional — sem esse filtro, dados bancários pessoais (nomes de
comerciantes, valores de cartão de crédito) vazariam pro pipeline de staging do app. O
probe (`api/fidelity-pending.js`) já foi corrigido: contas não-Fidelity retornam só
metadados (saldo, contagem), nunca amostra de holdings/transactions. Isso é ainda mais
relevante pra Fase 4 (multi-usuário) — cada amigo que conectar sua própria conta SimpleFin
provavelmente também terá bancos pessoais misturados.

**Nota lateral:** o `simplefinErrors` retornou `"Requested date range exceeds limit of 90
days and was capped"` mesmo pedindo exatamente 90 dias — o teto real de alguma instituição
linkada é menor. Não é bloqueante (SimpleFin capa e retorna o que consegue), mas a Fase 1
deve tratar isso como informativo (expor via `?resource=status`), não como erro fatal.

---

## 3. Assessment item a item (os 5 alvos de automação)

| # | Alvo | Viabilidade | Como |
|---|---|---|---|
| 1 | **Cash** | ✅ Confirmado | `available-balance` da conta Fidelity (não `balance`, que é o total incl. títulos) → proposta de update do `manualValue` do holding Cash (`CASH_ID` em `App.jsx`, `ensureCashAccount`). Vira um novo tipo de item staged ("balance update") com aprovação. Precisa de um mapa conta-SimpleFin → holding do app (config por usuário). |
| 2 | **Valor atual dos Bank Bonds** | ✅ Confirmado | `holdings[]` traz `market_value` direto por CD (sem CUSIP — `symbol: ""`). Como o holding `bank-bonds-aggregate` já é agregado (não por CUSIP), somar `market_value` de todo holding com `symbol === ""` e comparar/reconciliar com o principal já derivado das transações — sem precisar linkar por CUSIP. |
| 3 | **Interests / dividendos / tax** | ✅ Confirmado, alta reutilização | `description` reproduz as Actions do CSV Fidelity quase literalmente (`"DIVIDEND RECEIVED ... (TICKER) (Cash)"`, `"INTEREST ... (Cash)"`). Mapear para `bondIncome` com `kind: interest\|dividend\|tax`, `source: "simplefin"` — mesmo shape que o pipeline atual já aceita. Reusar os guards do parser (FOREIGN TAX antes de dividend, excluir INTEREST EARNED CASH, etc.). |
| 4 | **Transações buy/sell** | ⚠️ Alta confiança, sem exemplo real ainda | Conta do usuário sem trades nos últimos 90 dias — nenhum exemplo de `"YOU BOUGHT"`/`"YOU SOLD"` observado, mas o vocabulário de todos os outros tipos de evento bate 1:1 com as Actions do CSV Fidelity, então é uma aposta segura. Implementar heurística + bucket `unmapped` pra qualquer description não reconhecida (nunca descartar silenciosamente). |
| 5 | **Transações de bonds (compra/maturity)** | ✅ Maturity confirmado / ⚠️ compra sem exemplo | `"REDEMPTION PAYOUT <bond> (Cash)"` confirmado com `amount` = valor de face — vira `sell`. Compra de bond ainda não observada (mesma heurística do item 4 se aplica). |

**Dedupe cross-fonte é obrigatório**: o usuário vai continuar podendo importar CSV. Cada
item staged do SimpleFin deve carregar `simplefinId` (id nativo, dedupe forte) **e** passar
pelo `dupKey` (`ticker|side|qty|date`) contra live + pending — o `api/ingest-fidelity.js`
já faz exatamente isso; replicar no caminho novo.

---

## 4. Respostas às 3 considerações do usuário

### 4.1 "Auditar e aprovar — dentro do bulk import?"

**Não usar o ImportModal.** O lugar certo já existe: o card **"Fidelity Import"** de
staging/aprovação (item 38) foi desenhado exatamente pra isso — nada entra no live sem
checkbox + Approve, e o merge passa pelo `persist()` normal (sync de Holdings intacto).
Plano: **estender esse card** com seções para os novos tipos staged:

- **Trades** (já existe) — tabela Date/B‑S/Ticker/Qty/Price com checkboxes.
- **Income** (dividend/interest/tax) — hoje o `bondIncome` staged é aprovado junto com
  os trades sem listagem própria; ganhar tabela própria com checkboxes.
- **Balance updates** (novo) — "Cash: $X → $Y (fonte: SimpleFin, dd/mm)" com
  Approve/Dismiss por linha.

O ImportModal (CSV) permanece intocado como caminho manual/fallback.

### 4.2 "Conexão é minha — só pode aparecer pra mim"

Dois mecanismos combinados:

1. **Storage por usuário desde o dia 1**: o access URL fica em chave Redis do próprio
   usuário (`portfolio:email:<hash>:simplefin`), **nunca** retornado ao client (o
   endpoint devolve só `{ connected: true, lastSync }`). Quem não tem a chave não vê nada.
2. **Gate de UI na fase inicial**: o card de conexão/sync só renderiza para admin
   (`isAdmin()` já existe em `App.jsx`, via `VITE_ADMIN_EMAILS`). Amigos não veem o
   feature existir.

Atalho aceitável para a fase 1 (só o Pedro): access URL como env var
`SIMPLEFIN_ACCESS_URL` no Vercel (setável pelo iPhone) apontando pra conta do
`ADMIN_EMAILS` — zero UI de conexão, e evita ter que transportar o segredo pelo chat.
A migração para chave Redis por usuário é a Fase 4.

### 4.3 "Escalar pros amigos no futuro?"

**Sim, e o SimpleFin foi desenhado pra isso.** Cada amigo: cria a própria conta no
SimpleFin Bridge (paga a própria assinatura), conecta as instituições dele, e cola o
**setup token** num campo do app. O backend faz o claim (one-time) server-side e guarda o
access URL na chave Redis **daquele usuário**. Nenhum segredo compartilhado, nenhum custo
pro Pedro. Pré-requisitos técnicos (por isso "por usuário desde o dia 1" acima):

- staging keyed por `storageKey` (já é assim);
- mapper genérico (não hardcoded pra conta do Pedro);
- mapa conta-SimpleFin → holding configurável por usuário;
- remoção de usuário (`DELETE /api/users`, que já apaga `portfolio:email:<hash>:*` via
  SCAN) apagará a conexão junto — de graça.

O que fica de fora do MVP: UI de claim/disconnect, tratamento de instituições ≠ Fidelity
(descriptions variam por banco — o mapper precisa ser tolerante ou por-instituição).

---

## 5. Arquitetura proposta

```
[App aberto pelo admin]  ──── POST /api/fidelity-pending?resource=sync ────┐
                                                                           ▼
                                        Serverless: lê SIMPLEFIN_ACCESS_URL (fase 1)
                                        GET {accessUrl}/accounts?start-date=…
                                                                           │
                                        lib/simplefin-map.js (módulo puro, testado)
                                          payload → { transactions, bondIncome,
                                                      balanceUpdates, unmapped }
                                                                           │
                                        merge+dedupe no Redis `:fidelity-pending`
                                        (mesma semântica do ingest-fidelity)
                                                                           ▼
                        Card "Fidelity Import" (Transactions) — review + Approve
                                                                           ▼
                        persist() → live `:transactions` / holdings PUT (Cash)
```

Decisões de arquitetura e porquês:

- **Sem cron, sem GitHub Actions**: sync on-demand disparado pelo client (ao abrir o app
  e/ou botão "Sync"), com throttle server-side (ex: no máx 1 fetch SimpleFin a cada 6h,
  timestamp em Redis; chamadas dentro da janela retornam o staging atual). Elimina o
  scraper inteiro do plano antigo.
- **`api/` está em 12/12 arquivos (limite Vercel Hobby)** — regra do CONTEXT.md: **não
  criar arquivo novo**. As rotas novas entram em `api/fidelity-pending.js` via query-param
  dispatch (padrão já usado em `api/contributions-history.js?resource=alerts-read`):
  - `GET  /api/fidelity-pending` — staging (existente, ganha `balanceUpdates`)
  - `DELETE /api/fidelity-pending` — limpar (existente)
  - `POST /api/fidelity-pending?resource=sync` — fetch SimpleFin + stage (novo)
  - `GET  /api/fidelity-pending?resource=status` — `{ connected, lastSync, lastError }` (novo)
  - (Fase 4) `POST ?resource=connect` — claim de setup token por usuário
- **`api/ingest-fidelity.js` fica aposentável**: o SimpleFin supera o scraper. Proposta:
  deletar na Fase 3 (libera 1 slot de function pra futuro) — decisão do usuário (§7).
- **Mapper como módulo puro** (`lib/simplefin-map.js` ou `src/lib/` se compartilhado com
  client) + `test/simplefin-map.test.mjs` com fixtures do payload real (anonimizado) —
  mesmo padrão do `parsing.js`/CI. Toda a inteligência de description-parsing testável
  offline.
- **Segurança**: access URL nunca vai ao client nem a logs; respostas de erro genéricas;
  fetch com timeout explícito (~8s) pra caber no limite de 10s do Hobby (risco: bridge
  lento — mitigação: o Bridge serve cache local, raramente lento; se estourar, retornar
  `lastError` e tentar no próximo load).

---

## 6. Fases de execução (cada uma = 1 rodada do feature-workflow, buildável e deployável)

### Fase 0 — Probe do payload real (pré-requisito de tudo) — ✅ ENTREGUE (jul/2026)
- Env `SIMPLEFIN_ACCESS_URL` no Vercel (usuário seta pelo iPhone — fora do escopo do código).
- Implementado como `GET /api/fidelity-pending?resource=probe` (não `?resource=sync` como
  o rascunho original propunha — nome `probe` escolhido para deixar explícito que é
  read-only/inspect-only, sem colidir com o `?resource=sync` real da Fase 1). Admin-only
  (`auth.admin`), timeout de 8s (cabe no limite de 10s do Hobby), fetch direto no SimpleFin
  `/accounts?start-date=<90d atrás>` com Basic Auth extraído do access URL. Retorna dump
  resumido por conta: id/name/org/currency/balance/balanceDate, holdings (count + sample de
  até 15) e transactions (count + sample das 15 mais recentes, ordenadas por `posted` desc) —
  **sem** filtrar campos dentro dos itens da amostra, para preservar o shape real. Nada é
  gravado no Redis; nenhum arquivo novo em `api/` (dispatch por query-param em
  `api/fidelity-pending.js`, mesmo padrão de `api/contributions-history.js`).
- UI: card colapsável "SimpleFin Probe (admin)" em `src/Transactions.jsx`, gated por
  `isUserAdmin(auth)` (helper duplicado de `App.jsx`, mesma convenção do projeto), com botão
  "Run Probe" e `<pre>` mostrando o JSON completo da resposta.
- Saída esperada: usuário seta `SIMPLEFIN_ACCESS_URL` no Vercel, abre Transactions logado
  como admin, clica "Run Probe", e cola o JSON resultante numa session nova → resolve a
  incerteza nº 1 (§2) e os go/no-go dos itens 4–5, destravando a Fase 1.
- Build (`npm run build`) e os 3 suites de teste (54/54: analytics + fidelity-parser +
  perf-history) verdes. Nenhum teste novo — nada aqui tem lógica pura a testar ainda
  (é I/O puro); o mapper da Fase 1 é que ganha testes com fixtures do dump real.

#### Fase 0 — rodada real + hardening (jul/2026)

Probe executado contra a conta real do usuário. Achados resumidos em detalhe na
"Incerteza nº 1" (§2) — Cash, Bank Bonds e income confirmados; buy/sell ainda pendente de
exemplo real. Um achado obrigou correção no próprio endpoint antes de considerar a Fase 0
fechada: **a conexão SimpleFin retorna todas as instituições linkadas, não só a Fidelity**
(22 contas, 21 pessoais). Fix aplicado em `api/fidelity-pending.js`:
- Contas cujo `org.name`/`org.domain` não contém "fidelity" retornam só metadados
  (balance/counts) — nunca amostra de holdings/transactions.
- A conta Fidelity passa a retornar a lista **completa** (até um teto de segurança de 200
  itens) em vez de uma amostra de 15 — o volume real (76 tx, 58 holdings) é pequeno o
  suficiente, e isso aumenta a chance de capturar um exemplo de buy/sell na próxima rodada.
- `PROBE_MAX_ACCOUNTS` subiu de 10 para 50 (a SimpleFin Bridge documenta um teto de 25
  contas por conexão paga — 10 já cortava a lista antes de completar).

Build + 54/54 testes verdes após o fix. Esse filtro por instituição é **obrigatório na
Fase 1 também** (mapper real), não específico do probe.

**Segunda rodada (pós-fix) — Fase 0 fechada.** Com a conta Fidelity retornando a lista
completa, veio confirmação de `REDEMPTION PAYOUT` (bond maturity), `DISTRIBUTION`,
`INTEREST EARNED CASH`/`REINVESTMENT CASH` pareados, e do holding sintético `"CASH"` — ver
detalhe completo na "Incerteza nº 1" (§2). Único item sem exemplo real: buy/sell de ações
e compra de bond (a conta não teve nenhum trade na janela de 90 dias) — heurística
defensiva + bucket `unmapped` cobre esse caso na Fase 1. Fase 0 encerrada — próximo passo é
a Fase 1.

### Fase 1 — Mapper + staging de income e trades — ✅ ENTREGUE (jul/2026, PR #136)
- `lib/simplefin-map.js` (módulo puro, `lib/` — não `src/lib/`): `mapSimplefinPayload()`
  + `isFidelityOrg()`. Reconhece, em ordem, o ciclo INTEREST EARNED CASH/REINVESTMENT
  CASH (excluído), DISTRIBUTION (excluído), FOREIGN TAX (antes de DIVIDEND), DIVIDEND
  (exceto REINVEST), INTEREST de bond/CD, REDEMPTION PAYOUT (→ sell de Bank Bonds a
  valor de face) e YOU BOUGHT/SOLD (heurística — mas SimpleFin só reporta `amount`
  total sem qty/price estruturados, então vai pra `unmapped` em vez de inventar
  números). Qualquer description não reconhecida também cai em `unmapped` — nunca
  descartada silenciosamente. 16 testes em `test/simplefin-map.test.mjs` (fixtures
  sintéticas).
- `POST /api/fidelity-pending?resource=sync` (admin-only): fetch real + mapeia +
  merge/dedupe no `:fidelity-pending` — dedupe forte por `simplefinId` nativo +
  fallback `dupKey`/`bondKey` contra live e o que já está staged; throttle de 6h via
  timestamp gravado no próprio blob (persiste mesmo em falha, nunca martela o Bridge).
  `GET ?resource=status` → `{ connected, lastSync, lastError, nextSyncAt }`. Novo `PUT`
  (parcial, só substitui os arrays presentes no body) permite ao client remover só as
  linhas aprovadas/dispensadas do staging sem zerar o resto.
- Card "Fidelity Import" virou 4 seções: Trades (existente), **Income**
  (dividend/interest/tax, ganhou checkboxes + Approve/Discard própria — antes era
  aprovado junto com trades sem listagem), **Balance Updates** (adiantado da Fase 2,
  ver abaixo) e **Unmapped** (somente leitura). Botão "Sync Fidelity" + "Last sync"
  admin-only.
- Cobre os alvos **3, 4, 5** (4/5 no nível que o payload permitir) e adianta boa parte
  do alvo **1/2** da Fase 2 (ver abaixo).

### Fase 2 — Balance updates (Cash + Bank Bonds) — ⚠️ PARCIALMENTE ENTREGUE (jul/2026, PR #136)
- Staging ganhou `balanceCandidates[]`: `{ id, kind: "cash"|"bank-bonds", accountId,
  accountName, proposed, asOf }` (upsert por `id` a cada sync, não acumula duplicata).
  `current` não é gravado no staging — a UI lê direto do `holdings` do usuário (prop
  já disponível em `Transactions.jsx`) no momento de exibir a linha.
- Seção "Balance Updates" no card com Approve/Dismiss por linha. Aprovar Cash aplica
  `manualValue` via `applyFidelityBalanceUpdate` (`App.jsx`) — efeito imediato no
  Dashboard, mesmo fluxo normal de holdings.
- **Bank Bonds — só parcialmente resolvido.** `manualValue` do holding
  `bank-bonds-aggregate` é recalculado a cada mudança de transação por
  `applyBankBondsHolding` (principal derivado das transações) — gravar o valor de
  mercado ali seria sobrescrito na próxima transação. Aprovar grava, em vez disso, um
  campo aditivo `marketValueOverride`/`marketValueOverrideAsOf` no holding — mas
  **nada ainda lê esse campo**, então não há efeito visível no Dashboard. Falta:
  decidir onde/como exibir a reconciliação (badge no card do holding? nota
  "valor de mercado: $X, mercado vs. principal"?) — fica para uma sessão futura.
- Mapa conta→holding: não foi necessário — o mapper já resolve isso implicitamente
  (uma conta Fidelity só tem um Cash e um agregado de Bank Bonds), sem precisar de
  config por usuário nesta fase.
- Cobre os alvos **1 e 2**.

### Fase 3 — Hardening + limpeza
- Heartbeat no painel de Alerts (Bell): "SimpleFin sync falhou há N dias".
- Deletar `api/ingest-fidelity.js` + `docs/plans/scraper/` (se aprovado no §7).
- Atualizar CONTEXT.md / Features_Roadmap (item 38 → superseded por este plano).

### Fase 4 — Multi-usuário (futuro, quando quiser abrir pros amigos)
- `POST ?resource=connect` (claim de setup token server-side → Redis por usuário),
  disconnect, migração do env var pro Redis do admin.
- Remover gate de admin da UI; instruções de onboarding ("crie conta no SimpleFin…").

---

## 7. Decisões em aberto (responder antes/durante a Fase 0)

1. **Bank Bonds — override ou reconciliação?** ✅ Resolvido pelo probe real: como não há
   CUSIP no `holdings` (`symbol: ""`), linkar por CD individual não é viável mesmo — a
   única opção sensata já é a recomendada originalmente: **reconciliação agregada com
   aprovação** (somar `market_value` de todo holding `symbol === ""`, comparar com o
   principal derivado das transações, aprovar grava um `marketValueOverride` + data
   separado, sem quebrar a derivação existente).
2. **Aposentar o caminho scraper** (`api/ingest-fidelity.js` + `docs/plans/scraper/`)?
   Recomendação: sim, na Fase 3 — nunca foi ativado e o SimpleFin o supera; libera 1
   slot das 12 functions.
3. **Mapeamento de contas Cash**: quais contas do feed SimpleFin correspondem ao holding
   Cash do app (core Fidelity? outras)? Definir olhando o dump da Fase 0.
4. **Escopo de datas do sync**: janela rolante de 90 dias (como o plano do item 38)
   parece bom default — confirmar.

## 8. Riscos honestos

- **Payload pobre** (incerteza nº 1): itens 4–5 podem virar "alerta + CSV manual".
  O plano degrada bem: itens 1–3 não dependem de qty/price.
- **Timeout de 10s do Hobby** se o Bridge estiver lento num refresh: mitigado com
  timeout próprio + retry no próximo load; nunca bloqueia o app.
- **Descriptions do agregador ≠ Actions do CSV**: o reuso do parser pode ser parcial;
  por isso o mapper é módulo separado com fixtures reais, não um remendo no `parsing.js`.
- **Duplicatas cross-fonte** (SimpleFin + CSV): mitigado por `simplefinId` + `dupKey` +
  a UI de duplicata já existente; ainda assim, primeiro mês em modo "aprovar tudo
  manualmente" até criar confiança (exatamente o que o usuário pediu).
- **Segredo do access URL**: equivale a acesso read-only às contas conectadas. Fica em
  env/Redis server-side, nunca no client, nunca em repo (repo é público).
