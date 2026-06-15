# fidelity-sync — scraper (item 38)

Bundle pronto pra copiar pro **repo privado** `fidelity-sync`. NÃO mora no
`aa-findocs` (público) por conter o fluxo que usa credenciais.

> Estes arquivos ficam versionados aqui só como template. Copie-os pro repo privado.
> O código é **read-only** na Fidelity (só navega e baixa CSV); não há caminho de
> trade/transferência.

## Arquivos

| Arquivo | Vai para | O que faz |
|---|---|---|
| `parse-fidelity.mjs` | raiz do repo | Port em Node do parser do app: CSV → `{ transactions, bondIncome }` |
| `scrape.mjs` | raiz do repo | Playwright: login + TOTP + download CSV + POST pro staging |
| `package.json` | raiz do repo | deps: playwright, otplib, papaparse |
| `workflow-sync.yml` | `.github/workflows/sync.yml` | workflow manual (workflow_dispatch) |

## Setup (segue o runbook `item-38-activation-runbook.md` primeiro)

1. Endurecer a conta GitHub (2FA passkey). **Antes de tudo.**
2. Criar repo **privado** `fidelity-sync`, copiar os 4 arquivos (yml vai pra `.github/workflows/sync.yml`).
3. Cadastrar os secrets no repo: `FIDELITY_USER`, `FIDELITY_PASS`,
   `FIDELITY_TOTP_SECRET`, `INGEST_TOKEN`.
4. No Vercel (projeto aa-findocs): setar `INGEST_TOKEN` (mesmo valor) e `INGEST_EMAIL`
   (seu e-mail). Mergear a branch do app pro `main` pra publicar os endpoints.
5. **Self-hosted runner no laptop Windows** (runbook passo B2). A Fidelity bloqueia IP de
   datacenter; o runner roda no seu laptop (IP residencial). Iniciar com `run.cmd` em
   **sessão interativa** (não como serviço), laptop logado/desbloqueado.

## Primeiro run (validar seletores)

> Pré-requisito: runner ativo no laptop (`run.cmd` rodando, "Listening for Jobs").

A Fidelity não publica o DOM; os seletores em `scrape.mjs` marcados `TODO: confirm`
podem precisar de ajuste.

1. Actions → "Fidelity sync" → **Run workflow** (dá pra apertar no app do GitHub).
2. Abra o log do run:
   - "login ok" → credenciais + TOTP funcionaram.
   - "CSV downloaded" → achou o botão de download.
   - "ingest ok: added=N ..." → staging recebeu.
3. Se travar em algum passo, o log mostra qual locator falhou. Ajuste só aquela linha
   em `scrape.mjs` (use Inspect no site logado pra achar o id/text certo) e rode de novo.
   **Não rode em loop** — 1 tentativa por ajuste, pra evitar lockout.

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
