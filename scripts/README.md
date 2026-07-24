# scripts/

Scripts avulsos, rodados à mão fora do app. Não entram no build nem no deploy.

## `simplefin-dump.ps1` / `simplefin-dump.mjs`

Dump completo do que a SimpleFin Bridge devolve sobre a conta Fidelity — todos os
campos, inclusive os que o app hoje ignora. As duas versões fazem exatamente a
mesma coisa; escolha pelo ambiente (PowerShell no Windows, Node em qualquer
lugar).

**Por que existe:** o sync do app (`api/fidelity-pending.js` + `lib/simplefin-map.js`)
é opinativo de propósito — só extrai o que o portfolio precisa (cash, bank bonds,
dividendos/juros, deltas de posição) e joga o resto em `unmapped`. Esses scripts
não interpretam nada: mostram o payload cru, em tabela, pra responder "o que mais
dá pra puxar daqui?".

### Pré-requisito

O **access URL** do SimpleFin, com credenciais embutidas
(`https://usuario:senha@bridge.simplefin.org/simplefin`). É o mesmo valor da env
var `SIMPLEFIN_ACCESS_URL` no projeto da Vercel — copiar de
Settings → Environment Variables.

O access URL equivale a acesso read-only a **todas** as instituições linkadas no
Bridge. Não colar em chat, issue, log ou commit.

### Rodando

PowerShell (5.1 ou 7+):

```powershell
.\scripts\simplefin-dump.ps1                 # pergunta o access URL
.\scripts\simplefin-dump.ps1 -Days 90 -OutDir C:\temp\sf
.\scripts\simplefin-dump.ps1 -NoCsv          # só console, não grava arquivo
```

Se o Windows bloquear o script: `powershell -ExecutionPolicy Bypass -File .\scripts\simplefin-dump.ps1`

Node (sem dependências, usa o Node do projeto):

```bash
node scripts/simplefin-dump.mjs                       # pergunta o access URL
SIMPLEFIN_ACCESS_URL="https://user:pass@bridge.simplefin.org/simplefin" \
  node scripts/simplefin-dump.mjs --days 90
node scripts/simplefin-dump.mjs --no-csv
```

### Saída

No console: tabela de contas, tabela de holdings (com `Kind` classificando
`stock/etf` × `bank bond/CD` × `cash (sintético)`, mais custo total e ganho/perda
derivados), tabela de transações e um **inventário de campos** — toda chave que a
Bridge retornou em cada nível, com quantos itens vieram preenchidos. Chave que
aparece no inventário e não aparece nas tabelas = dado que o app ainda não lê.

Em disco (`./simplefin-out` por padrão, ignorado pelo git): `accounts-*.csv`,
`holdings-*.csv`, `transactions-*.csv`, `fields-*.csv` e o JSON bruto.

### Filtro Fidelity

Por padrão os scripts filtram `org.name`/`org.domain` contendo "fidelity" — a
mesma regra mandatória do mapper (`isFidelityOrg`). Uma conexão SimpleFin devolve
**todas** as instituições linkadas no Bridge (jul/2026: 22 contas, só 1 Fidelity),
então sem o filtro o dump inclui contas bancárias pessoais. O JSON bruto salvo em
disco também é reserializado só com o subconjunto filtrado, pelo mesmo motivo.

`-AllOrgs` / `--all-orgs` desliga o filtro — use só se for isso mesmo que você
quer.

### Janela de transações

Default 90 dias, que é o teto rígido da Bridge. Acima de ~45 dias ela devolve um
aviso em `payload.errors` (aviso, não erro — os scripts imprimem e seguem). O app
usa 44 dias justamente pra nunca ver esse aviso; aqui, num dump manual, o aviso é
inofensivo.
