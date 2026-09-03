# Qualificação por Conteúdo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o marcador `[[SUPER]]` que a IA já usa em produção exigir PJ (não só valor),
igualando a regra que o formulário da Meta já aplica — e dar à IA um marcador novo,
`[[URGENTE]]`, para sinalizar prazo processual/urgência em qualquer canal de entrada.

**Architecture:** Nenhuma infraestrutura nova. O CRM já tem um mecanismo de marcadores de
controle (`[[SUPER]]`, `[[QUALIFICADO]]`, `[[REAGENDAR]]` etc.) que a IA emite no fim da
resposta — o motor (`generate.ts`) já extrai isso do texto e `auto-reply.ts` já aplica tag e
move o card. Este plano SÓ estende esse mecanismo existente: conserta a regra do `[[SUPER]]` e
acrescenta `[[URGENTE]]` no mesmo padrão. Achado importante ao investigar: o caminho do
formulário (`intake.js`) já aplica `PJ && valor>=500k` corretamente — **não precisa mudar**. O
único lugar com a regra errada é o prompt da IA, que hoje testa só o valor.

**Tech Stack:** TypeScript, Next.js (wacrm), Vitest.

## Global Constraints

- Regra de "Superqualificado" em qualquer canal: **PJ E valor ≥ R$500.000** (igual ao
  `intake.js`, `TAG_SUPER = 'b9298582-dcc7-46a3-ae34-f54b3c6fece1'` — mesma tag em ambos).
- Critério de urgência: julgamento da IA sobre o CONTEÚDO (prazo processual, execução em
  andamento, citação recebida, protesto) — não é lista fechada de palavras (é frágil demais
  pra isso, ao contrário de "remarcar", que é intenção simples).
- Todo teste roda com `npx vitest run <arquivo>` a partir de `/root/wacrm` (SSH,
  `root@100.85.48.50`). Deploy: `npm run build` limpo → `pm2 restart wacrm`.
- Editar arquivos localmente (o repositório só existe na VPS) e subir via
  `ssh root@100.85.48.50 "cat > <caminho>" < <arquivo local>` — nunca editar direto na VPS.

---

### Task 1: `[[SUPER]]` passa a exigir PJ, não só valor

**Files:**
- Modify: `src/lib/ai/defaults.ts:114-127` (bloco de instrução dos marcadores de card-move,
  dentro de `buildSystemPrompt`)
- Test: `src/lib/ai/defaults.test.ts` (novo arquivo)

**Interfaces:**
- Consumes: nada de outra tarefa.
- Produces: nenhuma mudança de assinatura — só o TEXTO retornado por `buildSystemPrompt`. As
  Tasks 2 e 3 não dependem do texto exato aqui, só reaproveitam o mesmo padrão de
  `parts.push(...)`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/lib/ai/defaults.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './defaults'

