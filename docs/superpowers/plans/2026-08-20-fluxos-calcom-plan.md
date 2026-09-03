# Fluxos — Nós de Cal.com (offer_slots, book_meeting, cancel_meeting) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Três nós novos no motor de Fluxos — `offer_slots` (oferece horário do Cal.com),
`book_meeting` (reserva) e `cancel_meeting` (cancela) — reaproveitando as três funções de
Cal.com que já existem e já rodam em produção hoje, só que chamadas pela IA em vez de por um
Fluxo. É a peça que falta pro Fluxo de Agendamento (Frente D) deixar de precisar da IA pra
mecânica de reserva.

**Architecture:** Extensão do motor de Fluxos (`src/lib/flows/engine.ts`), mesmo arquivo tocado
hoje pra adicionar o nó `wait`. Reaproveita sem alterar: `horariosLivres`/`criarReserva`/
`cancelCalcomBooking` (`src/lib/appointments/calcom-*.ts`), `engineSendInteractiveList`
(`src/lib/flows/meta-send.ts`), e o padrão de leitura de `contact_tags` que o nó `condition`
já usa. Nenhuma tabela nova, nenhuma rota nova — diferente da fase do `wait`, esta fase não
precisa de agendamento por tempo.

**Tech Stack:** TypeScript, Next.js (wacrm), Vitest.

## Global Constraints

- Nenhuma infraestrutura nova fora de `src/lib/flows/*` — reaproveitar `calcom-*.ts` e
  `meta-send.ts` como estão, sem modificá-los.
- ⛔ **`CALCOM_API_KEY`/`CALCOM_EVENT_TYPE_ID` vêm de `process.env`, direto** — mesmo padrão que
  `auto-reply.ts` já usa (`agendaDoEscritorio()`), sem tabela de configuração por conta. Se
  ausentes, o nó `offer_slots` trata como "sem horário disponível" (silencioso, nunca lança).
- ⛔ **Limite real do WhatsApp, confirmado no código**: lista interativa aceita **no máximo 10
  linhas no total**, **título de linha ≤ 24 caracteres**, **descrição ≤ 72 caracteres**. O
  `rotulo` que `horariosLivres` já devolve ("segunda-feira, 11/08 às 14:00") tem ~30
  caracteres — **NÃO cabe no título**. Usar um formato curto pro título ("11/08 14:00") e o
  `rotulo` completo na descrição (cabe nos 72).
- O repositório só existe na VPS (`root@100.85.48.50`, `/root/wacrm`) — sem clone local, sem
  worktree. Editar local (scratchpad) → `ssh ... "cat > <path>" < <local>` → testar via
  `ssh ... "cd /root/wacrm && npx vitest run <arquivo>"`.
- ⛔ **Antes de commitar, sempre `git status --short` e conferir que só os arquivos DESTA
  tarefa estão staged** — o repositório tem outras mudanças não commitadas de trabalho
  anterior (deixar como está); `git commit` sem `--` commita tudo que estiver staged.
- Var keys entre nós são NOMEADAS, não fixas — `offer_slots.result_var_key` escreve o ISO
  escolhido; `book_meeting.slot_var_key` lê de onde o autor do fluxo configurar (o autor usa a
  MESMA chave nos dois, como já é o padrão do `collect_input.var_key`). Já
  `book_meeting`→`cancel_meeting` usa chaves FIXAS (`vars.booking_uid`,
  `vars.booking_inicio_iso`) porque só pode existir uma reserva ativa por vez num fluxo — sem
  necessidade de nomear.

---

### Task 1: Tipos — `OfferSlotsNodeConfig`, `BookMeetingNodeConfig`, `CancelMeetingNodeConfig`

**Files:**
- Modify: `src/lib/flows/types.ts`

**Interfaces:**
- Produces: os três tipos, consumidos pelas Tasks 2-5.

- [ ] **Step 1: Ler o bloco de tipos de nó e a união `FlowNodeConfig` antes de editar**

