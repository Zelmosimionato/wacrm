# Fluxo de Agendamento — Infraestrutura Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir as peças de infraestrutura que o [FLUXO] de pós-reserva vai precisar antes
de o grafo em si poder ser montado — extensões pequenas do motor de Fluxos, a migração de
notificação de urgência, a troca do marcador `[[AGENDAR:N]]` da Márcia por `[[AGENDAR]]` (sem
número, entregando o bastão pro Fluxo em vez de reservar ela mesma), a pergunta de urgência
proativa, e a etapa+automações novas de mudança visual do card.

**Architecture:** Extensão pontual do motor de Fluxos (`src/lib/flows/*`) e do pipeline da IA
(`src/lib/ai/*`) que já existem e já rodam em produção — sem infraestrutura nova do zero. O
grafo real do [FLUXO] (as tarefas de montar `flows`/`flow_nodes`) é um plano SEPARADO, que só
começa depois deste estar no ar — precisa das peças daqui prontas primeiro.

**Tech Stack:** TypeScript, Next.js (wacrm), Vitest, Supabase (Postgres).

## Global Constraints

- O repositório só existe na VPS (`root@100.85.48.50`, `/root/wacrm`) — sem clone local, sem
  worktree. Editar local (scratchpad) → baixar o arquivo real primeiro (`ssh ... "cat <path>" >
  local.ts`), editar, reenviar (`ssh ... "cat > <path>" < local.ts`) — evita erro de heredoc em
  edição cirúrgica no meio do arquivo.
- ⛔ **Antes de commitar, sempre `git status --short`** e confirmar que só os arquivos DESTA
  tarefa estão staged — o repositório tem outras mudanças não commitadas de trabalho anterior
  (deixar como está); `git commit` sem `--` commita tudo que estiver staged. `git add` explícito
  dos arquivos certos, NUNCA `git add -A`/`.`.
- Migrações são aplicadas MANUALMENTE pelo titular no SQL Editor do Supabase Dashboard — não há
  CLI do Supabase nem conexão Postgres direta na VPS. O padrão é: escrever o arquivo de
  migração numerado em `supabase/migrations/`, commitar, e dar ao titular o SQL exato pra
  colar no painel (mesmo processo das migrações `041`/`042` de hoje).
- ⛔ **Rollout faseado**: esta fase do Fluxo de Agendamento vale só pra leads **PF** (pessoa
  física) — PJ continua pelo caminho antigo (`[[AGENDAR:N]]`) por enquanto, decisão explícita
  do titular pra reduzir o raio de risco do lançamento (ver spec, seção "Rollout faseado"). A
  restrição por segmento entra na checagem do marcador `[[AGENDAR]]` (Tarefa 4).
- Nenhum node_type novo do motor de Fluxos nesta fase — as extensões são em `condition`
  (Tarefa 1) e uma função de início de run (Tarefa 2), não nós novos.
- Spec de referência completo: `docs/superpowers/specs/2026-08-20-agendamento-fluxos-design.md`
  (VPS) — este plano implementa só a parte de infraestrutura dele; o grafo em si (as tarefas de
  montar os nós do Fluxo de Agendamento/pós-reserva/No-show) é um plano futuro separado.

---

### Task 1: `condition` ganha o operador `keyword_match`

**Files:**
- Modify: `src/lib/flows/types.ts`
- Modify: `src/lib/flows/engine.ts`
- Test: `src/lib/flows/engine.test.ts`

**Interfaces:**
- Consumes: `matchesKeywordTrigger(text, cfg: KeywordTriggerConfig)` e o tipo
  `KeywordTriggerConfig` (`{ keywords: string[]; match_type?: "exact"|"contains";
  case_sensitive?: boolean }`), ambos já existem em `src/lib/flows/engine.ts`/`types.ts` desde
  a fundação do `wait` (hoje mais cedo).
- Produces: novo operador usável por qualquer `condition` node que precise checar uma LISTA de
  palavras-chave contra um `var` — consumido pela Task de montagem do grafo (pergunta de
  urgência, plano futuro separado).

- [ ] **Step 1: Confirmar o estado real de `ConditionOperator`/`ConditionNodeConfig` antes de
  editar**

`ssh root@100.85.48.50 "grep -n 'ConditionOperator\|ConditionNodeConfig' -A 20 /root/wacrm/src/lib/flows/types.ts | head -40"`
— confirmar que o formato ainda é:
```typescript
export type ConditionOperator =
  | "equals"
  | "contains"
  | "present"
  | "absent";
...
export interface ConditionNodeConfig {
  subject: ConditionSubject;
  subject_key: string;
  operator: ConditionOperator;
  value?: string;
  true_next: string;
  false_next: string;
}
```

- [ ] **Step 2: Adicionar o operador e o campo novo em `types.ts`**

```typescript
export type ConditionOperator =
  | "equals"
  | "contains"
  | "present"
  | "absent"
  | "keyword_match";
```

E em `ConditionNodeConfig`, logo depois do campo `value`:
```typescript
  /** Compared against `subject` for `equals`/`contains`. Ignored for `present`/`absent`. */
  value?: string;
  /** Used only for `keyword_match` — casa `subject` contra uma LISTA de
   *  palavras-chave (mesmo tipo que `wait.keyword_branches[].trigger` já
   *  usa). Ignorado pros outros operadores. */
  keywords?: KeywordTriggerConfig;
```

Confirmar que `KeywordTriggerConfig` já está importado/exportado em `types.ts` (é usado por
`WaitNodeConfig` desde hoje mais cedo) — se `ConditionNodeConfig` estiver num arquivo diferente
de onde `KeywordTriggerConfig` foi declarado, adicionar o import necessário.

- [ ] **Step 3: Adicionar o `case` em `evaluateConditionPredicate` (`engine.ts`)**

