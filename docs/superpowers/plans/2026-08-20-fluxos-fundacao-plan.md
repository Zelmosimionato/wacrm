# Fluxos — Fundação (nó `wait` + interrupção por palavra-chave) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao motor de Fluxos (`src/lib/flows/`) duas capacidades que faltam pra rodar o
Fluxo de Agendamento (Frente D, spec já escrito): um nó `wait` que suspende até um horário
futuro e retoma sozinho, e um jeito de reconhecer palavra-chave em texto livre enquanto o fluxo
está parado esperando — hoje só clique de botão acorda um fluxo suspenso.

**Architecture:** Extensão do motor de Fluxos que já existe (`src/lib/flows/engine.ts`, 1117
linhas, nunca usado em produção) — nenhum sistema paralelo. O `wait` segue o MESMO padrão de
fila+cron que a Automação já usa (`automation_pending_executions` + `/api/automations/cron`),
só que numa tabela própria (`flow_pending_resumes`) porque o alvo da retomada é diferente
(`current_node_key`, string, num grafo — não `next_step_position`, número, numa lista linear).
A palavra-chave reaproveita `matchesKeywordTrigger`, função pura que **já existe** no motor de
Fluxos (hoje só usada pra decidir se um fluxo COMEÇA — vamos usar a mesma função pra decidir se
um fluxo PARADO deve pular pra outro ramo).

**Tech Stack:** TypeScript, Next.js (wacrm), Supabase (Postgres), Vitest.

## Global Constraints

- Nenhuma infraestrutura nova fora do CRM. Tudo em `src/lib/flows/*` ou `src/app/api/flows/*`.
- O repositório só existe na VPS (`root@100.85.48.50`, `/root/wacrm`) — sem clone local, sem
  worktree. Editar arquivo local (scratchpad) → `ssh ... "cat > <path>" < <local>` → testar via
  `ssh ... "cd /root/wacrm && npx vitest run <arquivo>"`.
- ⛔ **Antes de commitar, sempre `git status --short` e conferir que só os arquivos DESTA
  tarefa estão staged** — o repositório tem outras mudanças não commitadas de trabalho anterior
  (deixar como está); `git commit` sem `--` commita tudo que estiver staged, não só o que você
  acabou de `git add`.
- `flow_pending_resumes` não substitui nem reaproveita `automation_pending_executions` — são
  motores diferentes (automações resolvem por posição numérica numa lista; fluxos resolvem por
  chave de nó num grafo). Tabela nova, pequena, no mesmo espírito.
- Autenticação dos novos endpoints de cron: MESMO padrão do `/api/flows/cron` que já existe —
  header `x-cron-secret`, comparado com `timingSafeEqual` contra `AUTOMATION_CRON_SECRET`
  (variável já existe, compartilhada com o cron de automações).

---

### Task 1: Tipos — `WaitNodeConfig`

**Files:**
- Modify: `src/lib/flows/types.ts` (adicionar `WaitNodeConfig`, adicionar `"wait"` à união
  `FlowNodeConfig`, adicionar `"wait"` à união `FlowNodeType` — ambas ficam perto de
  `CollectInputNodeConfig`/`"collect_input"`, seguindo a ordem já usada no arquivo)
- Test: `src/lib/flows/types.test.ts` — se não existir, não criar um vazio só pra isto; tipos
  puros não pedem teste próprio no padrão deste arquivo (confirmar isso é verdade rodando
  `find src/lib/flows -iname 'types.test.ts'` antes de assumir).

**Interfaces:**
- Consumes: `KeywordTriggerConfig` (já existe em `types.ts`, mesma interface usada pelo
  trigger `keyword` — `{ keywords: string[]; match_type?: 'exact' | 'contains';
  case_sensitive?: boolean }`).
- Produces: `WaitNodeConfig` — consumida pelas Tasks 3 e 4.

- [ ] **Step 1: Ler o bloco de tipos de nó inteiro antes de editar**

