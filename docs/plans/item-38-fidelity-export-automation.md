# Plano — Item 38: Automação de export Fidelity

> Status: **PLANO** (nada implementado). Pesquisa feita em 12/jun/2026 numa session Claude Code
> com acesso ao Gmail do Pedro (MCP) e à web. Fatos verificados estão marcados ✅; hipóteses, ⚠️.

## Objetivo

Eliminar o fluxo manual "logar na Fidelity → exportar Accounts History CSV → importar no
ImportModal". O processo final não pode depender do usuário no dia-a-dia (setup one-time é
aceitável).

---

## TL;DR — recomendação

O único caminho que entrega **dados completos** e roda **sem o usuário no loop**, dado o
constraint iPhone-only, é um **scraper headless em GitHub Actions (cron) que loga na Fidelity
gerando o código 2FA por TOTP, baixa o CSV "Accounts History" e injeta no app via um endpoint
de ingestão dedicado**. O destravamento decisivo é recente: desde **abril/2026 a Fidelity passou
a aceitar apps autenticadores TOTP padrão** — um servidor pode gerar o código de 6 dígitos a
partir de um segredo armazenado, sem humano digitando. Antes (só Symantec VIP) era inviável.

Há um atalho a testar **antes** (OFX, ~1h de spike) e dois caminhos descartados com evidência.

---

## Fatos levantados na pesquisa (jun/2026)

1. ✅ **O app já consome o formato certo.** `parseFidelityCSV` (`src/Transactions.jsx:2758`)
   processa o CSV nativo "Accounts History" (`Run Date, Action, Symbol, Symbol Description,
   Price ($), Quantity, Fees ($), Amount ($)`). Toda a lógica difícil já existe e está testada:
   BOUGHT/SOLD→buy/sell, datas MDY, correção qty/price de Bank Bonds (`qty/1000`, `price*10`),
   INTEREST→`bondIncome kind:interest`, DIVIDEND/CASH DIV→`kind:dividend`, REDEMPTION→sell,
   `inferAssetClass`. A automação só precisa produzir o CSV e alimentar essa lógica.

2. ✅ **Parsing de e-mail NÃO resolve sozinho** (responde a pergunta (c) do roadmap). Lido o corpo
   real das confirmações de trade no Gmail do Pedro (42 threads de `fidelity.com` em 90d):
   trazem só `Account: XXXXX9707` + tabela `Action | Security | Price`
   (ex: `BOUGHT | REALTY INCOME CORP COM | 59.9600`). **Faltam: quantity, total, e a data é a do
   e-mail, não a do trade.** Como o modelo exige `qty`, é estruturalmente impossível reconstruir
   a transação. E-mail só serve como gatilho/alerta, nunca como fonte de dados.

3. ✅ **API oficial (Fidelity Access / Akoya) não é para pessoa física.** Akoya é rede B2B para
   bancos/fintechs/agregadores, com onboarding institucional. Sem programa individual. Inviável.

4. ⚠️ **OFX/Direct Connect em deprecação,** substituído pelo Fidelity Access. Relatos de
   `403 Forbidden` e NetBenefits não suportado — mas brokerage às vezes ainda puxa via
   `ofxtools`/`ofxget`. Vale **probe rápido** (HTTP puro, sem browser; robusto se vivo), baixa
   confiança de durar.

5. ✅ **Libs open-source de scraping existem** (`kennyboy106/fidelity-api`, Playwright) mas fazem
   2FA **manual** (`input()`) e não documentam download de histórico em CSV. Referência de
   seletores/fluxo, não dependência pronta.

6. ✅ **Vercel é host ruim pro scraper.** Hobby ~10s de timeout + cold start de Chromium não
   suporta login+2FA+navegação+download. Runner correto: **GitHub Actions** (Chromium completo,
   sem limite de 10s, agendável, gerenciável pelo app do GitHub no iPhone).

7. ✅ **Gancho de auth pra gravar.** `PUT /api/transactions` (`api/transactions.js`) chaveia por
   `auth.storageKey`. Google exige JWT (difícil headless); senha (`x-app-password`) grava em
   bucket diferente (`sha(senha)` vs `sha(email)`) → cairia no lugar errado. Conclusão: ingestão
   precisa de **endpoint próprio com service-token** mirando a chave do e-mail, com merge idempotente.

---

## Caminhos avaliados

| Caminho | Veredito | Por quê |
|---|---|---|
| (a) Fidelity Access / Akoya oficial | ❌ Descartar | B2B institucional; sem onboarding individual |
| (b) OFX / Direct Connect | 🟡 Probar 1h primeiro | HTTP puro, simples se vivo; Fidelity está matando, 403 frequente |
| (c) Parsing de e-mail | ❌ Descartar como fonte | Confirmações não têm qty/total/data-do-trade |
| (d) Playwright headless + TOTP em GitHub Actions | ✅ **Recomendado** | Único com dado completo **e** sem humano, compatível com iPhone-only |