Ler a função real primeiro:
`ssh root@100.85.48.50 "grep -n 'function evaluateConditionPredicate' -A 25 /root/wacrm/src/lib/flows/engine.ts"`

Hoje ela é:
```typescript
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  subjectValue: string | undefined;
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}
```

Adicionar o parâmetro `keywords` e o `case` novo — o TypeScript vai reclamar de switch
não-exaustivo até isto ser adicionado (é o sinal de que o tipo está certo):

```typescript
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  subjectValue: string | undefined;
  configValue: string | undefined;
  keywords?: KeywordTriggerConfig;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
    case "keyword_match":
      if (args.subjectValue === undefined) return false;
      return matchesKeywordTrigger(args.subjectValue, args.keywords ?? { keywords: [] });
  }
}
```

- [ ] **Step 4: Passar `keywords` no chamador, `evaluateConditionNode`**

Ler a função real primeiro:
`ssh root@100.85.48.50 "grep -n 'async function evaluateConditionNode' -A 40 /root/wacrm/src/lib/flows/engine.ts"`

No final da função, onde ela chama `evaluateConditionPredicate`, adicionar `keywords:
cfg.keywords`:
```typescript
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
    keywords: cfg.keywords,
  });
```

- [ ] **Step 5: Testes**

Seguir o padrão de teste já usado hoje pro `wait`/palavra-chave (mesmo arquivo). Casos mínimos,
chamando `evaluateConditionPredicate` diretamente (função pura, já exportada — não precisa
subir um run completo):
1. `operator: "keyword_match"`, `keywords: {keywords: ["urgente", "prazo"]}`,
   `subjectValue: "tenho um prazo correndo"` → `true` (bate "prazo", `contains` por padrão).
2. Mesmo `keywords`, `subjectValue: "não, tudo tranquilo"` → `false`.
3. `subjectValue: undefined` → `false` (não lança, não trata `undefined` como match).
4. `keywords` ausente (`undefined`) com `operator: "keyword_match"` → `false`, sem lançar
   (usa o fallback `{keywords: []}` do Step 3, `matchesKeywordTrigger` já trata lista vazia
   como não-match).

- [ ] **Step 6: Rodar os testes**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts"`

- [ ] **Step 7: Checar tipos**

`ssh root@100.85.48.50 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i flow"` — sem erro novo.

- [ ] **Step 8: Commit**

```bash
git add src/lib/flows/types.ts src/lib/flows/engine.ts src/lib/flows/engine.test.ts
git commit -m "feat(flows): condition ganha operador keyword_match"
```

---

### Task 2: `startManualFlowRun` — iniciar um Fluxo sem mensagem inbound real

**Files:**
- Modify: `src/lib/flows/engine.ts`
- Test: `src/lib/flows/engine.test.ts`

**Interfaces:**
- Consumes: a função privada `startNewRun` já existente (vai ser refatorada, não duplicada) e
  `loadAllNodes` (privada, mesma arquivo).
- Produces: `export async function startManualFlowRun(db, flowId: string, args: { accountId:
  string; contactId: string; conversationId: string }): Promise<DispatchInboundResult>` —
  consumida pela Task 4 deste plano (Márcia aciona `[[AGENDAR]]`) e, num plano futuro separado,
  pelo endpoint novo que o `intake.js` vai chamar (Canal B).

- [ ] **Step 1: Ler `startNewRun` real por inteiro antes de mexer**

`ssh root@100.85.48.50 "grep -n 'async function startNewRun' -A 60 /root/wacrm/src/lib/flows/engine.ts"`

Confirmar contra o texto abaixo (é o estado como foi lido na sessão de hoje — pode ter mudado,
usar o real):
```typescript
async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      account_id: flow.account_id,
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    console.error("[flows] execution_count rpc error:", incErr.message);
  }
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
```

O único lugar que usa `input.message` é o `meta_message_id` do `logEvent`. Todo o resto usa só
`input.contactId`/`input.conversationId` e o `flow`/`nodes` já carregados.

- [ ] **Step 2: Extrair a lógica compartilhada, sem mudar o comportamento de `startNewRun`**

Trocar o corpo de `startNewRun` por uma chamada a um helper privado novo que recebe
`metaMessageId: string | null` em vez de `input.message`:

```typescript
async function insertAndStartRun(
  db: AdminClient,
  flow: FlowRow,
  args: { contactId: string; conversationId: string },
  nodes: Map<string, FlowNodeRow>,
  metaMessageId: string | null,
): Promise<DispatchInboundResult> {
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      account_id: flow.account_id,
      user_id: flow.user_id,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] insertAndStartRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: metaMessageId,
  });
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    console.error("[flows] execution_count rpc error:", incErr.message);
  }
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  return insertAndStartRun(
    db,
    flow,
    { contactId: input.contactId, conversationId: input.conversationId },
    nodes,
    input.message.meta_message_id,
  );
}
```

⚠️ `startNewRun` continua com a MESMA assinatura e o MESMO comportamento externo — só o corpo
virou uma chamada ao helper. Nenhum outro chamador de `startNewRun` precisa mudar.

- [ ] **Step 3: Adicionar `startManualFlowRun`, exportada**

Logo depois de `startNewRun`:

