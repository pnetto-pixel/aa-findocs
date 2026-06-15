# Handoff — Item 38: Automação de export da Fidelity

> Estado da sessão de 2026-06-15 para retomar numa sessão nova.
> **Resumo de uma linha:** os dois problemas difíceis (bloqueio de IP e 2FA) estão
> RESOLVIDOS e PROVADOS. Falta só o seletor do botão de download do CSV.

## Como retomar (faça isto na nova sessão)

1. **Linkar a nova sessão ao repo privado `pnetto-pixel/fidelity-sync`** (além do `aa-findocs`).
   Esta sessão só tinha escopo no `aa-findocs`, então cada mudança no scraper teve que
   ser copiada/colada à mão. Com o `fidelity-sync` no escopo, o Claude commita direto.
2. Os templates-fonte do scraper vivem aqui no `aa-findocs`, branch
   `claude/fidelity-export-automation-4v26wh`, em **`docs/plans/scraper/`**
   (`scrape.mjs`, `parse-fidelity.mjs`, `package.json`, `workflow-sync.yml`).
   São a verdade-fonte para copiar pro `fidelity-sync`.

## Arquitetura (decidida e construída)

Scraper Playwright (repo privado `fidelity-sync`) roda num **self-hosted runner no laptop
Windows ARM64** do usuário (IP residencial) → loga na Fidelity com credenciais + TOTP →
baixa o CSV "Accounts History" → parseia → POST pra `/api/ingest-fidelity` (staging Redis
`:fidelity-pending`, NUNCA no live) → usuário aprova no app (card dourado em Transactions).

### Backend no app (já em `main`, additive, zero-impacto)
- `api/ingest-fidelity.js` — endpoint service-token (`x-ingest-token`), grava só em
  `:fidelity-pending`. Alvo = `INGEST_EMAIL` (env), não vem do request.
- `api/fidelity-pending.js` — endpoint user-auth (Google/senha) que o app usa pra ler/limpar
  o staging.
- `src/Transactions.jsx` — card dourado "Fidelity Import — N new" (preview + Approve/Discard).

## O que JÁ FUNCIONA (provado em run real)

- ✅ **Self-hosted runner**: registrado e "Listening for Jobs". Pasta
  `C:\Users\pnett\actions-runner`. Windows **ARM64**, runner v2.335.1.
  **Interativo** (`run.cmd`), **NÃO** como serviço (serviço = sessão sem tela, navegador
  headed quebra). Laptop precisa estar logado/desbloqueado durante o run.
- ✅ **Bloqueio de IP resolvido**: GitHub-hosted (datacenter) dava "Sorry, we can't complete
  this action". O runner residencial passou.
- ✅ **Login**: `#dom-username-input`, `#dom-pswd-input`, `#dom-login-button` — confirmados.
- ✅ **2FA via TOTP**: gerou código com `otplib` e foi aceito. Chegou em
  `https://digital.fidelity.com/ftgw/digital/portfolio/summary` (área autenticada).
  O código normaliza o secret (`.replace(/\s/g,'')`) então um `\n` colado por engano não quebra.
- ✅ **Secrets** no `fidelity-sync`: `FIDELITY_USER`, `FIDELITY_PASS`, `FIDELITY_TOTP_SECRET`,
  `INGEST_TOKEN`. **Vercel** (aa-findocs): `INGEST_TOKEN` (mesmo valor) + `INGEST_EMAIL`.

## O que FALTA (único passo aberto)

**Seletor do botão de download do CSV** na página de atividades. O `scrape.mjs` atual já
está instrumentado pra diagnosticar: navega pra `ACTIVITY_URL`, espera 6s, salva
`fidelity-activity.png` (fullPage) e loga `download candidates: [...]` (todos os
links/botões com "download"/"export"/"csv" no texto/aria/id).

### Próximos passos exatos
1. Iniciar runner: PowerShell → `cd C:\Users\pnett\actions-runner` → `./run.cmd` →
   confirmar "Listening for Jobs". Laptop logado/desbloqueado.
2. Disparar **UM** run: `fidelity-sync` → Actions → Fidelity sync → Run workflow.
3. Coletar do log: linha `download candidates:` + `activity url`/`activity title`.
   Baixar artefato `debug-screenshots` → olhar `fidelity-activity.png` (onde fica o
   botão Download/Export).
4. Fixar o seletor real do download em `scrape.mjs` (no bloco `dlLocator`).
5. Rodar 1× de novo → esperar `CSV downloaded → parsed N trades → ingest ok`.
6. No app: Transactions → card dourado "Fidelity Import" → revisar → **Approve**.

## ⚠️ Cuidados

- **NÃO rodar repetidamente.** A Fidelity tem throttle antifraude por frequência: depois de
  muitos logins seguidos (debug de 2026-06-15) ela bloqueou temporariamente com a tela
  "Sorry, we can't complete this action" (mesmo no IP residencial que já tinha funcionado).
  Limpa sozinho em algumas horas. Em operação: **manual, máx 1×/dia** (o workflow já é assim;
  cron está comentado).
- **ARM**: o Chromium roda emulado x64 no laptop ARM — funciona, mas tem variação de timing
  ocasional. Se um passo der timeout esporádico, tentar de novo (respeitando o throttle).
- Login **manual** na Fidelity (navegador normal) confirmado OK em 2026-06-15 — conta saudável.

## Refinamento futuro (opcional, depois de fechar o download)

Reaproveitar a sessão (perfil persistente, `launchPersistentContext`) pra NÃO fazer login
completo todo run — reduz drasticamente os bloqueios por frequência. Foi avaliado; usuário
escolheu validar o fluxo TOTP primeiro (feito). Considerar antes de ligar qualquer schedule.

## Referências
- Runbook de ativação: `docs/plans/item-38-activation-runbook.md`
- Plano original: `docs/plans/item-38-fidelity-export-automation.md`
- Bundle do scraper: `docs/plans/scraper/` (README + 4 arquivos)
