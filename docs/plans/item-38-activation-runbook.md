# Runbook — Ativação segura da automação Fidelity (item 38)

> Para executar quando estiver no laptop. Ordem importa: **endureça o GitHub primeiro.**
> Tudo aqui é o que VOCÊ faz. O código (endpoint + scraper) é additive e fica numa branch
> até você revisar e mergear — nada vai ao ar antes disso.

## Garantia de zero-impacto (já vigente)

1. **Branch isolada** — todo o código vive em `claude/fidelity-export-automation-4v26wh`.
   Vercel só deploya do `main`. Sem merge seu = produção inalterada. É a trava principal.
2. **Só arquivos novos** — `api/ingest-fidelity.js` + docs. Nenhuma edição em
   `lib/auth.js`, `api/transactions.js`, `api/holdings.js` ou nas telas existentes.
3. **Staging, não live** — ingestão grava em chave Redis nova `:fidelity-pending`,
   nunca em `:transactions`/`:holdings`. Dado ao vivo intocado até você aprovar no app.
4. **Dormente** — endpoint inerte sem a env `INGEST_TOKEN` no Vercel.
5. **Reversível** — apagar branch / remover env / apagar a chave Redis = some sem rastro.

## Modelo de controle

- **O quê:** scraper → área pendente → você revisa/aprova no app → entra ao vivo (com dedupe).
- **Quando:** gatilho **manual** (botão "Run workflow" no app do GitHub). Sem cron até você optar.

---

## A. Endurecer a conta GitHub (FAÇA PRIMEIRO — é o cofre dos segredos)

1. **2FA com passkey ou chave física** (Settings → Password and authentication).
   NÃO usar SMS (é phishável). Passkey/security key é o padrão.
2. **Auditar acessos:** Settings → Applications (OAuth apps autorizados) e
   Developer settings → Personal access tokens. Revogar qualquer coisa desconhecida.
3. **Auditar SSH/GPG keys:** Settings → SSH and GPG keys. Remover chaves que não reconhece.
4. **Não adicionar colaboradores** ao repo do scraper.

## B. Criar o repositório do scraper

1. New repository → **Private** → nome ex. `fidelity-sync`. **Confirme que está Private**
   antes de qualquer push.
2. Settings → Actions → General → Workflow permissions: deixar "Read repository contents"
   (mínimo) e exigir aprovação para workflows de fork (você não terá forks, mas trave).

## B2. Self-hosted runner no laptop Windows (OBRIGATÓRIO — IP residencial)

> Por quê: a Fidelity (atrás do Akamai) bloqueia IPs de datacenter. Rodar nos servidores
> do GitHub dá a tela "Sorry, we can't complete this action". O runner no SEU laptop usa
> o IP da sua casa, que a Fidelity aceita. Você ainda dispara o run pelo app do GitHub no
> iPhone — o laptop só precisa estar ligado e com o runner ativo na hora.

1. `fidelity-sync` → Settings → Actions → Runners → **New self-hosted runner** → **Windows**.
2. Siga os comandos que o GitHub mostra (PowerShell): baixa o pacote, `config.cmd` registra
   o runner no repo (cole o token que a página fornece).
3. **NÃO instale como serviço.** Quando o `config.cmd` perguntar "Run as service?", responda
   **N**. (Serviço roda em sessão sem desktop e o navegador headed não teria tela.)
4. Para iniciar o runner: na pasta do runner, rode **`run.cmd`** (mantém uma janela aberta
   "Listening for Jobs"). Deixe essa janela aberta enquanto quiser rodar syncs.
5. Pré-requisitos no laptop (uma vez): instalar **Node.js 20** e **Git for Windows**.
6. Mantenha o laptop **logado e desbloqueado** durante o run (o navegador precisa do desktop).

> Para rodar: ligue o laptop → abra `run.cmd` → dispare "Run workflow" no app do GitHub.
> Terminou? Pode fechar o `run.cmd`. O laptop não precisa ficar ligado 24/7 — só na hora.