```typescript
/**
 * Inicia um Fluxo sem mensagem inbound real — usado quando outro sistema
 * (a IA detectando `[[AGENDAR]]`, ou um webhook externo) decide que é
 * hora de entregar o bastão pro Fluxo, em vez de o Fluxo ter sido
 * disparado por uma mensagem batendo um trigger. Carrega o flow pelo id
 * (precisa ter `entry_node_id` configurado) e reaproveita a MESMA
 * inserção/avanço que `startNewRun` usa — único código que sabe criar
 * uma run.
 */
export async function startManualFlowRun(
  db: AdminClient,
  flowId: string,
  args: { accountId: string; contactId: string; conversationId: string },
): Promise<DispatchInboundResult> {
  const { data: flowRow, error: flowErr } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .eq("account_id", args.accountId)
    .maybeSingle();
  if (flowErr || !flowRow) {
    console.error("[flows] startManualFlowRun: flow not found", flowId, flowErr?.message);
    return { consumed: false, outcome: "no_match" };
  }
  const flow = flowRow as FlowRow;
  if (!flow.entry_node_id) {
    console.error("[flows] startManualFlowRun: flow has no entry_node_id", flowId);
    return { consumed: false, outcome: "no_match" };
  }
  const nodes = await loadAllNodes(db, flow.id);
  return insertAndStartRun(
    db,
    flow,
    { contactId: args.contactId, conversationId: args.conversationId },
    nodes,
    null,
  );
}
```

Confirmar que `AdminClient`, `FlowRow`, `DispatchInboundResult` já estão importados/declarados
no arquivo (todos já usados por `startNewRun`/`dispatchInboundToFlows`) — não deveria precisar
de import novo.

- [ ] **Step 4: Testes**

Seguir o padrão de mock já usado pros outros testes de `dispatchInboundToFlows`/`startNewRun`
no mesmo arquivo. Casos mínimos:
1. Flow existe, tem `entry_node_id`, sem run ativo pro contato → cria a run, avança pro nó de
   entrada, retorna `{ consumed: true, outcome: "started", flow_run_id: ... }` (mesma forma que
   `startNewRun` já retorna em sucesso).
2. Flow não encontrado (id errado ou `account_id` não bate) → `{ consumed: false, outcome:
   "no_match" }`, sem lançar.
3. Flow encontrado mas sem `entry_node_id` → mesmo resultado do caso 2.
4. Índice único violado (`23505`, mesma simulação já usada nos testes de `startNewRun`) →
   `{ consumed: true, outcome: "duplicate_inbound_ignored" }`.
5. **Regressão**: os testes JÁ EXISTENTES de `dispatchInboundToFlows`/`startNewRun` continuam
   passando sem alteração — prova que a extração do Step 2 não mudou nada do comportamento
   real, só moveu código.

- [ ] **Step 5: Rodar os testes**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts"`

- [ ] **Step 6: Checar tipos**

`ssh root@100.85.48.50 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i flow"` — sem erro novo.

- [ ] **Step 7: Commit**

```bash
git add src/lib/flows/engine.ts src/lib/flows/engine.test.ts
git commit -m "feat(flows): startManualFlowRun inicia um fluxo sem mensagem inbound real"
```

---

### Task 3: Migração `notifications.type` + handoff de urgência

**Files:**
- Create: `supabase/migrations/043_notifications_urgent_lead.sql`
- Modify: `src/lib/ai/auto-reply.ts`
- Test: `src/lib/ai/auto-reply.test.ts`

**Interfaces:**
- Consumes: tabela `notifications` (schema já existe, migração 027+040), padrão de insert já
  usado pelo passo `notify` das Automações (`src/lib/automations/engine.ts`, case `'notify'`).
- Produces: toda vez que a tag "Urgente" é aplicada, um handoff imediato — não é consumido por
  nenhuma outra task deste plano, é o fim da cadeia (efeito visível: notificação na tela de
  Notificação do CRM).

- [ ] **Step 1: Ler o schema real de `notifications` e o passo `notify` como referência**

`ssh root@100.85.48.50 "grep -n \"CHECK (type IN\" /root/wacrm/supabase/migrations/040_notificacao_aguardando_resposta.sql"`
— confirmar a lista atual exata antes de escrever a migração (hoje é
`('conversation_assigned', 'awaiting_reply')`, mas confirme).

`ssh root@100.85.48.50 "sed -n '944,995p' /root/wacrm/src/lib/automations/engine.ts"` — o
shape exato do insert em `notifications` (case `'notify'`), pra reaproveitar as mesmas colunas.

- [ ] **Step 2: Escrever a migração**

```sql
-- ============================================================
-- 043 — NOTIFICAÇÃO DE LEAD URGENTE
-- ============================================================
-- Terceiro `type` em `notifications` (027 → conversation_assigned;
-- 040 → awaiting_reply). Escrito por `applyAiUrgente` em auto-reply.ts
-- quando a tag "Urgente" é aplicada — handoff imediato, sem esperar
-- checagem de prazo de agenda (ver spec agendamento-fluxos-design.md,
-- seção "Sinal de urgência").
-- ============================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'awaiting_reply', 'urgent_lead'));

COMMENT ON COLUMN notifications.type IS
  'conversation_assigned: gatilho de atribuição (027). '
  'awaiting_reply: conversa parada esperando resposta humana (040). '
  'urgent_lead: tag Urgente aplicada pela IA — handoff imediato, sem checar prazo (043).';
```

⚠️ Antes de escrever o número `043`, confirmar que é mesmo o próximo livre:
`ssh root@100.85.48.50 "ls /root/wacrm/supabase/migrations/ | tail -3"` — se já existir um
`043`, usar o próximo número disponível e ajustar o nome do arquivo/comentário de acordo.

- [ ] **Step 3: Ler `applyAiUrgente` e o call site real antes de editar**

