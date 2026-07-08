---
description: Orquestra o pipeline de 4 agentes — planeja, coda, audita, faz merge direto no main. Sem PR, sem portão humano (decisão do usuário, jul/2026).
argument-hint: "[nome ou número do item do roadmap, opcional]"
---

Rode o workflow completo de feature do aa-findocs, orquestrando os 4 subagents em sequência. Subagents não chamam uns aos outros — VOCÊ (sessão principal) os invoca em ordem via Task e passa a saída de um como entrada do próximo.

Feature alvo (se especificada pelo usuário): **$ARGUMENTS**

## Sequência

1. **Planejar** — invoque o subagent `feature-planner`.
   - Se `$ARGUMENTS` veio preenchido, passe-o para o planner validar e detalhar ESSE item.
   - Se veio vazio, deixe o planner escolher a próxima feature pelo roadmap.
   - Apresente ao usuário a feature recomendada + escopo e **confirme antes de codar** (a escolha da feature é uma decisão do usuário; respeite "uma tarefa por sessão"). Se o usuário já especificou a feature em `$ARGUMENTS`, pode prosseguir sem nova confirmação.

2. **Codar** — invoque o subagent `feature-coder` passando o briefing do planner. Ele implementa e valida o build.
   - Se o build falhar e ele não conseguir consertar, pare e reporte ao usuário.

3. **Auditar + mergear** — invoque o subagent `feature-auditor` passando o relatório do coder.
   - Se REPROVAR, devolva os achados ao `feature-coder` para correção e re-audite. No máximo 2 rodadas; depois disso, pare e reporte ao usuário.
   - Se APROVAR, ele segue o padrão "Deploy Pattern" do `CLAUDE.md`: branch de feature → build verde → `git checkout -B main origin/main` → `git merge --no-ff <branch>` → `git push origin main`. **Sem PR, sem espera por revisão humana** — o merge acontece direto se a auditoria e o build passarem.

4. **Documentar** — invoque o subagent `docs-updater` passando o resumo do coder + o resultado do merge do auditor. Ele atualiza `docs/CONTEXT.md` e `docs/Features_Roadmap.md`.
   - Commit + push das docs direto na `main` (mesmo padrão do passo 3 — sem PR).

## Regras

- **Merge direto no main, sem PR** (decisão explícita do usuário — antes o pipeline abria PR e esperava revisão humana; ver `docs/CONTEXT.md` § Decisões Técnicas). O build verde (`npm run build`) e a auditoria do `feature-auditor` são o único gate antes do merge — não há mais uma etapa de espera.
- Se o build falhar e não for corrigível em até 2 rodadas de auditoria, PARE antes do merge e reporte ao usuário — nunca empurre código com build quebrado para `main`.
- Modelo default Sonnet; só sugira Opus para algum passo se a feature for estruturalmente complexa.
- Ao final, entregue ao usuário: resumo do que foi feito, confirmação de que está em produção (`main`, Vercel rebuilda automático em ~1-2min), e o que ficou pendente.