`ssh root@100.85.48.50 "sed -n '90,200p' /root/wacrm/src/lib/flows/types.ts"` — ver exatamente
onde `CollectInputNodeConfig` e a união `FlowNodeConfig` (linha ~188-197) estão, pra inserir no
mesmo estilo (mesmo formato de comentário, mesma ordem de campos opcionais por último).

- [ ] **Step 2: Adicionar `WaitNodeConfig`**

Logo depois de `CollectInputNodeConfig` (antes do comentário `/** Total union... */` que
antecede `FlowNodeConfig`), inserir:

```typescript
export interface WaitNodeConfig {
  /** Duração da espera a partir do momento em que o fluxo entra neste nó. */
  unit: "minutes" | "hours" | "days";
  amount: number;
  /** Nó de destino quando o tempo esgota SEM interrupção por palavra-chave. */
  next_node_key: string;
  /**
   * Ramos de interrupção: se o cliente escrever algo enquanto o fluxo espera
   * aqui, e o texto casar com uma destas listas de palavras-chave, o fluxo
   * pula pra `next_node_key` do ramo — sem esperar o tempo todo. Reaproveita
   * o mesmo casador que já decide se um fluxo COMEÇA por palavra-chave
   * (`matchesKeywordTrigger`), só que aplicado a um fluxo já em andamento.
   */
  keyword_branches?: {
    trigger: KeywordTriggerConfig;
    next_node_key: string;
  }[];
}
```

- [ ] **Step 3: Adicionar `"wait"` às duas uniões**

Na união `FlowNodeConfig` (o bloco `| { node_type: "collect_input"; config: ... }` etc.),
acrescentar uma linha na MESMA posição relativa (perto de `collect_input`, antes de
`condition`):

```typescript
  | { node_type: "wait"; config: WaitNodeConfig }
```

E confirmar que `FlowNodeType` (derivado de `FlowNodeConfig["node_type"]` — conferir se é
literalmente `export type FlowNodeType = FlowNodeConfig["node_type"];`, já visto hoje) não
precisa de edição própria — se for derivado assim, `"wait"` já entra sozinho.

- [ ] **Step 4: Rodar o build de tipos**

`ssh root@100.85.48.50 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i flow"` — não deve
aparecer nenhum erro novo relacionado a `flows/` (o `wait` ainda não é tratado em lugar nenhum
do motor — isso é esperado e normal nesta task; as Tasks 3/4 é que fecham os `switch`/`if`
exaustivos que porventura reclamarem de um `node_type` não tratado).

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/types.ts
git commit -m "feat(flows): tipo WaitNodeConfig - nao do motor de fluxos ainda"
```

---

### Task 2: Tabela `flow_pending_resumes`

**Files:**
- Create: `supabase/migrations/<PRÓXIMO_NÚMERO>_flow_pending_resumes.sql` (achar o próximo
  número olhando `ls supabase/migrations/ | sort | tail -5` na VPS antes de nomear o arquivo —
  não adivinhar o número).

**Interfaces:**
- Produces: tabela `flow_pending_resumes` — consumida pelas Tasks 3 (grava) e 5 (lê/apaga).

- [ ] **Step 1: Ver o formato das migrations existentes**

`ssh root@100.85.48.50 "ls /root/wacrm/supabase/migrations/ | sort | tail -5 && cat /root/wacrm/supabase/migrations/017_*.sql 2>/dev/null | head -40"`
— confirmar convenção (tem RLS? tem índice? qual o padrão de nome de coluna `account_id` vs
tenancy) antes de escrever a nova migration do zero.

- [ ] **Step 2: Escrever a migration**

Conteúdo (ajustar RLS/índices pro padrão real visto no Step 1 se divergir do que segue):

```sql
-- ============================================================
-- flow_pending_resumes — fila de retomada por tempo pro motor de Fluxos.
--
-- Espelha o papel de automation_pending_executions, mas pro motor de
-- Fluxos: o alvo da retomada é current_node_key (string, num grafo),
-- não next_step_position (número, numa lista linear) — por isso é
-- tabela própria, não reaproveitamento.
-- ============================================================