`ssh root@100.85.48.50 "grep -n 'async function applyAiUrgente' -A 15 /root/wacrm/src/lib/ai/auto-reply.ts"`
e
`ssh root@100.85.48.50 "sed -n '1315,1330p' /root/wacrm/src/lib/ai/auto-reply.ts"` (o call site,
Fase 3b) — confirmar que o formato ainda bate com:
```typescript
async function applyAiUrgente(
  db: ReturnType<typeof supabaseAdmin>,
  args: { contactId: string },
): Promise<void> {
  const { contactId } = args
  const { count } = await db
    .from('contact_tags')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .eq('tag_id', AI_TAG_URGENTE)
  if (!count) {
    await db.from('contact_tags').insert({ contact_id: contactId, tag_id: AI_TAG_URGENTE })
  }
}
```
chamada em:
```typescript
    if (urgente && !isClient) {
      try {
        await applyAiUrgente(db, { contactId })
      } catch (err) {
        console.error('[ai auto-reply] marcar urgente falhou:', err)
      }
    }
```

- [ ] **Step 4: Estender `applyAiUrgente` pra disparar o handoff**

`applyAiUrgente` precisa de mais contexto do que tem hoje (`accountId`, `conversationId`, e um
texto/motivo pra `body`) — ajustar a assinatura e o call site juntos:

```typescript
async function applyAiUrgente(
  db: ReturnType<typeof supabaseAdmin>,
  args: { accountId: string; contactId: string; conversationId: string; motivo: string },
): Promise<void> {
  const { accountId, contactId, conversationId, motivo } = args
  const { count } = await db
    .from('contact_tags')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .eq('tag_id', AI_TAG_URGENTE)
  const jaTinhaTag = !!count
  if (!jaTinhaTag) {
    await db.from('contact_tags').insert({ contact_id: contactId, tag_id: AI_TAG_URGENTE })
  }
  // Handoff dispara toda vez que a tag é aplicada de novo nesta conversa,
  // não só na primeira — o titular pode já ter lido a notificação antiga
  // e o lead voltou a mencionar urgência numa conversa diferente depois.
  const { data: membros } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
  const destinatarios = (membros ?? []).map((m) => m.user_id as string)
  if (destinatarios.length === 0) return
  const { error } = await db.from('notifications').insert(
    destinatarios.map((uid) => ({
      account_id: accountId,
      user_id: uid,
      type: 'urgent_lead',
      conversation_id: conversationId,
      contact_id: contactId,
      title: 'Lead sinalizou urgência',
      body: motivo,
    })),
  )
  if (error) {
    console.error('[ai auto-reply] notificar urgente falhou:', error.message)
  }
}
```

⚠️ Confirme o nome real da coluna de conta em `profiles` (`account_id`) e o nome da tabela
(`profiles`) contra o padrão já usado no passo `notify` das Automações (Step 1) — reaproveitar
exatamente o mesmo padrão de busca de destinatários "todos da conta", não inventar um novo.

- [ ] **Step 5: Atualizar o call site**

No ponto onde `applyAiUrgente` é chamado (Fase 3b), passar o contexto novo. O `motivo` é a
última mensagem do lead que motivou o marcador — reaproveitar a variável já usada mais acima na
função pra "a pessoa afirma reunião" (`ultimaDoLead`) se ela estiver no mesmo escopo, ou a
variável equivalente que contém o texto do lead nesta função:

```typescript
    if (urgente && !isClient) {
      try {
        await applyAiUrgente(db, {
          accountId,
          contactId,
          conversationId,
          motivo: String(ultimaDoLead || textoParaIa || '').slice(0, 500),
        })
      } catch (err) {
        console.error('[ai auto-reply] marcar urgente falhou:', err)
      }
    }
```

⚠️ Confirme os nomes reais das variáveis disponíveis nesse escopo da função (`accountId`,
`conversationId`, e a variável com o texto do lead) contra o arquivo real — os nomes acima são
os observados na investigação de hoje, mas confirme antes de colar.

- [ ] **Step 6: Testes**

Seguir o padrão de mock já usado nos testes de `applyAiUrgente`/marcador `[[URGENTE]]` já
existentes em `auto-reply.test.ts` (da Frente C, hoje mais cedo) — atualizar os testes
existentes pra nova assinatura, e adicionar: (1) marcar urgente insere em `notifications` com
`type: 'urgent_lead'` e `body` contendo o texto do lead; (2) todos os membros da conta recebem
uma linha (não só um "atribuído"); (3) se `applyAiUrgente` já tinha a tag antes (segunda vez na
mesma conversa), AINDA ASSIM dispara a notificação (não é idempotente pro handoff, só pro
insert da tag).