---

## Arquitetura recomendada (caminho d)

```
GitHub Actions (cron diário, repo PRIVADO separado)
   │  secrets: FIDELITY_USER, FIDELITY_PASS, FIDELITY_TOTP_SECRET, INGEST_TOKEN
   ▼
Playwright + Chromium
   ├─ login digital.fidelity.com (user/pass)
   ├─ 2FA: gera código TOTP do segredo (otplib) → digita
   ├─ reaproveita storageState (sessão) entre runs
   └─ Activity/History → range 90d → Download CSV
   ▼
Script Node: lib/fidelity-parse.js  (MESMA lógica do app)
   │  CSV → { transactions, bondIncome }
   ▼
POST /api/ingest-fidelity   (Vercel, novo endpoint)
   ├─ auth por INGEST_TOKEN
   ├─ mira storageKey do e-mail do usuário
   └─ read-modify-write: merge + dedupe (dupKey) → grava
   ▼
App lê normalmente (já existe sync Transactions→Holdings)
```

### Por que cada escolha
- **Repo PRIVADO separado**: `aa-findocs` é público. Senha de corretora + segredo TOTP não podem
  morar (nem em Secrets) num repo público — Actions de PR de fork e logs são vetor de risco.
- **TOTP gerado no runner**: elimina o usuário do loop. Bootstrap único: ao habilitar o
  autenticador no app da Fidelity, copiar a *chave manual* (base32) pro GitHub Secret pelo celular
  (~5 min, uma vez).
- **`lib/fidelity-parse.js` compartilhado**: extrair as funções puras de parsing pra um módulo
  importado pelo `Transactions.jsx` **e** pelo script evita divergência de lógica. Refactor pequeno.
- **Endpoint de ingestão com merge-dedupe**: roda todo dia puxando 90 dias; dedupe por
  `dupKey = ticker|side|qty|date` torna reimportar janelas sobrepostas seguro e idempotente.

---

## Fases de execução

- **Fase 0 — Probe OFX (1h).** Testar `ofxget`/`ofxtools` contra a brokerage. Se puxar transações:
  pivota pra OFX (sem browser, mais robusto) e pula quase tudo. Se 403/morto: segue pro Playwright.
- **Fase 1 — Backend (`aa-findocs`).** (1) Extrair parsing pro `lib/fidelity-parse.js`;
  (2) criar `api/ingest-fidelity.js` (service-token `INGEST_TOKEN`, alvo = chave do e-mail,
  merge+dedupe de `transactions` e `bondIncome`). Testar postando output de um CSV conhecido.
  Mínimo toque em `lib/auth.js`/`api/transactions.js`.
- **Fase 2 — Scraper (repo privado).** Playwright: login + TOTP + `storageState`. Validar seletores
  via `workflow_dispatch` (manual) antes de agendar.
- **Fase 3 — Fio completo.** CSV → parser compartilhado → ingestão; cron diário (~22:00 UTC,
  pós-fechamento). Falha de login/download = Action falha → GitHub e-maila.
- **Fase 4 — Hardening.** Reuso de sessão, seletores resilientes, heartbeat "último sucesso" no
  painel de Alerts (Bell) do app.

---

## Riscos (honestos)

- **ToU da Fidelity proíbe acesso automatizado/robótico.** Conta própria, uso pessoal = zona
  cinzenta; risco real = flag/lock. Mitigar: 1x/dia, reusar sessão, não martelar.
- **Fragilidade de seletor**: mudança de UI quebra o scraper → alerta de falha (Fase 3) + seletores
  tolerantes.
- **Superfície de segredo**: senha+TOTP juntos enfraquecem o 2FA. Exige conta GitHub com 2FA forte.
- **OFX pode morrer** mesmo se sobreviver à Fase 0.

---

## Próximo passo concreto

Começar pela **Fase 0 (probe OFX)** — 1h e pode tornar 80% do resto desnecessário.

## Fontes
- Fidelity TOTP/autenticadores: https://www.mymoneyblog.com/fidelity-adds-multi-factor-authentication-with-authenticator-apps.html
- Fidelity 2FA TOTP setup: https://magneticb.github.io/blog/fidelity-2fa-symantec-vip.html
- kennyboy106/fidelity-api: https://github.com/kennyboy106/fidelity-api
- Akoya para fintechs: https://akoya.com/fintechs
- ofxtools #164 (OFX→FDX): https://github.com/csingley/ofxtools/issues/164
- ofxtools #140 (Fidelity OFX falhando): https://github.com/csingley/ofxtools/issues/140
