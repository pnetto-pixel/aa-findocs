# Handoff — Item 38: Automação de export Fidelity

> Estado vivo do item 38 para a próxima session retomar sem reconstruir contexto.
> Atualizado em 15/jun/2026. Acompanha [`item-38-fidelity-export-automation.md`](item-38-fidelity-export-automation.md)
> (o plano/decisões) e [`item-38-activation-runbook.md`](item-38-activation-runbook.md) (o que o usuário faz).

## Onde estamos (resumo de 30s)

A arquitetura recomendada no plano foi **construída e está FUNCIONANDO de ponta a ponta** (15/jun/2026).
O backend no `aa-findocs` está mergeado; o scraper no `fidelity-sync` roda num **self-hosted runner**.
O Akamai bloqueava o login automatizado, então o caminho é **reuso de sessão**: login manual 1× salva
a sessão (`storageState`, 88 cookies), e cada run reusa, abre o diálogo de export, clica **"Download as
CSV"**, faz parse e ingere com dedupe. Primeiro run real verde: `parsed 17 trades, 18 income rows` →
`ingest ok: added=0 alreadyLive=17` (os trades já estavam ao vivo; dedupe funcionando).

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
- `scrape.mjs` — Playwright headed, UA real, flags anti-automação, logging de discovery + screenshots.
  **Branch `main`** = versão antiga (login automatizado, bloqueada pelo Akamai). **Branch
  `claude/cool-wright-7cwemt`** = versão nova (reuso de sessão — ver "Blocker/Pivô").
- `.github/workflows/sync.yml` — `workflow_dispatch` manual, **`runs-on: self-hosted`**, headed,
  sobe screenshots `fidelity-*.png` como artifact em qualquer desfecho.
- Secrets cadastrados: `INGEST_TOKEN` (usado), + `FIDELITY_USER/PASS/TOTP_SECRET` (legados, não mais
  usados pelo sync após o pivô — podem ficar ou ser removidos).

## Pivô importante (não estava no plano original)

**A Fidelity está atrás do Akamai Bot Manager.** Runners GitHub-hosted usam IP de datacenter →
servem página de bloqueio ("Sorry, we can't complete this action") e fazem fingerprint de Chromium
headless. **Solução adotada:** runner **self-hosted no laptop Windows do usuário** (IP residencial),
sessão **interativa** (rodar `run.cmd` logado, NÃO como Windows Service — service não tem desktop e o
browser headed precisa de display), browser **headed** com `--disable-blink-features=AutomationControlled`
+ UA real. Isso destravou o bot-gate: o login agora renderiza o campo de usuário (antes nem isso).

## ✅ Resolvido (15/jun) — pipeline verde de ponta a ponta

Run `27557841703` (sync.yml, self-hosted `PEDRO-LAT-5455`): `re-injected 88 cookies` →
`activity url: .../portfolio/activity` (logado) → diálogo com botão **"Download as CSV"** →
`CSV downloaded` → `parsed 17 trades, 18 income rows` → `ingest ok: added=0 alreadyLive=17`.

**Operação de rotina:** ligar o runner (`run.cmd`, sessão interativa) → Actions → Run workflow.
A sessão dura até a Fidelity expirar; quando expirar, o run sai com `Session expired` e basta rodar
`npm run login` de novo no laptop. Cron diário (bloco `schedule` no `sync.yml`) é opt-in pra depois.

**Histórico do blocker (resolvido):**

Última run de login automatizado (`workflow_dispatch`, 15/jun 04:09 UTC, run `27523413828`):
todas as runs falharam. O screenshot `fidelity-after-submit.png` (artifact da run) mostra a página
**"Sorry, we can't complete this action right now"** — a tela de **bloqueio do Akamai Bot Manager**.
Confirmado com o usuário: os seletores de senha/botão estavam **corretos**; o problema é o Akamai
detectando a automação **no submit do login** e barrando, mesmo no runner residencial headed.