`ssh root@100.85.48.50 "sed -n '90,200p' /root/wacrm/src/lib/flows/types.ts"` — confirmar
formato exato antes de inserir (mesmo padrão usado hoje pra `WaitNodeConfig`).

- [ ] **Step 2: Adicionar os três tipos**

```typescript
export interface OfferSlotsNodeConfig {
  /** Texto antes da lista (ex.: "Temos estes horários disponíveis:"). */
  prompt_text: string;
  /** Rótulo do botão que abre a lista — Meta exige, ≤ 20 caracteres. */
  button_label: string;
  /** Chave em vars onde grava o ISO escolhido. O nó book_meeting seguinte
   *  lê desta MESMA chave via seu próprio slot_var_key — o autor do fluxo
   *  amarra os dois usando o mesmo nome, igual ao var_key do collect_input. */
  result_var_key: string;
  /** Pra onde vai depois que a pessoa escolhe QUALQUER horário da lista. */
  next_node_key: string;
  /** Pra onde vai se o Cal.com não tiver horário livre (ou a chave/evento
   *  não estiver configurado no ambiente) — nó auto-avança, não suspende. */
  no_slots_next_node_key: string;
}

export interface BookMeetingNodeConfig {
  /** Chave em vars onde está o ISO escolhido (setado por um offer_slots
   *  anterior no mesmo fluxo, usando o mesmo nome em result_var_key). */
  slot_var_key: string;
  /** Chave em vars onde está o e-mail digitado (de um collect_input
   *  anterior). Se ausente/vazio, cai pro e-mail já salvo no contato —
   *  se também não tiver, é o motivo de falha "sem_email". */
  email_var_key?: string;
  success_next_node_key: string;
  /** Um ramo por motivo de falha — cada um pode ter o texto certo no nó
   *  de destino, em vez de um texto genérico. `generico` é obrigatório
   *  (cobre qualquer motivo sem ramo próprio configurado). */
  failure_next_node_keys: {
    indisponivel?: string;
    email_invalido?: string;
    recusado?: string;
    sem_email?: string;
    generico: string;
  };
}

export interface CancelMeetingNodeConfig {
  /** Segue pra cá independente do cancelamento ter sucedido ou não —
   *  best-effort, igual ao "cancela e libera" do desenho original. */
  next_node_key: string;
}
```

- [ ] **Step 3: Adicionar os três à união `FlowNodeConfig`**

Junto das outras entradas (perto de `"wait"`, adicionado hoje):

```typescript
  | { node_type: "offer_slots"; config: OfferSlotsNodeConfig }
  | { node_type: "book_meeting"; config: BookMeetingNodeConfig }
  | { node_type: "cancel_meeting"; config: CancelMeetingNodeConfig }
```

- [ ] **Step 4: Checar tipos**

`ssh root@100.85.48.50 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i flow"` — sem erro
novo (os três node_types ainda não são tratados em lugar nenhum do motor — normal nesta task).

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/types.ts
git commit -m "feat(flows): tipos OfferSlotsNodeConfig/BookMeetingNodeConfig/CancelMeetingNodeConfig"
```

---

### Task 2: Motor — nó `offer_slots` (entrada: buscar e mandar a lista)

**Files:**
- Modify: `src/lib/flows/engine.ts`

**Interfaces:**
- Consumes: `OfferSlotsNodeConfig` (Task 1), `horariosLivres` (já existe,
  `src/lib/appointments/calcom-slots.ts`), `engineSendInteractiveList` (já existe,
  `src/lib/flows/meta-send.ts`).
- Produces: escreve `run.vars._offered_slots: { id: string; iso: string }[]` — consumido pela
  Task 3 (casamento da resposta).

- [ ] **Step 1: Ler `advanceFromNodeKey` e a assinatura real de `engineSendInteractiveList`**

`ssh root@100.85.48.50 "sed -n '547,830p' /root/wacrm/src/lib/flows/engine.ts"` (achar onde
inserir — depois do case `"wait"` de hoje, antes de `"condition"`) e
`ssh root@100.85.48.50 "sed -n '284,295p' /root/wacrm/src/lib/flows/meta-send.ts"` (a
interface `SendInteractiveListEngineArgs` exata: `{ accountId, userId, conversationId,
contactId, bodyText, buttonLabel, sections: InteractiveListSection[], headerText?,
footerText? }`, onde `InteractiveListSection = { title?: string; rows: InteractiveListRow[] }`
e `InteractiveListRow = { id: string; title: string; description?: string }` — confirmar que
não mudou desde a investigação de hoje).

- [ ] **Step 2: Escrever o formatador de título curto**

Perto de `waitMs` (bloco de "Pure helpers", topo do arquivo), acrescentar:

```typescript
/**
 * Título curto pra linha de lista do WhatsApp — o `rotulo` que
 * `horariosLivres` devolve ("segunda-feira, 11/08 às 14:00") passa dos
 * 24 caracteres que a Meta aceita no título. Isto gera "11/08 14:00"
 * (sempre ≤ 24); o `rotulo` completo vai na DESCRIÇÃO da linha, que
 * aceita até 72 — ninguém perde informação, só muda de campo.
 */
