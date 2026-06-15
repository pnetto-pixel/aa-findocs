# Handoff — Item 38: Automação de export Fidelity

> Estado vivo do item 38 para a próxima session retomar sem reconstruir contexto.
> Atualizado em 15/jun/2026. Acompanha [`item-38-fidelity-export-automation.md`](item-38-fidelity-export-automation.md)
> (o plano/decisões) e [`item-38-activation-runbook.md`](item-38-activation-runbook.md) (o que o usuário faz).

## Onde estamos (resumo de 30s)

A arquitetura recomendada no plano foi **construída e está parcialmente validada**. O backend
no `aa-findocs` está pronto e mergeado; o scraper vive no repo privado `fidelity-sync` e roda num
**self-hosted runner**. O fio ainda **não fechou**: o scraper trava no **submit do login da Fidelity**
(seletor de senha/botão não confirmado na página de signin atual). Nenhum dado real foi ingerido ainda.

## O que está PRONTO (✅)

### Backend no `aa-findocs` (mergeado no `main`)
- `api/ingest-fidelity.js` — endpoint **dormente** (503 sem `INGEST_TOKEN`), auth por service-token
  (`x-ingest-token`, comparação constant-time), alvo fixado em `INGEST_EMAIL` (token vazado não
  redireciona dados). Grava só em `:fidelity-pending` (staging), **nunca** em `:transactions`/`:holdings`.
  POST faz merge+dedupe (`dupKey = ticker|side|qty|date`) pulando o que já está live; GET lê pending;
  DELETE limpa. Commits `4433002`, `b6322c0`, merge `af0d393`.
- **UI de aprovação** no app (aba Transactions): card "Fidelity Import — N new" → revisar → Approve.
  Nada entra live sem o clique do usuário.

### Scraper no `fidelity-sync` (repo privado, branch `main`)
- `parse-fidelity.mjs` — port do `parseFidelityCSV` do app (idêntico ao template em `docs/plans/scraper/`).
- `scrape.mjs` — Playwright: login + TOTP (`otplib`) + download CSV + POST pro staging. Já evoluído
  além do template (ver "Pivô" abaixo): normaliza whitespace dos secrets, UA real, flags anti-automação,
  logging de discovery + screenshots.
- `.github/workflows/sync.yml` — `workflow_dispatch` manual, **`runs-on: self-hosted`**, headed,
  sobe screenshots `fidelity-*.png` como artifact em qualquer desfecho.
- 4 secrets cadastrados: `FIDELITY_USER`, `FIDELITY_PASS`, `FIDELITY_TOTP_SECRET`, `INGEST_TOKEN`.

## Pivô importante (não estava no plano original)

**A Fidelity está atrás do Akamai Bot Manager.** Runners GitHub-hosted usam IP de datacenter →
servem página de bloqueio ("Sorry, we can't complete this action") e fazem fingerprint de Chromium
headless. **Solução adotada:** runner **self-hosted no laptop Windows do usuário** (IP residencial),
sessão **interativa** (rodar `run.cmd` logado, NÃO como Windows Service — service não tem desktop e o
browser headed precisa de display), browser **headed** com `--disable-blink-features=AutomationControlled`
+ UA real. Isso destravou o bot-gate: o login agora renderiza o campo de usuário (antes nem isso).

## Blocker atual (🔴 — onde a próxima session/usuário pega)

Última run (`workflow_dispatch`, 15/jun 04:09 UTC, run `27523413828`): **todas as 10 runs falharam.**
A última chega mais longe que as anteriores. Sequência do log:

```
page commit, url: .../prgw/digital/signin/retail
username field visible              ← #dom-username-input OK (passou do Akamai)
url 4s after submit: .../prgw/digital/signin/retail   ← NÃO avançou
page title: Log in to Fidelity      ← continua na tela de login
no 2FA field                         ← campo de OTP não apareceu
scrape error: page.waitForURL: Timeout 30000ms exceeded
```

**Diagnóstico:** o submit do login não está progredindo. O campo de usuário é achado
(`#dom-username-input` correto), mas depois do `click('#dom-login-button')` a página continua em
`/prgw/digital/signin/retail` sem mostrar 2FA. Hipóteses (em ordem de probabilidade):
1. Na página de signin atual (`/prgw/digital/signin/retail` — NÃO a `/login/full-page` que o script
   navega; tem 307-redirect), os seletores **`#dom-pswd-input` e `#dom-login-button` estão errados/mudaram**.
   O username casou; senha/botão provavelmente não.
2. Há um banner de erro (senha não preenchida → "enter your password") que o script não detecta.

**Artefato-chave:** a run subiu `fidelity-after-submit.png` (artifact `debug-screenshots`,
run 27523413828). Esse screenshot mostra o estado real da tela pós-submit — é o primeiro lugar a olhar.

## Próximos passos concretos (para o usuário, no laptop)

> Isto exige a máquina com o runner self-hosted e sessão logada — **o Claude não consegue dirigir o
> site da Fidelity** (precisa do IP residencial + 2FA + inspeção do DOM logado).

1. **Baixar e abrir** `fidelity-after-submit.png` do último run (Actions → run → artifacts). Confirmar:
   a senha foi preenchida? apareceu erro? o botão certo foi clicado?
2. No laptop, abrir `https://digital.fidelity.com/prgw/digital/signin/retail` logado e **Inspect** nos
   campos de **senha** e no **botão de login** → pegar os `id`/seletores reais.
3. Ajustar **só** as duas linhas em `scrape.mjs` (`#dom-pswd-input`, `#dom-login-button`). Commit, rodar
   **uma vez** (não em loop — risco de lockout), reler o log.
4. Quando passar do login: confirmar que o campo de 2FA é capturado pela lista de seletores
   (`input[autocomplete="one-time-code"]`, etc.) e que o TOTP é aceito.
5. Depois do login: validar os seletores de **download do CSV** na página de Activity (o script já loga
   `download candidates:` e sobe `fidelity-activity.png` pra ajudar). Ajustar o locator de download.
6. Com "ingest ok" no log: abrir o app → card "Fidelity Import" → aprovar → conferir os trades.

> ⚠️ Antes do primeiro "ingest ok" funcionar de verdade, falta o usuário setar no Vercel (Production):
> `INGEST_TOKEN` (= secret do GitHub) e `INGEST_EMAIL` (pnetto@gmail.com). Sem isso o endpoint responde
> 503. Conferir esse passo se a chamada de ingest der 503.

## Estado dos arquivos / drift

- O template em `docs/plans/scraper/` (no `aa-findocs`) foi **reconciliado** com a realidade do
  `fidelity-sync`: `scrape.mjs` e `workflow-sync.yml` agora refletem o pivô self-hosted/headed/Akamai.
  `parse-fidelity.mjs` é idêntico nos dois.
- Fonte da verdade do código que **roda** é o repo `fidelity-sync` (branch `main`). O template aqui é
  documentação/backup — ao mexer no scraper, mexa no `fidelity-sync` e ressincronize o template depois.

## Cron / automação

Ainda **manual** (`workflow_dispatch`). O bloco `schedule` no `sync.yml` está comentado. Só ligar
depois de vários runs manuais verdes (Fase G do runbook).

## Riscos ainda abertos

- ToU da Fidelity proíbe acesso automatizado (zona cinzenta p/ conta própria) → manter 1×/dia, sessão
  reusada, sem martelar.
- Fragilidade de seletor (já é a causa do blocker atual) → seletores tolerantes + screenshots de debug.
- Self-hosted runner precisa do laptop ligado e logado na hora do run — limita "rodar sem o usuário".
