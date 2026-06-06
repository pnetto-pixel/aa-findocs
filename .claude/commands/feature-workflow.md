---
description: Orquestra o pipeline de 4 agentes — planeja, coda, audita+abre PR, atualiza docs. Para antes do merge (revisão humana).
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

3. **Auditar + entregar** — invoque o subagent `feature-auditor` passando o relatório do coder.
   - Se REPROVAR, devolva os achados ao `feature-coder` para correção e re-audite. No máximo 2 rodadas; depois disso, pare e reporte ao usuário.
   - Se APROVAR, ele cria branch, commita, dá push e abre o PR. **Ninguém faz merge** — esse é o portão humano.

4. **Documentar** — invoque o subagent `docs-updater` passando o resumo do coder + o PR do auditor. Ele atualiza `docs/CONTEXT.md` e `docs/Features_Roadmap.md`.
   - Garanta que as mudanças de docs entrem no mesmo PR da feature (commit + push na mesma branch). Se o PR já foi aberto, faça commit das docs na branch e o PR se atualiza sozinho.

## Regras

- **Nunca faça merge nem habilite auto-merge.** O pipeline termina com o PR aberto, pronto para revisão no GitHub mobile.
- Modelo default Sonnet; só sugira Opus para algum passo se a feature for estruturalmente complexa.
- Ao final, entregue ao usuário: link do PR, resumo do que foi feito, e o que ficou pendente.