- [ ] **Step 7: Rodar os testes**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/ai/auto-reply.test.ts"`

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/043_notifications_urgent_lead.sql src/lib/ai/auto-reply.ts src/lib/ai/auto-reply.test.ts
git commit -m "feat(ai): handoff imediato quando a tag Urgente e aplicada"
```

⚠️ **Depois do commit, dar ao titular o SQL exato da migração pra colar no SQL Editor do
Supabase Dashboard** (mesmo processo das migrações `041`/`042` de hoje) — o código só funciona
de ponta a ponta depois disso rodar no banco.

---

### Task 4: Márcia — `[[AGENDAR:N]]` vira `[[AGENDAR]]`, entrega o bastão pro Fluxo (só PF nesta fase)

**Files:**
- Modify: `src/lib/ai/defaults.ts`
- Modify: `src/lib/ai/generate.ts`
- Modify: `src/lib/ai/auto-reply.ts`
- Test: `src/lib/ai/generate.test.ts`, `src/lib/ai/auto-reply.test.ts`

**Interfaces:**
- Consumes: `startManualFlowRun` (Task 2), a tag "Qualificado"/"Superqualificado" (checagem de
  segurança antes de acionar — mesmo espírito de `AI_TAG_SUPER` já usada no arquivo).
- Produces: nada consumido por outra task deste plano — é o fim da cadeia da Márcia. O `flowId`
  do Fluxo de Agendamento em si é um valor que só vai existir depois que o PLANO FUTURO (montar
  o grafo) rodar — até lá, deixar como uma constante com comentário `TODO` explícito e um teste
  cobrindo o caminho, mas sem apontar pra um id fixo ainda inexistente (ver Step 4).

**⚠️ Esta é a tarefa de maior risco deste plano** — troca um mecanismo que já está em produção
funcionando bem (o titular relatou hoje que a Márcia agenda até de madrugada, atendendo leads
que ele só responderia no dia seguinte). Ler tudo com cuidado antes de editar; preservar
integralmente a lógica que NÃO é sobre a mecânica de marcar (qualificação antes de oferecer,
"explique o porquê antes do horário", oferecer-sem-pedir-licença, insistência única com
urgência, fechamento com `PORTA_ABERTA_SENTINEL`/`PERDIDO_SENTINEL`, o tom pra não soar como
cobrador). `REAGENDAR_SENTINEL`/`DESMARCAR_SENTINEL` (pra quem JÁ tem reunião e quer mexer)
ficam **INTOCADOS** nesta tarefa — fora de escopo, investigar depois.

- [ ] **Step 1: Ler o bloco de prompt real por inteiro antes de editar**

`ssh root@100.85.48.50 "sed -n '150,260p' /root/wacrm/src/lib/ai/defaults.ts"` — o bloco inteiro
que hoje instrui "VOCÊ MARCA A REUNIÃO... [[AGENDAR:N]]...". Ler linha por linha — é prompt
tunado com bastante nuance de negócio, não só mecânica.

- [ ] **Step 2: Trocar o marcador e a instrução de mecânica, preservando tudo o resto**

Trocar a constante (perto do topo do arquivo, junto das outras `_SENTINEL`):
```typescript
/**
 * Marcador de AGENDAMENTO: `[[AGENDAR]]` — o lead topou marcar e já está
 * qualificado. NÃO reserva nada sozinha: entrega o bastão pro Fluxo de
 * Agendamento, que mostra os horários de verdade (lista interativa do
 * WhatsApp) e reserva. Sem número — o Fluxo escolhe/mostra os horários,
 * a Márcia só sinaliza "hora de agendar".
 */
export const AGENDAR_SENTINEL = '[[AGENDAR]]'
```
(substitui `AGENDAR_SENTINEL_RE` — o parsing muda de regex-com-captura pra `includes`, igual
aos outros marcadores booleanos como `URGENTE_SENTINEL`).

No bloco de instrução (dentro do `if (mode === 'auto_reply' && agendaAtiva) { parts.push(...)
}`), trocar SÓ a parte que descreve a mecânica de oferecer/marcar — o trecho aproximado (adaptar
ao texto real lido no Step 1, mantendo a numeração/estrutura dos itens 1-5 que já existe pra
qualificação/tom/fechamento):

Onde hoje diz (aproximadamente):
> "VOCÊ MARCA A REUNIÃO... você mesma reserva: escreva a confirmação e termine a resposta com o
> marcador [[AGENDAR:N]], onde N é o NÚMERO do horário..."

Trocar por:
> "VOCÊ NÃO RESERVA NADA SOZINHA — quando decidir que é hora de mostrar horário pro lead
> (depois de explicar o porquê, como o item 1 abaixo já manda), escreva uma frase de transição
> curta ("perfeito, já vou te mostrar os horários disponíveis") e termine a resposta com o
> marcador [[AGENDAR]] — sem número, sozinho. O sistema mostra os horários de verdade logo em
> seguida, como lista. O cliente NUNCA vê o marcador.
> - ⛔⛔ NUNCA diga que agendou, que está confirmado, ou liste horários numerados você mesma —
> isso agora é sempre o sistema que faz, depois do seu [[AGENDAR]]. Sua única frase é a
> transição.
> - ⛔ Só use [[AGENDAR]] depois de ter QUALIFICADO (mesma regra de sempre — ver item abaixo)."

Manter, sem alterar: a numeração 1-5 (explicar o porquê / oferecer sem pedir licença /
insistência única / fechamento com PORTA_ABERTA / fechamento com PERDIDO), o parágrafo de tom,
a linha sobre "Só ofereça horário depois de QUALIFICADO", a interação com
`DESMARCAR_SENTINEL` ("A reunião de quem JÁ tem horário marcado se desfaz com..."). Remover
apenas os trechos que ficaram sem sentido no novo mecanismo: a exigência de PEDIR O E-MAIL antes
de marcar (o Fluxo pede isso agora, no `book_meeting` — ver spec, seção "Sequência de ações —
Agendamento", falha "sem e-mail"), e a linha "a reserva acontece ANTES da sua mensagem sair...
pode confirmar com naturalidade" (não é mais verdade — quem confirma agora é o Fluxo, depois).

⚠️ Se o texto real lido no Step 1 divergir do que está descrito aqui (é natural — foi lido numa
sessão anterior), adapte a transformação preservando a MESMA intenção (só mecânica muda,
qualificação/tom/fechamento ficam) e documente no relatório o que precisou ajustar.

- [ ] **Step 3: Restringir por segmento (rollout faseado — só PF nesta fase)**

Achar onde o prompt/código já sabe diferenciar PF/PJ (mesmo critério que `SUPER_SENTINEL` já
usa — buscar `pessoa jurídica`/`PJ` no arquivo:
`ssh root@100.85.48.50 "grep -n 'pessoa jurídica\|PJ\b' /root/wacrm/src/lib/ai/defaults.ts"`).
Adicionar uma linha de instrução no MESMO bloco do Step 2, explicando a restrição temporária:
> "⛔ [[AGENDAR]] só vale pra pessoa FÍSICA (PF) nesta fase — se o lead for pessoa jurídica
> (PJ), a mecânica de agendamento direto por você continua sendo a de sempre (não aplicável
> agora — ainda não removida) até esta restrição ser levantada numa fase futura."

⚠️ Esta linha é temporária por natureza — comentar no código, perto da constante ou do bloco de
prompt, que ela existe só pro rollout faseado (ver spec) e deve ser removida quando PJ for
estendido.

- [ ] **Step 4: `generate.ts` — trocar o parsing**

Ler o parsing real primeiro:
`ssh root@100.85.48.50 "sed -n '70,115p' /root/wacrm/src/lib/ai/generate.ts"`

Hoje `agendar` é `number | null` (`mAgendar ? Number(mAgendar[1]) : null`, usando
`AGENDAR_SENTINEL_RE`). Trocar pro padrão booleano que `urgente`/`desmarcar`/`portaAberta` já
usam:
```typescript
const agendar = raw.includes(AGENDAR_SENTINEL)
```
e a limpeza do marcador do texto final (`.replace(new RegExp(AGENDAR_SENTINEL_RE.source,
'gi'), '')`) vira `.replaceAll(AGENDAR_SENTINEL, '')` — mesmo padrão de replace simples que
`URGENTE_SENTINEL` já usa nesse arquivo. Atualizar o tipo de retorno de `generateReply`
(`GenerateResult` em `types.ts`) — `agendar: number | null` vira `agendar: boolean`.

- [ ] **Step 5: `auto-reply.ts` — trocar o efeito**

Ler o bloco real (Fase 2, "AGENDAMENTO") por inteiro antes de editar:
`ssh root@100.85.48.50 "sed -n '1150,1210p' /root/wacrm/src/lib/ai/auto-reply.ts"`

Trocar SÓ o trecho `if (agendar !== null) { ... reservarHorario(...) ... }` — o que vem ANTES
dele nesse mesmo bloco (o `if ((desmarcar || moveFinal === 'perdido') && hasMeeting) {
await desfazerReuniao(db, contactId) }`) fica **intocado**, é fora de escopo desta tarefa.

Novo trecho, substituindo o `if (agendar !== null) { ... }`:
```typescript
      if (agendar) {
        const { count: qualificado } = await db
          .from('contact_tags')
          .select('id', { count: 'exact', head: true })
          .eq('contact_id', contactId)
          .in('tag_id', [AI_TAG_QUALIFICADO, AI_TAG_SUPER])
        if (!qualificado) {
          console.warn(
            `[ai auto-reply] [[AGENDAR]] ignorado: contato ${contactId} ainda não está qualificado`,
          )
        } else if (segmentoPJ) {
          console.log(
            `[ai auto-reply] [[AGENDAR]] ignorado: contato ${contactId} é PJ, fora do rollout faseado`,
          )
        } else {
          const r = await startManualFlowRun(db, FLUXO_AGENDAMENTO_ID, {
            accountId,
            contactId,
            conversationId,
          })
          reservaFeita = r.outcome === 'started'
        }
      }