CREATE TABLE flow_pending_resumes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  node_key TEXT NOT NULL,
  run_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'cancelled', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_flow_pending_resumes_due
  ON flow_pending_resumes (run_at)
  WHERE status = 'pending';

CREATE INDEX idx_flow_pending_resumes_run
  ON flow_pending_resumes (flow_run_id);

ALTER TABLE flow_pending_resumes ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE policy for authenticated users — all
-- access is server-side via the service-role key (same convention as
-- automation_pending_executions, migration 006).
```
**✅ Já aplicado (20/08/2026) em `041_flow_pending_resumes.sql`, exatamente como acima —
RLS conferido contra o padrão real de `automation_pending_executions` antes de rodar.**

- [ ] **Step 3: Aplicar a migration — ⚠️ NÃO delegar a um subagente só com SSH**

Confirmado nesta sessão: o projeto não tem CLI do Supabase instalado na VPS
(`which supabase` vazio), não tem `supabase/config.toml`, e não existe string de conexão
direta com o Postgres em `.env.local` (só a URL REST + a chave de serviço, que não executam
DDL). As migrations anteriores (até `040_notificacao_aguardando_resposta.sql`) só existem como
arquivo `.sql` versionado — a aplicação de verdade é manual, colando o SQL no **SQL Editor do
painel do Supabase**, no navegador.

**Isto é tarefa do controller (Claude, via `mcp__Claude_Browser__*`) ou do titular — nunca de
um subagente implementador que só tem acesso a SSH/Bash.** Se você é o subagente implementador
desta task: pare aqui, reporte `NEEDS_CONTEXT` pedindo que o controller aplique a migration, e
não tente contornar isso com uma conexão Postgres improvisada ou uma chave nova.

Se você é o controller: abra o painel do Supabase (`mcp__Claude_Browser__navigate` pra
`https://supabase.com/dashboard/project/<project-ref>/sql/new` — o `project-ref` está no
`NEXT_PUBLIC_SUPABASE_URL` do `.env.local`, formato `https://<project-ref>.supabase.co`), cole
o conteúdo do arquivo de migration, rode, confirme "Success" na resposta antes de seguir pro
Step 4.

- [ ] **Step 4: Confirmar que a tabela existe**

