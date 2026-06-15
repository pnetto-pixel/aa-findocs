# fidelity-sync — scraper (item 38)

Bundle pronto pra copiar pro **repo privado** `fidelity-sync`. NÃO mora no
`aa-findocs` (público) por conter o fluxo que usa credenciais.

> Estes arquivos ficam versionados aqui só como template (a fonte da verdade do que
> **roda** é o repo `fidelity-sync`). Copie-os pro repo privado. O código é
> **read-only** na Fidelity (só navega e baixa CSV); não há caminho de trade/transferência.

> **Runner self-hosted (importante):** a Fidelity está atrás do Akamai Bot Manager e
> bloqueia IPs de datacenter (runners GitHub-hosted recebem "Sorry, we can't complete
> this action") + faz fingerprint de Chromium headless. Por isso o `sync.yml` usa
> `runs-on: self-hosted` (laptop Windows, IP residencial) com browser **headed** numa
> sessão **interativa** (rode `run.cmd` logado, NÃO como Windows Service). Estado atual
> e blocker em [`../item-38-handoff.md`](../item-38-handoff.md).

## Arquivos

| Arquivo | Vai para | O que faz |
|---|---|---|
| `parse-fidelity.mjs` | raiz do repo | Port em Node do parser do app: CSV → `{ transactions, bondIncome }` |
| `scrape.mjs` | raiz do repo | Playwright: **reusa sessão salva** + download CSV + POST pro staging |
| `package.json` | raiz do repo | deps: playwright, papaparse |
| `workflow-sync.yml` | `.github/workflows/sync.yml` | workflow manual (workflow_dispatch) |

## Setup (segue o runbook `item-38-activation-runbook.md` primeiro)

1. Endurecer a conta GitHub (2FA passkey). **Antes de tudo.**
2. Criar repo **privado** `fidelity-sync`, copiar os 4 arquivos (yml vai pra `.github/workflows/sync.yml`).
3. Cadastrar os secrets no repo: `FIDELITY_USER`, `FIDELITY_PASS`,
   `FIDELITY_TOTP_SECRET`, `INGEST_TOKEN`.
4. No Vercel (projeto aa-findocs): setar `INGEST_TOKEN` (mesmo valor) e `INGEST_EMAIL`
   (seu e-mail). Mergear a branch do app pro `main` pra publicar os endpoints.

## Login: NÃO é automatizado (sessão reusada)

O Akamai bloqueia login automatizado mesmo no runner residencial. Por isso o login é
**manual, uma vez**, e o scraper reusa a sessão salva. Fluxo:

**1. Logar uma vez (no laptop, terminal, NÃO via Actions):**
```
npm install
npx playwright install chromium
npm run login
```
Abre uma janela do navegador → logue na mão (usuário + senha + 2FA) até ver o portfólio →
volte ao terminal e aperte **Enter**. Os cookies ficam salvos em `~/.fidelity-sync-profile`
(fora do workspace, sobrevive a checkout/limpeza). Rode como o **mesmo usuário Windows** que
o runner usa, senão não compartilham a sessão.

**2. Rodar o sync (Actions → "Fidelity sync" → Run workflow, com o runner ligado):**
- `activity url: ...` → entrou logado (sessão válida).
- `Session expired (redirected to login)` → a sessão caiu: rode `npm run login` de novo.
- `download candidates: [...]` → ajuda a confirmar o seletor de download.
- `CSV downloaded` → achou o botão; `ingest ok: added=N` → staging recebeu.

> Os seletores de **download** ainda podem precisar de ajuste (DOM da Fidelity não é público).
> O log de `download candidates` + o screenshot `fidelity-activity.png` (artifact) mostram o alvo.
> **Não rode em loop** — 1 tentativa por ajuste.

## Aprovar no app

Depois de "ingest ok", abra o app aa-findocs → aba **Transactions** → card dourado
**"Fidelity Import — N new"** → revise → **Approve**. Só então entra nas suas transações
(com dedupe). Nada é salvo antes da sua aprovação.

## Automatizar (opcional, depois de confiar)

Em `.github/workflows/sync.yml`, descomente o bloco `schedule`. Roda diário ~22:00 UTC.

## Kill switch (se suspeitar de acesso indevido)

1. Fidelity → Security Center → remover o authenticator app (invalida o TOTP_SECRET na hora).
2. Trocar a senha da Fidelity.
3. Rotacionar os secrets do GitHub e o `INGEST_TOKEN` (GitHub + Vercel).