```

⚠️ Vários pontos que dependem do estado REAL do arquivo, confirmar antes de colar:
- Nome exato da constante de tag "Qualificado" (`AI_TAG_QUALIFICADO` é um palpite — buscar
  `ssh root@100.85.48.50 "grep -n 'AI_TAG_QUALIFICADO\|AI_TAG_SUPER' /root/wacrm/src/lib/ai/auto-reply.ts"`
  pra achar o nome/valor reais).
- Como o código já sabe se o lead é PJ (`segmentoPJ` é um placeholder — achar a variável real,
  provavelmente perto de onde `SUPER_SENTINEL` decide PJ×valor no parsing do move).
- `FLUXO_AGENDAMENTO_ID`: **não existe ainda** — o Fluxo real só é criado no plano futuro
  (montagem do grafo). Declare como uma constante com o `id` vazio e um comentário `// TODO:
  preencher com o id real depois que o plano de montagem do grafo rodar (ver spec)` — e um
  teste que cubra o caminho SEM exigir que a constante aponte pra um Fluxo real (mock de
  `startManualFlowRun`, não integração de ponta a ponta — essa só é possível depois do próximo
  plano).
- Onde a variável `r` do código antigo (`reservarHorario`) era referenciada MAIS ABAIXO no
  arquivo (`r.reagendar`, `r.ok`, linhas ~1195-1210 na leitura de hoje) — como o novo trecho
  não produz mais um `r` no mesmo formato, essas referências precisam ser ajustadas ou
  removidas, olhando o código real pra decidir caso a caso (não adivinhar aqui — ler o restante
  da função antes de decidir).

- [ ] **Step 6: Testes**

Atualizar os testes existentes de `generate.test.ts`/`auto-reply.test.ts` que cobrem
`[[AGENDAR:N]]` pro novo formato `[[AGENDAR]]` (parsing booleano, sem número). Casos mínimos
novos em `auto-reply.test.ts`: (1) `[[AGENDAR]]` + contato SEM tag qualificado → não chama
`startManualFlowRun`, loga o aviso; (2) `[[AGENDAR]]` + qualificado + PF → chama
`startManualFlowRun` com os args certos; (3) `[[AGENDAR]]` + qualificado + PJ → não chama,
loga o aviso de rollout faseado; (4) resposta sem `[[AGENDAR]]` → nada disso executa (caminho
já coberto pelos testes existentes, confirmar que continua passando).

- [ ] **Step 7: Rodar os testes**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/ai/generate.test.ts src/lib/ai/auto-reply.test.ts"`

- [ ] **Step 8: Checar tipos**

`ssh root@100.85.48.50 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i 'ai/'"` — sem erro novo.

- [ ] **Step 9: Commit**

```bash
git add src/lib/ai/defaults.ts src/lib/ai/generate.ts src/lib/ai/auto-reply.ts src/lib/ai/generate.test.ts src/lib/ai/auto-reply.test.ts src/lib/ai/types.ts
git commit -m "feat(ai): [[AGENDAR]] entrega o bastao pro Fluxo em vez de reservar direto (PF, rollout faseado)"
```