Script Node (mesmo padrão usado o dia inteiro nesta sessão pra conferir tabelas):
```bash
ssh root@100.85.48.50 'cat > /root/wacrm/_check_table.mjs <<'"'"'EOF'"'"'
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = Object.fromEntries(fs.readFileSync("/root/wacrm/.env.local","utf8").split("\n").filter(l=>l.includes("=")).map(l=>{const i=l.indexOf("="); return [l.slice(0,i), l.slice(i+1)];}));
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const r = await supa.from("flow_pending_resumes").select("*").limit(1);
console.log("err:", r.error?.message, "| ok:", !r.error);
EOF
node /root/wacrm/_check_table.mjs
rm -f /root/wacrm/_check_table.mjs'
```
Expected: `err: undefined | ok: true`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/<arquivo_novo>.sql
git commit -m "feat(flows): tabela flow_pending_resumes - fila de retomada do no wait"
```

---

### Task 3: Motor — entrar no nó `wait`

**Files:**
- Modify: `src/lib/flows/engine.ts`

**Interfaces:**
- Consumes: `WaitNodeConfig` (Task 1), tabela `flow_pending_resumes` (Task 2).
- Produces: nenhuma função nova exportada — só um novo `if` dentro de `advanceFromNodeKey`
  (função interna, não exportada) e a classificação em `isSuspending`.

- [ ] **Step 1: Ler `advanceFromNodeKey` inteira e `isSuspending` antes de editar**

`ssh root@100.85.48.50 "sed -n '547,830p' /root/wacrm/src/lib/flows/engine.ts"` — confirmar que
o padrão abaixo (baseado no que já foi lido nesta sessão) ainda bate linha a linha antes de
inserir; se o arquivo mudou desde então, seguir o padrão real, não este texto.

- [ ] **Step 2: Adicionar `"wait"` a `isSuspending`**

Em `isSuspending` (perto do topo do arquivo, junto de `isAutoAdvancing`/`isTerminal`):

```typescript
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input" ||
    node_type === "wait"
  );
}
```

- [ ] **Step 3: Adicionar o `waitMs` helper**

Perto de `matchesKeywordTrigger` (bloco de "Pure helpers"), acrescentar:

```typescript
/** Converte a config do nó `wait` em milissegundos. */
export function waitMs(cfg: { unit: "minutes" | "hours" | "days"; amount: number }): number {
  const unitMs =
    cfg.unit === "days" ? 86_400_000 : cfg.unit === "hours" ? 3_600_000 : 60_000;
  return Math.max(1_000, cfg.amount * unitMs);
}
```

- [ ] **Step 4: Adicionar o case `wait` em `advanceFromNodeKey`**

Dentro do loop de `advanceFromNodeKey`, logo depois do bloco `if (node.node_type === "collect_input") { ... }`
(que termina com `return { outcome: "advanced" };`) e antes de `if (node.node_type === "condition")`,
inserir:

```typescript
    if (node.node_type === "wait") {
      const cfg = node.config as unknown as WaitNodeConfig;
      const runAt = new Date(Date.now() + waitMs(cfg));
      const { error: schedErr } = await db.from("flow_pending_resumes").insert({
        flow_run_id: run.id,
        account_id: run.account_id,
        node_key: node.node_key,
        run_at: runAt.toISOString(),
        status: "pending",
      });
      if (schedErr) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "wait_schedule_failed",
          detail: schedErr.message,
        });
        await endRun(db, run.id, "failed", "wait_schedule_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
```

Não esquecer de importar `WaitNodeConfig` no topo do arquivo, junto dos outros imports de
`./types`.

- [ ] **Step 5: Escrever o teste**

Ver como `engine.test.ts` testa hoje as funções puras já exportadas (`matchReplyId`,
`isAutoAdvancing` etc. — `sed -n '1,50p' src/lib/flows/engine.test.ts` pra ver o padrão de
mock/setup usado) antes de escrever. No mínimo, cobrir `waitMs` (pura, fácil) e `isSuspending`
com `"wait"`:

```typescript
describe("waitMs", () => {
  it("converte minutos/horas/dias pra ms, com piso de 1s", () => {
    expect(waitMs({ unit: "minutes", amount: 3 })).toBe(180_000);
    expect(waitMs({ unit: "hours", amount: 1 })).toBe(3_600_000);
    expect(waitMs({ unit: "days", amount: 1 })).toBe(86_400_000);
    expect(waitMs({ unit: "minutes", amount: 0 })).toBe(1_000);
  });
});

describe("isSuspending — wait", () => {
  it('trata "wait" como nó suspensivo', () => {
    expect(isSuspending("wait")).toBe(true);
  });
});
```

O `advanceFromNodeKey` em si é função interna (não exportada) que já não tem teste unitário
direto no arquivo atual (confirmar isso lendo o arquivo inteiro antes de assumir) — se não
tiver, seguir o mesmo padrão: sem teste de integração pra este case específico agora, coberto
por build limpo + `waitMs`/`isSuspending` testados isoladamente. Se HOUVER teste de integração
para os outros cases (`send_buttons`, `collect_input`), então este PRECISA ter um também, no
mesmo formato — ler o arquivo primeiro decide isso, não adivinhar.

- [ ] **Step 6: Rodar os testes**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts"`

- [ ] **Step 7: Commit**

```bash
git add src/lib/flows/engine.ts src/lib/flows/engine.test.ts
git commit -m "feat(flows): no wait suspende e agenda retomada em flow_pending_resumes"
```

---

### Task 4: Motor — interrupção por palavra-chave num nó `wait`

**Files:**
- Modify: `src/lib/flows/engine.ts` (dentro de `handleReplyForActiveRun`)

**Interfaces:**
- Consumes: `matchesKeywordTrigger` (já existe, não muda), `WaitNodeConfig.keyword_branches`
  (Task 1), tabela `flow_pending_resumes` (Task 2/3).

- [ ] **Step 1: Reler `handleReplyForActiveRun` inteira**

`ssh root@100.85.48.50 "sed -n '884,1049p' /root/wacrm/src/lib/flows/engine.ts"` — o ponto de
inserção é o bloco `if/else if` que decide `matched` (hoje só trata `interactive_reply` contra
`send_buttons`/`send_list` e `text` contra `collect_input`).

- [ ] **Step 2: Adicionar o ramo de palavra-chave**

Depois do `else if (message.kind === "text" && currentNode.node_type === "collect_input") { ... }`
(que termina antes do `if (matched) { ... }` seguinte), acrescentar mais um `else if`:

```typescript
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "wait"
  ) {
    const cfg = currentNode.config as unknown as WaitNodeConfig;
    for (const branch of cfg.keyword_branches ?? []) {
      if (matchesKeywordTrigger(message.text, branch.trigger)) {
        matched = branch.next_node_key;
        // A espera por tempo não vale mais — o fluxo saiu pelo ramo de
        // palavra-chave antes do prazo. Cancela a retomada agendada pra
        // o poller não tentar avançar um nó que o cliente já pulou.
        await db
          .from("flow_pending_resumes")
          .update({ status: "cancelled" })
          .eq("flow_run_id", run.id)
          .eq("node_key", currentNode.node_key)
          .eq("status", "pending");
        break;
      }
    }
  }
```

⚠️ Ponto de atenção pro implementador: este bloco entra como mais um `else if` na cadeia
JÁ EXISTENTE — não duplicar o `if` inicial nem mudar a estrutura dos ramos anteriores. Ler a
sintaxe exata (chaves, indentação) da cadeia atual antes de encaixar, pra não quebrar o
`if (matched) { ... }` que vem logo depois.

- [ ] **Step 3: Escrever o teste**

Seguir o padrão de teste já usado pra `matchReplyId`/`collect_input` no arquivo de teste (ler
antes de escrever — provavelmente monta um `run` + `nodes` Map fake e chama a função via mock
de `admin-client`, igual ao padrão hoisted-mock visto em `automations/engine.test.ts` hoje).
Casos mínimos a cobrir:
- Texto que casa com uma palavra-chave de um `keyword_branches` → `matched` vira o
  `next_node_key` daquele ramo.
- Texto que não casa com nenhuma → cai no fallback normal (comportamento inalterado).
- Nó atual não é `wait` → comportamento inalterado (não quebra os ramos de `send_buttons`/
  `collect_input` já existentes).

- [ ] **Step 4: Rodar os testes**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts"`

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/engine.ts src/lib/flows/engine.test.ts
git commit -m "feat(flows): palavra-chave interrompe no wait, cancela retomada agendada"
```

---

### Task 5: Motor — retomada por tempo + rota de cron

**Files:**
- Modify: `src/lib/flows/engine.ts` (nova função exportada `resumeWaitingFlow`)
- Create: `src/app/api/flows/cron-resume/route.ts`

**Interfaces:**
- Consumes: `loadAllNodes`, `advanceFromNodeKey` (internas ao arquivo, reaproveitadas), tabela
  `flow_pending_resumes`.
- Produces: `resumeWaitingFlow(db, pendingId: string): Promise<void>` — chamada pela nova rota.

- [ ] **Step 1: Ler `resumePendingExecution` do motor de AUTOMAÇÕES como referência de forma**

`ssh root@100.85.48.50 "sed -n '218,260p' /root/wacrm/src/lib/automations/engine.ts"` — não é
pra copiar (motores diferentes), é só pra ver o FORMATO esperado (carrega, confere
precondição, executa, marca como feito/falhou) antes de escrever a versão de Fluxos.

- [ ] **Step 2: Escrever `resumeWaitingFlow` em `engine.ts`**

Perto de `dispatchInboundToFlows` (é a outra função pública do arquivo), acrescentar:

```typescript
/**
 * Retoma um fluxo que estava parado num nó `wait` cujo prazo venceu.
 * Chamada pelo poller de `/api/flows/cron-resume`. Confere que o run
 * ainda está ativo E ainda está no MESMO nó que agendou esta retomada
 * — se o cliente já saiu por palavra-chave (Task 4 cancela a linha) ou
 * o run terminou por outro motivo, isto é um no-op seguro.
 */
export async function resumeWaitingFlow(
  db: AdminClient,
  pending: { id: string; flow_run_id: string; node_key: string },
): Promise<void> {
  const { data: run } = await db
    .from("flow_runs")
    .select("*")
    .eq("id", pending.flow_run_id)
    .maybeSingle();
  const runRow = run as FlowRunRow | null;
  if (!runRow || runRow.status !== "active" || runRow.current_node_key !== pending.node_key) {
    return;
  }
  const nodes = await loadAllNodes(db, runRow.flow_id);
  const node = nodes.get(pending.node_key);
  if (!node || node.node_type !== "wait") return;
  const cfg = node.config as unknown as WaitNodeConfig;
  await advanceFromNodeKey(db, runRow, cfg.next_node_key, nodes);
}
```

Conferir se `AdminClient`/`FlowRunRow`/`loadAllNodes`/`advanceFromNodeKey` já estão acessíveis
no escopo do arquivo (devem estar — são todos definidos mais acima no mesmo arquivo).

- [ ] **Step 3: Escrever a rota `/api/flows/cron-resume/route.ts`**

Modelar em `/root/wacrm/src/app/api/flows/cron/route.ts` (ler primeiro — mesmo padrão de auth
com `timingSafeEqual`, mesmo header `x-cron-secret`, mesma variável `AUTOMATION_CRON_SECRET`):

```typescript
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resumeWaitingFlow } from '@/lib/flows/engine'

