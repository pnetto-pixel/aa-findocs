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

### ⚠️ Incerteza nº 1 — verificar ANTES de codar o mapper

O shape exato do payload da **Fidelity via SimpleFin** precisa ser inspecionado com dados
reais. Perguntas que o payload responde:

1. As transações de investimento vêm com **qty e price estruturados**, ou só
   `amount` + `description` texto-livre (ex: `"YOU BOUGHT REALTY INCOME CORP…"`)?
   - Se for texto no formato das Actions do CSV Fidelity, boa parte do
     `src/lib/parsing.js` é reaproveitável para extrair side/ticker.
   - Se qty/price não forem recuperáveis, os itens 4 e 5 (transações buy/sell e de
     bonds) degradam para "detectar e alertar" em vez de "importar" — mesmo limite
     estrutural já documentado para parsing de e-mail no item 38.
2. Existe array `holdings` (com `symbol`, `shares`, `market_value`, `cost_basis`)?
   Ele destrava os itens 2 (valor dos Bank Bonds) e reconciliação de posições.
3. Como aparecem **core cash / sweep**, dividendos, juros de bond, foreign tax,
   redemptions? Com que `description`?
4. Sinais de `amount`, campo `pending`, e granularidade de datas (`posted` unix).

**Fase 0 do plano existe exatamente pra isso** (ver §6).

---

## 3. Assessment item a item (os 5 alvos de automação)

| # | Alvo | Viabilidade | Como |
|---|---|---|---|
| 1 | **Cash** | ✅ Alta | `balance` da(s) conta(s) SimpleFin mapeada(s) → proposta de update do `manualValue` do holding Cash (`CASH_ID` em `App.jsx`, `ensureCashAccount`). Vira um novo tipo de item staged ("balance update") com aprovação. Precisa de um mapa conta-SimpleFin → holding do app (config por usuário). |
| 2 | **Valor atual dos Bank Bonds** | ✅ Média-alta | Se o payload trouxer `holdings` com `market_value` por CUSIP: hoje o holding `bank-bonds-aggregate` é **derivado das transações** (principal, itens 36/37/40) — não sobrescrever isso silenciosamente. Proposta: staged "reconciliation" — mostrar valor SimpleFin vs valor derivado; aprovar grava um campo novo (ex: `marketValueOverride` + data) OU só sinaliza divergência. Decisão de produto na Fase 0 (ver §7). |
| 3 | **Interests / dividendos / tax** | ✅ Alta (se descriptions preservarem as Actions) | Mapear para `bondIncome` com `kind: interest\|dividend\|tax`, `source: "simplefin"` — mesmo shape que o pipeline atual já aceita (`ingest` já suporta `bondIncome`; card de aprovação já mergeia com dedupe `date\|ticker\|amount`). Reusar os guards do parser (INTEREST + CUSIP, FOREIGN TAX antes de dividend, excluir INTEREST EARNED CASH, etc.). |
| 4 | **Transações buy/sell** | ⚠️ Condicional à incerteza nº 1 | Se qty/price recuperáveis: mapear para o modelo de transação e stagear — pipeline de aprovação, dedupe (`dupKey` + `simplefinId`) e sync Holdings já existem. Senão: alertar "N trades detectados no feed sem detalhe suficiente — importe o CSV" (o fluxo CSV continua como fonte de verdade). |
| 5 | **Transações de bonds (compra/maturity)** | ⚠️ Condicional, com normalização | Mesmo caso do item 4 + a normalização específica de bonds (equivalente ao `qty/1000`, `price×10` do CSV — conferir como o SimpleFin reporta CDs) + redemptions → sell (lógica já existe no parser CSV). |

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

### Fase 1 — Mapper + staging de income e trades
- `lib/simplefin-map.js` + testes com fixtures da Fase 0.
- `?resource=sync` real: mapeia → merge+dedupe no `:fidelity-pending`
  (`simplefinId` + `dupKey`), throttle, `?resource=status`.
- Card "Fidelity Import": seção própria pra income (dividend/interest/tax) com
  checkboxes; botão "Sync Fidelity" + "last sync" (admin-only).
- Cobre os alvos **3, 4, 5** (4/5 no nível que o payload permitir).

### Fase 2 — Balance updates (Cash + Bank Bonds)
- Staging ganha `balanceUpdates[]`: `{ id, kind: "cash"|"bank-bonds", accountId,
  accountName, current, proposed, asOf }`.
- Seção "Balance updates" no card com Approve/Dismiss; aprovar Cash aplica
  `manualValue` via fluxo normal de holdings; Bank Bonds conforme decisão do §7.
- Mapa conta→holding: começa hardcoded-por-config no Redis do usuário (editável depois).
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

1. **Bank Bonds — override ou reconciliação?** O agregado é derivado de transações
   (principal). Recomendação: **reconciliação com aprovação** (mostrar divergência,
   aprovar grava market value com data como campo separado, sem quebrar a derivação).
   Alternativa mais simples: só alertar divergência, sem gravar.
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