export function rotuloCurto(iso: string): string {
  const d = new Date(iso);
  const data = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(d);
  const hora = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Sao_Paulo",
  }).format(d);
  return `${data} ${hora}`;
}
```

- [ ] **Step 3: Adicionar o case `offer_slots` em `advanceFromNodeKey`**

Logo depois do case `"wait"` de hoje e antes de `"condition"`:

```typescript
    if (node.node_type === "offer_slots") {
      const cfg = node.config as unknown as OfferSlotsNodeConfig;
      const apiKey = process.env.CALCOM_API_KEY;
      const eventTypeId = process.env.CALCOM_EVENT_TYPE_ID;
      const slots =
        apiKey && eventTypeId ? await horariosLivres(eventTypeId, apiKey, 45, 10) : [];
      if (slots.length === 0) {
        currentKey = cfg.no_slots_next_node_key;
        continue;
      }
      const offered = slots.map((s, i) => ({ id: `slot_${i}`, iso: s.iso }));
      try {
        const { whatsapp_message_id } = await engineSendInteractiveList({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          bodyText: interpolateVars(cfg.prompt_text, run.vars),
          buttonLabel: cfg.button_label,
          sections: [
            {
              rows: slots.map((s, i) => ({
                id: `slot_${i}`,
                title: rotuloCurto(s.iso),
                description: s.rotulo,
              })),
            },
          ],
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "offer_slots",
          whatsapp_message_id,
          offered_count: offered.length,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "offer_slots_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "offer_slots_send_failed");
        return { outcome: "completed" };
      }
      const newVars = { ...run.vars, _offered_slots: offered };
      const { error: varsErr } = await db
        .from("flow_runs")
        .update({ vars: newVars })
        .eq("id", run.id);
      if (!varsErr) run.vars = newVars;
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

Importar `horariosLivres` de `@/lib/appointments/calcom-slots` e `engineSendInteractiveList`
de `./meta-send` no topo do arquivo, junto dos imports já existentes de `./meta-send`
(`engineSendText` etc. já são importados de lá — acrescentar `engineSendInteractiveList` na
MESMA linha de import, não criar um import novo separado).

- [ ] **Step 4: Adicionar `"offer_slots"` a `isSuspending`**

```typescript
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input" ||
    node_type === "wait" ||
    node_type === "offer_slots"
  );
}
```

- [ ] **Step 5: Testes**

```typescript
describe("rotuloCurto", () => {
  it("formata dia/mês hora:minuto, sempre dentro do limite de 24 caracteres da Meta", () => {
    const r = rotuloCurto("2026-08-11T17:00:00.000Z"); // 14:00 BRT (UTC-3)
    expect(r).toBe("11/08 14:00");
    expect(r.length).toBeLessThanOrEqual(24);
  });
});
```
Ler o padrão de teste já usado hoje pra `waitMs`/`isSuspending` no mesmo arquivo e seguir o
mesmo formato de `describe`/`it`.

- [ ] **Step 6: Rodar os testes**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts"`

- [ ] **Step 7: Commit**

```bash
git add src/lib/flows/engine.ts src/lib/flows/engine.test.ts
git commit -m "feat(flows): no offer_slots busca horario no Cal.com e manda lista"
```

---

### Task 3: Motor — casar a resposta do `offer_slots`

**Files:**
- Modify: `src/lib/flows/engine.ts` (dentro de `handleReplyForActiveRun`)

**Interfaces:**
- Consumes: `run.vars._offered_slots` (Task 2), `OfferSlotsNodeConfig.result_var_key`.

- [ ] **Step 1: Reler `handleReplyForActiveRun` inteira**

`ssh root@100.85.48.50 "sed -n '884,1070p' /root/wacrm/src/lib/flows/engine.ts"` — o ponto de
inserção é o mesmo bloco `if/else if` mexido hoje pra adicionar a interrupção por palavra-chave
do `wait`. Este é mais um `else if` na mesma cadeia.

- [ ] **Step 2: Adicionar o ramo de casamento do `offer_slots`**

```typescript
  } else if (
    message.kind === "interactive_reply" &&
    currentNode.node_type === "offer_slots"
  ) {
    const offered =
      (run.vars._offered_slots as { id: string; iso: string }[] | undefined) ?? [];
    const hit = offered.find((o) => o.id === message.reply_id);
    if (hit) {
      const cfg = currentNode.config as unknown as OfferSlotsNodeConfig;
      const newVars = { ...run.vars, [cfg.result_var_key]: hit.iso };
      const { error: capErr } = await db
        .from("flow_runs")
        .update({ vars: newVars, reprompt_count: 0 })
        .eq("id", run.id);
      if (!capErr) {
        run.vars = newVars;
        run.reprompt_count = 0;
        matched = cfg.next_node_key;
      }
    }
  }
```

⚠️ Encaixar como mais um `else if` na cadeia já existente (que hoje termina no ramo do `wait`
adicionado mais cedo) — não duplicar o `if` inicial, não alterar os ramos anteriores.

- [ ] **Step 3: Testes**

Seguir o padrão de mock já usado pro teste do `wait`/palavra-chave (mesmo arquivo, adicionado
hoje) — casos mínimos: reply_id bate com um item de `_offered_slots` → `matched` vira o
`next_node_key`, e `vars[result_var_key]` recebe o `iso` certo; reply_id não bate com nada →
cai no fallback normal, inalterado; nó atual não é `offer_slots` → ramos anteriores
(`send_buttons`/`collect_input`/`wait`) inalterados.

- [ ] **Step 4: Rodar os testes**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts"`

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/engine.ts src/lib/flows/engine.test.ts
git commit -m "feat(flows): casa a resposta da lista de horarios com o offer_slots"
```

---

### Task 4: Motor — nó `book_meeting`

**Files:**
- Modify: `src/lib/flows/engine.ts`

**Interfaces:**
- Consumes: `BookMeetingNodeConfig` (Task 1), `run.vars[cfg.slot_var_key]` (escrito pela Task
  3), `criarReserva` (já existe, `src/lib/appointments/calcom-book.ts`), leitura de
  `contacts.email/name/phone` (padrão já usado no `condition` node — `contact_field`,
  `ALLOWED = ["name", "email", "phone", "company"]`, perto da linha 500 de `engine.ts`).
- Produces: em sucesso, escreve `run.vars.booking_uid` e `run.vars.booking_inicio_iso`
  (chaves FIXAS) — consumidas pela Task 5.

- [ ] **Step 1: Ler `criarReserva` e o padrão de leitura de `contacts` já usado no `condition`**

`ssh root@100.85.48.50 "sed -n '1,50p' /root/wacrm/src/lib/appointments/calcom-book.ts"` (a
assinatura completa de `criarReserva` e o shape exato de `Reserva`) e
`ssh root@100.85.48.50 "grep -n 'contact_field' -A20 /root/wacrm/src/lib/flows/engine.ts"`
(como o `condition` node já lê `name`/`email`/`phone` do contato — reaproveitar a MESMA
consulta, não inventar outra).

- [ ] **Step 2: Adicionar o case `book_meeting`**

Depois do case `offer_slots` (Task 2) e antes de `"condition"`:

```typescript
    if (node.node_type === "book_meeting") {
      const cfg = node.config as unknown as BookMeetingNodeConfig;
      const iso = run.vars[cfg.slot_var_key] as string | undefined;
      const apiKey = process.env.CALCOM_API_KEY;
      const eventTypeId = process.env.CALCOM_EVENT_TYPE_ID;
      const { data: contactRow } = await db
        .from("contacts")
        .select("name, phone, email")
        .eq("id", run.contact_id!)
        .maybeSingle();
      const contact = contactRow as { name: string | null; phone: string | null; email: string | null } | null;
      const email =
        (cfg.email_var_key ? (run.vars[cfg.email_var_key] as string | undefined) : undefined) ||
        contact?.email ||
        undefined;

      let failReason: keyof BookMeetingNodeConfig["failure_next_node_keys"] | null = null;
      if (!iso || !apiKey || !eventTypeId) {
        failReason = "generico";
      } else if (!email) {
        failReason = "sem_email";
      }

      if (!failReason) {
        const reserva = await criarReserva({
          eventTypeId: eventTypeId!,
          apiKey: apiKey!,
          iso: iso!,
          nome: contact?.name ?? "Cliente",
          email: email!,
          telefone: contact?.phone ?? "",
        });
        if (reserva.ok) {
          const newVars = {
            ...run.vars,
            booking_uid: reserva.uid,
            booking_inicio_iso: reserva.inicio,
          };
          const { error } = await db.from("flow_runs").update({ vars: newVars }).eq("id", run.id);
          if (!error) run.vars = newVars;
          await logEvent(db, run.id, "node_entered", node.node_key, {
            node_type: "book_meeting",
            result: "sucesso",
          });
          currentKey = cfg.success_next_node_key;
          continue;
        }
        failReason = reserva.motivo;
      }

      await logEvent(db, run.id, "node_entered", node.node_key, {
        node_type: "book_meeting",
        result: "falha",
        motivo: failReason,
      });
      currentKey =
        cfg.failure_next_node_keys[failReason as keyof typeof cfg.failure_next_node_keys] ??
        cfg.failure_next_node_keys.generico;
      continue;
    }
```

Importar `criarReserva` de `@/lib/appointments/calcom-book` no topo do arquivo.

⚠️ Ponto de atenção: `book_meeting` é um nó **auto-avançante** (usa `currentKey = ...; continue;`,
igual a `condition`/`set_tag`) — não suspende esperando resposta, porque a decisão (qual
horário) já foi tomada no `offer_slots` anterior. Não adicionar a `isSuspending`.

- [ ] **Step 3: Testes**

Ler o padrão de teste do `condition` node (mock de `contacts`/`flow_runs` já estabelecido no
arquivo) antes de escrever. Casos mínimos: reserva com sucesso → `vars.booking_uid`/
`booking_inicio_iso` gravados, avança pra `success_next_node_key`; `criarReserva` devolve
`{ok:false, motivo:'indisponivel'}` → avança pro ramo `indisponivel`; sem `slot_var_key` em
vars → avança pro ramo `generico`; sem e-mail (nem em vars nem no contato) → avança pro ramo
`sem_email`.

- [ ] **Step 4: Rodar os testes**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts"`

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/engine.ts src/lib/flows/engine.test.ts
git commit -m "feat(flows): no book_meeting reserva no Cal.com, ramifica por motivo de falha"
```

---

### Task 5: Motor — nó `cancel_meeting`

**Files:**
- Modify: `src/lib/flows/engine.ts`

**Interfaces:**
- Consumes: `CancelMeetingNodeConfig` (Task 1), `run.vars.booking_uid` (escrito pela Task 4),
  `cancelCalcomBooking` (já existe, `src/lib/appointments/calcom-cancel.ts`).

- [ ] **Step 1: Ler `cancelCalcomBooking`**

`ssh root@100.85.48.50 "cat /root/wacrm/src/lib/appointments/calcom-cancel.ts"` — assinatura
completa, confirmar que devolve `boolean` (não objeto com motivo), como já levantado hoje.

- [ ] **Step 2: Adicionar o case `cancel_meeting`**

Depois do case `book_meeting` (Task 4):

```typescript
    if (node.node_type === "cancel_meeting") {
      const cfg = node.config as unknown as CancelMeetingNodeConfig;
      const uid = run.vars.booking_uid as string | undefined;
      const apiKey = process.env.CALCOM_API_KEY;
      if (uid && apiKey) {
        const ok = await cancelCalcomBooking(uid, apiKey);
        await logEvent(db, run.id, "node_entered", node.node_key, {
          node_type: "cancel_meeting",
          cancelado: ok,
        });
      } else {
        await logEvent(db, run.id, "node_entered", node.node_key, {
          node_type: "cancel_meeting",
          cancelado: false,
          motivo: "sem_booking_uid_ou_api_key",
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
```

Importar `cancelCalcomBooking` de `@/lib/appointments/calcom-cancel` no topo do arquivo.

Best-effort de propósito, igual ao "cancela e libera" do desenho original — não ramifica por
sucesso/falha, sempre segue pra `next_node_key`.

- [ ] **Step 3: Testes**

Casos mínimos: `vars.booking_uid` presente → chama `cancelCalcomBooking`, avança; ausente →
não chama (evita chamada com `uid` undefined), avança do mesmo jeito, com o motivo logado.

- [ ] **Step 4: Rodar os testes**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts"`

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/engine.ts src/lib/flows/engine.test.ts
git commit -m "feat(flows): no cancel_meeting cancela a reserva no Cal.com, best-effort"
```

---

### Task 6: Deploy e verificação

- [ ] **Step 1: Build final**

`ssh root@100.85.48.50 "cd /root/wacrm && npm run build 2>&1 | tail -40"` — `EXIT_CODE=0`.

- [ ] **Step 2: Rodar a suíte inteira**

`ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run 2>&1 | tail -20"` — baseline antes
desta fase: 806 passando, 2 falhas pré-existentes (`date-utils.test.ts`, sem relação); a
contagem cresce com os testes novos das Tasks 2-5.

- [ ] **Step 3: Restart**

`ssh root@100.85.48.50 "pm2 restart wacrm"`

- [ ] **Step 4: Confirmar estabilidade**

`ssh root@100.85.48.50 "pm2 list"` (depois de ~3s) — `wacrm` online, sem reinício extra.

- [ ] **Step 5: git status limpo**

`ssh root@100.85.48.50 "cd /root/wacrm && git status --short"` — só `types.ts`/`engine.ts`/
`engine.test.ts` modificados desta fase — nada mais.

## Fora de escopo deste plano

- A definição do Fluxo de Agendamento em si (os nós/dados reais compondo `offer_slots` →
  `book_meeting` → confirmação → `wait` → reagendar/no-show) — próxima fase, monta o grafo
  usando as peças que este plano constrói.
- Tirar a IA da mecânica de reserva em `auto-reply.ts` (`criarReserva`/`horariosLivres`/
  `cancelCalcomBooking` chamados direto de lá) — só acontece quando o Fluxo de Agendamento
  estiver pronto e assumindo de verdade.
- O sinal de urgência priorizando horário (Frente C já aplica a tag "Urgente" — a leitura dela
  pra ordenar/alertar compõe com `condition` + `handoff`, nós que já existem, na hora de montar
  o grafo do Fluxo de Agendamento — não é um node_type novo).