⚠️ **Nota pro relatório desta task**: como `FLUXO_AGENDAMENTO_ID` fica vazio até o plano de
montagem do grafo rodar, o `[[AGENDAR]]` vai silenciosamente não fazer nada de útil (o
`startManualFlowRun` vai retornar `no_match`, "flow not found") até lá — isso é esperado e
seguro (não quebra nada, só não tem efeito ainda), mas o relatório deve deixar isso claro pro
titular não achar que já está funcionando de ponta a ponta.

---

### Task 5: Márcia — pergunta de urgência proativa no checklist de qualificação

**Files:**
- Modify: `src/lib/ai/defaults.ts`

**Interfaces:**
- Consumes: `URGENTE_SENTINEL` (já existe).
- Produces: nada consumido por outra task — reforça a detecção que a Task 3 já consome.

- [ ] **Step 1: Ler o bloco de qualificação real (onde a IA pergunta área/valor) antes de
  editar**

`ssh root@100.85.48.50 "grep -n 'qualific' -i /root/wacrm/src/lib/ai/defaults.ts | head -20"` —
achar o bloco que instrui a sequência de perguntas de qualificação (área do problema, valor da
dívida) pra saber onde encaixar a pergunta de urgência como mais um item do checklist.

- [ ] **Step 2: Adicionar a instrução**

Perto do comentário já existente sobre `URGENTE_SENTINEL` (topo do arquivo, onde a constante é
declarada) ou no bloco de qualificação (o Step 1 vai revelar qual encaixa melhor conforme a
estrutura real) — adicionar uma linha instruindo a pergunta proativa, não só detecção passiva:

> "Além de área e valor, pergunte TAMBÉM, como parte natural da qualificação (não como
> interrogatório à parte): existe alguma urgência no caso dela — conta bloqueada, processo já
> em andamento, prazo correndo, já foi citada? Se ela confirmar qualquer uma dessas, feche a
> resposta com ${URGENTE_SENTINEL} (pode vir junto de QUALIFICADO/SUPER, nunca sozinho sem
> eles). Não pergunte isso como um formulário — encaixe na conversa."

⚠️ O texto exato e o ponto de encaixe dependem da estrutura real do bloco de qualificação lida
no Step 1 — adaptar mantendo a voz e a estrutura do resto do prompt (não reescrever o bloco
inteiro, só inserir este item).

- [ ] **Step 3: Não precisa de teste automatizado novo**

Isto é uma mudança de TEXTO de prompt, não de lógica de parsing (o parsing de `URGENTE_SENTINEL`
já está testado desde a Frente C, hoje mais cedo, e não muda aqui). Verificação é `tsc`
(garante que a string concatena sem erro de sintaxe) + leitura humana do prompt final.

- [ ] **Step 4: Checar tipos**

`ssh root@100.85.48.50 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i 'ai/'"` — sem erro novo.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/defaults.ts
git commit -m "feat(ai): pergunta de urgencia proativa no checklist de qualificacao"
```

---

### Task 6: Etapa "Reunião Agendada 2" + 2 automações novas (tag → move_deal)

**Files:**
- Create: script local temporário (scratchpad, NÃO commitado — é ferramenta de uma vez, roda e
  descarta, mesmo padrão da tag "Urgente" criada hoje mais cedo).

**Interfaces:**
- Consumes: `pipeline_stages` (tabela existente, sem migração de schema — INSERT puro), tabela
  `automations`/`automation_steps` (schema existente).
- Produces: `stage_id` da etapa nova e os dois `automation_id` novos — precisados pelo plano
  futuro de montagem do grafo (as tags "Agendou"/[tag de cancelamento] precisam bater com os
  `tag_id` que essas automações escutam).

- [ ] **Step 1: Ler os dados reais antes de criar — não adivinhar ids**

Rodar (dentro de `/root/wacrm`, script Node temporário com o service-role client — mesmo padrão
já usado hoje pra consultar `pipeline_stages`/`automations`):
```javascript
const { data: stages } = await db.from('pipeline_stages')
  .select('id, name, position, pipeline_id')
  .eq('pipeline_id', '8e89e154-763c-4cf8-b73b-42f7368c59c3') // funil de vendas, confirmar
  .order('position')
console.log(stages)
```
Confirmar: (a) o `pipeline_id` do funil de vendas ainda é `8e89e154-...` (b) a posição da etapa
"Reunião Agendada" existente (pra decidir a posição da etapa nova — logo depois dela faz
sentido) (c) que não existe JÁ uma etapa chamada "Reunião Agendada 2" (evitar duplicata se
outra sessão já criou).

- [ ] **Step 2: Criar a etapa nova**

```javascript
const { data: novaEtapa, error } = await db.from('pipeline_stages')
  .insert({
    pipeline_id: '8e89e154-763c-4cf8-b73b-42f7368c59c3',
    name: 'Reunião Agendada 2',
    position: /* posição real, confirmada no Step 1 — logo depois de "Reunião Agendada" */,
  })
  .select('id')
  .single()