**Pivô (implementado em 15/jun):** parar de automatizar o login. Em vez disso, **reuso de sessão**:
- `scrape.mjs` agora usa `launchPersistentContext` com um perfil persistente em `~/.fidelity-sync-profile`
  (fora do workspace, sobrevive a `checkout`).
- `npm run login` (modo `--login`): abre o navegador headed, o usuário loga **na mão** (com 2FA),
  aperta Enter, e os cookies ficam salvos no perfil.
- `npm run sync`: reusa o perfil e vai **direto pra página de Activity** — sem login, nada pro Akamai
  flagar. Se a sessão expirou, sai com código 2 e mensagem "run `npm run login` again".
- `FIDELITY_USER/PASS/TOTP_SECRET` **não são mais usados** pelo sync (login é manual). `otplib` removido.
- Entregue na branch **`claude/cool-wright-7cwemt`** do `fidelity-sync` (commits de scrape.mjs + package.json).
  **Ainda não está no `main`** desse repo → o usuário precisa mergear (ou rodar o workflow selecionando
  essa branch) pra valer.

## Próximos passos concretos (para o usuário, no laptop)

> **O Claude não consegue dirigir o site da Fidelity** (precisa do IP residencial + 2FA + janela de
> navegador). Daqui pra frente é o usuário na máquina com o runner.

1. **Trazer o código novo pro `main` do `fidelity-sync`** (mergear a branch `claude/cool-wright-7cwemt`)
   — ou, no "Run workflow", escolher essa branch no dropdown.
2. **Logar uma vez** (terminal no laptop, NÃO via Actions):
   `npm install && npx playwright install chromium && npm run login` → logar na mão (2FA) até ver o
   portfólio → Enter. Rodar como o **mesmo usuário Windows** do runner.
3. **Ligar o runner** (`run.cmd` na pasta `actions-runner`, sessão logada) e disparar **Fidelity sync**.
4. Ler o log: `activity url:` = entrou logado; `Session expired` = repetir o passo 2; depois validar o
   **seletor de download** (`download candidates:` + screenshot `fidelity-activity.png` ajudam).
5. Com `ingest ok` no log: abrir o app → card "Fidelity Import" → aprovar → conferir os trades.

> Lembrete: `INGEST_TOKEN` + `INGEST_EMAIL` no Vercel já estão setados (confirmado pelo usuário).

> ⚠️ Antes do primeiro "ingest ok" funcionar de verdade, falta o usuário setar no Vercel (Production):
> `INGEST_TOKEN` (= secret do GitHub) e `INGEST_EMAIL` (pnetto@gmail.com). Sem isso o endpoint responde
> 503. Conferir esse passo se a chamada de ingest der 503.

## Estado dos arquivos / drift

- O template em `docs/plans/scraper/` (no `aa-findocs`) reflete a versão **reuso de sessão**
  (`scrape.mjs`, `package.json`, README). `workflow-sync.yml` = self-hosted/headed. `parse-fidelity.mjs`
  idêntico ao do `fidelity-sync`.
- Fonte da verdade do código que **roda** é o repo `fidelity-sync`. A versão nova está na branch
  `claude/cool-wright-7cwemt` (ainda não no `main` desse repo). Ao mexer no scraper, mexa lá e
  ressincronize o template aqui depois.

## Cron / automação

Ainda **manual** (`workflow_dispatch`). O bloco `schedule` no `sync.yml` está comentado. Só ligar
depois de vários runs manuais verdes (Fase G do runbook).

## Riscos ainda abertos

- ToU da Fidelity proíbe acesso automatizado (zona cinzenta p/ conta própria) → manter 1×/dia, sessão
  reusada, sem martelar.
- Fragilidade de seletor (já é a causa do blocker atual) → seletores tolerantes + screenshots de debug.
- Self-hosted runner precisa do laptop ligado e logado na hora do run — limita "rodar sem o usuário".