## C. Habilitar TOTP na Fidelity e capturar o segredo

1. App da Fidelity → Profile → Security Center → Multi-factor authentication →
   adicionar **authenticator app**.
2. Na tela do QR, abrir **"Can't scan / Enter key manually"** → copiar a string base32
   (ex. `JBSWY3DPEHPK3PXP...`). Esse é o `FIDELITY_TOTP_SECRET`.
3. **Também** escaneie o QR com um app real (Authy/Google Auth) pra você manter login manual.
4. Trate o segredo como uma segunda senha: senha + TOTP = acesso total. Por isso o passo A.

## D. Cadastrar os 4 segredos no GitHub

Repo `fidelity-sync` → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Valor |
|---|---|
| `FIDELITY_USER` | login da Fidelity |
| `FIDELITY_PASS` | senha da Fidelity |
| `FIDELITY_TOTP_SECRET` | string base32 do passo C |
| `INGEST_TOKEN` | token aleatório 40+ chars que você gera |

GitHub Secrets é criptografado, não aparece em log e não é legível depois de salvo.

## E. Backend no app (eu entrego additive; você revisa e ativa)

1. Revisar a branch (Files changed no app do GitHub): deve haver só `api/ingest-fidelity.js`
   novo + docs. Se aparecer edição em arquivo existente do caminho crítico, **não mergear** e
   me avisar.
2. Vercel → Project Settings → Environment Variables → adicionar (Production):
   - `INGEST_TOKEN` = mesmo valor do secret do GitHub
   - `INGEST_EMAIL` = seu e-mail (o endpoint mira a chave de storage desse e-mail; o token
     não pode redirecionar dados pra outra conta)
3. Mergear a branch → Vercel rebuilda. Endpoint passa a existir, mas só responde ao token.

## F. Scraper no repo privado (eu entrego; você valida manualmente)

1. Push do código do scraper no `fidelity-sync`.
2. Com o **runner ativo** (laptop ligado, `run.cmd` rodando — passo B2), rodar
   **manualmente** uma vez: Actions → workflow → "Run workflow" (dá pra apertar no
   app do GitHub no iPhone). O job vai pro seu laptop, não pros servidores do GitHub.
3. Conferir no log: "login ok", "CSV baixado", "N linhas enviadas". O log **não** deve
   conter senha/CSV bruto (o script só loga status; GitHub mascara secrets).
4. Abrir o app aa-findocs → revisar o import pendente da Fidelity → aprovar → confirmar
   que os trades entraram corretos.
5. Repetir o run manual mais algumas vezes em dias diferentes antes de confiar.

## G. (Opcional, mais tarde) Automatizar

Só depois de vários runs manuais bem-sucedidos: ligar cron diário e/ou auto-merge.
Cada um é uma mudança pequena e reversível.

---

## Plano de resposta a incidente (se suspeitar de acesso indevido)

**Kill switch da Fidelity (neutraliza um vazamento do segredo na hora):**
1. Fidelity → Security Center → **remover o authenticator app** → isso regenera o segredo;
   o `FIDELITY_TOTP_SECRET` guardado vira inútil imediatamente.
2. Trocar a senha da Fidelity.
3. Revogar/rotacionar os secrets do GitHub e o `INGEST_TOKEN` (GitHub + Vercel).

**Defesa em profundidade (configurar antes, por garantia):**
- Ativar alertas da Fidelity (login de novo device, transferências) — você nota uso indevido rápido.
- O scraper é **read-only** (só baixa CSV; não há caminho de código que faça trade/transferência).
- O endpoint só escreve em `:fidelity-pending` (nunca move dinheiro, nunca toca live sem aprovação).

## Limites de blast-radius (por design)

- Scraper read-only na Fidelity.
- Endpoint grava só em staging; alvo = seu e-mail por config, não por request.
- Gatilho manual / 1×dia + sessão reusada = baixa chance de flag por automação.
- Runner no seu laptop (IP residencial): os secrets nunca saem do GitHub para um terceiro;
  o navegador só roda na sua máquina, sob sua sessão.