console.log('nova etapa id:', novaEtapa?.id, error?.message)
```

⚠️ Conferir se `pipeline_stages` tem alguma constraint de posição única por pipeline (evitar
colisão) — se tiver, ajustar a posição das etapas seguintes ou usar uma posição fracionária se
a coluna permitir, olhando o schema real (`\d pipeline_stages` equivalente via
`information_schema` ou a migração original da tabela).

- [ ] **Step 3: Criar as duas automações novas**

Usar a MESMA estrutura de `automations`/`automation_steps` já usada pelas automações reais
lidas hoje (`Superqualificado — primeiro toque` como referência de trigger `tag_added`, e o
passo `move_deal` já visto na automação FUP como referência de step). Precisa dos `tag_id`
reais das tags "Agendou" e da tag nova de cancelamento — **estas tags ainda não existem**,
criar primeiro (mesmo padrão da tag "Urgente" de hoje: `db.from('tags').insert({name: 'Agendou',
account_id: ...})`, um script de uma vez, sem duplicar se já existir).

```javascript
// 1) Tags (criar se não existirem — checar antes, mesmo padrão de hoje pra "Urgente")
// tag "Agendou" e tag "Perdeu Confirmação" (nomes exatos a confirmar com o titular se
// divergirem do spec)

// 2) Automação: tag_added "Agendou" -> move_deal "Reunião Agendada 2"
const { data: autoAgendou } = await db.from('automations').insert({
  account_id: /* mesma conta das outras automações reais */,
  name: 'Agendou (Fluxo) — move para Reunião Agendada 2',
  trigger_type: 'tag_added',
  trigger_config: { tag_id: /* id da tag Agendou */ },
}).select('id').single()
await db.from('automation_steps').insert({
  automation_id: autoAgendou.id,
  step_type: 'move_deal',
  step_config: {
    pipeline_id: '8e89e154-763c-4cf8-b73b-42f7368c59c3',
    stage_id: /* id da etapa nova, do Step 2 */,
  },
  position: 0,
})

// 3) Automação: tag_added "Perdeu Confirmação" -> move_deal "FUP - Reativar Lead"
const { data: autoCancelou } = await db.from('automations').insert({
  account_id: /* mesma conta */,
  name: 'Perdeu Confirmação (Fluxo) — move para FUP',
  trigger_type: 'tag_added',
  trigger_config: { tag_id: /* id da tag nova de cancelamento */ },
}).select('id').single()
await db.from('automation_steps').insert({
  automation_id: autoCancelou.id,
  step_type: 'move_deal',
  step_config: {
    pipeline_id: '8e89e154-763c-4cf8-b73b-42f7368c59c3',
    stage_id: '8bd228cf-fba4-4b28-b704-068bdcfa7c8d', // FUP - Reativar Lead, já existe
  },
  position: 0,
})
```

⚠️ Ler o shape REAL de `automations`/`automation_steps` (colunas obrigatórias, valores default)
antes de colar — o exemplo acima é baseado na leitura de hoje mais cedo, mas confirme contra o
schema (`supabase/migrations/006_automations.sql` ou equivalente) antes de rodar.

- [ ] **Step 4: Verificar**

Rodar uma consulta lendo de volta as duas automações + a etapa criadas, confirmando que os
`stage_id`/`tag_id` referenciados batem com o esperado — sem teste automatizado (é dado, não
código), a verificação é a releitura + o titular confirmando visualmente na tela de Automações
do CRM depois.

- [ ] **Step 5: Reportar os ids pro titular e pro plano futuro**

Anotar no relatório desta task: o `id` da etapa "Reunião Agendada 2", o `id` das duas tags
novas, e o `id` das duas automações — o plano de montagem do grafo (próximo, separado) vai
precisar da tag "Agendou" e da tag de cancelamento pra configurar os nós `set_tag` do Fluxo.

---

### Task 7: Deploy e verificação

- [ ] **Step 1: Build final**

`ssh root@100.85.48.50 "cd /root/wacrm && npm run build > /tmp/build.log 2>&1; echo EXIT_CODE=\$?; tail -20 /tmp/build.log"`
— `EXIT_CODE=0`.

- [ ] **Step 2: Suíte inteira**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run 2>&1 | tail -20"` — baseline antes
desta fase: conferir o número real no início da execução (deve estar perto de 857, ver ledger
da fase anterior); 2 falhas pré-existentes em `date-utils.test.ts`, sem relação, continuam.

- [ ] **Step 3: Restart**

`ssh root@100.85.48.50 "pm2 restart wacrm"`

- [ ] **Step 4: Confirmar estabilidade**

`ssh root@100.85.48.50 "pm2 list"` (depois de ~3s) — `wacrm` online, mesmo padrão de PID
estável, sem restart extra.

- [ ] **Step 5: git status limpo**

`ssh root@100.85.48.50 "cd /root/wacrm && git status --short"` — só os arquivos desta fase
staged/commitados; o resto (mudanças de trabalho anterior na sessão) continua como estava,
intocado.

- [ ] **Step 6: Confirmar com o titular a aplicação da migração `043`**

Igual às migrações `041`/`042` de hoje — dar o SQL exato (Task 3) e pedir pra rodar no SQL
Editor do Supabase Dashboard. Confirmar de volta com uma query de verificação (mesmo padrão de
`SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE...` usado nas migrações
anteriores, adaptado pra `notifications_type_check`).

## Fora de escopo deste plano

- **A montagem do grafo em si** (as tarefas de criar os `flows`/`flow_nodes` do Fluxo de
  Agendamento, do Fluxo pós-reserva, e do Fluxo No-show) — plano futuro separado, só começa
  depois deste estar completo e no ar (precisa de `startManualFlowRun`, `keyword_match`, a
  etapa+tags novas, todos prontos primeiro).
- **`intake.js`** (Canal B, Cal.com direto) — plano futuro, sequenciado por ÚLTIMO, depois do
  Canal A (Márcia) estar validado em produção (ver spec, seção "Rollout faseado" e "riscos").
- **Extensão pra PJ** — quando o rollout faseado avançar, remove a restrição adicionada na
  Task 4 Step 3. Decisão do titular, não deste plano.
- **`REAGENDAR_SENTINEL`/`DESMARCAR_SENTINEL`** — investigação de como interagem com o Fluxo
  novo fica pra depois, registrada como risco aberto no spec.