/**
 * Drena `flow_pending_resumes` vencidos — o poller do nó `wait`.
 * Mesma autenticação e mesmo espírito do `/api/flows/cron` (sweep) e
 * do `/api/automations/cron`: URL própria, secret compartilhado.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('flow_pending_resumes')
    .select('id, flow_run_id, node_key')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('flow_pending_resumes')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      await resumeWaitingFlow(admin, row as { id: string; flow_run_id: string; node_key: string })
      await admin.from('flow_pending_resumes').update({ status: 'done' }).eq('id', row.id)
      processed++
    } catch (err) {
      console.error('[flows-cron-resume] resume failed:', row.id, err)
      await admin.from('flow_pending_resumes').update({ status: 'failed' }).eq('id', row.id)
    }
  }

  return NextResponse.json({ processed })
}
```

Conferir se `src/lib/flows/admin-client.ts` exporta `supabaseAdmin` com essa assinatura exata
(mesmo nome usado em `/api/flows/cron/route.ts`) antes de importar.

- [ ] **Step 4: Build**

`ssh root@100.85.48.50 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i flow"` — sem erro.

- [ ] **Step 5: Rodar a suíte inteira**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run 2>&1 | tail -20"` — baseline esperado
depois das Tasks 1-4: contagem de testes cresce com os novos de `waitMs`/`isSuspending`/
palavra-chave; as 2 falhas de `date-utils.test.ts` continuam, sem relação.

- [ ] **Step 6: Commit**

```bash
git add src/lib/flows/engine.ts src/app/api/flows/cron-resume/route.ts
git commit -m "feat(flows): resumeWaitingFlow + rota de cron pra retomar nos wait vencidos"
```

---

### Task 6: Deploy e ligar os DOIS crons de Fluxos (nenhum está ligado hoje)

**Achado desta sessão, confirmado por `crontab -l | grep -i flow` (vazio):** o cron de
sweep de Fluxos (`/api/flows/cron`, já existe no código, nunca usado) e o novo de retomada
(`/api/flows/cron-resume`, Task 5) **nenhum dos dois está no crontab da VPS.** Sem o sweep,
todo fluxo abandonado trava `idx_one_active_run_per_contact` pra sempre — impede QUALQUER
fluxo novo pra aquele contato. Isto precisa ser ligado agora, senão a Frente D nasce com o
mesmo vazamento que os lembretes duplicados de hoje de manhã tinham.

- [ ] **Step 1: Build final**

`ssh root@100.85.48.50 "cd /root/wacrm && npm run build 2>&1 | tail -40"` — `EXIT_CODE=0`.

- [ ] **Step 2: Restart**

`ssh root@100.85.48.50 "pm2 restart wacrm"`

- [ ] **Step 3: Confirmar estabilidade**

`ssh root@100.85.48.50 "pm2 list"` (depois de ~3s) — `wacrm` online, sem reinício extra.

- [ ] **Step 4: Criar os dois scripts de cron**, no mesmo padrão de
`/root/intake/tempo.sh` (ler esse arquivo primeiro — reaproveitar a exata estrutura):

`/root/intake/flows_cron_sweep.sh`:
```sh
#!/bin/sh
# Varredura de fluxos abandonados. Chamado pelo cron a cada 5 min.
SEG=$(grep '^AUTOMATION_CRON_SECRET=' /root/wacrm/.env.local | cut -d= -f2-)
[ -z "$SEG" ] && { echo "$(date -Is) sem AUTOMATION_CRON_SECRET"; exit 1; }
R=$(curl -s -H "x-cron-secret: $SEG" https://crm.simionatoadvogados.com.br/api/flows/cron)
if ! echo "$R" | grep -q '"swept":0'; then
  echo "$(date -Is) $R"
fi
```

`/root/intake/flows_cron_resume.sh`:
```sh
#!/bin/sh
# Retomada de nos wait vencidos. Chamado pelo cron a cada 5 min.
SEG=$(grep '^AUTOMATION_CRON_SECRET=' /root/wacrm/.env.local | cut -d= -f2-)
[ -z "$SEG" ] && { echo "$(date -Is) sem AUTOMATION_CRON_SECRET"; exit 1; }
R=$(curl -s -H "x-cron-secret: $SEG" https://crm.simionatoadvogados.com.br/api/flows/cron-resume)
if ! echo "$R" | grep -q '"processed":0'; then
  echo "$(date -Is) $R"
fi
```

`ssh root@100.85.48.50 "chmod +x /root/intake/flows_cron_sweep.sh /root/intake/flows_cron_resume.sh"`

- [ ] **Step 5: Adicionar ao crontab**

`ssh root@100.85.48.50 "crontab -l > /tmp/cron_atual.txt; echo '*/5 * * * * /root/intake/flows_cron_sweep.sh >> /root/intake/flows_sweep.log 2>&1' >> /tmp/cron_atual.txt; echo '*/5 * * * * /root/intake/flows_cron_resume.sh >> /root/intake/flows_resume.log 2>&1' >> /tmp/cron_atual.txt; crontab /tmp/cron_atual.txt; rm /tmp/cron_atual.txt; crontab -l | grep flow"`

Expected: as duas linhas novas aparecem.

- [ ] **Step 6: git status limpo**

`ssh root@100.85.48.50 "cd /root/wacrm && git status --short"` — só os arquivos deste plano
modificados/criados (`types.ts`, a migration nova, `engine.ts`, `engine.test.ts`,
`cron-resume/route.ts`) — nada mais.

## Fora de escopo deste plano

- A definição do Fluxo de Agendamento em si (os nós/dados reais — offer_slots, book_meeting,
  cancel_meeting) — esses NÓS ainda não existem no motor; é a PRÓXIMA fase, depois desta.
- Tirar a IA da mecânica de agendamento (`auto-reply.ts`'s `criarReserva` etc.) — só acontece
  quando o Fluxo de Agendamento estiver pronto pra assumir de verdade.
- Interface visual pra montar o nó `wait` no editor de Fluxos (`components/flows/`) — o editor
  já existe mas não é o caminho usado aqui; os nós desta fase são criados via dado direto
  (assim como as automações de hoje foram investigadas via script, não pela tela).