describe('buildSystemPrompt — marcador SUPER exige PJ', () => {
  it('instrui a IA a checar PF/PJ antes de usar SUPER, não só o valor', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    // ⛔ 20/08/2026: a regra antiga testava só "valor >= 500k" — um PF com
    // dívida grande virava Superqualificado, quando a regra real (igual ao
    // formulário da Meta, intake.js) é PJ E valor >= 500k.
    expect(prompt).toContain('pessoa jurídica')
    expect(prompt).toMatch(/PJ.*500\.000|500\.000.*PJ/)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/ai/defaults.test.ts"`
Expected: FAIL (prompt atual não menciona "pessoa jurídica" em lugar nenhum — já confirmado
por grep antes de escrever este plano).

- [ ] **Step 3: Corrigir a instrução no prompt**

Em `src/lib/ai/defaults.ts`, dentro de `buildSystemPrompt`, o bloco atual (linhas ~122-127) é:

```typescript
    parts.push(
      `Card moves (internal control markers - the customer NEVER sees these; the system removes them and moves the deal card in the CRM). Put the marker at the very END of your reply, only when it truly applies, at most ONE per reply:
- ${QUALIFIED_SENTINEL}: you just concluded the lead QUALIFIES (reached the minimum debt value for their area). Moves the card to Lead Qualificado.
- ${SUPER_SENTINEL}: use INSTEAD of ${QUALIFIED_SENTINEL} when the debt is R$ 500.000 or more. Also tags the lead and alerts the team.
- ${REAGENDAR_SENTINEL}: the lead wants to change the meeting — remarcar, adiar, ANTECIPAR, or asking whether another day/time is available. Moves the card to Reagendar reuniao; the system then sends the reschedule template with the button, so do NOT paste a scheduling link yourself in that case.
  ⚠️ "Tem horário no dia X?" from someone who ALREADY has a meeting is this case — the lead is trying to move it, and wanting it EARLIER is a buying signal, never a reason to close the subject. If you were given the agenda above, offer real times first and mark ${REAGENDAR_SENTINEL} at the end.
Never mention or explain these markers to the customer.`,
    )
```

Trocar a linha do `${SUPER_SENTINEL}` por (a linha do `${QUALIFIED_SENTINEL}` e as demais
ficam iguais):

```typescript
    parts.push(
      `Card moves (internal control markers - the customer NEVER sees these; the system removes them and moves the deal card in the CRM). Put the marker at the very END of your reply, only when it truly applies, at most ONE per reply:
- ${QUALIFIED_SENTINEL}: you just concluded the lead QUALIFIES (reached the minimum debt value for their area). Moves the card to Lead Qualificado.
- ${SUPER_SENTINEL}: use INSTEAD of ${QUALIFIED_SENTINEL} ONLY when BOTH are true — the lead is a pessoa jurídica (company/business, not an individual) AND the debt is R$ 500.000 or more. A pessoa física (individual) with a large debt is still ${QUALIFIED_SENTINEL}, never ${SUPER_SENTINEL} — this exact rule already runs on the Meta form intake (PJ AND >= R$500k), so keep both paths agreeing. If the conversation hasn't made PF/PJ clear yet, ask before deciding between the two.
- ${REAGENDAR_SENTINEL}: the lead wants to change the meeting — remarcar, adiar, ANTECIPAR, or asking whether another day/time is available. Moves the card to Reagendar reuniao; the system then sends the reschedule template with the button, so do NOT paste a scheduling link yourself in that case.
  ⚠️ "Tem horário no dia X?" from someone who ALREADY has a meeting is this case — the lead is trying to move it, and wanting it EARLIER is a buying signal, never a reason to close the subject. If you were given the agenda above, offer real times first and mark ${REAGENDAR_SENTINEL} at the end.
Never mention or explain these markers to the customer.`,
    )
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/ai/defaults.test.ts"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/defaults.ts src/lib/ai/defaults.test.ts
git commit -m "fix(ai): SUPER sentinel agora exige PJ, igual ao intake do formulário"
```

---

### Task 2: Novo marcador `[[URGENTE]]` — tipos e parsing

**Files:**
- Modify: `src/lib/ai/defaults.ts` (nova constante + instrução no prompt)
- Modify: `src/lib/ai/types.ts` (campo novo em `GenerateResult`)
- Modify: `src/lib/ai/generate.ts` (`parseGeneration` extrai o marcador)
- Modify: `src/lib/ai/generate.test.ts` (testes novos)

**Interfaces:**
- Consumes: nada de outra tarefa.
- Produces: `GenerateResult.urgente: boolean` — a Task 3 lê este campo.
  `URGENTE_SENTINEL = '[[URGENTE]]'` exportado de `defaults.ts` — a Task 3 não precisa dele
  diretamente (só `auto-reply.ts` liga `urgente` na tag), mas fica disponível se algum teste
  precisar montar um texto bruto com o marcador.

- [ ] **Step 1: Escrever o teste que falha**

Em `src/lib/ai/generate.test.ts`, acrescentar (a estrutura do arquivo já tem
`describe('parseGeneration', ...)` com vários `it(...)` — acrescentar dentro do mesmo bloco,
ou logo depois dele):

```typescript
describe('parseGeneration — [[URGENTE]]', () => {
  it('reconhece o marcador de urgência e some do texto', () => {
    const r = parseGeneration('Entendi, vou verificar os horários mais próximos. [[URGENTE]]')
    expect(r.urgente).toBe(true)
    expect(r.text).not.toContain('[[URGENTE]]')
  })

  it('sem o marcador, urgente é false', () => {
    expect(parseGeneration('Qual horário fica melhor?').urgente).toBe(false)
  })

  it('convive com outro marcador na mesma resposta (ex.: SUPER + URGENTE)', () => {
    const r = parseGeneration('Combinado! [[SUPER]][[URGENTE]]')
    expect(r.move).toBe('super')
    expect(r.urgente).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/ai/generate.test.ts"`
Expected: FAIL com `Property 'urgente' does not exist` ou `expected undefined to be true`.

- [ ] **Step 3: Adicionar a constante e a instrução do prompt em `defaults.ts`**

Depois do bloco de `REAGENDAR_SENTINEL` (linhas ~23-26 de `defaults.ts`), acrescentar:

```typescript
/**
 * Marcador de URGÊNCIA: a pessoa mencionou algo com prazo correndo — prazo
 * processual, execução em andamento, já foi citada, protesto já saiu. Não
 * move o card sozinho (convive com QUALIFICADO/SUPER na mesma resposta) —
 * só marca o contato como prioridade pra oferta de horário. Julgamento da
 * IA sobre o conteúdo, não lista fechada de palavras.
 */
export const URGENTE_SENTINEL = '[[URGENTE]]'
```

No bloco de instrução dos marcadores (o mesmo `parts.push` da Task 1, já com o `${SUPER_SENTINEL}`
corrigido), acrescentar uma linha nova depois da linha do `${REAGENDAR_SENTINEL}` e antes de
"Never mention...":

```
- ${URGENTE_SENTINEL}: the lead mentioned something with a real deadline running — an active legal enforcement (execução), already being sued/served (citação), a protest that already happened, a court deadline. This is independent from ${QUALIFIED_SENTINEL}/${SUPER_SENTINEL} — use it TOGETHER with one of those in the same reply when it applies, never alone. Judge from content, not a fixed keyword list.
```

- [ ] **Step 4: Adicionar o campo em `types.ts`**

Em `src/lib/ai/types.ts`, no `interface GenerateResult`, depois do campo `portaAberta`:

```typescript
  /** A recusou marcar agora: mandar a despedida com o botão "Agendar agora". */
  portaAberta: boolean
  /** A IA identificou prazo/urgência real na conversa (execução em andamento,
   *  citação, protesto). Independente de `move` — pode vir junto com
   *  'qualified'/'super' na mesma resposta. */
  urgente: boolean
```

- [ ] **Step 5: Extrair o marcador em `generate.ts`**

Em `src/lib/ai/generate.ts`, importar `URGENTE_SENTINEL` junto dos outros sentinels (linha
~13, no bloco `import { HANDOFF_SENTINEL, QUALIFIED_SENTINEL, ... } from './defaults'`).

Na função `parseGeneration`, depois da linha `const portaAberta = raw.includes(PORTA_ABERTA_SENTINEL)`,
acrescentar:

```typescript
  const urgente = raw.includes(URGENTE_SENTINEL)
```

E no objeto retornado por `parseGeneration` (achar o `return { text, handoff, move, ... }` no
fim da função), acrescentar `urgente,` junto dos outros campos — e garantir que o marcador
também é removido do `text` final (a função já remove os outros sentinels do texto antes de
devolver; seguir o MESMO padrão usado pelos outros — provavelmente um `.replace()` encadeado
ou um array de sentinels a limpar; ler a função inteira antes de editar para usar o mecanismo
de limpeza já existente, não inventar um novo).

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/ai/generate.test.ts"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/defaults.ts src/lib/ai/types.ts src/lib/ai/generate.ts src/lib/ai/generate.test.ts
git commit -m "feat(ai): novo marcador [[URGENTE]] — sinaliza prazo/urgência em qualquer canal"
```

---

### Task 3: Tag "Urgente" (dado) + aplicação em `auto-reply.ts`

**Files:**
- Data: criar a tag "Urgente" na tabela `tags` (mesma conta, mesmo padrão das existentes).
- Modify: `src/lib/ai/auto-reply.ts`

**Interfaces:**
- Consumes: `GenerateResult.urgente` (Task 2).
- Produces: nada que outra tarefa use — é a ponta final da cadeia (aplica a tag no contato).
  A Frente D (Fluxo de Agendamento, spec já escrito) é quem vai LER essa tag depois, no nó
  `offer_slots` — fora do escopo deste plano.

- [ ] **Step 1: Criar a tag "Urgente"**

Confirmado nesta investigação: a tag NÃO existe ainda (`SELECT * FROM tags WHERE name ILIKE
'%urgente%'` devolveu vazio). Criar com um script Node na VPS (mesmo padrão usado o dia
inteiro nesta sessão para consultas/gravações pontuais — nunca editar `tags` na mão via SQL
direto sem o `account_id`/`user_id` certos):

```bash
ssh root@100.85.48.50 'cat > /root/wacrm/_cria_tag_urgente.mjs <<'"'"'EOF'"'"'
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = Object.fromEntries(fs.readFileSync("/root/wacrm/.env.local","utf8").split("\n").filter(l=>l.includes("=")).map(l=>{const i=l.indexOf("="); return [l.slice(0,i), l.slice(i+1)];}));
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const existing = await supa.from("tags").select("id").eq("name", "Urgente").maybeSingle();
if (existing.data) { console.log("já existe:", existing.data.id); process.exit(0); }
const r = await supa.from("tags").insert({
  user_id: "be874c16-32b2-46c2-b5fa-45097dc62ff1",
  account_id: "2569c0e9-5f2e-4d04-957c-e2f158e7a87e",
  name: "Urgente",
  color: "#DC2626",
}).select("id,name,color").single();
console.log("criada:", JSON.stringify(r.data), r.error?.message);
EOF
node /root/wacrm/_cria_tag_urgente.mjs
rm -f /root/wacrm/_cria_tag_urgente.mjs'
```

Anotar o `id` devolvido — vai para o `AI_TAG_URGENTE` do Step 2 abaixo (substituir o
placeholder pelo UUID real antes de commitar).

- [ ] **Step 2: Acrescentar a constante e a função de aplicar a tag**

Em `src/lib/ai/auto-reply.ts`, junto das outras constantes `AI_*` (perto de
`const AI_TAG_SUPER = 'b9298582-dcc7-46a3-ae34-f54b3c6fece1'`, linha ~171):

```typescript
/** Criada em 20/08/2026 — ver Step 1 deste plano para o id real. */
const AI_TAG_URGENTE = '<UUID devolvido pelo Step 1>'
```

Logo depois da função `applyAiCardMove` (que termina com o `await runAutomationsForTrigger(...)`
final), acrescentar uma função irmã, pequena, seguindo o MESMO padrão de dedupe que
`applyAiCardMove` já usa para `AI_TAG_SUPER` (conferir count antes de inserir):

```typescript
/**
 * Marca o contato como urgente quando a IA identificou prazo real na
 * conversa. Independente de `applyAiCardMove` — não move etapa, só marca;
 * quem lê essa tag para priorizar horário é o Fluxo de Agendamento (fora
 * deste plano).
 */
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

- [ ] **Step 3: Ligar `urgente` no destructuring e no ponto de chamada**

Em `src/lib/ai/auto-reply.ts:1071`, o destructuring atual é:

```typescript
    const { text, handoff, move, agendar, desmarcar, portaAberta, usage } = await generateReply({
```

Trocar para:

```typescript
    const { text, handoff, move, agendar, desmarcar, portaAberta, urgente, usage } = await generateReply({
```

Depois do bloco "Fase 3: act on the AI's card-move marker" (o `if (moveFinal && !isClient) { ... }`
que termina por volta da linha 1290), acrescentar uma "Fase 3b":

```typescript
    // Fase 3b: sinal de urgência — independente do move, pode vir em
    // qualquer resposta que também qualificou/superqualificou (ou nenhuma).
    if (urgente && !isClient) {
      try {
        await applyAiUrgente(db, { contactId })
      } catch (err) {
        console.error('[ai auto-reply] marcar urgente falhou:', err)
      }
    }
```

- [ ] **Step 4: Build (sem teste dedicado — ver nota abaixo)**

`applyAiCardMove`, a função irmã mais próxima desta, não tem teste unitário direto no
repositório hoje (só é exercitada indiretamente pelos testes de
`dispatchInboundToAiReply — eligibility gates/handoff`, que mockam a camada toda). Seguindo o
mesmo padrão já estabelecido no código, `applyAiUrgente` fica sem teste unitário dedicado
também — a garantia aqui é build limpo + revisão manual do dedupe (mesma lógica testada em
produção pelo `AI_TAG_SUPER`).

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npm run build 2>&1 | tail -40"`
Expected: build limpo, sem erro de tipo (o novo campo `urgente` precisa estar em TODOS os
lugares que constroem um `GenerateResult` — checar se algum teste ou mock em outro arquivo
constrói esse objeto manualmente e precisa do campo novo; `grep -rn "GenerateResult" src/`
antes de considerar o build definitivo).

- [ ] **Step 5: Rodar a suíte inteira**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run 2>&1 | tail -15"`
Expected: mesma contagem de antes + os 4 testes novos das Tasks 1 e 2 (797+4=801 passando; as
2 falhas de `date-utils.test.ts` continuam pré-existentes, sem relação).

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/auto-reply.ts
git commit -m "feat(ai): aplica tag Urgente quando a IA sinaliza [[URGENTE]]"
```

---

### Task 4: Deploy e verificação

- [ ] **Step 1: Build final**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npm run build 2>&1 | tail -40"`
Expected: `EXIT_CODE=0`, sem "Failed to compile".

- [ ] **Step 2: Restart**

Run: `ssh root@100.85.48.50 "pm2 restart wacrm"`
Expected: `[PM2] [wacrm](0) ✓`

- [ ] **Step 3: Confirmar estabilidade**

Run (depois de ~3s): `ssh root@100.85.48.50 "pm2 list"`
Expected: `wacrm` com `status: online`, uptime crescente, sem reinício extra na contagem `↺`.

- [ ] **Step 4: git status limpo**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && git status --short"`
Expected: só os arquivos deste plano modificados (`defaults.ts`, `defaults.test.ts`,
`types.ts`, `generate.ts`, `generate.test.ts`, `auto-reply.ts`) — nenhum script temporário
esquecido (`_cria_tag_urgente.mjs` já foi apagado no Step 1 da Task 3).

## Fora de escopo deste plano (decisões já tomadas, não repetir aqui)
- `intake.js` (o webhook do formulário) **não muda** — já aplica `PJ && valor>=500k`
  corretamente; é o único caminho que já estava certo.
- Nenhuma chamada de função real (tool-calling) da Anthropic é adicionada — o mecanismo de
  marcadores já resolve o problema, mais barato e já testado em produção.
- O Fluxo de Agendamento (Frente D, spec já escrito) que vai LER a tag "Urgente" pra priorizar
  horário — isso é outro plano, não este.
