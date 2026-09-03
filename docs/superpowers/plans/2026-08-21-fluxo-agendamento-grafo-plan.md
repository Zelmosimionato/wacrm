# Fluxo de Agendamento — Montagem do Grafo (Plano B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Montar o grafo real do [FLUXO] de Agendamento (Canal A — Márcia) e do [FLUXO] No-show no motor de Fluxos já existente, ligar as automações-ponte já criadas (Task 6 do Plano A) e apontar `[[AGENDAR]]` pro Fluxo de verdade — deixando o Canal A operante de ponta a ponta em produção.

**Architecture:** Duas rows em `flows`, cada uma com sua árvore de `flow_nodes`. Extensões pequenas e aditivas no motor (nenhuma migração SQL — ver Global Constraints):
1. `notify` (Automações) ganha `tipo` configurável.
2. `start_flow` — passo novo nas Automações, deixa uma Automação acordar um Fluxo.
3. `wait` (Fluxos) ganha alvo dinâmico (`until`) + `fimDoExpedienteAPartir` corrigida.
4. `send_buttons` (Fluxos) ganha `timeout` roteável (reaproveita `until`) + a interpolação `{{vars.X}}` que já deveria ter desde sempre (bug pré-existente, corrigido junto).
5. `collect_input` (Fluxos) ganha a mesma peça de `timeout` de `send_buttons`.
6. `condition` (Fluxos) ganha o operador `hours_until_lt`.
7. `AutomationTriggerType` ganha `calcom_booking_created`/`_rescheduled`/`_cancelled` — capacidade nova pra uma Automação (dado, não script) reagir a evento do Cal.com; uma rota nova no wacrm decide se um Fluxo já é dono do contato antes de disparar esse gatilho, e o `intake.js` (script externo, webhook do Cal.com) passa a perguntar essa decisão ao CRM em vez de decidir sozinho — ver "Tasks 11-13" mais abaixo pro motivo (2ª auditoria achou que o Fluxo colidia com esse script, já vivo em produção).

## ⚠️ Estado deste plano — LEIA ANTES DE EXECUTAR

Este é o plano **pós-auditoria independente**. A 1ª versão (mesmo já revisada por mim antes de mandar pro auditor) voltou com **5 bloqueantes + 7 bugs reais + 9 riscos** — ver a lista completa abaixo, "O que a auditoria achou e como foi corrigido". Nenhuma linha deste plano foi executada ainda. Antes de rodar QUALQUER Task, este arquivo corrigido precisa passar por uma NOVA rodada de revisão independente (Task 0) — a rodada anterior foi contra a versão anterior, não contra esta.

### O que a auditoria achou e como foi corrigido

**Bloqueantes:**
1. **`send_buttons` não interpola `{{vars.X}}`** — só `send_message`/`send_media`/`collect_input`/`offer_slots` chamam `interpolateVars`; `sendButtonsAndSuspend` manda `cfg.text` cru. As mensagens de `confirmar` e `lembrete_vespera` mandariam `{{vars.booking_rotulo}}` literal pro cliente. **Corrigido:** `sendButtonsAndSuspend` (e `sendListAndSuspend`, mesmo bug, mesmo arquivo) passam a interpolar `bodyText`/`headerText`/`footerText` — Task 4.
2. **`on_timeout_hours: 72` mataria o run de qualquer reunião marcada com mais de 3 dias de antecedência** — o sweep de 24/24h (na real, a cada 5 min) usa `last_advanced_at`, que não se move enquanto o run está parado em `esperar_vespera`; o horizonte de agendamento do Cal.com é 45 dias. **Corrigido:** `on_timeout_hours` sobe pra 1200 (50 dias, cobre o horizonte inteiro + margem) — Task 8.
3. **Um `throw` no passo `send_template` aborta os passos seguintes da automação** — confirmado lendo `executeStepsFrom`: `catch(err){ ...; break }`. A automação "Perdeu Confirmação" ficaria travada (nunca move o card) enquanto o template não for aprovado pela Meta. **Corrigido:** reordenar os passos — `move_deal` na posição 0, `send_template` na posição 1 — Task 7.
4. **Template sem `variables` explícito dispara o auto-fill `{'1':'{{nome}}'}`**, que a Meta rejeita (#132000) porque o template não tem `{{1}}`. **Corrigido:** `step_config` da automação passa `variables: {}` explicitamente — Task 7.
5. **`fimDoExpedienteAPartir` original devolvia meio-dia (fim do 1º bloco) em vez de 17h (fim do expediente de verdade)** pro caso mais comum de uso (fora do horário comercial). **Corrigido:** lógica reescrita — Task 3.

**Bugs reais:**
6. **Data de teste já no passado** (a auditoria rodou depois da data que eu tinha fixado) — testes do `wait`/`until` agora usam datas relativas a `Date.now()`, nunca uma data absoluta fixa — Task 3.
7. **Os testes do `wait`/`until` simulavam uma RESPOSTA a um nó já ativo**, o que cai no caminho de `keyword_branches`, não no caminho de ENTRAR no nó pela primeira vez (que é o que agenda o `flow_pending_resumes`) — reescritos usando o padrão real do arquivo (`collect_input` avançando PRA DENTRO do nó sob teste) — Tasks 3 e 4.
8. **Os helpers de teste que os Steps 1 de Tasks 1-2 inventavam (`h.state.automation`, `automation()`, `step()`) não existem** — o estado real é `h.state.automations` (array) e `h.state.steps`; não há helper de módulo reaproveitável. Reescrito usando o shape real, confirmado lendo o arquivo inteiro — Tasks 1 e 2.
9. **As tags-ponte só disparam a automação na 1ª vez** — `contact_tags` tem `UNIQUE(contact_id, tag_id)`; reaplicar uma tag já presente não gera INSERT, e é o INSERT que acorda o webhook. Um lead que passa pelo Fluxo uma 2ª vez fica em silêncio. **Corrigido:** todo `set_tag add` de tag-ponte (Agendou, Perdeu Confirmação, Urgente, Remarcado via No-show, Perdido via No-show) agora tem um `set_tag remove` da MESMA tag imediatamente antes, garantindo INSERT fresco sempre — Tasks 6 e 7 (grafo cresceu de 26→29 e de 8→10 nós).
10. **`npx tsx` não está instalado na VPS** (`node_modules/.bin` não tem `tsx` nem `ts-node`) **e `dotenv` não é dependência declarada** (só transitiva). **Corrigido:** os scripts de seed viram `.js` puro (CommonJS, `require`), rodados com `node` direto — mesmo padrão já usado várias vezes nesta sessão via SSH, comprovadamente funcional nesta VPS — Tasks 5, 6, 7.
11. **`confirmar` (1ª pergunta de confirmação, logo após reservar) não tinha timeout nenhum** — silêncio aí prendia o run até o sweep de 50 dias, sem nunca perguntar urgência nem entrar no ciclo de lembretes. **Corrigido:** `confirmar` ganha `timeout` de 24h fixas → segue pra `perguntar_urgencia` (silêncio prolongado é tratado como "segue com a reserva", e o lembrete de véspera reforça a confirmação depois) — Task 8.

**Riscos:**
12. ⚠️ **REFUTADO pela 2ª auditoria (era achado NEW-1) — não estava corrigido, a verificação original estava errada.** A alegação "o Fluxo novo nunca escreve no campo `e482845b-...`" ignorava que o **`/root/intake/intake.js` já está vivo em produção** e escreve NELE (e move o card pra etapa antiga `fd70e3b2-...`) toda vez que o Cal.com dispara o webhook — o que acontece em TODA reserva que o `book_meeting` do Fluxo faz, porque é o MESMO Cal.com. **Corrigido de verdade agora:** ver "Tasks 11-13 — por que existem" abaixo — o `intake.js` passa a perguntar ao CRM antes de agir, e a decisão de negócio (o que fazer sem Fluxo) vira gatilho de Automação (`calcom_booking_*`), não mais lógica escondida numa checagem.
13. **`somente_horario_comercial: false`** nas automações novas de `start_flow` — pra `deal_stage_changed` esse campo nem é lido pelo motor (`holdForBusinessHours` só olha `tag_added`), então "Fluxo No-show — inicia" fica como risco aceito e documentado (mitigado na prática porque é um humano movendo o card, normalmente em horário de trabalho); "Remarcado via No-show" (`tag_added`, ESSE respeita o campo) passa pra `true` — Task 7.
14. **Scripts de seed fazem `DELETE FROM flow_nodes` antes de reinserir** — perigoso se houver run ativo naquele Fluxo no momento. **Corrigido:** os scripts agora checam `flow_runs` por runs ativos antes do delete e abortam com erro claro se houver — Tasks 6 e 7.
15. **`tipo?: string` sem restrição batendo contra um `CHECK` de 4 valores fixos** — um erro de digitação só apareceria em runtime (`throw` dentro do `notify`). **Corrigido:** union exato `'conversation_assigned' | 'awaiting_reply' | 'urgent_lead' | 'pj_agendamento_bloqueado'` — Task 1.
16. **`upsertByUniqueColumn` casava só por `name`**, sem escopo de conta — funciona hoje (schema é single-tenant na prática) mas é uma suposição latente. **Corrigido:** passa a casar por `(name, account_id)` — Task 7.
17. Import novo em `automations/engine.ts` pra `@/lib/flows/engine` amplia a cadeia de módulos que QUALQUER teste que importe `automations/engine.ts` carrega — nenhum ciclo hoje, mas Task 2 ganhou uma nota explícita pra investigar (não presumir) se algum teste existente quebra por isso.

### O que a 2ª auditoria achou (rodada contra a versão já corrigida) e como foi corrigido

Verificou os 17 achados acima (13 confirmados corrigidos, 3 parciais, 1 refutado — o #12, ver acima) e achou problemas NOVOS, mais sérios — o Fluxo colidindo com código que já está VIVO em produção (`intake.js`, `webhook/route.ts`), não só bug isolado no plano:

- **NEW-1 (bloqueante):** `intake.js` já rearma as 3 automações antigas em toda reserva do Fluxo (era o achado #12 refutado acima). **Corrigido:** Tasks 11-12 (gatilho `calcom_booking_*` + `intake.js` pergunta ao CRM antes de agir).
- **NEW-2 (bloqueante):** cancelamento do Fluxo não era reconhecido pelo `intake.js`, que disparava a automação antiga de reagendamento por cima. **Corrigido:** Task 12, Step 2 (marcador `[ia-whatsapp]` no motivo do cancelamento — mesmo mecanismo que o `intake.js` já usa pra cancelamento feito pela IA) + a checagem de Fluxo ativo da Task 11/12 cobre o mesmo caso por outro caminho (defesa em profundidade).
- **NEW-3 (bloqueante):** botão "Confirmar presença" colide com um handler antigo hardcoded (`vespera-buttons.ts`) que não respeitava `flowConsumed` — um toque, duas respostas. **Corrigido:** Task 13.
- **NEW-4 (bloqueante):** reunião de curto prazo (Cal.com oferece horário no mesmo dia) quebrava a cadeia de lembretes — "sua reunião é amanhã" errado, e o timeout de cancelamento podia vencer minutos depois de confirmar. **Corrigido:** Task 6 (`hours_until_lt`) + Task 8 (nó `checar_prazo_curto`, texto de `lembrete_vespera` sem afirmar "amanhã").
- **NEW-5 (bloqueante):** `perguntar_urgencia` (pergunta aberta, sem botão) não tinha timeout — silêncio travava o run pra sempre, sem tag Agendou nem lembrete nenhum. **Corrigido:** Task 5 (`collect_input` ganha `timeout`) + Task 8 (`perguntar_urgencia` usa).
- **NEW-6 (bug real):** nada cancelava o `flow_pending_resumes` de um `timeout` de `send_buttons` quando o botão era tocado antes do prazo, e o grafo tem loops (reagendar volta pro `offer_slots`/`confirmar`) — risco de uma linha de timeout velha disparar na passagem seguinte. Mitigado pelo mesmo guard que `resumeWaitingFlow` já tinha (`current_node_key !== pending.node_key` vira no-op) — sem código novo, mas vale reconferir esse guard especificamente contra os loops do grafo na Task 0 (revisão independente).
- **NEW-7 e NEW-8 (bugs reais, não compilariam):** bloco de `send_buttons` sem declarar `cfg`; `resumeWaitingFlow` com o guard antigo nunca alcançando o ramo novo. **Corrigidos:** Task 4, Step 8 (blocos completos reescritos, com a nota explícita do erro original).
- **NEW-9 (bloqueante):** com `on_unknown_reply: 'reprompt'`, qualquer mensagem do lead fora de um botão/palavra-chave era engolida pelo Fluxo — Márcia ficava muda até 45 dias, e depois de 2 tentativas o run inteiro ia pra handoff, matando os lembretes restantes. **Corrigido:** Tasks 8 e 9, `fallback_policy.on_unknown_reply: 'ignore'` nos dois Fluxos — mensagem que não bate simplesmente cai pra Márcia, sem consumir nem travar nada; os prazos do próprio Fluxo (agora todo nó suspensivo tem `timeout`) são quem realmente decide o que acontece, não mais o reprompt.
- **Mudança de princípio (não é achado técnico, é correção de escopo pedida pelo titular):** a 1ª tentativa de corrigir NEW-1/NEW-2 ainda deixava a decisão de negócio como código dentro do `intake.js`. Redesenhado — ver "Tasks 11-13 — por que existem" — pra a decisão virar Automação de dado (gatilho novo `calcom_booking_*`), não script.

---

## Global Constraints

- **Nenhuma migração SQL é necessária neste plano.** `automation_steps.step_type` é `TEXT NOT NULL` sem `CHECK`. `flow_nodes.config` é JSONB livre. `notifications.type` já tem os 4 valores usados (`conversation_assigned`, `awaiting_reply`, `urgent_lead`, `pj_agendamento_bloqueado` — confirmado lendo as migrações 027/040/043/044 uma a uma).
- **Interpolação de texto no motor de Fluxos é `{{vars.chave}}`**, e depois da Task 4 isso vale pra `send_buttons`/`send_list` também, não só `send_message`/`collect_input`/`offer_slots`/`send_media`. Continua SEM acesso a campo do contato (nome/telefone/email) — isso é só das Automações.
- **Todo texto de mensagem ao cliente é em português, primeira pessoa, sem gíria, sem emoji.**
- **Todo botão ≤ 20 caracteres** — `Confirmar presença` (18), `Preciso reagendar` (17), `Quero remarcar` (14), `Não, obrigado` (13), `Ver horários` (11).
- **Rollout faseado continua só PF** — nada neste plano mexe no gate PJ existente em `auto-reply.ts`.
- **Deploy:** editar em `/root/wacrm` → `npx vitest run <pasta>` → `npm run build` (Task 11 Step 6, SEM restart) → build final + `pm2 restart wacrm` + `pm2 restart intake` + ativação de dado na Task 17 (achados REAL-BUG-4/RISK-8/RISK-10, 4ª auditoria — a versão anterior desta linha dizia "depois da Task 15", que não roda hoje; o deploy de verdade é a Task 17, não a Task 15).
- **Specs/planos ficam em `docs/superpowers/`, NÃO commitados.** Scripts de seed em `scripts/` SÃO commitados (agora `.js`, ver achado #10).
- **IDs confirmados no banco de produção:**
  - `account_id` = `2569c0e9-5f2e-4d04-957c-e2f158e7a87e`; `user_id` = `be874c16-32b2-46c2-b5fa-45097dc62ff1`.
  - Tags: `Urgente` = `9db3b56e-eecf-4b29-bace-2cc034b38f72`; `Agendou` = `c0278b4c-8f17-416e-a7e4-b66b6e78315a`; `Perdeu Confirmação` = `19b12e9b-79c8-4a3d-812b-bcdbeef3e16b`.
  - Etapas (pipeline `8e89e154-763c-4cf8-b73b-42f7368c59c3`): `Reunião Agendada 2` = `1a6dcb28-81bb-49ce-a070-8d1edf4f97dc`; `FUP - Reativar Lead` = `8bd228cf-fba4-4b28-b704-068bdcfa7c8d`; `Follow up No-show` = `8c39cc10-4568-432f-b4dd-9a4ba228add6`; `Perdido` = `0d0382a5-f15d-4e43-88aa-0c70337d94d4`; `Reunião Agendada` (ANTIGA) = `fd70e3b2-52e2-4f2c-b6e8-15450fe6c9d4`.
  - Automações já criadas (Plano A, `is_active:false`): `Agendou (Fluxo)` = `f2347d27-201c-48c1-ac90-722a5d1b5ff8`; `Perdeu Confirmação (Fluxo)` = `6809f61f-0a02-4d1a-8a84-87598ac959ee`.
  - Automação antiga a desativar — **NA TASK 15, não antes** (achado RISK-9/MINOR da 4ª/5ª auditoria — fica ATIVA até lá): `Follow up No-show — 3 toques e encerra` = `b6359cda-4516-4186-8937-d7c86a90c8c8`.
- **Verificação de sobreposição com as automações antigas (achado #12, feita agora por leitura, não suposição) — ⚠️ CORRIGIDA duas vezes: pelo BLOCKER-3 da 4ª auditoria, e pela 5ª auditoria (a descrição TÉCNICA do próprio Blocker-3 tinha 2 erros e uma omissão — a DECISÃO abaixo não muda, só o entendimento do risco fica mais preciso):** `Reunião Agendada — lembrete véspera/1h` são `trigger_type:'time_based'`, chave `relativo.campo = 'e482845b-8ed4-4f4d-ae0e-0eed9dafbe4e'`. ⚠️ Esse campo é do **CONTATO** (`contact_custom_values`), não do deal — `publicoPorData` (`src/lib/automations/tempo.ts:205-227`) lê de `contact_custom_values` e, por comentário explícito no próprio código, NÃO filtra por etapa. Ou seja, o alcance real não são só os 16 deals hoje em "Reunião Agendada" (antiga) — é QUALQUER contato com um valor futuro nesse campo, não importa em que etapa o card dele esteja. E o motivo da desatualização não é "nada escreve nesse campo" — **hoje** `intake.js:530` ESCREVE nesse campo (`CF_DATA_ISO`) a cada reserva nova, então um lead legado remarcando pelo WhatsApp HOJE já teria o lembrete realinhado pro horário novo, funcionando certo. É o `return` antecipado da Task 12 (quando um Fluxo é dono do contato) que TIRA essa atualização — ou seja, **este plano CRIA a sobreposição, não herda uma que já existia.** E tem uma consequência pior, que a versão anterior desta nota não mencionava: `[[AGENDAR]]` (Task 10) starta o Fluxo novo SEM `initialVars` — `run.vars.booking_uid` fica vazio — e sem isso `cancel_meeting` (`engine.ts:967`) não tem como cancelar a reserva ANTIGA no Cal.com. Pra um desses leads remarcando pelo Fluxo novo, o resultado não é só "dois lembretes contraditórios" — é **duas reservas VIVAS no Cal.com pra mesma pessoa**, uma que ninguém cancelou. `Reunião Agendada — confirmação` (`deal_stage_changed` na etapa ANTIGA `fd70e3b2-...`) continua segura por construção — o Fluxo move o card pra `1a6dcb28-...`, etapa DIFERENTE, então essa não dispara. **Decisão do titular (21/08/2026), mantida com o risco real agora mais claro: opção (c)** — aceitar a sobreposição por enquanto (mesmo princípio já usado pra decidir adiar a Task 15 inteira: "vemos depois"), e resolver de verdade quando a Task 15 migrar esses leads. Não é esquecimento — é escopo explícito de hoje: Canal A no ar, migração numa sessão dedicada.
- **Todo script de seed é IDEMPOTENTE e AGORA TEM GUARDA CONTRA RUN ATIVO** (achado #14) — antes de `DELETE FROM flow_nodes`, verifica se existe `flow_runs` com `status='active'` pro `flow_id` e aborta com erro se houver, em vez de apagar embaixo de um run em andamento.
- **Scripts de seed são `.js` (CommonJS, `require`), rodados via `node`, não `.ts`/`tsx`** (achado #10) — `tsx` não está instalado nesta VPS.

---

## File Structure

- `src/types/index.ts` — `NotifyStepConfig.tipo` (union exata); `AutomationStepType` ganha `'start_flow'`; novo `StartFlowStepConfig`.
- `src/lib/automations/engine.ts` — case `'notify'` usa `cfg.tipo`; novo case `'start_flow'`.
- `src/lib/automations/engine.test.ts` — testes, usando o shape REAL do mock (`h.state.automations`/`h.state.steps`, `h.state.owned`).
- `src/lib/automations/horario-comercial.ts` — `fimDoExpedienteAPartir`, versão corrigida.
- `src/lib/automations/horario-comercial.test.ts` — testes corrigidos (valores esperados certos desta vez).
- `src/lib/flows/types.ts` — `WaitNodeConfig.until`; `SendButtonsNodeConfig.timeout`.
- `src/lib/flows/engine.ts` — `wait` usa `computeWaitRunAt`; `send_buttons` ganha `timeout` + interpolação; `resumeWaitingFlow` trata `send_buttons` também.
- `src/lib/flows/engine.test.ts` — testes usando o padrão real (`collect_input` avançando pro nó sob teste, não resposta a nó já ativo).
- `scripts/lib/seed-client.js` (novo, CommonJS).
- `scripts/wire-automacoes-fluxo-agendamento.js` (novo).
- `scripts/seed-fluxo-agendamento.js` (novo, 30 nós — corrigido, achado MINOR da 4ª auditoria; contagem real confere com o cabeçalho da Task 8).
- `scripts/seed-fluxo-noshow.js` (novo, 10 nós).
- `src/lib/ai/auto-reply.ts` — `FLUXO_AGENDAMENTO_ID` real, `export const`.
- `src/lib/ai/auto-reply.test.ts` — usa a constante importada.

---

### Task 0: Revisão independente do plano (OBRIGATÓRIA — repetir contra ESTA versão)

- [ ] **Step 1:** Dispatch de um agente novo (sem contexto desta conversa) com o mandato: ler este plano inteiro na VPS e, PRA CADA script/trecho de código, conferir contra o código-fonte real: (1) todo campo de INSERT/UPDATE existe na tabela certa com o NOT NULL/CHECK certo; (2) todo shape de `config`/`step_config` bate com a interface TS real; (3) toda referência `next_node_key`/`true_next`/`false_next`/`timeout.next_node_key`/botão existe no MESMO grafo (30 nós no Fluxo de Agendamento, 10 no No-show — conferir os 40 de novo, o grafo mudou desde a 1ª auditoria — contagem corrigida na 4ª auditoria, achado MINOR: estava 29 em várias referências, o grafo real da Task 8 tem 30); (4) toda interpolação usa `{{vars.chave}}`; (5) todo mock de teste (`h.state.*`) referenciado de fato existe ou é criado corretamente — ler os arquivos de teste inteiros, não confiar na descrição deste plano; (6) reconferir especificamente os 5 bloqueantes e 7 bugs listados acima — a correção que EU apliquei também pode estar errada.
- [ ] **Step 2:** Agente devolve achados, sem corrigir nada.
- [ ] **Step 3:** Cada achado corrigido neste arquivo antes da Task 1. Achado de produto (não só técnico) volta pro titular.

---

### Task 1: `notify` (Automações) ganha `tipo` configurável

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/automations/engine.ts`
- Test: `src/lib/automations/engine.test.ts`

**Interfaces:**
- Produces: `NotifyStepConfig.tipo?: 'conversation_assigned' | 'awaiting_reply' | 'urgent_lead' | 'pj_agendamento_bloqueado'`.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar a `src/lib/automations/engine.test.ts`, DEPOIS do `describe("triggerMatches — tag_added", ...)` existente e ANTES de `describe("automacaoVaiResponder", ...)`. Usa o shape REAL do mock (`h.state.automations` é array; `h.state.owned` precisa estar setado pro guard de tenancy não bloquear antes de tudo; `destinatario:'usuario'` evita depender de uma tabela `profiles` que este mock não modela; `conversation_id` no `context` evita a criação de conversa via `resolveConversationId`, que este mock também não modela):

```typescript
describe("notify — tipo configuravel", () => {
  it("grava o type configurado em vez do fixo awaiting_reply", async () => {
    h.state.owned = { id: "contact-1" };
    h.state.automations = [
      {
        id: "a1",
        account_id: ACCOUNT,
        user_id: "u1",
        trigger_type: "tag_added",
        // somente_horario_comercial: false — achado F1 da checagem Task 0:
        // holdForBusinessHours() PARA a execução inteira pra trigger_type
        // 'tag_added' fora do expediente (horario-comercial.ts) — sem isto
        // o teste roda vermelho (ou verde só por sorte de horário) fora de
        // seg-sex 9-12/13-17 BRT. Este campo aqui é só do FIXTURE de
        // teste (não é o comportamento em produção da automação real).
        trigger_config: { tag_id: "9db3b56e-eecf-4b29-bace-2cc034b38f72", somente_horario_comercial: false },
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: "s1",
        automation_id: "a1",
        step_type: "notify",
        position: 0,
        parent_step_id: null,
        step_config: {
          destinatario: "usuario",
          user_id: "user-1",
          titulo: "Lead sinalizou urgência",
          corpo: "Verificar a conversa.",
          tipo: "urgent_lead",
        },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "contact-1",
      context: { tag_id: "9db3b56e-eecf-4b29-bace-2cc034b38f72", conversation_id: "conv-1" },
    });

    expect(h.state.notificationsInserted).toHaveLength(1);
    expect(h.state.notificationsInserted[0]).toMatchObject({
      type: "urgent_lead",
      title: "Lead sinalizou urgência",
      body: "Verificar a conversa.",
    });
  });

  it("sem tipo configurado continua gravando awaiting_reply (compatibilidade)", async () => {
    h.state.owned = { id: "contact-1" };
    h.state.automations = [
      {
        id: "a1",
        account_id: ACCOUNT,
        user_id: "u1",
        trigger_type: "tag_added",
        // somente_horario_comercial: false — achado F1 da checagem Task 0:
        // holdForBusinessHours() PARA a execução inteira pra trigger_type
        // 'tag_added' fora do expediente (horario-comercial.ts) — sem isto
        // o teste roda vermelho (ou verde só por sorte de horário) fora de
        // seg-sex 9-12/13-17 BRT. Este campo aqui é só do FIXTURE de
        // teste (não é o comportamento em produção da automação real).
        trigger_config: { tag_id: "9db3b56e-eecf-4b29-bace-2cc034b38f72", somente_horario_comercial: false },
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: "s1",
        automation_id: "a1",
        step_type: "notify",
        position: 0,
        parent_step_id: null,
        step_config: { destinatario: "usuario", user_id: "user-1", titulo: "Aviso" },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "contact-1",
      context: { tag_id: "9db3b56e-eecf-4b29-bace-2cc034b38f72", conversation_id: "conv-1" },
    });

    expect(h.state.notificationsInserted[0]).toMatchObject({ type: "awaiting_reply" });
  });
});
```

Isto usa `h.state.notificationsInserted`, que não existe. Adicionar ao objeto `h.state` hoisted no topo do arquivo: `notificationsInserted: [] as Record<string, unknown>[],` e resetar no `beforeEach` já existente (`h.state.notificationsInserted = [];`). No `resolve(ops)` do `vi.mock("./admin-client", ...)`, adicionar ANTES do `return { data: null, error: null };` final:

```typescript
    if (table === "notifications") {
      if (type === "insert") {
        const rows = Array.isArray(ops.payload) ? ops.payload : [ops.payload];
        state.notificationsInserted.push(...(rows as Record<string, unknown>[]));
        return { data: rows, error: null };
      }
      return { data: null, error: null };
    }
```

⚠️ **Achado R6 da 3ª auditoria — correção do texto acima, não do código:** este arquivo (`automations/engine.test.ts`) desestrutura só `const { table, type } = ops;` no topo de `resolve` — **`payload` NÃO está desestruturado aqui**, ao contrário de `flows/engine.test.ts` (que desestrutura os quatro). Por isso o snippet usa `ops.payload`, não `payload` bare — usar a variável errada quebra a compilação. Uma versão anterior deste plano afirmou "os dois arquivos são consistentes nesse padrão" — não são; conferido agora, não presumido.

- [ ] **Step 2: Rodar, confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/automations/engine.test.ts -t 'notify —'"`
Expected: FAIL — sem a captura de `notifications`, `h.state.notificationsInserted` fica vazio (ou, antes de adicionar o case, o teste falha por outro motivo — ambos são sinais válidos de "ainda não implementado").

- [ ] **Step 3: Implementar**

Em `src/types/index.ts`, dentro de `NotifyStepConfig`:

```typescript
  /** Tipo gravado em `notifications.type` — union EXATA batendo com o
   *  CHECK constraint real (migracoes 027/040/043/044). Default
   *  'awaiting_reply' preserva o comportamento anterior a este campo. */
  tipo?: 'conversation_assigned' | 'awaiting_reply' | 'urgent_lead' | 'pj_agendamento_bloqueado';
```

Em `src/lib/automations/engine.ts`, dentro do case `'notify'`, trocar `type: 'awaiting_reply',` por `type: cfg.tipo ?? 'awaiting_reply',`.

- [ ] **Step 4: Rodar, confirmar que passa**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/automations/engine.test.ts"`
Expected: PASS — toda a suíte deste arquivo, não só o teste novo (confirma que a captura de `notifications` não quebrou nenhum teste existente que também passe por `notify` indiretamente).

- [ ] **Step 5: Commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add src/types/index.ts src/lib/automations/engine.ts src/lib/automations/engine.test.ts && git commit -m 'feat: notify aceita tipo configuravel de notificacao'"
```

---

### Task 2: `start_flow` — passo novo nas Automações

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/automations/engine.ts`
- Test: `src/lib/automations/engine.test.ts`

⚠️ **Nota de risco (achado #17):** este Task adiciona `import { startManualFlowRun } from '@/lib/flows/engine'` a `src/lib/automations/engine.ts`. Isto amplia a cadeia de módulos que QUALQUER arquivo de teste que importa `automations/engine.ts` carrega transitivamente (agora inclui `flows/admin-client`, `flows/meta-send`, e os três módulos de Cal.com). Depois do Step 4 (rodar a suíte inteira de `automations`), se algum teste QUE NÃO SEJA deste arquivo quebrar por causa disso, **investigar a causa real antes de mockar às cegas** — pode ser um sinal de que o import deveria ser dinâmico (`await import(...)` dentro do case, não estático no topo) em vez de mockar tudo.

- [ ] **Step 1: Escrever os testes que falham**

```typescript
describe("start_flow", () => {
  it("chama startManualFlowRun com o flow_id configurado e a tenancy do contato", async () => {
    h.state.owned = { id: "contact-1" };
    h.state.automations = [
      {
        id: "a1",
        account_id: ACCOUNT,
        user_id: "u1",
        trigger_type: "deal_stage_changed",
        trigger_config: { stage_id: "stage-1" },
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: "s1",
        automation_id: "a1",
        step_type: "start_flow",
        position: 0,
        parent_step_id: null,
        step_config: { flow_id: "flow-noshow-1" },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "deal_stage_changed",
      contactId: "contact-1",
      context: { stage_id: "stage-1", conversation_id: "conv-1" },
    });

    expect(h.startManualFlowRun).toHaveBeenCalledTimes(1);
    expect(h.startManualFlowRun).toHaveBeenCalledWith(expect.anything(), "flow-noshow-1", {
      accountId: ACCOUNT,
      contactId: "contact-1",
      conversationId: "conv-1",
    });
  });

  it("start_flow sem contactId nunca chama startManualFlowRun (guard 'needs a contact')", async () => {
    // Sem contactId, runAutomationsForTrigger PULA o guard de tenancy
    // (ele só roda `if (input.contactId)`) e chega a executar o passo —
    // é o próprio case 'start_flow' que recusa (`if (!args.contactId)
    // throw`). Por isso o trigger_config PRECISA bater (stage_id no
    // context) para o teste genuinamente alcançar esse guard, e não
    // ficar vazio por falta de match — achado #8 da auditoria: um teste
    // "not called" com automação que nunca roda passa por motivo errado.
    h.state.automations = [
      {
        id: "a1",
        account_id: ACCOUNT,
        user_id: "u1",
        trigger_type: "deal_stage_changed",
        trigger_config: { stage_id: "stage-1" },
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: "s1",
        automation_id: "a1",
        step_type: "start_flow",
        position: 0,
        parent_step_id: null,
        step_config: { flow_id: "flow-noshow-1" },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "deal_stage_changed",
      contactId: null,
      context: { stage_id: "stage-1" },
    });

    expect(h.startManualFlowRun).not.toHaveBeenCalled();
  });
});
```

Adicionar `startManualFlowRun: vi.fn(),` ao objeto `h` hoisted e `vi.mock("@/lib/flows/engine", () => ({ startManualFlowRun: h.startManualFlowRun }));` no topo do arquivo (ao lado dos outros `vi.mock`). Resetar `h.startManualFlowRun.mockReset();` no `beforeEach` já existente.

- [ ] **Step 2: Rodar, confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/automations/engine.test.ts -t start_flow"`
Expected: FAIL — `unknown step: start_flow` (o case ainda não existe) ou `startManualFlowRun` nunca chamado.

- [ ] **Step 3: Implementar**

Em `src/types/index.ts`:

```typescript
export type AutomationStepType =
  | 'send_message'
  | 'send_buttons'
  | 'send_list'
  | 'send_template'
  | 'add_tag'
  | 'remove_tag'
  | 'assign_conversation'
  | 'update_contact_field'
  | 'create_deal'
  | 'move_deal'
  | 'wait'
  | 'condition'
  | 'send_webhook'
  | 'close_conversation'
  | 'notify'
  | 'start_flow';

export interface StartFlowStepConfig {
  flow_id: string;
}
```

Adicionar `| StartFlowStepConfig` na union `AutomationStepConfig`.

Em `src/lib/automations/engine.ts`: `import { startManualFlowRun } from '@/lib/flows/engine'`, `StartFlowStepConfig` no bloco de import de tipos, e o case (antes do `default:`):

```typescript
    case 'start_flow': {
      const cfg = step.step_config as StartFlowStepConfig
      if (!cfg.flow_id) throw new Error('start_flow needs flow_id')
      if (!args.contactId) throw new Error('start_flow needs a contact')
      const conversationId = await resolveConversationId(args)
      const result = await startManualFlowRun(db, cfg.flow_id, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        conversationId,
      })
      return `start_flow: ${result.outcome ?? 'sem outcome'}`
    }
```

- [ ] **Step 4: Rodar, confirmar que passa; rodar a suíte inteira de `automations`**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/automations"`
Expected: PASS — se algo quebrar fora dos testes novos, ver a nota de risco acima antes de mockar por cima.

- [ ] **Step 5: Commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add src/types/index.ts src/lib/automations/engine.ts src/lib/automations/engine.test.ts && git commit -m 'feat: automacao ganha passo start_flow para acordar um Fluxo'"
```

---

### Task 3: `wait` (Fluxos) ganha alvo dinâmico (`until`) + `fimDoExpedienteAPartir` corrigida

**Files:**
- Modify: `src/lib/flows/types.ts`, `src/lib/flows/engine.ts`, `src/lib/automations/horario-comercial.ts`
- Test: `src/lib/automations/horario-comercial.test.ts`, `src/lib/flows/engine.test.ts`

- [ ] **Step 1: Escrever os testes de `fimDoExpedienteAPartir`**

```typescript
describe("fimDoExpedienteAPartir", () => {
  it("dentro do expediente da tarde, devolve o fim do próprio bloco (17h BRT)", () => {
    const t = Date.parse("2026-08-11T17:00:00.000Z"); // terça 11/08, 14h BRT
    expect(new Date(fimDoExpedienteAPartir(t)).toISOString()).toBe("2026-08-11T20:00:00.000Z");
  });

  it("antes do expediente começar (mesmo dia útil), devolve o fim do EXPEDIENTE DO DIA (17h), não do 1º bloco", () => {
    const t = Date.parse("2026-08-11T10:00:00.000Z"); // terça 11/08, 07h BRT
    expect(new Date(fimDoExpedienteAPartir(t)).toISOString()).toBe("2026-08-11T20:00:00.000Z");
  });

  it("durante o almoço (mesmo dia útil), também devolve o fim do expediente do dia (17h)", () => {
    const t = Date.parse("2026-08-11T15:30:00.000Z"); // terça 11/08, 12h30 BRT (almoço)
    expect(new Date(fimDoExpedienteAPartir(t)).toISOString()).toBe("2026-08-11T20:00:00.000Z");
  });

  it("depois do expediente encerrar, devolve o fim do expediente do PRÓXIMO dia útil", () => {
    const t = Date.parse("2026-08-11T22:00:00.000Z"); // terça 11/08, 19h BRT
    expect(new Date(fimDoExpedienteAPartir(t)).toISOString()).toBe("2026-08-12T20:00:00.000Z");
  });

  it("num fim de semana (sábado), devolve o fim do expediente da segunda-feira seguinte", () => {
    const t = Date.parse("2026-08-15T15:00:00.000Z"); // sábado 15/08, meio-dia
    expect(new Date(fimDoExpedienteAPartir(t)).toISOString()).toBe("2026-08-17T20:00:00.000Z"); // segunda 17/08, 17h BRT
  });
});
```

(11/08/2026 = terça-feira; 15/08/2026 = sábado; 17/08/2026 = segunda-feira — conferido por cálculo de calendário nesta rodada.)

- [ ] **Step 2: Rodar, confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/automations/horario-comercial.test.ts -t fimDoExpedienteAPartir"`
Expected: FAIL.

- [ ] **Step 3: Implementar (versão corrigida — a 1ª tentativa devolvia meio-dia no lugar de 17h)**

```typescript
/**
 * Fim (epoch ms) do EXPEDIENTE DO DIA — 17h do dia útil relevante:
 * se `t` cai dentro de um bloco de expediente, o fim desse bloco (só
 * bate com "fim do dia" quando `t` já está no bloco da tarde); se `t`
 * está fora de todo bloco mas ainda é hoje e antes das 17h (antes de
 * abrir, ou no almoço), o fim do ÚLTIMO bloco de HOJE (17h); se já
 * passou das 17h ou não é dia útil, o fim do último bloco do PRÓXIMO
 * dia útil.
 */
export function fimDoExpedienteAPartir(t: number): number {
  const ULTIMO_FIM = EXPEDIENTE[EXPEDIENTE.length - 1][1]; // 17*60
  if (dentroDoExpediente(t)) {
    const dia = meiaNoiteBrt(t);
    const minuto = minutoDoDiaBrt(t);
    for (const [ini, fim] of EXPEDIENTE) {
      if (minuto >= ini && minuto < fim) return dia + fim * MS_MIN;
    }
  }
  if (ehDiaUtil(t) && minutoDoDiaBrt(t) < ULTIMO_FIM) {
    return meiaNoiteBrt(t) + ULTIMO_FIM * MS_MIN;
  }
  const proximoDiaUtil = proximoInstanteDeExpediente(t);
  return meiaNoiteBrt(proximoDiaUtil) + ULTIMO_FIM * MS_MIN;
}
```

- [ ] **Step 4: Rodar, confirmar que passa; commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/automations/horario-comercial.test.ts && git add src/lib/automations/horario-comercial.ts src/lib/automations/horario-comercial.test.ts && git commit -m 'feat: fimDoExpedienteAPartir calcula fim do expediente do dia (17h), nao do bloco mais proximo'"
```

- [ ] **Step 5: Escrever os testes do `wait` com `until`**

Em `src/lib/flows/engine.test.ts`, criar `describe("dispatchInboundToFlows — wait node com until (alvo dinâmico)", ...)`. Usa o padrão REAL confirmado no arquivo (o teste "nó atual não é wait — ramo novo não interfere no collect_input já existente", que entra num nó parando em `collect1` e deixa o `collect_input` AVANÇAR PRA DENTRO do nó sob teste, em vez de simular uma resposta a um nó já ativo — isso é o que de fato exercita o bloco que agenda `flow_pending_resumes`). Datas relativas a `Date.now()`, nunca uma data absoluta fixa (achado #6):

```typescript
describe("dispatchInboundToFlows — wait node com until (alvo dinâmico)", () => {
  it("until.mode='before_var' agenda run_at = var menos hours_before", async () => {
    const bookingIso = new Date(Date.now() + 30 * 86_400_000).toISOString(); // sempre no futuro
    h.state.activeRun = waitRun({
      current_node_key: "collect1",
      vars: { booking_inicio_iso: bookingIso },
    });
    h.state.nodeRows = [
      node({
        node_key: "collect1",
        node_type: "collect_input",
        config: { prompt_text: "x", var_key: "nome", next_node_key: "wait1" },
      }),
      node({
        node_key: "wait1",
        node_type: "wait",
        config: {
          unit: "hours",
          amount: 1,
          next_node_key: "timeout_end",
          until: { mode: "before_var", var_key: "booking_inicio_iso", hours_before: 18 },
        },
      }),
      node({ node_key: "timeout_end", node_type: "end", config: {} }),
    ];

    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "qualquer coisa", meta_message_id: "m1" },
      isFirstInboundMessage: false,
    });

    expect(h.state.insertedPendingResumes).toHaveLength(1);
    expect(h.state.insertedPendingResumes[0].node_key).toBe("wait1");
    expect(new Date(h.state.insertedPendingResumes[0].run_at as string).getTime()).toBe(
      Date.parse(bookingIso) - 18 * 3_600_000,
    );
  });

  it("until.mode='before_var' com alvo já passado agenda pra agora (sem negativo)", async () => {
    const passado = new Date(Date.now() - 3_600_000).toISOString();
    h.state.activeRun = waitRun({
      current_node_key: "collect1",
      vars: { booking_inicio_iso: passado },
    });
    h.state.nodeRows = [
      node({
        node_key: "collect1",
        node_type: "collect_input",
        config: { prompt_text: "x", var_key: "nome", next_node_key: "wait1" },
      }),
      node({
        node_key: "wait1",
        node_type: "wait",
        config: {
          unit: "hours",
          amount: 1,
          next_node_key: "timeout_end",
          until: { mode: "before_var", var_key: "booking_inicio_iso", hours_before: 1 },
        },
      }),
      node({ node_key: "timeout_end", node_type: "end", config: {} }),
    ];

    const before = Date.now();
    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "oi", meta_message_id: "m2" },
      isFirstInboundMessage: false,
    });

    const runAt = new Date(h.state.insertedPendingResumes[0].run_at as string).getTime();
    expect(runAt).toBeGreaterThanOrEqual(before);
  });

  it("sem until, continua usando unit/amount (compatibilidade)", async () => {
    h.state.activeRun = waitRun({ current_node_key: "collect1" });
    h.state.nodeRows = [
      node({
        node_key: "collect1",
        node_type: "collect_input",
        config: { prompt_text: "x", var_key: "nome", next_node_key: "wait1" },
      }),
      node({
        node_key: "wait1",
        node_type: "wait",
        config: { unit: "hours", amount: 2, next_node_key: "timeout_end" },
      }),
      node({ node_key: "timeout_end", node_type: "end", config: {} }),
    ];

    const before = Date.now();
    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "oi", meta_message_id: "m4" },
      isFirstInboundMessage: false,
    });

    const runAt = new Date(h.state.insertedPendingResumes[0].run_at as string).getTime();
    expect(runAt).toBeGreaterThanOrEqual(before + 7_200_000 - 1_000);
    expect(runAt).toBeLessThanOrEqual(before + 7_200_000 + 5_000);
  });
});
```

Isto usa `h.state.insertedPendingResumes` e `isFirstInboundMessage` (campo real de `DispatchInboundInput`, confirmado lendo chamadas existentes no arquivo — conferir se ele é de fato obrigatório ou opcional antes de assumir, mas incluí-lo sempre é seguro). Adicionar `insertedPendingResumes: [] as Record<string, unknown>[],` ao `h.state` hoisted, resetar no `beforeEach`. No `resolve(ops)` deste arquivo (`flows/engine.test.ts`), dentro do bloco `if (table === "flow_pending_resumes") { ... }`, que hoje só trata `type === "update"`, adicionar o ramo de insert:

```typescript
    if (table === "flow_pending_resumes") {
      if (type === "update") {
        state.pendingResumeUpdates.push({ payload, filters });
      }
      if (type === "insert") {
        state.insertedPendingResumes.push(payload as Record<string, unknown>);
      }
      return { data: null, error: null };
    }
```

- [ ] **Step 6: Rodar, confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts -t 'wait node com until'"`
Expected: FAIL.

- [ ] **Step 7: Implementar `WaitUntilConfig` + `computeWaitRunAt`**

Em `src/lib/flows/types.ts`:

```typescript
export type WaitUntilConfig =
  | {
      mode: "before_var";
      var_key: string;
      hours_before: number;
    }
  | {
      mode: "end_of_business_day";
    };

export interface WaitNodeConfig {
  unit: "minutes" | "hours" | "days";
  amount: number;
  next_node_key: string;
  keyword_branches?: {
    trigger: KeywordTriggerConfig;
    next_node_key: string;
  }[];
  until?: WaitUntilConfig;
}
```

Em `src/lib/flows/engine.ts`, importar `fimDoExpedienteAPartir` de `@/lib/automations/horario-comercial`, adicionar perto de `waitMs`:

```typescript
export function computeWaitRunAt(
  cfg: { unit: "minutes" | "hours" | "days"; amount: number; until?: WaitUntilConfig },
  vars: Record<string, unknown>,
): number {
  if (!cfg.until) return Date.now() + waitMs(cfg);
  if (cfg.until.mode === "end_of_business_day") {
    return fimDoExpedienteAPartir(Date.now());
  }
  const raw = vars[cfg.until.var_key];
  const varTs = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (Number.isNaN(varTs)) return Date.now();
  return Math.max(varTs - cfg.until.hours_before * 3_600_000, Date.now());
}
```

E no bloco do nó `wait` dentro de `advanceFromNodeKey`, trocar `const runAt = new Date(Date.now() + waitMs(cfg));` por `const runAt = new Date(computeWaitRunAt(cfg, run.vars));`.

- [ ] **Step 8: Rodar, confirmar que passa; rodar a suíte inteira do projeto**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run"`
Expected: só as 2 falhas pré-existentes de `date-utils.test.ts` (sem relação).

- [ ] **Step 9: Commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add src/lib/flows/types.ts src/lib/flows/engine.ts src/lib/flows/engine.test.ts && git commit -m 'feat: wait aceita alvo dinamico (until)'"
```

⚠️ **Achado real R2 da 3ª auditoria — `confirmar`/`perguntar_urgencia` (Task 8) usam timeout fixo de 24h; pra uma reunião marcada com menos de 24h de antecedência, o timeout dispara DEPOIS da reunião já ter acontecido.** Nenhum dos dois modos de `WaitUntilConfig` de cima resolve isso sozinho — `before_var` sozinho ("esperar até a reunião") seria bom pra prazo curto mas péssimo pra prazo longo (esperaria 30 dias se a reunião for daqui a 30 dias); um valor fixo (24h) é bom pro prazo longo mas ruim pro curto. É preciso o MENOR dos dois.

⚠️ **Achado MINOR da 5ª auditoria — import faltando.** `src/lib/flows/engine.test.ts` importa hoje 10 nomes de `./engine` (linha ~212-223). Os testes abaixo (e os de `resumeWaitingFlow` que a Task 4 acrescenta) chamam `computeWaitRunAt`/`resumeWaitingFlow` DIRETO, não só através de `dispatchInboundToFlows` — conferir se esses dois nomes já estão nesse bloco de import antes de colar os testes; se não estiverem, acrescentar ali, não como um `import` novo solto no meio do arquivo.

- [ ] **Step 10: Escrever o teste do modo novo**

```typescript
describe("computeWaitRunAt — sooner_of_hours_or_var", () => {
  it("reunião distante: usa o limite de horas (não espera até a reunião)", () => {
    const daqui30dias = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const runAt = computeWaitRunAt(
      { unit: "hours", amount: 0, until: { mode: "sooner_of_hours_or_var", hours: 24, var_key: "booking_inicio_iso", margin_minutes: 60 } },
      { booking_inicio_iso: daqui30dias },
    );
    expect(runAt).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000 + 1_000);
    expect(runAt).toBeGreaterThanOrEqual(Date.now() + 24 * 3_600_000 - 1_000);
  });

  it("reunião próxima (menos de 24h): usa o horário da reunião MENOS a margem, não o horário exato dela", () => {
    const daqui3h = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const runAt = computeWaitRunAt(
      { unit: "hours", amount: 0, until: { mode: "sooner_of_hours_or_var", hours: 24, var_key: "booking_inicio_iso", margin_minutes: 60 } },
      { booking_inicio_iso: daqui3h },
    );
    const alvo = Date.parse(daqui3h) - 60 * 60_000;
    expect(runAt).toBeLessThanOrEqual(alvo + 1_000);
    expect(runAt).toBeGreaterThanOrEqual(alvo - 1_000);
  });

  it("var ausente: cai pro limite de horas", () => {
    const runAt = computeWaitRunAt(
      { unit: "hours", amount: 0, until: { mode: "sooner_of_hours_or_var", hours: 24, var_key: "booking_inicio_iso", margin_minutes: 60 } },
      {},
    );
    expect(runAt).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000 + 1_000);
  });

  it("reunião MUITO próxima (menos que a margem): nunca devolve horário no passado — trava em 'agora'", () => {
    const daqui10min = new Date(Date.now() + 10 * 60_000).toISOString();
    const runAt = computeWaitRunAt(
      { unit: "hours", amount: 0, until: { mode: "sooner_of_hours_or_var", hours: 24, var_key: "booking_inicio_iso", margin_minutes: 60 } },
      { booking_inicio_iso: daqui10min },
    );
    // reunião - 60min já passou (reunião é daqui a só 10min) — clampa em agora,
    // nunca no passado. Achado real R2/REAL-BUG-7 (3ª/4ª auditoria): sem essa
    // margem, o timeout resolvia EXATAMENTE no horário da reunião, e a cadeia
    // downstream (checar_prazo_curto → esperar_1h) mandava "sua reunião é
    // daqui a 1 hora" DEPOIS da reunião já ter acontecido.
    expect(runAt).toBeGreaterThanOrEqual(Date.now() - 1_000);
    expect(runAt).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});
```

- [ ] **Step 11: Rodar, confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts -t sooner_of_hours_or_var"`
Expected: FAIL.

- [ ] **Step 12: Implementar**

Em `src/lib/flows/types.ts`, estender `WaitUntilConfig`:

```typescript
export type WaitUntilConfig =
  | {
      mode: "before_var";
      var_key: string;
      hours_before: number;
    }
  | {
      mode: "end_of_business_day";
    }
  | {
      /** O MENOR dos dois: `hours` a partir de agora, OU o timestamp da
       *  var MENOS `margin_minutes` — o que vier primeiro. Existe pra
       *  timeouts que precisam de um teto (não esperar pra sempre numa
       *  reunião distante) MAS também não podem ultrapassar um evento
       *  que pode estar bem mais perto que o teto (reunião marcada pra
       *  daqui a poucas horas).
       *
       *  ⚠️ REAL-BUG-7 (4ª auditoria): a margem é OBRIGATÓRIA, não
       *  cosmética. Sem ela, pra uma reunião próxima o resultado é o
       *  horário EXATO da reunião — e nós que encadeiam outro `wait`
       *  relativo à MESMA var (ex.: `esperar_1h` com `before_var
       *  hours_before:1`) acabam calculando um alvo já no passado,
       *  clampam em "agora" e mandam "sua reunião é daqui a 1 hora"
       *  DEPOIS da reunião já ter acontecido. `margin_minutes` garante
       *  que este nó sempre resolve ANTES da reunião, com folga
       *  suficiente pra cadeia downstream ainda fazer sentido. */
      mode: "sooner_of_hours_or_var";
      hours: number;
      var_key: string;
      margin_minutes: number;
    };
```

Em `src/lib/flows/engine.ts`, dentro de `computeWaitRunAt`, adicionar o ramo (antes do `before_var` existente ou depois, tanto faz — são mutuamente exclusivos por `mode`):

```typescript
  if (cfg.until.mode === "sooner_of_hours_or_var") {
    const byHours = Date.now() + cfg.until.hours * 3_600_000;
    const raw = vars[cfg.until.var_key];
    const varTs = typeof raw === "string" ? Date.parse(raw) : NaN;
    const marginMs = cfg.until.margin_minutes * 60_000;
    const byVar = Number.isNaN(varTs) ? byHours : varTs - marginMs;
    return Math.max(Math.min(byHours, byVar), Date.now());
  }
```

- [ ] **Step 13: Rodar, confirmar que passa; rodar a suíte inteira; commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run && git add src/lib/flows/types.ts src/lib/flows/engine.ts src/lib/flows/engine.test.ts && git commit -m 'feat: wait/timeout ganha sooner_of_hours_or_var, evita disparar depois da reuniao'"
```

(Task 8, mais abaixo neste arquivo, usa `sooner_of_hours_or_var` em `confirmar` e `perguntar_urgencia` — os dois blocos LÁ já foram atualizados com `margin_minutes: 60`, achado REAL-BUG-7 da 4ª auditoria. Rodar Task 8 DEPOIS desta Task 3 completa, já que o grafo depende do modo novo existir.)

---

### Task 4: `send_buttons` ganha `timeout` roteável E interpolação `{{vars.X}}`

**Files:**
- Modify: `src/lib/flows/types.ts`, `src/lib/flows/engine.ts`
- Test: `src/lib/flows/engine.test.ts`

⚠️ **`timeout` aceita `unit`/`amount` fixos OU `until` dinâmico** (mesma forma de `WaitNodeConfig`) — o Fluxo No-show (Task 9) precisa de "esperar exatos 2 dias", que nenhum modo de `WaitUntilConfig` expressa sozinho.

- [ ] **Step 1: Escrever o teste que falha pra interpolação (bug pré-existente, achado #1)**

```typescript
describe("dispatchInboundToFlows — send_buttons interpola {{vars.X}}", () => {
  it("bodyText/headerText/footerText são interpolados antes de mandar pro WhatsApp", async () => {
    h.state.activeRun = waitRun({
      current_node_key: "collect1",
      vars: { booking_rotulo: "12/09 14:00" },
    });
    h.state.nodeRows = [
      node({
        node_key: "collect1",
        node_type: "collect_input",
        config: { prompt_text: "x", var_key: "nome", next_node_key: "confirmar" },
      }),
      node({
        node_key: "confirmar",
        node_type: "send_buttons",
        config: {
          text: "Reunião marcada para {{vars.booking_rotulo}}.",
          header_text: "Aviso — {{vars.booking_rotulo}}",
          buttons: [{ reply_id: "sim", title: "Sim", next_node_key: "fim" }],
        },
      }),
      node({ node_key: "fim", node_type: "end", config: {} }),
    ];

    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "oi", meta_message_id: "m5" },
      isFirstInboundMessage: false,
    });

    expect(engineSendInteractiveButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyText: "Reunião marcada para 12/09 14:00.",
        headerText: "Aviso — 12/09 14:00",
      }),
    );
  });
});
```

Adicionar `import { engineSendInteractiveButtons } from "./meta-send";` ao topo do arquivo (o mock já EXPORTA esse `vi.fn` — só falta o teste importar pra poder fazer asserção contra ele, mesmo padrão já usado pra `engineSendInteractiveList`).

- [ ] **Step 2: Rodar, confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts -t 'interpola'"`
Expected: FAIL — `bodyText` chega cru (`"Reunião marcada para {{vars.booking_rotulo}}."`).

- [ ] **Step 3: Corrigir `sendButtonsAndSuspend` (e `sendListAndSuspend`, mesmo bug)**

Em `src/lib/flows/engine.ts`, dentro de `sendButtonsAndSuspend`:

```typescript
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    headerText: cfg.header_text ? interpolateVars(cfg.header_text, run.vars) : undefined,
    footerText: cfg.footer_text ? interpolateVars(cfg.footer_text, run.vars) : undefined,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
  });
```

Dentro de `sendListAndSuspend`, mesma ideia pro `bodyText`/`headerText`/`footerText` dela.

- [ ] **Step 4: Rodar, confirmar que passa**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts"`
Expected: PASS — toda a suíte do arquivo (o texto de OUTROS testes de `send_buttons` que já existiam não tinha `{{vars}}`, então não deveria mudar de comportamento).

- [ ] **Step 5: Commit deste fix isolado**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add src/lib/flows/engine.ts src/lib/flows/engine.test.ts && git commit -m 'fix: send_buttons/send_list interpolam vars no texto, mesmo padrao dos outros nos'"
```

- [ ] **Step 6: Escrever os testes do `timeout`**

```typescript
describe("dispatchInboundToFlows — send_buttons com timeout", () => {
  it("ao suspender com timeout.until, agenda um flow_pending_resumes pro prazo calculado", async () => {
    h.state.activeRun = waitRun({ current_node_key: "collect1" });
    h.state.nodeRows = [
      node({
        node_key: "collect1",
        node_type: "collect_input",
        config: { prompt_text: "x", var_key: "nome", next_node_key: "confirmar" },
      }),
      node({
        node_key: "confirmar",
        node_type: "send_buttons",
        config: {
          text: "Confirma?",
          buttons: [{ reply_id: "sim", title: "Sim", next_node_key: "fim_sim" }],
          timeout: { until: { mode: "end_of_business_day" }, next_node_key: "fim_timeout" },
        },
      }),
      node({ node_key: "fim_sim", node_type: "end", config: {} }),
      node({ node_key: "fim_timeout", node_type: "end", config: {} }),
    ];

    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "oi", meta_message_id: "m6" },
      isFirstInboundMessage: false,
    });

    expect(h.state.insertedPendingResumes).toHaveLength(1);
    expect(h.state.insertedPendingResumes[0].node_key).toBe("confirmar");
  });

  it("ao suspender com timeout.unit/amount fixos (sem until), agenda a duração simples", async () => {
    h.state.activeRun = waitRun({ current_node_key: "collect1" });
    h.state.nodeRows = [
      node({
        node_key: "collect1",
        node_type: "collect_input",
        config: { prompt_text: "x", var_key: "nome", next_node_key: "toque1" },
      }),
      node({
        node_key: "toque1",
        node_type: "send_buttons",
        config: {
          text: "Quer remarcar?",
          buttons: [{ reply_id: "sim", title: "Sim", next_node_key: "fim" }],
          timeout: { unit: "days", amount: 2, next_node_key: "toque2" },
        },
      }),
      node({ node_key: "fim", node_type: "end", config: {} }),
      node({ node_key: "toque2", node_type: "end", config: {} }),
    ];

    const before = Date.now();
    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "oi", meta_message_id: "m7" },
      isFirstInboundMessage: false,
    });

    const runAt = new Date(h.state.insertedPendingResumes.at(-1)!.run_at as string).getTime();
    expect(runAt).toBeGreaterThanOrEqual(before + 2 * 86_400_000 - 1_000);
    expect(runAt).toBeLessThanOrEqual(before + 2 * 86_400_000 + 5_000);
  });
});
```

⚠️ **Os dois testes de `resumeWaitingFlow` com `send_buttons` — sem precedente neste arquivo (`resumeWaitingFlow` HOJE NÃO TEM NENHUM TESTE, confirmado por busca — `grep resumeWaitingFlow` só acha a definição em `engine.ts`).** Isso significa que o mock de `flow_runs` para leitura por `id` (que `resumeWaitingFlow` faz via `.eq("id", pending.flow_run_id).maybeSingle()`) nunca foi exercitado e HOJE devolve `state.activeRun` **embrulhado num array** (`{ data: state.activeRun ? [state.activeRun] : [] }`) pra QUALQUER select nessa tabela que não seja insert/update — o que quebraria `resumeWaitingFlow` (`runRow.status` ficaria `undefined` num array, o guard do topo da função sempre bateria, e a função nunca chegaria a avançar nada). Antes de escrever esses dois testes, estender o `resolve()` de `flow_runs` pra devolver o objeto singular quando a query tem um filtro `["eq","id",<valor que bate com state.activeRun.id>]`:

```typescript
    if (table === "flow_runs") {
      if (type === "insert") { /* ...inalterado... */ }
      if (type === "update") { /* ...inalterado... */ }
      const idFilter = filters.find(([op, k]) => op === "eq" && k === "id");
      if (idFilter && state.activeRun && idFilter[2] === state.activeRun.id) {
        return { data: state.activeRun, error: null };
      }
      return { data: state.activeRun ? [state.activeRun] : [], error: null };
    }
```

(Ler o bloco `flow_runs` REAL do arquivo antes de colar — o trecho acima assume a estrutura já lida nesta sessão, mas o arquivo pode ter mudado; conferir os nomes exatos de `filters`/`payload` desestruturados no topo de `resolve`.) Só DEPOIS de fazer essa extensão, escrever:

```typescript
describe("resumeWaitingFlow — send_buttons com timeout vencido", () => {
  it("avança pro next_node_key do timeout quando ninguém respondeu", async () => {
    h.state.activeRun = waitRun({ id: "run-1", current_node_key: "confirmar" });
    h.state.nodeRows = [
      node({
        node_key: "confirmar",
        node_type: "send_buttons",
        config: {
          text: "Confirma?",
          buttons: [{ reply_id: "sim", title: "Sim", next_node_key: "fim_sim" }],
          timeout: { until: { mode: "end_of_business_day" }, next_node_key: "fim_timeout" },
        },
      }),
      node({ node_key: "fim_sim", node_type: "end", config: {} }),
      node({ node_key: "fim_timeout", node_type: "end", config: {} }),
    ];

    const db = supabaseAdmin();
    await resumeWaitingFlow(db, { id: "pend-1", flow_run_id: "run-1", node_key: "confirmar" });

    expect(
      h.state.flowRunEvents.some((e) => e.node_key === "fim_timeout" && e.event_type === "completed"),
    ).toBe(true);
  });

  it("não faz nada se current_node_key já mudou (cliente respondeu antes do timeout)", async () => {
    h.state.activeRun = waitRun({ id: "run-1", current_node_key: "fim_sim" }); // já avançou
    h.state.nodeRows = [
      node({
        node_key: "confirmar",
        node_type: "send_buttons",
        config: {
          text: "Confirma?",
          buttons: [{ reply_id: "sim", title: "Sim", next_node_key: "fim_sim" }],
          timeout: { until: { mode: "end_of_business_day" }, next_node_key: "fim_timeout" },
        },
      }),
      node({ node_key: "fim_sim", node_type: "end", config: {} }),
    ];

    const db = supabaseAdmin();
    await resumeWaitingFlow(db, { id: "pend-1", flow_run_id: "run-1", node_key: "confirmar" });

    expect(h.state.flowRunEvents.some((e) => e.node_key === "fim_timeout")).toBe(false);
  });
});
```

- [ ] **Step 7: Rodar, confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts -t 'timeout'"`
Expected: FAIL.

- [ ] **Step 8: Implementar `timeout` + estender `resumeWaitingFlow`**

Em `src/lib/flows/types.ts`, dentro de `SendButtonsNodeConfig`:

```typescript
  timeout?: {
    unit?: "minutes" | "hours" | "days";
    amount?: number;
    until?: WaitUntilConfig;
    next_node_key: string;
  };
```

⚠️ **Achado #NEW-7 da 2ª auditoria:** o bloco real `if (node.node_type === "send_buttons") {` em `advanceFromNodeKey` **NÃO declara `cfg`** — cada tipo de nó declara o seu próprio dentro do próprio `if`, e o de `send_buttons` hoje só usa `node.config` implicitamente dentro de `sendButtonsAndSuspend` (chamada, não inline). Sem declarar `cfg` aqui, o trecho abaixo não compila (`cfg` seria identificador livre). Em `src/lib/flows/engine.ts`, no bloco `if (node.node_type === "send_buttons") {`, ANTES do `await sendButtonsAndSuspend(...)`, adicionar a declaração, e só então, depois do `advanceCurrentNodeKey`, o `if (cfg.timeout)`:

```typescript
    if (node.node_type === "send_buttons") {
      const cfg = node.config as unknown as SendButtonsNodeConfig;
      await sendButtonsAndSuspend(db, run, node);
      const advanced = await advanceCurrentNodeKey(
        db, run.id, run.current_node_key, node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      if (cfg.timeout) {
        const runAt = new Date(
          computeWaitRunAt(
            { unit: cfg.timeout.unit ?? "hours", amount: cfg.timeout.amount ?? 0, until: cfg.timeout.until },
            run.vars,
          ),
        );
        await db.from("flow_pending_resumes").insert({
          flow_run_id: run.id,
          account_id: run.account_id,
          node_key: node.node_key,
          run_at: runAt.toISOString(),
          status: "pending",
        });
      }
      return { outcome: "advanced" };
    }
```

(Isto é o bloco INTEIRO — substituir o `if (node.node_type === "send_buttons") { ... }` existente por este, não colar só o trecho novo dentro do velho.)

⚠️ **Achado #NEW-8 da 2ª auditoria:** o guard real no topo de `resumeWaitingFlow` é `if (!node || node.node_type !== "wait") return;` — isto precisa virar `if (!node) return;` (só isso), porque senão o `if (node.node_type === "send_buttons")` abaixo nunca é alcançado (o guard antigo já teria retornado pra qualquer coisa que não seja `wait`). Substituir a função INTEIRA:

```typescript
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
  if (!node) return;
  if (node.node_type === "wait") {
    const cfg = node.config as unknown as WaitNodeConfig;
    await advanceFromNodeKey(db, runRow, cfg.next_node_key, nodes);
    return;
  }
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    if (cfg.timeout) {
      await logEvent(db, runRow.id, "node_entered", node.node_key, {
        reason: "suspend_timeout_fired",
      });
      await advanceFromNodeKey(db, runRow, cfg.timeout.next_node_key, nodes);
    }
    return;
  }
  if (node.node_type === "collect_input") {
    // Task 5 estende este mesmo padrão pro collect_input — ver aquele
    // Task antes de rodar esta função em produção; se a Task 5 ainda
    // não rodou, este bloco não existe e collect_input com timeout
    // (perguntar_urgencia) não tem como avançar sozinho. (Corrigido —
    // achado MINOR da 5ª auditoria; referência antiga dizia "Task 11".)
    const cfg = node.config as unknown as CollectInputNodeConfig;
    if (cfg.timeout) {
      await logEvent(db, runRow.id, "node_entered", node.node_key, {
        reason: "suspend_timeout_fired",
      });
      await advanceFromNodeKey(db, runRow, cfg.timeout.next_node_key, nodes);
    }
  }
}
```

(O ramo `collect_input` acima já vem pronto pra Task 11 — escrever agora evita reabrir esta função duas vezes; só passa a ser exercitado de verdade depois que `CollectInputNodeConfig.timeout` existir.)

- [ ] **Step 9: Rodar, confirmar que passa; rodar a suíte inteira**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run"`
Expected: só as 2 falhas pré-existentes de `date-utils.test.ts`.

⚠️ **Achado real R1 da 3ª auditoria — falta cancelar o `timeout` quando a resposta bate, e o grafo TEM loop.** O `wait` já cancela sua própria retomada pendente quando sai por `keyword_branches` (bloco em `handleReplyForActiveRun`, `.update({status:"cancelled"})` — já existe, não mexer nele). Mas quando um `send_buttons`/`collect_input` com `timeout` recebe a resposta certa (botão tocado, texto capturado) e avança, NADA cancela a linha de `flow_pending_resumes` que o Step 3 acima agendou — ela fica pendente. Isso não importa se o nó nunca é revisitado, mas o grafo da Task 8 TEM loop (`lembrete_vespera → aviso_reagendar_vespera → cancelar_para_reagendar → offer_slots → book_meeting → confirmar → … → esperar_vespera → lembrete_vespera`) — numa segunda passagem pelo MESMO `node_key`, a linha velha (calculada com o `booking_inicio_iso` ANTIGO, de antes do reagendamento) pode disparar por cima da run já reagendada, cancelando uma reunião que acabou de ser remarcada. `resumeWaitingFlow`'s guard (`current_node_key !== pending.node_key`) só protege enquanto o run está em OUTRO nó — não impede que a run volte a PARAR no mesmo node_key antes da linha velha disparar.

- [ ] **Step 11: Escrever o teste que falha**

```typescript
describe("dispatchInboundToFlows — send_buttons com timeout cancela a retomada ao receber resposta", () => {
  it("resposta certa cancela o flow_pending_resumes agendado por este nó", async () => {
    h.state.activeRun = waitRun({ current_node_key: "confirmar" });
    h.state.nodeRows = [
      node({
        node_key: "confirmar",
        node_type: "send_buttons",
        config: {
          text: "Confirma?",
          buttons: [{ reply_id: "sim", title: "Sim", next_node_key: "fim" }],
          timeout: { unit: "hours", amount: 24, next_node_key: "fim_timeout" },
        },
      }),
      node({ node_key: "fim", node_type: "end", config: {} }),
      node({ node_key: "fim_timeout", node_type: "end", config: {} }),
    ];

    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "interactive_reply", reply_id: "sim", reply_title: "Sim", meta_message_id: "m9" },
      isFirstInboundMessage: false,
    });

    expect(h.state.pendingResumeUpdates).toHaveLength(1);
    expect(h.state.pendingResumeUpdates[0].payload).toEqual({ status: "cancelled" });
    expect(h.state.pendingResumeUpdates[0].filters).toEqual([
      ["eq", "flow_run_id", "run-1"],
      ["eq", "node_key", "confirmar"],
      ["eq", "status", "pending"],
    ]);
  });
});
```

(Conferir contra `matchReplyId`/o bloco de `interactive_reply` real em `handleReplyForActiveRun` — `send_buttons` casa resposta via `matchReplyId(currentNode, message.reply_id)`, não via um dos ramos que a Task 3 já mostrou explicitamente; ler o código real pra confirmar o `message` shape exato que faz esse caminho casar antes de rodar o teste.)

- [ ] **Step 12: Rodar, confirmar que falha; implementar**

No bloco `if (matched) { ... }` de `handleReplyForActiveRun` (o mesmo bloco que já reseta `reprompt_count` e chama `advanceFromNodeKey` — existe HOJE, antes de qualquer mudança deste plano), adicionar a cancelação ANTES do `advanceFromNodeKey`:

```typescript
  if (matched) {
    await db
      .from("flow_runs")
      .update({ reprompt_count: 0 })
      .eq("id", run.id); // (linha já existente, condicional a reprompt_count !== 0 — não duplicar, só localizar)
    // Achado R1 (3ª auditoria) + Blocker 2 (4ª/5ª auditoria): cancela
    // qualquer timeout pendente deste nó — sem isto, um loop no grafo
    // (reagendar volta pro mesmo nó) pode deixar uma retomada calculada
    // com dado velho disparar por cima de uma run que já avançou de
    // verdade.
    // ⚠️ MAS: (1) o ramo `wait` (acima, dentro do loop de
    // `keyword_branches`, já existente antes deste plano) JÁ cancela sua
    // própria retomada antes de setar `matched` e cair aqui — cancelar
    // de novo faria o update disparar 2x, quebrando `engine.test.ts:683`
    // (esperava length 1). (2) A 5ª auditoria achou que o guard só por
    // `node_type !== "wait"` quebra OUTRO teste já existente,
    // `engine.test.ts:748` ("nó atual não é wait — ramo novo não
    // interfere no collect_input já existente") — ali o run para num
    // `collect_input` SEM `timeout` configurado, espera
    // `pendingResumeUpdates` com length 0, e o guard antigo cancelaria
    // mesmo sem ter nada pra cancelar. O guard certo não é "não é wait",
    // é "não é wait E o nó realmente tem um timeout configurado" — isso
    // resolve os dois de uma vez. `currentNode` JÁ EXISTE mais acima
    // nesta mesma função (é `nodes.get(run.current_node_key)`,
    // resolvido antes do `if (matched)`) — reusar essa variável, não
    // redeclarar (redeclarar aqui dentro faz sombra/shadow sobre ela,
    // achado MINOR da 5ª auditoria).
    if (currentNode?.node_type !== "wait" && (currentNode?.config as { timeout?: unknown } | undefined)?.timeout) {
      await db
        .from("flow_pending_resumes")
        .update({ status: "cancelled" })
        .eq("flow_run_id", run.id)
        .eq("node_key", run.current_node_key)
        .eq("status", "pending");
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
  }
```

(Isto é ADITIVO ao bloco `if (matched)` que já existe — inserir a chamada nova, não reescrever o bloco inteiro; ler o código real primeiro pra achar o ponto exato de inserção, porque a Task 3 já documentou este bloco com um comentário diferente sobre o reset de `reprompt_count` que não deve ser duplicado. Confirmar que `currentNode` já existe mais acima nesta mesma função — NÃO redeclarar.)

- [ ] **Step 12b: Escrever o teste que confirma o guard contra double-fire em `wait`, com o shape REAL de `keyword_branches`**

⚠️ **Achado da 5ª auditoria:** uma versão anterior deste Step usava `keyword_branches: [{ keyword: "sim", next_node_key: "fim_sim" }]` — campo `keyword` não existe. O shape real (`src/lib/flows/types.ts`, `WaitNodeConfig.keyword_branches`) é `{ trigger: KeywordTriggerConfig; next_node_key: string }[]`, e `KeywordTriggerConfig` é `{ keywords: string[]; match_type?: "exact"|"contains"; case_sensitive?: boolean }`. Sem `keywords`, `matchesKeywordTrigger` lança (`cfg.keywords?.length` sobre `undefined` já seria `undefined`, não lança — mas o achado real é que o campo errado faz o matcher nunca casar OU lançar dependendo da implementação exata; usar o shape certo evita o problema de qualquer jeito):

```typescript
describe("dispatchInboundToFlows — wait não duplica a cancelação de timeout no if(matched)", () => {
  it("nó wait com keyword_branches: pendingResumeUpdates tem exatamente 1 entrada, não 2", async () => {
    h.state.activeRun = waitRun({ current_node_key: "espera1" });
    h.state.nodeRows = [
      node({
        node_key: "espera1",
        node_type: "wait",
        config: {
          unit: "hours",
          amount: 24,
          until: { mode: "end_of_business_day" },
          next_node_key: "fim_timeout",
          keyword_branches: [{ trigger: { keywords: ["sim"] }, next_node_key: "fim_sim" }],
        },
      }),
      node({ node_key: "fim_sim", node_type: "end", config: {} }),
      node({ node_key: "fim_timeout", node_type: "end", config: {} }),
    ];

    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "sim", meta_message_id: "m10" },
      isFirstInboundMessage: false,
    });

    expect(h.state.pendingResumeUpdates).toHaveLength(1);
  });
});
```

⚠️ **Não pular este teste já existente:** `engine.test.ts:723-748`, `"nó atual não é wait — ramo novo não interfere no collect_input já existente"`, para o run num `collect_input` **sem** `timeout` configurado e espera `pendingResumeUpdates` com length **0**. Uma versão anterior deste guard (só `node_type !== "wait"`) quebrava esse teste, porque tentava cancelar mesmo sem nada pra cancelar — achado da 5ª auditoria. A checagem `&& (...)?.timeout` acrescentada no Step 12 resolve isso: sem `timeout` no config, a condição inteira é falsa, nada é cancelado, o teste continua passando como já passava antes desta Task.

- [ ] **Step 12c: Rodar, confirmar que passa (não precisa falhar antes — é teste de regressão pro guard que acabou de ser escrito no Step 12)**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts -t 'não duplica'"`
Expected: PASS.

- [ ] **Step 13: Rodar, confirmar que passa; rodar a suíte inteira; commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run && git add src/lib/flows/engine.ts src/lib/flows/engine.test.ts && git commit -m 'fix: cancela timeout pendente do no ao receber resposta, protege contra loop no grafo'"
```

---

### Task 5: `collect_input` (Fluxos) ganha `timeout` — mesma peça de `send_buttons`

**Files:**
- Modify: `src/lib/flows/types.ts` (`CollectInputNodeConfig.timeout`)
- Modify: `src/lib/flows/engine.ts` (bloco `collect_input`, `resumeWaitingFlow` — já deixado pronto na Task 4, Step 8, ver achado #NEW-8)
- Test: `src/lib/flows/engine.test.ts`

**Interfaces:**
- Consumes: `WaitUntilConfig`/`computeWaitRunAt` (Task 3).
- Produces: `CollectInputNodeConfig.timeout` — usado por `perguntar_urgencia` (Task 8), resolve o achado NEW-5 (pergunta de urgência sem timeout travava o run pra sempre).

- [ ] **Step 1: Escrever o teste que falha**

Em `src/lib/flows/engine.test.ts`, `describe("dispatchInboundToFlows — collect_input com timeout", ...)`, mesmo padrão de entrada-fresca-no-nó já usado nas Tasks 3-4 (um nó anterior avançando PRA DENTRO do `collect_input` sob teste):

```typescript
describe("dispatchInboundToFlows — collect_input com timeout", () => {
  it("ao suspender com timeout, agenda um flow_pending_resumes pro prazo calculado", async () => {
    h.state.activeRun = waitRun({ current_node_key: "collect_prev" });
    h.state.nodeRows = [
      node({
        node_key: "collect_prev",
        node_type: "collect_input",
        config: { prompt_text: "x", var_key: "nome", next_node_key: "pergunta" },
      }),
      node({
        node_key: "pergunta",
        node_type: "collect_input",
        config: {
          prompt_text: "Tem urgência?",
          var_key: "urgencia_texto",
          next_node_key: "fim_resposta",
          timeout: { unit: "hours", amount: 24, next_node_key: "fim_timeout" },
        },
      }),
      node({ node_key: "fim_resposta", node_type: "end", config: {} }),
      node({ node_key: "fim_timeout", node_type: "end", config: {} }),
    ];

    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "qualquer coisa", meta_message_id: "m8" },
      isFirstInboundMessage: false,
    });

    expect(h.state.insertedPendingResumes).toHaveLength(1);
    expect(h.state.insertedPendingResumes[0].node_key).toBe("pergunta");
  });

  it("resumeWaitingFlow avança pro next_node_key do timeout quando ninguém respondeu", async () => {
    h.state.activeRun = waitRun({ id: "run-1", current_node_key: "pergunta" });
    h.state.nodeRows = [
      node({
        node_key: "pergunta",
        node_type: "collect_input",
        config: {
          prompt_text: "Tem urgência?",
          var_key: "urgencia_texto",
          next_node_key: "fim_resposta",
          timeout: { unit: "hours", amount: 24, next_node_key: "fim_timeout" },
        },
      }),
      node({ node_key: "fim_resposta", node_type: "end", config: {} }),
      node({ node_key: "fim_timeout", node_type: "end", config: {} }),
    ];

    const db = supabaseAdmin();
    await resumeWaitingFlow(db, { id: "pend-1", flow_run_id: "run-1", node_key: "pergunta" });

    expect(
      h.state.flowRunEvents.some((e) => e.node_key === "fim_timeout" && e.event_type === "completed"),
    ).toBe(true);
  });
});
```

(⚠️ Blocker 1 da 4ª auditoria: uma versão anterior deste teste usava `start_node`/`start` como nó anterior, na teoria de que "start avança automaticamente sem esperar resposta". Isso está ERRADO — com uma run ativa, `dispatchInboundToFlows` vai direto pra `handleReplyForActiveRun`, cujos ramos só casam pra `interactive_reply`+`send_buttons`/`list`, `text`+`collect_input`, `text`+`wait`, `interactive_reply`+`offer_slots`. Um nó `start` não casa em NENHUM desses — `matched` ficava `null`, caía no fallback, o `collect_input` sob teste nunca era alcançado, e `insertedPendingResumes` ficava vazio mesmo com a implementação certa. Corrigido usando o MESMO padrão de dois `collect_input` em sequência que as Tasks 3-4 já usam: a run ativa começa em `collect_prev` — que É um `collect_input` válido pro ramo `text`+`collect_input` — captura a mensagem recebida, avança pra `pergunta` [o nó sob teste], e É NESSE AVANÇO que o `if (cfgTimeout)` do Step 3 roda e agenda o `flow_pending_resumes`. O 2º teste reaproveita a extensão do resolver de `flow_runs` por `id` já feita na Task 4.)

- [ ] **Step 2: Rodar, confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts -t 'collect_input com timeout'"`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Em `src/lib/flows/types.ts`, dentro de `CollectInputNodeConfig`:

```typescript
  /** Mesma forma do `timeout` de `SendButtonsNodeConfig` (Task 4) —
   *  se ninguém responder até o prazo, avança pra este nó em vez de
   *  esperar pra sempre. Perguntas abertas (sem botão) são as que MAIS
   *  precisam disto: ignorar é o caso comum, não a exceção. */
  timeout?: {
    unit?: "minutes" | "hours" | "days";
    amount?: number;
    until?: WaitUntilConfig;
    next_node_key: string;
  };
```

Em `src/lib/flows/engine.ts`, no bloco `if (node.node_type === "collect_input") {` dentro de `advanceFromNodeKey`, depois do `advanceCurrentNodeKey` que já existe (mesma posição relativa que a Task 4 usou pro `send_buttons`):

```typescript
      const cfgTimeout = (node.config as unknown as CollectInputNodeConfig).timeout;
      if (cfgTimeout) {
        const runAt = new Date(
          computeWaitRunAt(
            { unit: cfgTimeout.unit ?? "hours", amount: cfgTimeout.amount ?? 0, until: cfgTimeout.until },
            run.vars,
          ),
        );
        await db.from("flow_pending_resumes").insert({
          flow_run_id: run.id,
          account_id: run.account_id,
          node_key: node.node_key,
          run_at: runAt.toISOString(),
          status: "pending",
        });
      }
```

(`resumeWaitingFlow` já tem o ramo `collect_input` pronto — foi escrito antecipadamente na Task 4, Step 8, achado #NEW-8 — não precisa mexer nela de novo aqui, só rodar os testes. Achado real R7 da 3ª auditoria: entre o commit da Task 4 e o desta Task 5, a árvore fica com um `cfg.timeout` referenciando um campo que só passa a existir em `CollectInputNodeConfig` AGORA — `npx vitest run` não acusa isso, porque não faz typecheck. Não rodar `npm run build` nesse intervalo entre as duas Tasks; a suíte volta a compilar assim que este Step 3 terminar.)

- [ ] **Step 4: Rodar, confirmar que passa; rodar a suíte inteira**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run"`
Expected: só as 2 falhas pré-existentes.

- [ ] **Step 5: Commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add src/lib/flows/types.ts src/lib/flows/engine.ts src/lib/flows/engine.test.ts && git commit -m 'feat: collect_input aceita timeout, mesma forma do send_buttons'"
```

---

### Task 6: `condition` ganha o operador `hours_until_lt`

**Files:**
- Modify: `src/lib/flows/types.ts` (`ConditionOperator`)
- Modify: `src/lib/flows/engine.ts` (`evaluateConditionPredicate`)
- Test: `src/lib/flows/engine.test.ts`

**Interfaces:**
- Produces: `ConditionOperator` ganha `'hours_until_lt'` — usado por `checar_prazo_curto` (Task 8), resolve o achado NEW-4 (reunião de curto prazo quebrando a cadeia de lembretes).

- [ ] **Step 1: Escrever o teste que falha**

Localizar o `describe` existente de `evaluateConditionPredicate` (a função é pura, testável direto, sem precisar do mock de `dispatchInboundToFlows`) e adicionar:

```typescript
describe("evaluateConditionPredicate — hours_until_lt", () => {
  it("true quando o alvo está a menos horas de distância que o valor configurado", () => {
    const daqui10h = new Date(Date.now() + 10 * 3_600_000).toISOString();
    expect(
      evaluateConditionPredicate({
        operator: "hours_until_lt",
        subjectValue: daqui10h,
        configValue: "20",
      }),
    ).toBe(true);
  });

  it("false quando o alvo está a mais horas de distância que o valor configurado", () => {
    const daqui30h = new Date(Date.now() + 30 * 3_600_000).toISOString();
    expect(
      evaluateConditionPredicate({
        operator: "hours_until_lt",
        subjectValue: daqui30h,
        configValue: "20",
      }),
    ).toBe(false);
  });

  it("false quando o subject está ausente", () => {
    expect(
      evaluateConditionPredicate({
        operator: "hours_until_lt",
        subjectValue: undefined,
        configValue: "20",
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar, confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts -t hours_until_lt"`
Expected: FAIL (TypeScript nem aceita `"hours_until_lt"` como operator ainda — falha de tipo, ou em runtime se o teste rodar sem checagem estrita).

- [ ] **Step 3: Implementar**

Em `src/lib/flows/types.ts`:

```typescript
export type ConditionOperator =
  | "equals"
  | "contains"
  | "present"
  | "absent"
  | "keyword_match"
  | "hours_until_lt";
```

Em `src/lib/flows/engine.ts`, dentro de `evaluateConditionPredicate`, adicionar o case (a função já é um `switch (args.operator)` exaustivo — TypeScript aponta sozinho se faltar):

```typescript
    case "hours_until_lt": {
      if (args.subjectValue === undefined) return false;
      const targetTs = Date.parse(args.subjectValue);
      if (Number.isNaN(targetTs)) return false;
      const hoursUntil = (targetTs - Date.now()) / 3_600_000;
      return hoursUntil < Number(args.configValue ?? "0");
    }
```

- [ ] **Step 4: Rodar, confirmar que passa; rodar a suíte inteira**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run"`
Expected: só as 2 falhas pré-existentes.

- [ ] **Step 5: Commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add src/lib/flows/types.ts src/lib/flows/engine.ts src/lib/flows/engine.test.ts && git commit -m 'feat: condition ganha operador hours_until_lt'"
```

---

### Task 7: Tags-ponte + automações novas/ajustadas

**Files:**
- Create: `scripts/lib/seed-client.js`, `scripts/wire-automacoes-fluxo-agendamento.js`

- [ ] **Step 1: `scripts/lib/seed-client.js` (CommonJS — achado #10, `tsx` não está instalado)**

```javascript
const path = require('node:path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env.local') })
const { createClient } = require('@supabase/supabase-js')

function seedClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('seed-client: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes em .env.local')
  }
  return createClient(url, key)
}

// Casa por (coluna, account_id) — nao so pela coluna sozinha (achado
// #16: risco de casar linha de outra conta num schema que ja e
// multi-tenant em todo o resto).
async function upsertByUniqueColumn(db, table, column, accountId, row) {
  const { data: existing } = await db.from(table).select('*').eq(column, row[column]).eq('account_id', accountId).maybeSingle()
  if (existing) {
    const { data, error } = await db.from(table).update(row).eq('id', existing.id).select('*').single()
    if (error) throw new Error(`upsert ${table}.${row[column]}: ${error.message}`)
    return data
  }
  const { data, error } = await db.from(table).insert(row).select('*').single()
  if (error) throw new Error(`insert ${table}.${row[column]}: ${error.message}`)
  return data
}

// Guarda contra apagar flow_nodes debaixo de um run ativo (achado #14).
async function garantirSemRunAtivo(db, flowId) {
  if (!flowId) return
  const { count, error } = await db
    .from('flow_runs')
    .select('id', { count: 'exact', head: true })
    .eq('flow_id', flowId)
    .eq('status', 'active')
  if (error) throw new Error(`checagem de run ativo falhou: ${error.message}`)
  if (count && count > 0) {
    throw new Error(`ABORTADO: ${count} run(s) ativo(s) no flow ${flowId} — reseed apagaria flow_nodes debaixo deles. Esperar terminarem ou tratar manualmente.`)
  }
}

module.exports = { seedClient, upsertByUniqueColumn, garantirSemRunAtivo }
```

- [ ] **Step 2: `scripts/wire-automacoes-fluxo-agendamento.js`**

```javascript
const { seedClient, upsertByUniqueColumn } = require('./lib/seed-client')

const ACCOUNT_ID = '2569c0e9-5f2e-4d04-957c-e2f158e7a87e'
const USER_ID = 'be874c16-32b2-46c2-b5fa-45097dc62ff1'

const TAG_URGENTE = '9db3b56e-eecf-4b29-bace-2cc034b38f72'
const STAGE_FOLLOWUP_NOSHOW = '8c39cc10-4568-432f-b4dd-9a4ba228add6'
const STAGE_PERDIDO = '0d0382a5-f15d-4e43-88aa-0c70337d94d4'
const PIPELINE_VENDAS = '8e89e154-763c-4cf8-b73b-42f7368c59c3'
const AUTOMATION_FOLLOWUP_NOSHOW_ANTIGA = 'b6359cda-4516-4186-8937-d7c86a90c8c8'
const AUTOMATION_PERDEU_CONFIRMACAO = '6809f61f-0a02-4d1a-8a84-87598ac959ee'
const AUTOMATION_AGENDOU = 'f2347d27-201c-48c1-ac90-722a5d1b5ff8'

function argFlag(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : undefined
}

async function main() {
  const db = seedClient()
  const flowAgendamentoId = argFlag('flow-agendamento-id') || null
  const flowNoshowId = argFlag('flow-noshow-id') || null
  const ativarTudo = !!flowAgendamentoId && !!flowNoshowId

  const tagRemarcado = await upsertByUniqueColumn(db, 'tags', 'name', ACCOUNT_ID, {
    name: 'Remarcado via No-show', account_id: ACCOUNT_ID, user_id: USER_ID,
  })
  const tagPerdidoNoshow = await upsertByUniqueColumn(db, 'tags', 'name', ACCOUNT_ID, {
    name: 'Perdido via No-show', account_id: ACCOUNT_ID, user_id: USER_ID,
  })
  console.log('tags:', { tagRemarcado: tagRemarcado.id, tagPerdidoNoshow: tagPerdidoNoshow.id })

  const autoUrgente = await upsertByUniqueColumn(db, 'automations', 'name', ACCOUNT_ID, {
    name: 'Urgente (Fluxo) — notificação', account_id: ACCOUNT_ID, user_id: USER_ID,
    trigger_type: 'tag_added',
    trigger_config: { tag_id: TAG_URGENTE, somente_horario_comercial: false },
    is_active: true,
  })
  await db.from('automation_steps').delete().eq('automation_id', autoUrgente.id)
  await db.from('automation_steps').insert({
    automation_id: autoUrgente.id, position: 0, parent_step_id: null, branch: null,
    step_type: 'notify',
    step_config: {
      destinatario: 'todos',
      titulo: 'Lead sinalizou urgência (Fluxo de Agendamento)',
      corpo: 'Uma reunião em andamento no Fluxo de Agendamento recebeu sinal de urgência — vale olhar a conversa.',
      tipo: 'urgent_lead',
    },
  })

  const autoIniciaNoshow = await upsertByUniqueColumn(db, 'automations', 'name', ACCOUNT_ID, {
    name: 'Fluxo No-show — inicia', account_id: ACCOUNT_ID, user_id: USER_ID,
    trigger_type: 'deal_stage_changed',
    // somente_horario_comercial nao se aplica a deal_stage_changed (o
    // motor so le esse campo pra tag_added) — risco aceito e
    // documentado, achado #13.
    trigger_config: { stage_id: STAGE_FOLLOWUP_NOSHOW, pipeline_id: PIPELINE_VENDAS },
    // ⚠️ F2 (gate Task 0): NUNCA `ativarTudo` — este trigger
    // (deal_stage_changed na MESMA etapa/pipeline) é idêntico ao da
    // automação antiga "Follow up No-show — 3 toques e encerra"
    // (b6359cda-...), que fica ATIVA de propósito até a Task 15 (achado
    // RISK-9). Ativar os dois juntos faz TODO card novo entrando em
    // "Follow up No-show" a partir de hoje disparar os 3 toques antigos
    // E os 3 toques do Fluxo novo ao mesmo tempo — mesmo lead, duas
    // sequências de mensagem. Fica sempre `false` aqui; a ativação real
    // é um passo à parte na Task 15, no MESMO momento em que `b6359cda`
    // é desativada (nunca os dois ativos juntos).
    is_active: false,
  })
  await db.from('automation_steps').delete().eq('automation_id', autoIniciaNoshow.id)
  await db.from('automation_steps').insert({
    automation_id: autoIniciaNoshow.id, position: 0, parent_step_id: null, branch: null,
    step_type: 'start_flow',
    step_config: { flow_id: flowNoshowId || '' },
  })

  const autoRemarcado = await upsertByUniqueColumn(db, 'automations', 'name', ACCOUNT_ID, {
    name: 'Remarcado via No-show (Fluxo) — reinicia Agendamento', account_id: ACCOUNT_ID, user_id: USER_ID,
    trigger_type: 'tag_added',
    // ESTE respeita somente_horario_comercial (tag_added, o unico
    // trigger_type que o motor confere) — true, achado #13.
    trigger_config: { tag_id: tagRemarcado.id, somente_horario_comercial: true },
    is_active: ativarTudo,
  })
  await db.from('automation_steps').delete().eq('automation_id', autoRemarcado.id)
  await db.from('automation_steps').insert({
    automation_id: autoRemarcado.id, position: 0, parent_step_id: null, branch: null,
    step_type: 'start_flow',
    step_config: { flow_id: flowAgendamentoId || '' },
  })

  const autoPerdidoNoshow = await upsertByUniqueColumn(db, 'automations', 'name', ACCOUNT_ID, {
    name: 'Perdido via No-show (Fluxo) — move para Perdido', account_id: ACCOUNT_ID, user_id: USER_ID,
    trigger_type: 'tag_added',
    trigger_config: { tag_id: tagPerdidoNoshow.id, somente_horario_comercial: false },
    is_active: true,
  })
  await db.from('automation_steps').delete().eq('automation_id', autoPerdidoNoshow.id)
  await db.from('automation_steps').insert({
    automation_id: autoPerdidoNoshow.id, position: 0, parent_step_id: null, branch: null,
    step_type: 'move_deal',
    step_config: { stage_id: STAGE_PERDIDO, pipeline_id: PIPELINE_VENDAS, status: 'lost' },
  })

  // "Perdeu Confirmacao": move_deal na posicao 0, send_template na 1 —
  // ORDEM INVERTIDA de proposito (achado bloqueante #3): um throw no
  // send_template (template ainda nao aprovado, ver Task 9) NAO pode
  // impedir o card de mover, porque executeStepsFrom interrompe tudo
  // que vem DEPOIS do passo que lancou o erro.
  await db.from('automation_steps').delete().eq('automation_id', AUTOMATION_PERDEU_CONFIRMACAO)
  await db.from('automation_steps').insert([
    {
      automation_id: AUTOMATION_PERDEU_CONFIRMACAO, position: 0, parent_step_id: null, branch: null,
      step_type: 'move_deal',
      step_config: { stage_id: '8bd228cf-fba4-4b28-b704-068bdcfa7c8d', pipeline_id: PIPELINE_VENDAS },
    },
    {
      automation_id: AUTOMATION_PERDEU_CONFIRMACAO, position: 1, parent_step_id: null, branch: null,
      step_type: 'send_template',
      // variables:{} EXPLICITO (achado bloqueante #4) — sem isso o
      // engine faz auto-fill de {1:'{{nome}}'} e a Meta rejeita
      // (#132000) porque este template nao tem {{1}}.
      step_config: { template_name: 'horario_liberado_sem_confirmacao', variables: {} },
    },
  ])

  console.log('automações:', {
    autoUrgente: autoUrgente.id, autoIniciaNoshow: autoIniciaNoshow.id,
    autoRemarcado: autoRemarcado.id, autoPerdidoNoshow: autoPerdidoNoshow.id,
    perdeuConfirmacao: AUTOMATION_PERDEU_CONFIRMACAO,
  })

  // ⚠️ RISK-9 (4ª auditoria): as duas ações abaixo eram UMA SÓ (`ativarTudo`)
  // numa versão anterior — ligar as automações novas E desligar a "Follow
  // up No-show antiga" no mesmo flip. Isso presumia que a Task 15
  // (migração das 37 reuniões já agendadas, INCLUINDO os 13 leads que
  // estão HOJE nessa etapa) rodaria junto. Como a Task 15 foi adiada
  // (Blocker 3, 4ª auditoria — decisão do titular, ver nota "NÃO EXECUTAR
  // HOJE" na Task 15), desligar essa automação agora tiraria a ÚNICA
  // cobertura real desses 13 leads sem colocar nada no lugar — exatamente
  // o tipo de "automação some, cobertura zero, sem ninguém perceber" que
  // motivou toda esta rodada de correções. Por isso as duas ações são
  // INDEPENDENTES agora: a nova automação liga (novos leads, a partir de
  // hoje, passam pelo Fluxo), a antiga continua ligada até a Task 15
  // rodar de verdade e migrar quem já está nela.
  if (ativarTudo) {
    await db.from('automations').update({ is_active: true }).in('id', [AUTOMATION_AGENDOU, AUTOMATION_PERDEU_CONFIRMACAO])
    console.log('ativação aplicada: Agendou + Perdeu Confirmação ON.')
    console.log('⛔ Follow up No-show antiga (' + AUTOMATION_FOLLOWUP_NOSHOW_ANTIGA + ') NAO foi desativada — ' +
      'continua cobrindo os 13 leads reais que já estão nessa etapa até a Task 15 (migração) rodar. ' +
      'Desativar isso ANTES da migração real deixaria essas 13 pessoas sem cobertura nenhuma.')
  } else {
    console.log('flow_id ainda não informado — automações start_flow criadas com is_active:false.')
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

- [ ] **Step 3: Rodar sem os flow-id (1ª passada)**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && node scripts/wire-automacoes-fluxo-agendamento.js"`
Expected: imprime as 2 tags + 5 automações; `start_flow`-based saem `is_active:false`; "Urgente" e "Perdido via No-show" saem `true`.

- [ ] **Step 4: Verificação manual**

```bash
ssh root@100.85.48.50 'cd /root/wacrm && node -e "
require(\"dotenv\").config({path:\".env.local\"});
const { createClient } = require(\"@supabase/supabase-js\");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const { data } = await sb.from(\"automations\").select(\"name,trigger_type,is_active,automation_steps(step_type,step_config,position)\").in(\"name\", [\"Urgente (Fluxo) — notificação\",\"Fluxo No-show — inicia\",\"Remarcado via No-show (Fluxo) — reinicia Agendamento\",\"Perdido via No-show (Fluxo) — move para Perdido\",\"Perdeu Confirmação (Fluxo) — move para FUP\"]);
  console.log(JSON.stringify(data, null, 2));
})();
"'
```
Expected: `Perdeu Confirmação` mostra `move_deal` na posição 0 e `send_template` (com `variables:{}`) na posição 1.

- [ ] **Step 5: Commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add scripts/lib/seed-client.js scripts/wire-automacoes-fluxo-agendamento.js && git commit -m 'feat(seed): tags-ponte e automacoes do Fluxo No-show/Agendamento'"
```

---

### Task 8: Seed do `Fluxo de Agendamento` (30 nós)

**Depende da Task 5** (`collect_input` ganha `timeout`, usado por `perguntar_urgencia`) **e da Task 6** (`condition` ganha o operador `hours_until_lt`, usado por `checar_prazo_curto`) — as duas rodam ANTES desta Task.

**Files:** Create: `scripts/seed-fluxo-agendamento.js`

**Grafo corrigido — mudanças desde a 2ª auditoria:** `confirmar` ganha `timeout` de 24h (achado #11, 1ª auditoria); `perguntar_urgencia` ganha `timeout` de 24h (achado NEW-5, 2ª auditoria — depende da Task 5, corrigido — achado MINOR da 5ª auditoria, referência antiga dizia "Task 11" por engano); `checar_prazo_curto` é nó novo entre `marcar_agendou` e `esperar_vespera` (achado NEW-4 — depende da Task 6, corrigido — mesmo achado, referência antiga dizia "Task 12"); `lembrete_vespera` troca `timeout.until` de `end_of_business_day` pra `before_var hours_before:2` e o texto não afirma mais "é amanhã" nem "fim do expediente" (achados #5 + NEW-4); `on_timeout_hours` do Fluxo sobe de 72 pra 1200 (achado #2); `on_unknown_reply` vira `'ignore'` em vez de `'reprompt'` (achado NEW-9 — sem isso o Fluxo engole toda mensagem que não seja um botão/palavra-chave, calando a Márcia pelo tempo inteiro entre o agendamento e a reunião); toda tag-ponte (`Urgente`, `Agendou`, `Perdeu Confirmação`) ganha um `set_tag remove` imediatamente antes do `set_tag add` (achado #9).

**Nota de produto sobre `lembrete_vespera`:** a versão anterior usava `end_of_business_day` pro prazo de cancelamento — mesmo com `fimDoExpedienteAPartir` corrigida (Task 3), isso podia devolver um horário DEPOIS da própria reunião quando o `esperar_vespera` dispara à noite. Trocado pra `before_var hours_before:2` (cancela 2h antes da reunião, sempre por construção antes dela).

**Textos exatos:**

- `confirmar`: `"Prontinho! Sua reunião ficou marcada para {{vars.booking_rotulo}}.\n\nPreciso que você confirme sua presença — é só tocar no botão abaixo."`
- `aviso_reagendar`/`aviso_reagendar_vespera`: `"Sem problema! Vou liberar esse horário e já te mostro outras opções."`
- `perguntar_urgencia`: `"Show, já ficou confirmado! Só mais uma coisa antes de eu deixar você à vontade: existe alguma urgência no seu caso — conta bloqueada, processo já em andamento, prazo correndo?\n\nSe tiver, me conta aqui que já vou avisar o Dr. Zelmo e a Dra. Maria pra chegarem preparados. Se não, pode só me dizer \"não\" que sigo por aqui."`
- `lembrete_vespera`: `"Passando pra lembrar da sua reunião, {{vars.booking_rotulo}}.\n\nSe eu não tiver sua confirmação, vou liberar esse horário em breve para outro cliente que está esperando — prefiro muito mais te ver na reunião, mas preciso saber.\n\nPode confirmar por aqui?"` (achado NEW-4: não cita mais "amanhã" — o nó também é alcançado por reuniões de curto prazo, ver `checar_prazo_curto`)
- `lembrete_1h`: `"Já já é a hora! Sua reunião é daqui a 1 hora, {{vars.booking_rotulo}}.\n\nAté já!"`
- `pedir_email`: `"Pra eu deixar sua reunião confirmada, preciso do seu e-mail — é pra lá que vai o convite com o link da videochamada. Pode me passar?"`
- `pedir_email_invalido`: `"Esse e-mail não está recebendo mensagens — deve ter escapado um errinho de digitação.\n\nPode conferir e me mandar de novo? É para lá que vai o convite da videochamada."`
- `offer_slots.prompt_text`: `"Encontrei estes horários disponíveis pra sua reunião:"`

- [ ] **Step 1: Escrever `scripts/seed-fluxo-agendamento.js`**

```javascript
const { seedClient, upsertByUniqueColumn, garantirSemRunAtivo } = require('./lib/seed-client')

const ACCOUNT_ID = '2569c0e9-5f2e-4d04-957c-e2f158e7a87e'
const USER_ID = 'be874c16-32b2-46c2-b5fa-45097dc62ff1'
const TAG_URGENTE = '9db3b56e-eecf-4b29-bace-2cc034b38f72'
const TAG_AGENDOU = 'c0278b4c-8f17-416e-a7e4-b66b6e78315a'
const TAG_PERDEU_CONFIRMACAO = '19b12e9b-79c8-4a3d-812b-bcdbeef3e16b'

const PALAVRAS_REAGENDAR = { keywords: ['remarcar', 'reagendar', 'cancelar'], match_type: 'contains' }
const PALAVRAS_URGENCIA = {
  keywords: ['urgente', 'prazo', 'bloqueada', 'bloqueado', 'processo', 'citação', 'citacao', 'sim'],
  match_type: 'contains',
}

async function main() {
  const db = seedClient()

  const { data: existente } = await db.from('flows').select('id').eq('name', 'Fluxo de Agendamento').eq('account_id', ACCOUNT_ID).maybeSingle()
  await garantirSemRunAtivo(db, existente ? existente.id : null)

  const flow = await upsertByUniqueColumn(db, 'flows', 'name', ACCOUNT_ID, {
    name: 'Fluxo de Agendamento',
    account_id: ACCOUNT_ID,
    user_id: USER_ID,
    description: 'Canal A (Márcia): oferece horário, reserva, confirma, pergunta urgência, lembra, cancela por falta de confirmação. Entrada via [[AGENDAR]] em auto-reply.ts, usando startManualFlowRun.',
    status: 'active',
    trigger_type: 'manual',
    trigger_config: {},
    entry_node_id: null,
    // on_timeout_hours = 1200 (50 dias) — cobre o horizonte de 45 dias
    // do Cal.com com margem; 72h (valor original) matava o run de
    // qualquer reunião marcada com mais de 3 dias de antecedência
    // (achado bloqueante #2).
    //
    // on_unknown_reply = 'ignore' (achado NEW-9 da 2ª auditoria, não
    // 'reprompt') — com 'reprompt', QUALQUER mensagem do lead que não
    // bata com um botão/palavra-chave enquanto o Fluxo está ativo
    // (até 45 dias, do agendamento até a reunião) é ENGOLIDA: a Márcia
    // fica muda, e depois de 2 tentativas o run passa pra 'handoff' e
    // TODOS os lembretes restantes morrem junto. Com 'ignore', a
    // mensagem que não bate simplesmente NÃO é consumida pelo Fluxo —
    // cai pra Márcia normalmente, como se o Fluxo não existisse pra
    // aquele texto — enquanto os prazos do próprio Fluxo (agora todo
    // nó suspensivo tem `timeout`, ver Tasks 4 e 5 — corrigido, achado
    // MINOR da 5ª auditoria, referência antiga dizia "Tasks 4 e 11")
    // continuam
    // valendo e disparando sozinhos, sem depender de reprompt algum.
    fallback_policy: { on_unknown_reply: 'ignore', max_reprompts: 0, on_timeout_hours: 1200, on_exhaust: 'handoff' },
  })

  await db.from('flow_nodes').delete().eq('flow_id', flow.id)

  const nodes = [
    { node_key: 'start', node_type: 'start', config: { next_node_key: 'offer_slots' } },
    {
      node_key: 'offer_slots', node_type: 'offer_slots',
      config: {
        prompt_text: 'Encontrei estes horários disponíveis pra sua reunião:',
        button_label: 'Ver horários',
        result_var_key: 'horario_escolhido',
        next_node_key: 'book_meeting',
        no_slots_next_node_key: 'handoff_sem_horario',
      },
    },
    {
      node_key: 'book_meeting', node_type: 'book_meeting',
      config: {
        slot_var_key: 'horario_escolhido',
        email_var_key: 'email_capturado',
        success_next_node_key: 'confirmar',
        failure_next_node_keys: {
          indisponivel: 'offer_slots',
          sem_email: 'pedir_email',
          email_invalido: 'pedir_email_invalido',
          recusado: 'handoff_recusado',
          generico: 'handoff_generico',
        },
      },
    },
    {
      node_key: 'pedir_email', node_type: 'collect_input',
      config: {
        prompt_text: 'Pra eu deixar sua reunião confirmada, preciso do seu e-mail — é pra lá que vai o convite com o link da videochamada. Pode me passar?',
        var_key: 'email_capturado', next_node_key: 'book_meeting',
      },
    },
    {
      node_key: 'pedir_email_invalido', node_type: 'collect_input',
      config: {
        prompt_text: 'Esse e-mail não está recebendo mensagens — deve ter escapado um errinho de digitação.\n\nPode conferir e me mandar de novo? É para lá que vai o convite da videochamada.',
        var_key: 'email_capturado', next_node_key: 'book_meeting',
      },
    },
    { node_key: 'handoff_sem_horario', node_type: 'handoff', config: { note: 'Fluxo de Agendamento: sem horário livre no Cal.com.' } },
    { node_key: 'handoff_recusado', node_type: 'handoff', config: { note: 'Fluxo de Agendamento: Cal.com recusou a reserva.' } },
    { node_key: 'handoff_generico', node_type: 'handoff', config: { note: 'Fluxo de Agendamento: falha genérica ao reservar (Cal.com fora do ar / config ausente).' } },
    {
      // timeout de 24h fixas — sem isto, silêncio aqui prendia o run
      // até o sweep de 50 dias, sem nunca chegar na pergunta de
      // urgência nem no ciclo de véspera (achado real #11).
      node_key: 'confirmar', node_type: 'send_buttons',
      config: {
        text: 'Prontinho! Sua reunião ficou marcada para {{vars.booking_rotulo}}.\n\nPreciso que você confirme sua presença — é só tocar no botão abaixo.',
        buttons: [
          { reply_id: 'confirmar_presenca', title: 'Confirmar presença', next_node_key: 'perguntar_urgencia' },
          { reply_id: 'preciso_reagendar', title: 'Preciso reagendar', next_node_key: 'aviso_reagendar' },
        ],
        // sooner_of_hours_or_var (achado real R2, 3ª auditoria — ver
        // Task 3, Steps 10-13): 24h fixas sozinhas disparariam DEPOIS
        // da reunião pra quem marca com pouca antecedência.
        // margin_minutes: 60 (REAL-BUG-7, 4ª auditoria) — sem essa
        // folga, o timeout podia resolver EXATAMENTE no horário da
        // reunião, e a cadeia de véspera (que também olha
        // booking_inicio_iso) mandava aviso depois do fato consumado.
        timeout: { until: { mode: 'sooner_of_hours_or_var', hours: 24, var_key: 'booking_inicio_iso', margin_minutes: 60 }, next_node_key: 'perguntar_urgencia' },
      },
    },
    {
      node_key: 'aviso_reagendar', node_type: 'send_message',
      config: { text: 'Sem problema! Vou liberar esse horário e já te mostro outras opções.', next_node_key: 'cancelar_para_reagendar' },
    },
    { node_key: 'cancelar_para_reagendar', node_type: 'cancel_meeting', config: { next_node_key: 'offer_slots' } },
    {
      // timeout (achado NEW-5 da 2ª auditoria — Task 5 dá ao
      // collect_input a mesma capacidade de timeout que send_buttons
      // já tem desde a Task 4): sem isto, quem não responde a pergunta
      // opcional de urgência travava o run pra sempre — sem tag
      // Agendou, sem card movido, sem nenhum lembrete de véspera/1h.
      // Ignorar uma pergunta aberta é o caso COMUM, não a exceção.
      // Silêncio aqui é tratado como "sem urgência" — pula direto pro
      // ciclo de agendamento, sem passar por checar_urgencia (não há
      // urgencia_texto nenhum pra checar). sooner_of_hours_or_var pelo
      // mesmo motivo do nó `confirmar` acima (achado R2).
      node_key: 'perguntar_urgencia', node_type: 'collect_input',
      config: {
        prompt_text: 'Show, já ficou confirmado! Só mais uma coisa antes de eu deixar você à vontade: existe alguma urgência no seu caso — conta bloqueada, processo já em andamento, prazo correndo?\n\nSe tiver, me conta aqui que já vou avisar o Dr. Zelmo e a Dra. Maria pra chegarem preparados. Se não, pode só me dizer "não" que sigo por aqui.',
        var_key: 'urgencia_texto', next_node_key: 'checar_urgencia',
        // margin_minutes: 60 (REAL-BUG-7, 4ª auditoria) — mesmo motivo do nó `confirmar` acima.
        timeout: { until: { mode: 'sooner_of_hours_or_var', hours: 24, var_key: 'booking_inicio_iso', margin_minutes: 60 }, next_node_key: 'limpar_agendou' },
      },
    },
    {
      node_key: 'checar_urgencia', node_type: 'condition',
      config: {
        subject: 'var', subject_key: 'urgencia_texto', operator: 'keyword_match',
        keywords: PALAVRAS_URGENCIA, true_next: 'limpar_urgente', false_next: 'limpar_agendou',
      },
    },
    // Cada tag-ponte ganha um "remove" imediatamente antes do "add" —
    // contact_tags tem UNIQUE(contact_id,tag_id), reaplicar uma tag já
    // presente NÃO gera INSERT, e é o INSERT que acorda a automação
    // via webhook. Sem isto, um lead que passa pelo Fluxo 2 vezes fica
    // em silêncio na 2ª (achado real #9).
    { node_key: 'limpar_urgente', node_type: 'set_tag', config: { mode: 'remove', tag_id: TAG_URGENTE, next_node_key: 'marcar_urgente' } },
    { node_key: 'marcar_urgente', node_type: 'set_tag', config: { mode: 'add', tag_id: TAG_URGENTE, next_node_key: 'limpar_agendou' } },
    { node_key: 'limpar_agendou', node_type: 'set_tag', config: { mode: 'remove', tag_id: TAG_AGENDOU, next_node_key: 'marcar_agendou' } },
    { node_key: 'marcar_agendou', node_type: 'set_tag', config: { mode: 'add', tag_id: TAG_AGENDOU, next_node_key: 'checar_prazo_curto' } },
    {
      // Achado NEW-4 da 2ª auditoria: uma reunião marcada com poucas
      // horas de antecedência (o Cal.com oferece horário no MESMO
      // dia) não pode passar pelo ciclo de véspera — "sua reunião é
      // amanhã" fica errado, e o timeout de cancelamento de
      // lembrete_vespera (2h antes) pode vencer minutos depois de o
      // lead ter acabado de confirmar em `confirmar`. Reunião a menos
      // de 20h de distância pula direto pro ciclo de 1h antes.
      node_key: 'checar_prazo_curto', node_type: 'condition',
      config: {
        subject: 'var', subject_key: 'booking_inicio_iso', operator: 'hours_until_lt',
        value: '20', true_next: 'esperar_1h', false_next: 'esperar_vespera',
      },
    },
    {
      node_key: 'esperar_vespera', node_type: 'wait',
      config: {
        unit: 'hours', amount: 18, next_node_key: 'lembrete_vespera',
        until: { mode: 'before_var', var_key: 'booking_inicio_iso', hours_before: 18 },
        keyword_branches: [{ trigger: PALAVRAS_REAGENDAR, next_node_key: 'aviso_reagendar_vespera' }],
      },
    },
    {
      node_key: 'aviso_reagendar_vespera', node_type: 'send_message',
      config: { text: 'Sem problema! Vou liberar esse horário e já te mostro outras opções.', next_node_key: 'cancelar_para_reagendar' },
    },
    {
      // Texto ajustado (achado NEW-4) — não afirma mais "é amanhã":
      // esperar_vespera já garante que este nó só é alcançado por
      // reuniões com ≥20h de antecedência quando disparado no prazo
      // normal, mas o `until` ainda pode resolver pra "agora" se o
      // sweep atrasar por qualquer motivo operacional — texto que não
      // cita um dia específico nunca fica errado.
      node_key: 'lembrete_vespera', node_type: 'send_buttons',
      config: {
        text: 'Passando pra lembrar da sua reunião, {{vars.booking_rotulo}}.\n\nSe eu não tiver sua confirmação, vou liberar esse horário em breve para outro cliente que está esperando — prefiro muito mais te ver na reunião, mas preciso saber.\n\nPode confirmar por aqui?',
        buttons: [
          { reply_id: 'confirmar_presenca', title: 'Confirmar presença', next_node_key: 'esperar_1h' },
          { reply_id: 'preciso_reagendar', title: 'Preciso reagendar', next_node_key: 'aviso_reagendar_vespera' },
        ],
        // before_var, NÃO end_of_business_day — garante por construção
        // que o cancelamento acontece ANTES da reunião, mesmo quando o
        // lembrete de véspera dispara à noite (ver nota de produto
        // acima do script).
        timeout: { until: { mode: 'before_var', var_key: 'booking_inicio_iso', hours_before: 2 }, next_node_key: 'cancelar_sem_confirmacao' },
      },
    },
    {
      node_key: 'esperar_1h', node_type: 'wait',
      config: {
        unit: 'hours', amount: 1, next_node_key: 'lembrete_1h',
        until: { mode: 'before_var', var_key: 'booking_inicio_iso', hours_before: 1 },
        keyword_branches: [{ trigger: PALAVRAS_REAGENDAR, next_node_key: 'aviso_reagendar_vespera' }],
      },
    },
    {
      node_key: 'lembrete_1h', node_type: 'send_message',
      config: { text: 'Já já é a hora! Sua reunião é daqui a 1 hora, {{vars.booking_rotulo}}.\n\nAté já!', next_node_key: 'esperar_horario' },
    },
    {
      node_key: 'esperar_horario', node_type: 'wait',
      config: {
        unit: 'hours', amount: 1, next_node_key: 'fim_compareceu',
        until: { mode: 'before_var', var_key: 'booking_inicio_iso', hours_before: 0 },
      },
    },
    { node_key: 'fim_compareceu', node_type: 'end', config: {} },
    { node_key: 'cancelar_sem_confirmacao', node_type: 'cancel_meeting', config: { next_node_key: 'remover_tag_agendou' } },
    { node_key: 'remover_tag_agendou', node_type: 'set_tag', config: { mode: 'remove', tag_id: TAG_AGENDOU, next_node_key: 'limpar_perdeu_confirmacao' } },
    { node_key: 'limpar_perdeu_confirmacao', node_type: 'set_tag', config: { mode: 'remove', tag_id: TAG_PERDEU_CONFIRMACAO, next_node_key: 'marcar_perdeu_confirmacao' } },
    { node_key: 'marcar_perdeu_confirmacao', node_type: 'set_tag', config: { mode: 'add', tag_id: TAG_PERDEU_CONFIRMACAO, next_node_key: 'fim_perdeu_confirmacao' } },
    { node_key: 'fim_perdeu_confirmacao', node_type: 'end', config: {} },
  ]

  const inserted = await db.from('flow_nodes').insert(
    nodes.map((n) => ({ ...n, flow_id: flow.id, position_x: 0, position_y: 0 })),
  ).select('id, node_key')
  if (inserted.error) throw new Error(`insert flow_nodes: ${inserted.error.message}`)
  const startNode = inserted.data.find((n) => n.node_key === 'start')
  // entry_node_id GUARDA O node_key (TEXT), NÃO o id (UUID) do node.
  await db.from('flows').update({ entry_node_id: startNode.node_key }).eq('id', flow.id)

  console.log('Fluxo de Agendamento id:', flow.id, '| total de nós:', nodes.length)
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Rodar**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && node scripts/seed-fluxo-agendamento.js"`
Expected: `Fluxo de Agendamento id: <uuid> | total de nós: 30` — GUARDAR o id.

- [ ] **Step 3: Verificar o grafo (script de checagem de órfãos)**

```bash
ssh root@100.85.48.50 'cd /root/wacrm && node -e "
require(\"dotenv\").config({path:\".env.local\"});
const { createClient } = require(\"@supabase/supabase-js\");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const { data: flow } = await sb.from(\"flows\").select(\"*\").eq(\"name\",\"Fluxo de Agendamento\").single();
  const { data: nodes } = await sb.from(\"flow_nodes\").select(\"node_key,node_type,config\").eq(\"flow_id\", flow.id);
  console.log(\"total de nós:\", nodes.length, \"| entry_node_id:\", flow.entry_node_id);
  const chaves = new Set(nodes.map(n => n.node_key));
  const orfaos = [];
  for (const n of nodes) {
    const cfg = n.config || {};
    const alvos = [cfg.next_node_key, cfg.true_next, cfg.false_next, cfg.no_slots_next_node_key,
      cfg.success_next_node_key, ...(cfg.failure_next_node_keys ? Object.values(cfg.failure_next_node_keys) : []),
      cfg.timeout && cfg.timeout.next_node_key, ...(cfg.keyword_branches ? cfg.keyword_branches.map(k=>k.next_node_key) : []),
      ...((cfg.buttons||[]).map(b=>b.next_node_key))].filter(Boolean);
    for (const alvo of alvos) if (!chaves.has(alvo)) orfaos.push({de: n.node_key, para: alvo});
  }
  console.log(\"órfãos (deve ser vazio):\", JSON.stringify(orfaos));
})();
"'
```

Expected: `total de nós: 30` · `entry_node_id: start` · órfãos `[]`.

- [ ] **Step 4: Commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add scripts/seed-fluxo-agendamento.js && git commit -m 'feat(seed): grafo do Fluxo de Agendamento (30 nos, pos-auditoria)'"
```

---

### Task 9: Seed do `Fluxo No-show` (10 nós)

**Depende da Task 8** (flow_id real) **e da Task 7** (ids das tags-ponte, log `tags:`).

- [ ] **Step 1: Escrever `scripts/seed-fluxo-noshow.js`**

```javascript
const { seedClient, upsertByUniqueColumn, garantirSemRunAtivo } = require('./lib/seed-client')

const ACCOUNT_ID = '2569c0e9-5f2e-4d04-957c-e2f158e7a87e'
const USER_ID = 'be874c16-32b2-46c2-b5fa-45097dc62ff1'

const TAG_REMARCADO = process.argv[2]
const TAG_PERDIDO_NOSHOW = process.argv[3]
if (!TAG_REMARCADO || !TAG_PERDIDO_NOSHOW) {
  throw new Error('uso: node scripts/seed-fluxo-noshow.js <tag_remarcado_id> <tag_perdido_noshow_id>\n(ids impressos pela Task 7, Step 3, log "tags:")')
}

const BOTAO_REMARCAR = { reply_id: 'quero_remarcar', title: 'Quero remarcar' }
const BOTAO_NAO = { reply_id: 'nao_obrigado', title: 'Não, obrigado' }

async function main() {
  const db = seedClient()

  const { data: existente } = await db.from('flows').select('id').eq('name', 'Fluxo No-show').eq('account_id', ACCOUNT_ID).maybeSingle()
  await garantirSemRunAtivo(db, existente ? existente.id : null)

  const flow = await upsertByUniqueColumn(db, 'flows', 'name', ACCOUNT_ID, {
    name: 'Fluxo No-show',
    account_id: ACCOUNT_ID,
    user_id: USER_ID,
    description: 'Substitui a automação "Follow up No-show — 3 toques e encerra". Acordado via start_flow quando o card entra em "Follow up No-show".',
    status: 'active',
    trigger_type: 'manual',
    trigger_config: {},
    entry_node_id: null,
    // on_unknown_reply:'ignore', mesmo motivo do achado NEW-9 no Fluxo
    // de Agendamento (Task 8) — sem isso, um "oi" fora de hora enquanto
    // o No-show espera resposta calava a Márcia por até 6 dias (3
    // toques x 2 dias) até esgotar os reprompts.
    fallback_policy: { on_unknown_reply: 'ignore', max_reprompts: 0, on_timeout_hours: 240, on_exhaust: 'end' },
  })

  await db.from('flow_nodes').delete().eq('flow_id', flow.id)

  const nodes = [
    { node_key: 'start', node_type: 'start', config: { next_node_key: 'toque1' } },
    {
      node_key: 'toque1', node_type: 'send_buttons',
      config: {
        text: 'Notei que não conseguimos nos falar na reunião marcada. Quer que eu já veja um novo horário pra você?',
        buttons: [
          { ...BOTAO_REMARCAR, next_node_key: 'limpar_remarcado' },
          { ...BOTAO_NAO, next_node_key: 'limpar_perdido' },
        ],
        timeout: { unit: 'days', amount: 2, next_node_key: 'toque2' },
      },
    },
    {
      node_key: 'toque2', node_type: 'send_buttons',
      config: {
        text: 'Ainda dá tempo de remarcar, se fizer sentido pra você — é só me avisar.',
        buttons: [
          { ...BOTAO_REMARCAR, next_node_key: 'limpar_remarcado' },
          { ...BOTAO_NAO, next_node_key: 'limpar_perdido' },
        ],
        timeout: { unit: 'days', amount: 2, next_node_key: 'toque3' },
      },
    },
    {
      node_key: 'toque3', node_type: 'send_buttons',
      config: {
        text: 'Última tentativa por aqui — se quiser remarcar, é só chamar quando puder.',
        buttons: [
          { ...BOTAO_REMARCAR, next_node_key: 'limpar_remarcado' },
          { ...BOTAO_NAO, next_node_key: 'limpar_perdido' },
        ],
        timeout: { unit: 'days', amount: 2, next_node_key: 'limpar_perdido' },
      },
    },
    // remove-antes-de-add, mesmo motivo da Task 8 (achado real #9).
    { node_key: 'limpar_remarcado', node_type: 'set_tag', config: { mode: 'remove', tag_id: TAG_REMARCADO, next_node_key: 'marcar_remarcado' } },
    { node_key: 'marcar_remarcado', node_type: 'set_tag', config: { mode: 'add', tag_id: TAG_REMARCADO, next_node_key: 'fim_remarcado' } },
    { node_key: 'fim_remarcado', node_type: 'end', config: {} },
    { node_key: 'limpar_perdido', node_type: 'set_tag', config: { mode: 'remove', tag_id: TAG_PERDIDO_NOSHOW, next_node_key: 'marcar_perdido' } },
    { node_key: 'marcar_perdido', node_type: 'set_tag', config: { mode: 'add', tag_id: TAG_PERDIDO_NOSHOW, next_node_key: 'fim_perdido' } },
    { node_key: 'fim_perdido', node_type: 'end', config: {} },
  ]

  const inserted = await db.from('flow_nodes').insert(
    nodes.map((n) => ({ ...n, flow_id: flow.id, position_x: 0, position_y: 0 })),
  ).select('id, node_key')
  if (inserted.error) throw new Error(`insert flow_nodes: ${inserted.error.message}`)
  const startNode = inserted.data.find((n) => n.node_key === 'start')
  await db.from('flows').update({ entry_node_id: startNode.node_key }).eq('id', flow.id)

  console.log('Fluxo No-show id:', flow.id, '| total de nós:', nodes.length)
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Rodar**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && node scripts/seed-fluxo-noshow.js <tag_remarcado_id> <tag_perdido_noshow_id>"`
Expected: `Fluxo No-show id: <uuid> | total de nós: 10`.

- [ ] **Step 3: Verificar o grafo (mesmo script de checagem da Task 8, trocando o `name`)**

Expected: `entry_node_id: start` · órfãos `[]`.

- [ ] **Step 4: Commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add scripts/seed-fluxo-noshow.js && git commit -m 'feat(seed): grafo do Fluxo No-show (10 nos, pos-auditoria)'"
```

---

### Task 10: Religar `[[AGENDAR]]` (código) — ativação de dado fica pra Task 17

**Depende das Tasks 8 e 9.**

⚠️ **RISK-8 (4ª auditoria) — o flip de automações saiu daqui.** Uma versão anterior tinha, como Step 1 desta Task, rodar `wire-automacoes-fluxo-agendamento.js` (ativa "Agendou"/"Perdeu Confirmação", desativa a "Follow up No-show" antiga) NESTE PONTO — antes de qualquer build. Mas o motor só entende `case 'start_flow'` (Task 2) depois de um `npm run build && pm2 restart wacrm` de verdade, e o primeiro desses só acontece na Task 17 (ver nota da Task 11, achado REAL-BUG-4). Rodar o flip aqui abriria uma janela silenciosa: um card entrando em "Follow up No-show" entre este ponto e o build da Task 17 cairia no `default: return \`unknown step\`` do motor — sem erro, sem log, sem aviso, e o card simplesmente pararia de progredir. **O script de ativação (`wire-automacoes-fluxo-agendamento.js`) foi movido pra dentro da Task 17, depois do build+restart.** Esta Task fica só com as mudanças de CÓDIGO (inertes até build), que é seguro commitar sem deploy.

- [ ] **Step 1:** Em `src/lib/ai/auto-reply.ts`, trocar `const FLUXO_AGENDAMENTO_ID = ''` por `export const FLUXO_AGENDAMENTO_ID = '<uuid real>'`; reescrever o comentário/TODO acima (linhas 19-29) removendo "ainda não existe".
- [ ] **Step 2:** Em `src/lib/ai/auto-reply.test.ts`: importar `FLUXO_AGENDAMENTO_ID` de `./auto-reply`; linha 485, trocar `expect.anything(), ''` por `expect.anything(), FLUXO_AGENDAMENTO_ID`; reler linhas ~533-548/~559-583, remover a alegação "está vazio hoje" dos comentários (o comportamento do teste não muda — o mock de `startManualFlowRun` é configurado explicitamente em cada teste).
- [ ] **Step 3:** `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/ai/auto-reply.test.ts && npx vitest run"` — Expected: tudo verde (só as 2 falhas pré-existentes).
- [ ] **Step 4:** Commit: `git add src/lib/ai/auto-reply.ts src/lib/ai/auto-reply.test.ts && git commit -m 'feat: liga FLUXO_AGENDAMENTO_ID ao grafo real (codigo — ativacao de automacao vem na Task 17)'`.

⚠️ **Nada disto vai ao ar ainda** — `FLUXO_AGENDAMENTO_ID` só passa a valer depois do build da Task 17. Commitar é seguro; o efeito real fica pra lá.

---

## ⚠️ Tasks 11-13 — por que existem (achado da 2ª auditoria + correção de princípio do titular)

A 2ª auditoria independente achou que o Fluxo de Agendamento colide com código que **já está vivo em produção** — o `/root/intake/intake.js` (processo pm2, webhook do Cal.com) e o `webhook/route.ts` do wacrm — de um jeito que reproduziria exatamente o incidente de 09/08/2026 (mais de um sistema mexendo na mesma reunião sem se enxergar), só que agora entre o Fluxo novo e código antigo já rodando:

- **NEW-1:** toda reserva que o `book_meeting` do Fluxo faz no Cal.com dispara o MESMO webhook que o `intake.js` já escuta — e o `intake.js`, sem saber que existe um Fluxo, escreve no campo customizado que arma as 3 automações antigas de lembrete e move o card pra etapa antiga, por cima do que o Fluxo está fazendo.
- **NEW-2:** quando o Fluxo cancela uma reserva (`cancel_meeting`), o `intake.js` não reconhece esse cancelamento como "já tratado" e dispara a automação antiga de reagendamento por cima.
- **NEW-3:** o botão "Confirmar presença" do Fluxo tem o MESMO texto que um handler antigo hardcoded no webhook do wacrm (`vespera-buttons.ts`), que não checa se o Fluxo já tratou a mensagem — um toque gera duas respostas.

**Princípio do titular (repetido nesta sessão porque a 1ª tentativa de correção não cumpriu):** fluxos e automações vivem DENTRO do CRM, como dado configurável; código só existe pra dar CAPACIDADE nova ao motor, nunca pra codificar a regra de negócio em si num script solto. A 1ª correção desta rodada (descartada) ainda deixava a decisão real — aplicar tag, mover etapa, mandar confirmação — como código escrito à mão dentro do `intake.js`, só com um `if` de desvio na frente. Isso não muda a lógica de lugar, só esconde ela atrás de uma checagem.

**Desenho corrigido:**
1. `runAutomationsForTrigger` ganha 3 gatilhos novos — `calcom_booking_created`/`calcom_booking_rescheduled`/`calcom_booking_cancelled` (Task 11) — **isto é capacidade de motor**, no mesmo sentido que `tag_added`/`deal_stage_changed` já são: uma automação configurada na tela pode reagir a "chegou uma reserva do Cal.com", sem nenhum código bespoke por trás da REGRA em si.
2. Uma rota nova no wacrm (`/api/flows/calcom-booking`, Task 11) recebe o evento já resolvido (contato, uid, horário), confere se um Fluxo já é dono daquele contato — se for, não faz nada (o Fluxo já cuida) — e se NÃO for, dispara o gatilho novo. **A decisão "o que fazer quando chega uma reserva sem Fluxo" deixa de estar no código e passa a ser uma Automação de verdade**, com os passos que já existem (`add_tag`, `move_deal`, `send_template`) — dado, não script.
3. **Fronteira honesta, não escondida:** o `intake.js` de hoje tem nuances que uma Automação simples ainda não cobre (extrair telefone de formatos variados do payload do Cal.com, "card não regride de etapa", "Perdido não ressuscita", dedup por uid+data). Migrar TUDO isso pra dentro do motor (viraria capacidade nova de Automação: um passo `move_deal_se_a_frente`, uma checagem de dedup, etc.) é trabalho real e maior — e vale fazer, mas não dentro desta mesma virada, porque essas nuances hoje protegem tráfego de PRODUÇÃO de verdade (reservas de leads que NÃO passam pelo Fluxo — o Canal B, que ainda nem existe, e as reservas anteriores a este corte). Arriscar meio-migrar essa parte agora, sob pressão, é o tipo de atalho que já causou o histórico ruim deste projeto. **Por isso: o `intake.js` só passa a PERGUNTAR ao CRM se um Fluxo é dono antes de agir — a lógica de quando NÃO há Fluxo continua onde está, sem mudança nenhuma de comportamento, e o gatilho novo (`calcom_booking_created` etc.) já fica pronto, disponível, esperando a Automação de dado que vai substituir essa lógica quando o Canal B for construído de verdade.** Isto não é o mesmo atalho de novo — é uma fronteira clara, documentada, com o próximo passo já habilitado, em vez de um desvio escondido dentro do script.

---

### Task 11: Gatilhos de Automação pro Cal.com + rota de decisão no wacrm

**Files:**
- Modify: `src/types/index.ts` (`AutomationTriggerType`)
- Modify: `src/lib/automations/engine.ts` (`triggerMatches`)
- Create: `src/app/api/flows/calcom-booking/route.ts`
- Test: `src/lib/automations/engine.test.ts`

**Interfaces:**
- Produces: `AutomationTriggerType` ganha `'calcom_booking_created' | 'calcom_booking_rescheduled' | 'calcom_booking_cancelled'` — capacidade nova, disponível pra qualquer Automação configurada na tela reagir a evento do Cal.com, começando pela que vai substituir a lógica do `intake.js` quando o Canal B for construído. `POST /api/flows/calcom-booking` — consumido pelo `intake.js` na Task 12.

- [ ] **Step 1: Escrever o teste que falha (gatilho novo sempre bate quando ativo — sem config pra casar, mesmo padrão de `new_message_received`)**

Em `src/lib/automations/engine.test.ts`, junto do `describe("triggerMatches — tag_added", ...)` existente:

```typescript
describe("triggerMatches — calcom_booking_*", () => {
  function automation(trigger_type: string): Automation {
    return {
      id: "a1", account_id: ACCOUNT, user_id: "u1", name: "reserva cal.com",
      trigger_type: trigger_type as Automation["trigger_type"],
      trigger_config: {}, is_active: true, execution_count: 0, created_at: "", updated_at: "",
    };
  }

  it("calcom_booking_created bate sempre que a automacao estiver ativa (sem config pra casar)", () => {
    expect(triggerMatches(automation("calcom_booking_created"), {})).toBe(true);
  });
  it("calcom_booking_rescheduled bate sempre", () => {
    expect(triggerMatches(automation("calcom_booking_rescheduled"), {})).toBe(true);
  });
  it("calcom_booking_cancelled bate sempre", () => {
    expect(triggerMatches(automation("calcom_booking_cancelled"), {})).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar, confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/automations/engine.test.ts -t calcom_booking"`
⚠️ **Achado R5 da 3ª auditoria:** `triggerMatches` é uma sequência de `if`s terminando em `return true` (não um `switch` fechado) — um trigger_type não tratado hoje já cai nesse `return true` final, então os 3 testes acima **PASSAM antes do Step 3**, sem vermelho nenhum. Isto não invalida a implementação (ela continua correta e necessária — sem o `if` explícito, o comportamento de "sempre bate" ficaria por acidente, dependendo do fallback genérico, não de uma decisão deliberada pro trigger novo), só significa que este Step não serve como gate vermelho/verde de verdade — pular a expectativa de FAIL e ir direto pro Step 3, documentando que a suíte já passava antes (não é regressão, é a estrutura real da função).
Expected: os 3 testes já passam mesmo antes da Task 3 (Step 3) — confirmar isso é o próprio propósito deste Step, não um erro.

- [ ] **Step 3: Implementar**

Em `src/types/index.ts`, estender `AutomationTriggerType`:

```typescript
export type AutomationTriggerType =
  | 'new_message_received'
  | 'first_inbound_message'
  | 'keyword_match'
  | 'new_contact_created'
  | 'conversation_assigned'
  | 'tag_added'
  | 'time_based'
  | 'interactive_reply'
  | 'deal_stage_changed'
  | 'awaiting_reply'
  /** Reserva criada/reagendada/cancelada no Cal.com — disparado pela
   *  rota /api/flows/calcom-booking quando NENHUM Fluxo é dono do
   *  contato (se um Fluxo já cuida, este gatilho nem é disparado). */
  | 'calcom_booking_created'
  | 'calcom_booking_rescheduled'
  | 'calcom_booking_cancelled';
```

Em `src/lib/automations/engine.ts`, dentro de `triggerMatches`, adicionar (mesmo padrão do `keyword_match`, sem predicado — qualquer automação ativa deste tipo bate):

```typescript
  if (
    automation.trigger_type === 'calcom_booking_created' ||
    automation.trigger_type === 'calcom_booking_rescheduled' ||
    automation.trigger_type === 'calcom_booking_cancelled'
  ) {
    return true
  }
```

(Ler a função real antes de colar pra achar o lugar certo — ela é uma sequência de `if`s por trigger_type, não um `switch`; inserir junto dos outros, antes do fallback final se houver um.)

- [ ] **Step 4: Escrever a rota `/api/flows/calcom-booking`**

Mesmo padrão de autenticação por secret compartilhado já usado em `/api/automations/engine/route.ts` (`AUTOMATION_ENGINE_SECRET`, header `x-engine-secret`):

```typescript
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

/**
 * O intake.js (script EXTERNO, webhook do Cal.com) já resolveu o
 * contato e os dados da reserva — chama aqui pra o CRM DECIDIR o que
 * fazer. Se um Fluxo já é dono do contato, não faz nada (o Fluxo já
 * cuida de tudo). Se não, dispara o gatilho `calcom_booking_*` — a
 * regra de negócio de verdade (tag, etapa, confirmação) mora numa
 * Automação configurada na tela, não neste arquivo.
 */
export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_ENGINE_SECRET
  const supplied = request.headers.get('x-engine-secret')
  if (!secret || supplied !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const { contactId, accountId, event, bookingUid, startIso, bookingLabel } = body ?? {}
  if (!contactId || !accountId || !event) {
    return NextResponse.json({ error: 'contactId, accountId e event sao obrigatorios' }, { status: 400 })
  }

  const db = supabaseAdmin()
  const { data: activeRun, error } = await db
    .from('flow_runs')
    .select('id')
    .eq('account_id', accountId) // achado MINOR (4ª auditoria) — sem isto, inconsistente com o resto do arquivo (achado #16 já corrigido)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[calcom-booking] lookup failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (activeRun) {
    // Achado bloqueante B5 (3ª auditoria): quando um Fluxo é dono do
    // contato, esta rota simplesmente NÃO FAZ NADA — o que é certo pra
    // 'created'/'rescheduled' via WhatsApp com o Fluxo (ele já trata
    // tudo sozinho), mas deixa um buraco real pro cancelamento/
    // reagendamento feito pelo LEAD diretamente no Cal.com (e-mail),
    // por fora do WhatsApp: o Fluxo continua com o `booking_inicio_iso`
    // ANTIGO, manda lembrete de uma reunião que já não existe (ou já
    // mudou de hora), e pode até cancelar uma reserva que o lead acabou
    // de remarcar por conta própria. Não dá pra resolver isso com
    // automação de dado nesta rodada (o motor de Fluxos não tem como
    // ser "empurrado" um evento externo no meio de um run) — o mínimo
    // seguro é AVISAR um humano em vez de falhar em silêncio, mesmo
    // padrão que o resto do projeto já usa quando a automação completa
    // não é segura de construir na hora.
    if (event === 'cancelled' || event === 'rescheduled') {
      const { data: perfis } = await db.from('profiles').select('user_id').eq('account_id', accountId)
      const destinatarios = (perfis ?? []).map((p) => p.user_id as string)
      if (destinatarios.length > 0) {
        await db.from('notifications').insert(
          destinatarios.map((uid) => ({
            account_id: accountId,
            user_id: uid,
            type: 'awaiting_reply',
            contact_id: contactId,
            title: event === 'cancelled' ? 'Reserva cancelada no Cal.com — Fluxo de Agendamento ainda ativo' : 'Reserva reagendada no Cal.com — Fluxo de Agendamento ainda ativo',
            body: 'O lead mexeu na reserva direto no Cal.com enquanto o Fluxo de Agendamento (WhatsApp) ainda está com ele — o Fluxo não sabe disso sozinho. Conferir a conversa e, se precisar, encerrar ou ajustar o Fluxo manualmente.',
          })),
        )
      }
    }
    return NextResponse.json({ decision: 'flow_owns_this', flow_run_id: activeRun.id })
  }

  const triggerType =
    event === 'cancelled' ? 'calcom_booking_cancelled' :
    event === 'rescheduled' ? 'calcom_booking_rescheduled' :
    'calcom_booking_created'

  await runAutomationsForTrigger({
    accountId,
    triggerType,
    contactId,
    // Achado bloqueante B3 (3ª auditoria): AutomationContext é uma
    // interface FECHADA (message_text/conversation_id/vars/tag_id/
    // agent_id/esperando_desde/interactive_reply_id/stage_id/
    // pipeline_id — nada além disso) — um objeto literal com chaves
    // extras (booking_uid/booking_inicio_iso/booking_rotulo direto no
    // nível de cima) estoura o excess-property check do TypeScript e
    // `npm run build` falha. `vars` já é `Record<string, unknown>` —
    // aninhar ali passa pelo compilador sem alargar o tipo.
    context: {
      vars: {
        booking_uid: bookingUid,
        booking_inicio_iso: startIso,
        booking_rotulo: bookingLabel,
      },
    },
  })

  return NextResponse.json({ decision: 'dispatched_to_automations' })
}
```

⚠️ Hoje NÃO existe nenhuma Automação ativa com `trigger_type` `calcom_booking_*` — a rota dispara o gatilho, mas sem automação configurada pra reagir, `runAutomationsForTrigger` simplesmente não encontra nada e não faz nada (`if (!automations || automations.length === 0) return`, comportamento já existente, seguro). Isso é intencional nesta fase: cria a CAPACIDADE, sem migrar a lógica do `intake.js` ainda (ver nota da fronteira honesta acima) — o `intake.js` continua fazendo seu trabalho de sempre pro caso "sem Fluxo", só agora perguntando antes se deve.

- [ ] **Step 5: Rodar a suíte inteira**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run"`
Expected: só as 2 falhas pré-existentes. ⚠️ Isto NÃO prova que a rota compila (`vitest` usa esbuild, não faz typecheck — achado bloqueante B3 da 3ª auditoria só aparece num `npm run build` de verdade).

- [ ] **Step 6: Build (SEM restart) — pega erro de tipo agora, sem colocar nada no ar ainda**

⚠️ **REAL-BUG-4 (4ª auditoria) corrige o achado B2 da 3ª sem reabrir o problema que B2 tentava evitar.** B2 (3ª auditoria) estava certo em querer o `npm run build` cedo — sem ele, o erro de tipo do achado B3 (`context: { vars: {...} }`) só apareceria na Task 17, tarde demais. Mas a versão anterior deste plano também fazia `pm2 restart wacrm` aqui — e isso bota o Fluxo no ar (via `FLUXO_AGENDAMENTO_ID`, já commitado na Task 10) ANTES do gate de véspera (Task 13) e do marcador `[ia-whatsapp]` (Task 12) existirem no build rodando. Entre esta Task e a Task 17 haveria uma janela de produção real sem essas proteções. **Solução: builda (pega o erro de tipo AGORA, satisfaz B2), mas NÃO reinicia — o `.next` fica pronto no disco, esperando as Tasks 12 e 13 completarem, pra um ÚNICO restart na Task 17 já com tudo dentro.**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && npm run build"
```
Expected: build limpo (confirma também que B3 foi corrigido de verdade — se `context: { vars: {...} }` ainda tiver erro de tipo, o build acusa AQUI, não só na Task 17). ⛔ NÃO rodar `pm2 restart wacrm` neste Step — o processo continua servindo o `.next` ANTERIOR até a Task 17.

- [ ] **Step 7: Teste da rota — adiado pra Task 17**

A rota só existe pro servidor DEPOIS do `pm2 restart` — que não acontece nesta Task (ver Step 6). O teste manual (`curl` com e sem `x-engine-secret`) virou parte da verificação da Task 17, junto com o restart real. Nada a fazer aqui além de confirmar que o build do Step 6 terminou sem erro — é a garantia de que a rota VAI existir quando a Task 17 reiniciar o processo.

- [ ] **Step 8: Commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add src/types/index.ts src/lib/automations/engine.ts src/app/api/flows/calcom-booking/route.ts src/lib/automations/engine.test.ts && git commit -m 'feat: gatilhos calcom_booking_* + rota que decide se um Fluxo ja e dono do contato'"
```

---

### Task 12: `intake.js` pergunta ao CRM antes de agir + Fluxo marca cancelamento como próprio

**Files (fora do repositório do wacrm — `/root/intake/intake.js` na VPS, deploy próprio):**
- Modify: `/root/intake/intake.js`
- Modify: `src/lib/flows/engine.ts` (marcador `[ia-whatsapp]` no motivo de cancelamento — reforço, não é o mecanismo principal)

⚠️ **Risco maior de superfície de teste** (mesma nota já no spec original) — este arquivo não tem suíte automatizada. Testar manualmente com um agendamento de verdade (ou o mais próximo disso) antes de considerar concluído.

**O `intake.js` continua com toda a sua lógica atual intacta pro caso "sem Fluxo"** (ver nota da fronteira honesta, no cabeçalho das Tasks 11-13) — a única mudança é: ANTES de agir, ele chama a rota nova (Task 11) e só segue com o comportamento de sempre se ela responder que nenhum Fluxo é dono do contato.

- [ ] **Step 1: Adicionar a chamada de decisão em `handleCalcom`**

Em `/root/intake/intake.js`, perto do topo (junto de `ENGINE_URL`, linha ~98), adicionar:

```javascript
const FLOW_BOOKING_URL = 'http://100.85.48.50:3000/api/flows/calcom-booking';
async function fluxoDonoDoContato(contactId, event, extra) {
  if (!ENGINE_SECRET || !contactId) return false;
  try {
    const r = await Promise.race([
      jreq(FLOW_BOOKING_URL, 'POST', { 'x-engine-secret': ENGINE_SECRET }, {
        contactId, accountId: ACCOUNT_ID, event, ...extra,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 5s consultando o CRM')), 5000)),
    ]);
    return !!(r.json && r.json.decision === 'flow_owns_this');
  } catch (e) {
    // ⚠️ REAL-BUG-5 (4ª auditoria): `jreq` não tem timeout embutido (confirmado
    // lendo a função real, linha ~109) e REJEITA em erro de conexão (`r.on
    // ('error', reject)`) — sem este catch, um webhook do Cal.com chegando
    // durante um `pm2 restart wacrm` (Task 17) derrubava o `handleCalcom`
    // inteiro (500 pro Cal.com, evento potencialmente perdido) por causa de
    // uma checagem que devia ser best-effort. Fail-open: se não dá pra
    // perguntar ao CRM, segue com o comportamento de sempre (sem Fluxo) em
    // vez de travar o webhook inteiro.
    console.error('[fluxoDonoDoContato] falha ao consultar o CRM, seguindo sem Fluxo (fail-open):', e.message);
    return false;
  }
}
```

⚠️ **REAL-BUG-6 (4ª auditoria) — o ponto de inserção certo pro cancelamento NÃO é dentro de `if (dl) { ... }`.** Lendo o `intake.js` real (linhas 447-462): a remoção da tag "Agendou" (`sb('contact_tags?...', 'DELETE')`) roda como a PRIMEIRA coisa dentro de `if (cid) { ... }`, ANTES até de buscar o deal (`dl`) — bem antes do bloco `if (dl)` que uma versão anterior deste plano mirava. Inserir a checagem ali (depois da tag já ter sido apagada) faria o intake "não mexer" mas MESMO ASSIM já ter apagado a tag por baixo do Fluxo — exatamente o "intake não mexe" mentindo no log enquanto mexeu. O gate certo é logo na abertura do `if (cid) { ... }`, antes de QUALQUER mutação:

```javascript
    const cid = await findContactByPhone(digits);
    if (cid) {
      if (await fluxoDonoDoContato(cid, 'cancelled')) {
        console.log('[/calcom] BOOKING_CANCELLED — Fluxo ativo pra este contato, intake nao mexe (o proprio Fluxo trata reagendar/cancelar)');
        return { ok: true, ev: ev, cancelled: true, contactId: cid, fluxoDono: true };
      }
      await sb('contact_tags?contact_id=eq.' + cid + '&tag_id=eq.' + TAG_AGENDOU, 'DELETE').catch(function(){});
      const ex = await sb('deals?contact_id=eq.' + cid + '&pipeline_id=eq.' + PIPELINE + '&status=eq.open&select=id,notes,stage_id', 'GET');
      const dl = ex.json && ex.json[0];
      // ⛔ PERDIDO NAO RESSUSCITA.
      //
      // Dar o lead por perdido e decisao do escritorio. Se a reserva dele for
      // cancelada depois — inclusive pelo nosso proprio vigia, que libera o
      // horario de quem foi perdido —, mover o card para "Reagendar" o traz de
      // volta ao funil e faz o vigia convidar a remarcar quem ja foi
      // dispensado. Foi o que aconteceu com o JORGE em 12/08/2026: cancelei a
      // reserva por ele estar em Perdido e o card voltou para Reagendar no
      // mesmo minuto. So nao virou mensagem porque o freio segurou.
      if (dl && dl.stage_id === STAGE_PERDIDO) {
        console.log('[/calcom] BOOKING_CANCELLED de card em PERDIDO -- horario liberado, card fica onde esta');
        return { ok: true, ev: ev, cancelled: true, contactId: cid, mantidoEmPerdido: true };
      }
      if (dl) {
        const nt = (dl.notes ? dl.notes + '\n\n' : '') + 'X Reuniao CANCELADA (Cal.com) -- movido p/ Reagendar; enviado o botao de reagendamento';
        await sb('deals?id=eq.' + dl.id, 'PATCH', { stage_id: STAGE_REAGENDAR, notes: nt });
        fireStageAutomation(cid, STAGE_REAGENDAR);
      }
    }
```

(Isto substitui o `if (cid) { ... }` INTEIRO do bloco `BOOKING_CANCELLED` real — inclui de volta o guard `PERDIDO NÃO RESSUSCITA`, já existente, pra não se perder na substituição. Conferir a numeração de linha real antes de aplicar — pode ter mudado desde 21/08.)

Nos eventos ativos (`BOOKING_CREATED`/`BOOKING_RESCHEDULED`/etc — logo depois de `contactId` estar resolvido E do bloco de criação/atualização de e-mail original já ter rodado, ANTES do passo "2) tag Agendou"):

```javascript
  {
    const eventoFluxo = ev === 'BOOKING_RESCHEDULED' ? 'rescheduled' : 'created';
    if (await fluxoDonoDoContato(contactId, eventoFluxo, {
      bookingUid: p.uid ? String(p.uid) : undefined,
      startIso: dataISO,
      bookingLabel: dataBR,
    })) {
      console.log(`[/calcom] ${ev} — Fluxo ativo pra este contato (${contactId}), intake nao mexe em tag/etapa/lembrete (o Fluxo cuida disso)`);
      return { ok: true, ev, contactId, fluxoDono: true };
    }
  }
```

(Ler o arquivo real antes de colar pra confirmar a linha exata onde `dataISO`/`dataBR` já estão calculadas neste ponto — a numeração pode ter mudado desde a leitura desta sessão; o bloco precisa vir DEPOIS delas, já que o payload manda pro CRM.)

- [ ] **Step 2: Reforço — Fluxo cancela com o marcador que o intake já reconhece**

⚠️ **Achado R8 da 3ª auditoria:** a linha real (confirmada de novo agora) é `const ok = await cancelCalcomBooking(uid, apiKey);` — JÁ tem `const ok =` na frente. Uma versão anterior deste plano mandava "trocar `await cancelCalcomBooking(uid, apiKey);` por `const ok = await cancelCalcomBooking(...)`", o que geraria `const ok = const ok = await ...` se colado literalmente. Trocar a linha INTEIRA (com o `const ok =` já presente) por:

```typescript
          const ok = await cancelCalcomBooking(
            uid,
            apiKey,
            '[ia-whatsapp] Fluxo de Agendamento cancelou para remarcar',
          );
```

(Isto reaproveita o mecanismo de silenciamento que já existe no `intake.js` pra cancelamentos feitos pela IA — `/\[ia-whatsapp\]/i.test(p.cancellationReason)` — em vez de depender só da checagem nova da Task 11. Defesa em profundidade: mesmo se a Task 11 falhar por algum motivo de rede, este marcador sozinho já impede o `intake.js` de reagir.)

⚠️ **Achado da 5ª auditoria: os Steps 3 e 4 originais (teste manual + `pm2 restart intake`) foram ADIADOS pra Task 17 — não rodam aqui.** Neste ponto do plano, o wacrm ainda está servindo o `.next` ANTERIOR a este corte inteiro: `FLUXO_AGENDAMENTO_ID` continua `''` no bundle rodando (só é buildado na Task 17), e `/api/flows/calcom-booking` ainda não existe pro servidor (404). Testar `[[AGENDAR]]` agora não pode dar a linha `Fluxo ativo... intake nao mexe` no log — o Fluxo real nem inicia ainda. E reiniciar o `intake.js` agora (Step 4 original) é o próprio Real-bug-4/Risk-8 de novo, só que do lado do intake: chamadas de `fluxoDonoDoContato` batendo numa rota que não existe até a Task 17 — inofensivo por causa do fail-open (achado REAL-BUG-5), mas sem sentido rodar cedo. **O teste manual e o restart do `intake.js` viraram parte da Task 17** (Steps 4 e 7 de lá). Esta Task 12 fica só com o código (Steps 1-2) + commit (Step 5, abaixo) — mesmo padrão que a Task 10 já usa.

- [ ] **Step 3: Commit (dois repositórios/locais separados — confirmar qual delas tem git antes de rodar)**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add src/lib/flows/engine.ts && git commit -m 'fix: cancel_meeting marca o motivo com [ia-whatsapp], reforcando o silenciamento do intake.js'"
```

Pro `/root/intake/intake.js` — verificar primeiro se `/root/intake` é repositório git (`ssh root@100.85.48.50 "cd /root/intake && git status"`); se for, commitar lá também com mensagem equivalente; se não for, registrar no relatório final que a mudança está só no arquivo, sem versionamento (mesma situação que o restante do `intake.js` já está hoje).

---

### Task 13: `webhook/route.ts` — gate do handler antigo de véspera atrás do Fluxo

**Files:** Modify: `src/app/api/whatsapp/webhook/route.ts`

**Interfaces:**
- Resolve o achado NEW-3 (colisão de rótulo de botão) da 2ª auditoria.

⚠️ **Achado real R3 da 3ª auditoria — `!flowConsumed` sozinho NÃO basta, e a Task 3/Global Constraints deste mesmo plano é quem reabriu o buraco.** `flowConsumed = flowResult.consumed` (confirmado, `webhook/route.ts:787`). Com `fallback_policy.on_unknown_reply: 'ignore'` (decisão da Task 8/9, achado NEW-9), toda mensagem que não bate com um botão/palavra-chave do Fluxo ativo devolve `consumed: false` de propósito — inclusive quando existe um Fluxo de verdade cuidando do contato. Ou seja: **`!flowConsumed` passa a ser praticamente sempre verdadeiro pra qualquer texto solto, mesmo com o Fluxo ativo** — reabrindo exatamente a colisão do botão "Confirmar presença" (achado NEW-3) que este Task deveria fechar: um segundo toque, ou uma reentrega do WhatsApp, casa com `isVesperaButton` e nada bloqueia. O gate certo não é "esta mensagem foi consumida", é "existe um Fluxo cuidando deste contato" — e `flowResult` já carrega essa informação: o motor devolve `flow_run_id` preenchido tanto quando consumiu quanto quando ignorou de propósito (`{ consumed: false, flow_run_id: run.id, outcome: "no_match" }` no ramo `ignore` de `handleReplyForActiveRun`) — só fica vazio quando não havia Fluxo NENHUM pro contato.

- [ ] **Step 1: Corrigir o gate**

Em `src/app/api/whatsapp/webhook/route.ts`, a chamada a `isVesperaButton`/`handleVesperaButton` hoje roda incondicionalmente (`if (isVesperaButton(contentText)) { ... }`). Trocar por:

```typescript
  if (!flowResult.flow_run_id && isVesperaButton(contentText)) {
    try {
      await handleVesperaButton({
        accountId,
        userId: configOwnerUserId,
        conversationId: conversation.id,
        contactId: contactRecord.id,
        buttonText: contentText as string,
        contactName: (contactRecord as { name?: string | null }).name ?? null,
      })
    } catch (err) {
      console.error('[vespera-button dispatch]', err)
    }
  }
```

(`flowResult` já está no escopo neste ponto — é a MESMA variável de onde `flowConsumed` foi lido, linha 787; usar `flowResult.flow_run_id` direto, não `flowConsumed`.)

- [ ] **Step 2: Rodar a suíte do webhook (se existir) e a suíte inteira**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run"`
Expected: só as 2 falhas pré-existentes — se houver teste específico de `vespera-buttons`/webhook que dependia do comportamento incondicional antigo, ele vai acusar; ajustar o teste pro novo comportamento (gated), não reverter o fix.

- [ ] **Step 3: Commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add src/app/api/whatsapp/webhook/route.ts && git commit -m 'fix: handler antigo de vespera respeita flowConsumed, evitando resposta dupla'"
```

---

## ⚠️ Tasks 14-15 — por que existem, e por que a Task 15 NÃO roda hoje

Decisão original do titular (sessão de 21/08): **nada de dois sistemas rodando em paralelo, nem "por enquanto"** — as 4 automações antigas de reunião são desativadas de vez, e as reuniões JÁ agendadas sob o sistema antigo entram no Fluxo hoje, não ficam esperando.

Levantamento ao vivo no banco (21/08/2026): **16 deals abertos em "Reunião Agendada" (antiga)**, **8 em "Reagendar reunião"**, **13 em "Follow up No-show"** — 37 reuniões/leads reais.

**⛔ A 3ª auditoria independente achou que a Task 15, do jeito que foi desenhada, causaria exatamente o tipo de falha que motivou esta rodada inteira — não é um ajuste pequeno:**
- **B1 (bloqueante):** cheguei a medir a janela de resposta de 24h do WhatsApp contra os 21 leads de "Reagendar"/"Follow up No-show" — **8 de 8 e 12 de 13 estão FORA da janela**. O motor de Fluxos só manda mensagem livre (sem template) — as automações antigas usam `send_template` justamente pra cobrir esse caso. Rodar a migração assim faria essas ~20 pessoas reais **não receberem mensagem nenhuma**.
- **B4 (bloqueante):** o script desativa as automações antigas DEPOIS de migrar, não antes — abre uma janela onde a mesma reunião pode receber lembrete do sistema antigo e do novo ao mesmo tempo.
- **R4 (bug real):** o próprio script de verificação (Step 5) não detectaria a falha acima — contaria como "coberto" um run que travou silenciosamente.

**Decisão, dado o achado: a Task 15 fica fora do escopo de hoje.** As 37 reuniões continuam servidas pelo sistema antigo (que já funciona, mesmo que long-term deva ser aposentado) enquanto a Task 15 é redesenhada com calma — o ponto central do redesenho é dar ao motor de Fluxos uma forma de mandar `send_template` (capacidade que ele não tem hoje), pra quem está fora da janela de 24h, espelhando o que as automações antigas já fazem certo. Isto é trabalho de sessão dedicada, não patch em cima do que já foi escrito sob pressão de prazo — ver a nota "NÃO EXECUTAR HOJE" na própria Task 15, mais abaixo.

**O que SEGUE fazendo parte do escopo de hoje:** Task 14 (capacidade de motor — `entryNodeKey`/`initialVars` — é infraestrutura genérica, útil e correta independente de quando a migração rodar) segue nesta rodada. As 4 automações antigas de reunião **continuam ATIVAS** por enquanto (não desativar hoje — sem a migração, desativá-las deixaria as 37 reuniões reais sem cobertura nenhuma).

---

### Task 14: `startManualFlowRun` ganha `entryNodeKey`/`initialVars` + rota `/api/flows/manual-start`

**Files:**
- Modify: `src/lib/flows/engine.ts` (`insertAndStartRun`, `startManualFlowRun`)
- Create: `src/app/api/flows/manual-start/route.ts`
- Test: `src/lib/flows/engine.test.ts`

**Interfaces:**
- Produces: `startManualFlowRun(db, flowId, args, opts?)` — `opts.entryNodeKey` entra num nó QUALQUER do Fluxo em vez do `entry_node_id` padrão; `opts.initialVars` popula `flow_runs.vars` na criação. Retrocompatível — chamadas existentes (auto-reply.ts, Task 2) não passam `opts`, comportamento idêntico a hoje. `POST /api/flows/manual-start` — consumido pela Task 15 (migração) e, mais tarde, pelo Canal B (Plano C) quando for construído — mesma rota serve os dois usos.

- [ ] **Step 1: Escrever o teste que falha**

No `describe("startManualFlowRun", ...)` já existente em `src/lib/flows/engine.test.ts`, adicionar:

```typescript
  it("com entryNodeKey, entra nesse nó em vez do entry_node_id padrão do Fluxo", async () => {
    h.state.flow = manualFlow(); // entry_node_id: "manual_entry"
    h.state.nodeRows = [
      ...MANUAL_FLOW_NODES,
      node({ node_key: "outro_ponto", node_type: "end", config: {} }),
    ];

    const db = supabaseAdmin();
    const result = await startManualFlowRun(db, "flow-manual-1", {
      accountId: "acct-1",
      contactId: "contact-9",
      conversationId: "conv-9",
    }, { entryNodeKey: "outro_ponto" });

    expect(result.outcome).toBe("completed"); // "outro_ponto" é end, não collect_input
    expect(h.state.insertedFlowRuns[0]).toMatchObject({ current_node_key: "outro_ponto" });
  });

  it("com initialVars, grava as vars na criação do run", async () => {
    h.state.flow = manualFlow();
    h.state.nodeRows = MANUAL_FLOW_NODES;

    const db = supabaseAdmin();
    await startManualFlowRun(db, "flow-manual-1", {
      accountId: "acct-1",
      contactId: "contact-9",
      conversationId: "conv-9",
    }, { initialVars: { booking_uid: "uid-123" } });

    expect(h.state.insertedFlowRuns[0]).toMatchObject({ vars: { booking_uid: "uid-123" } });
  });
```

- [ ] **Step 2: Rodar, confirmar que falha**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run src/lib/flows/engine.test.ts -t 'entryNodeKey\|initialVars'"`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Em `src/lib/flows/engine.ts`, estender `insertAndStartRun` (assinatura ganha um 7º parâmetro opcional) e `startManualFlowRun`:

```typescript
async function insertAndStartRun(
  db: AdminClient,
  flow: FlowRow,
  args: { contactId: string; conversationId: string },
  nodes: Map<string, FlowNodeRow>,
  metaMessageId: string | null,
  logPrefix: string,
  opts?: { entryNodeKey?: string; initialVars?: Record<string, unknown> },
): Promise<DispatchInboundResult> {
  const entryKey = opts?.entryNodeKey ?? flow.entry_node_id;
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      account_id: flow.account_id,
      user_id: flow.user_id,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      status: "active",
      current_node_key: entryKey,
      vars: opts?.initialVars ?? {},
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error(`[flows] ${logPrefix} insert error:`, insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", entryKey, {
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
  const outcome = await advanceFromNodeKey(db, run, entryKey!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
```

(Isto é a função INTEIRA — substituir a existente. Única mudança real: `flow.entry_node_id` virou `entryKey` em três lugares, e o `insert` ganhou `vars: opts?.initialVars ?? {}` — sem `opts`, `entryKey === flow.entry_node_id` e `vars === {}`, idêntico ao comportamento de hoje.)

```typescript
export async function startManualFlowRun(
  db: AdminClient,
  flowId: string,
  args: { accountId: string; contactId: string; conversationId: string },
  opts?: { entryNodeKey?: string; initialVars?: Record<string, unknown> },
): Promise<DispatchInboundResult> {
  const flow = await loadFlow(db, flowId);
  if (!flow || flow.account_id !== args.accountId) {
    console.error(
      "[flows] startManualFlowRun: flow not found",
      flowId,
      flow ? "account_id mismatch" : "no row",
    );
    return { consumed: false, outcome: "no_match" };
  }
  if (!opts?.entryNodeKey && !flow.entry_node_id) {
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
    "startManualFlowRun",
    opts,
  );
}
```

- [ ] **Step 4: Rodar, confirmar que passa; rodar a suíte inteira**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run"`
Expected: só as 2 falhas pré-existentes — inclui reconferir que os 4 testes JÁ EXISTENTES de `startManualFlowRun` (sem `opts`) continuam passando exatamente como antes.

- [ ] **Step 5: Escrever a rota `/api/flows/manual-start`**

```typescript
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { startManualFlowRun } from '@/lib/flows/engine'

/**
 * Inicia um Fluxo pra um contato num ponto qualquer do grafo — usado
 * pela migração das reuniões já agendadas (Task 15) e, mais tarde,
 * pelo Canal B (lead agenda direto no Cal.com, sem passar pela
 * Márcia) quando for construído. Acha/cria a conversa sozinha — quem
 * chama só precisa saber o contactId.
 */
export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_ENGINE_SECRET
  const supplied = request.headers.get('x-engine-secret')
  if (!secret || supplied !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const { accountId, userId, contactId, flowId, entryNodeKey, initialVars } = body ?? {}
  if (!accountId || !userId || !contactId || !flowId) {
    return NextResponse.json({ error: 'accountId, userId, contactId e flowId sao obrigatorios' }, { status: 400 })
  }

  const db = supabaseAdmin()
  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  let conversationId = conv?.id
  if (!conversationId) {
    const { data: created, error } = await db
      .from('conversations')
      .insert({ account_id: accountId, user_id: userId, contact_id: contactId })
      .select('id')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    conversationId = created.id
  }

  const result = await startManualFlowRun(
    db, flowId, { accountId, contactId, conversationId }, { entryNodeKey, initialVars },
  )
  return NextResponse.json(result)
}
```

⚠️ Antes de colar, conferir o shape REAL de `conversations` (colunas obrigatórias além de `account_id`/`user_id`/`contact_id`) lendo a migração da tabela — `resolveConversationId` em `automations/engine.ts` já faz esse mesmo insert, usar exatamente as mesmas colunas que ela usa.

- [ ] **Step 6: Commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add src/lib/flows/engine.ts src/lib/flows/engine.test.ts src/app/api/flows/manual-start/route.ts && git commit -m 'feat: startManualFlowRun aceita entrada/vars customizados + rota manual-start'"
```

---

### Task 15: Migrar as reuniões já agendadas pro Fluxo + desativar as automações antigas de vez

## ⛔⛔ NÃO EXECUTAR HOJE — fica registrada como referência do desenho, não como Task pronta pra rodar

A 3ª auditoria independente achou que esta Task, do jeito que está escrita abaixo, mandaria **zero mensagem** pra ~20 dos 21 leads reais que deveria alcançar (achado bloqueante B1 — 8/8 de "Reagendar" e 12/13 de "Follow up No-show" estão fora da janela de 24h do WhatsApp; o motor de Fluxos não tem capacidade de `send_template`, só mensagem livre) e desativaria a cobertura antiga ANTES de confirmar que a migração funcionou (B4). Rodar isto contra as 37 reuniões reais **pioraria** a situação delas, não melhoraria. **Decisão: esta Task fica pra uma sessão dedicada**, com o motor de Fluxos ganhando `send_template` primeiro (mesmo padrão que as Automações já têm) — ver a nota "Tasks 14-15" acima. O conteúdo abaixo continua no arquivo como registro do que foi desenhado e do porquê não é suficiente ainda — não apagar, mas também não seguir os Steps abaixo sem esse trabalho prévio.

**Files:** Create: `scripts/migrar-reunioes-legado.js`

**Depende da Task 14** (rota `manual-start`) **e das Tasks 8-10** (Fluxos e `[[AGENDAR]]` já no ar) — **E, antes de tudo isso, do motor de Fluxos ganhar capacidade de `send_template` pra quem está fora da janela de 24h (trabalho ainda não desenhado, sessão futura).**

- [ ] **Step 1: Escrever o script (dry-run por padrão, `--confirmar` executa de verdade)**

```javascript
const { seedClient } = require('./lib/seed-client')

const ACCOUNT_ID = '2569c0e9-5f2e-4d04-957c-e2f158e7a87e'
const USER_ID = 'be874c16-32b2-46c2-b5fa-45097dc62ff1'
const CF_DATA_ISO = 'e482845b-8ed4-4f4d-ae0e-0eed9dafbe4e'
const CF_CAL_UID = '9a4af810-d6d3-4201-b39d-9ed46648b5d9'
const CF_DATA = 'e7935f62-b9f6-414b-9cde-b3c7315c0f11'
const STAGE_REUNIAO_ANTIGA = 'fd70e3b2-52e2-4f2c-b6e8-15450fe6c9d4'
const STAGE_REAGENDAR = 'f2b7e7f6-c7d6-4d2b-ac6d-ad7842ab7045'
const STAGE_NOSHOW = '8c39cc10-4568-432f-b4dd-9a4ba228add6'
const MANUAL_START_URL = 'http://100.85.48.50:3000/api/flows/manual-start'

const FLUXO_AGENDAMENTO_ID = process.argv[2]
const FLUXO_NOSHOW_ID = process.argv[3]
const CONFIRMAR = process.argv.includes('--confirmar')

if (!FLUXO_AGENDAMENTO_ID || !FLUXO_NOSHOW_ID) {
  throw new Error('uso: node scripts/migrar-reunioes-legado.js <fluxo_agendamento_id> <fluxo_noshow_id> [--confirmar]\nSem --confirmar, so mostra o que faria (dry-run) — nenhuma mensagem sai.')
}

async function chamarManualStart(contactId, flowId, entryNodeKey, initialVars) {
  const secret = process.env.AUTOMATION_ENGINE_SECRET
  const res = await fetch(MANUAL_START_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-engine-secret': secret },
    body: JSON.stringify({ accountId: ACCOUNT_ID, userId: USER_ID, contactId, flowId, entryNodeKey, initialVars }),
  })
  return res.json()
}

async function main() {
  const db = seedClient()
  const relatorio = { reuniao: [], reagendar: [], noshow: [], pulados: [] }

  const { data: dealsReuniao } = await db.from('deals').select('id,contact_id').eq('stage_id', STAGE_REUNIAO_ANTIGA).eq('status', 'open')
  for (const deal of dealsReuniao ?? []) {
    const { data: cvs } = await db.from('contact_custom_values').select('custom_field_id,value')
      .eq('contact_id', deal.contact_id).in('custom_field_id', [CF_DATA_ISO, CF_CAL_UID, CF_DATA])
    const iso = (cvs ?? []).find((v) => v.custom_field_id === CF_DATA_ISO)?.value
    const uid = (cvs ?? []).find((v) => v.custom_field_id === CF_CAL_UID)?.value
    const rotulo = (cvs ?? []).find((v) => v.custom_field_id === CF_DATA)?.value
    if (!iso || !uid || Date.parse(iso) < Date.now()) {
      relatorio.pulados.push({ deal: deal.id, contact: deal.contact_id, motivo: (!iso || !uid) ? 'sem uid/data no Cal.com — revisar a mao' : 'reuniao ja passou — revisar a mao (provavel no-show nunca marcado)' })
      continue
    }
    relatorio.reuniao.push({ deal: deal.id, contact: deal.contact_id, iso, uid, rotulo: rotulo || iso })
  }

  const { data: dealsReagendar } = await db.from('deals').select('id,contact_id').eq('stage_id', STAGE_REAGENDAR).eq('status', 'open')
  for (const deal of dealsReagendar ?? []) relatorio.reagendar.push({ deal: deal.id, contact: deal.contact_id })

  const { data: dealsNoshow } = await db.from('deals').select('id,contact_id').eq('stage_id', STAGE_NOSHOW).eq('status', 'open')
  for (const deal of dealsNoshow ?? []) relatorio.noshow.push({ deal: deal.id, contact: deal.contact_id })

  console.log('=== ' + (CONFIRMAR ? 'EXECUCAO REAL' : 'DRY RUN — nada sera executado') + ' ===')
  console.log(`Reuniao Agendada (antiga) -> Fluxo de Agendamento (silencioso, so agenda lembrete): ${relatorio.reuniao.length}`)
  console.log(`Reagendar reuniao -> Fluxo de Agendamento (MANDA MENSAGEM AGORA): ${relatorio.reagendar.length}`)
  console.log(`Follow up No-show -> Fluxo No-show (MANDA MENSAGEM AGORA): ${relatorio.noshow.length}`)
  console.log(`Pulados, precisam de revisao manual: ${relatorio.pulados.length}`)
  console.log(JSON.stringify(relatorio.pulados, null, 2))

  if (!CONFIRMAR) {
    console.log('\nConfira a lista acima. Rode de novo com --confirmar pra migrar de verdade.')
    return
  }

  const resultados = { reuniao: [], reagendar: [], noshow: [] }
  for (const item of relatorio.reuniao) {
    const r = await chamarManualStart(item.contact, FLUXO_AGENDAMENTO_ID, 'limpar_agendou', {
      booking_uid: item.uid, booking_inicio_iso: item.iso, booking_rotulo: item.rotulo,
    })
    resultados.reuniao.push({ contact: item.contact, outcome: r.outcome })
  }
  for (const item of relatorio.reagendar) {
    const r = await chamarManualStart(item.contact, FLUXO_AGENDAMENTO_ID)
    resultados.reagendar.push({ contact: item.contact, outcome: r.outcome })
  }
  for (const item of relatorio.noshow) {
    const r = await chamarManualStart(item.contact, FLUXO_NOSHOW_ID)
    resultados.noshow.push({ contact: item.contact, outcome: r.outcome })
  }
  console.log('=== RESULTADO ===')
  console.log(JSON.stringify(resultados, null, 2))
  const falhas = [...resultados.reuniao, ...resultados.reagendar, ...resultados.noshow].filter((r) => r.outcome !== 'started')
  if (falhas.length) console.log(`⚠️ ${falhas.length} nao iniciaram com outcome 'started' — revisar a mao:`, JSON.stringify(falhas, null, 2))
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Rodar em dry-run e MOSTRAR o resultado ao titular antes de confirmar**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && node scripts/migrar-reunioes-legado.js <uuid-fluxo-agendamento> <uuid-fluxo-noshow>"`

Reportar a contagem exata (deveria bater ~16/8/13, mas o número real no momento da execução manda) e a lista de `pulados` — esses ficam de fora da migração automática, o titular decide o que fazer com eles um a um.

- [ ] **Step 3: Rodar com `--confirmar`**

Run: `ssh root@100.85.48.50 "cd /root/wacrm && node scripts/migrar-reunioes-legado.js <uuid-fluxo-agendamento> <uuid-fluxo-noshow> --confirmar"`
Expected: todo `outcome` na lista de resultados é `started` (ou `duplicate_inbound_ignored`, se por acaso o contato já tiver um run ativo de outra origem — não é falha). Qualquer outro outcome (`no_match`, `failed`) precisa de investigação antes de considerar a migração completa.

- [ ] **Step 4: Desativar as automações antigas de vez (não mais "intocadas servindo o legado")**

```bash
ssh root@100.85.48.50 'cd /root/wacrm && node -e "
require(\"dotenv\").config({path:\".env.local\"});
const { createClient } = require(\"@supabase/supabase-js\");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const { error } = await sb.from(\"automations\").update({ is_active: false }).in(\"id\", [
    \"ddb16425-db3c-4885-94af-caaea2c4e650\",
    \"d820b380-5b90-4531-a89a-3f46ef488686\",
    \"856ef83a-2949-424b-9bc6-203f8d9df04d\",
    \"0b8e5576-efd4-4db6-b5cb-21d485a203dd\",
    \"b6359cda-4516-4186-8937-d7c86a90c8c8\",
  ]);
  // F2 (gate Task 0): ativa a automacao NOVA (\"Fluxo No-show — inicia\",
  // Task 7) NO MESMO PASSO em que a antiga (b6359cda) e desativada —
  // nunca as duas ativas junto (dispararia 2 sequencias de toque pro
  // mesmo lead), nunca as duas desativadas junto (card entrando na
  // etapa ficaria sem nenhuma automacao cuidando). Busca por nome
  // porque o id e gerado em runtime na Task 7, nao fixo como os outros.
  const { data: novaAuto } = await sb.from(\"automations\").select(\"id\").eq(\"name\", \"Fluxo No-show — inicia\").eq(\"account_id\", \"2569c0e9-5f2e-4d04-957c-e2f158e7a87e\").maybeSingle();
  if (!novaAuto) { console.error(\"NAO achei a automacao 'Fluxo No-show — inicia' pelo nome — Task 7 rodou?\"); process.exit(1); }
  const { error: erroAtivar } = await sb.from(\"automations\").update({ is_active: true }).eq(\"id\", novaAuto.id);
  console.log(error || erroAtivar ? (error||erroAtivar).message : \"5 automacoes antigas desativadas (lembrete vespera, lembrete 1h, confirmacao, reagendar-convite, follow-up no-show) + Fluxo No-show — inicia ATIVADA\");
})();
"'
```

(⚠️ RISK-9, 4ª auditoria + F2, gate Task 0: a "Follow up No-show — 3 toques e encerra" (`b6359cda-...`) NÃO foi desativada na Task 17 como uma versão anterior deste plano fazia — ficou ativa de propósito, cobrindo os 13 leads reais que estavam nessa etapa até ESTE PASSO, aqui na Task 15, rodar de verdade e migrá-los. Por isso ela entra nesta lista de 5, não fica de fora. E pela mesma razão, a automação NOVA que assume o lugar dela (`Fluxo No-show — inicia`, mesmo trigger — `deal_stage_changed` na mesma etapa) só é ativada AGORA, não na Task 17 — as duas rodando juntas mandariam dois toques duplicados pro mesmo lead a partir de hoje.)

- [ ] **Step 5: Verificar que ninguém ficou sem cobertura**

```bash
ssh root@100.85.48.50 'cd /root/wacrm && node -e "
require(\"dotenv\").config({path:\".env.local\"});
const { createClient } = require(\"@supabase/supabase-js\");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const stages = [\"fd70e3b2-52e2-4f2c-b6e8-15450fe6c9d4\",\"f2b7e7f6-c7d6-4d2b-ac6d-ad7842ab7045\",\"8c39cc10-4568-432f-b4dd-9a4ba228add6\"];
  const { data: deals } = await sb.from(\"deals\").select(\"id,contact_id,stage_id\").in(\"stage_id\", stages).eq(\"status\",\"open\");
  const { data: runs } = await sb.from(\"flow_runs\").select(\"contact_id,status\").eq(\"status\",\"active\");
  const comRun = new Set((runs||[]).map(r=>r.contact_id));
  const semRun = (deals||[]).filter(d => !comRun.has(d.contact_id));
  console.log(\"deals nas 3 etapas antigas SEM run ativo (deveria ser so os pulados):\", JSON.stringify(semRun, null, 2));
})();
"'
```
Expected: a lista bate exatamente com os `pulados` do Step 2 — ninguém mais ficou órfão (nem no Fluxo, nem numa automação ativa).

- [ ] **Step 6: Commit**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && git add scripts/migrar-reunioes-legado.js && git commit -m 'feat(migracao): reunioes ja agendadas entram no Fluxo, automacoes antigas desativadas'"
```

---

### Task 16: Submeter o template "horário liberado" na Meta

- [ ] **Step 1:** Submeter via Graph API — nome `horario_liberado_sem_confirmacao`, categoria `UTILITY`, idioma `pt_BR`, corpo: "Como não tive sua confirmação, precisei liberar esse horário — mas fica tranquilo, é só me chamar quando fizer sentido pra você que eu já vejo outro horário livre." (sem `{{1}}`, bate com `variables:{}` da Task 7).
- [ ] **Step 2:** Registrar id/status (`PENDING` até aprovação).
- [ ] **Step 3:** Já não é mais uma dúvida em aberto (era o achado bloqueante #3, corrigido na Task 7 reordenando os passos) — confirmar isso lendo o resultado real da automação "Perdeu Confirmação" depois de ativa (Task 17) em vez de só confiar na leitura de código.

---

### Task 17: Build, deploy único, ativação de dado e verificação (escopo de hoje — sem a Task 15)

⚠️ **Esta é a Task que efetivamente coloca tudo no ar — não uma checagem final de algo que já foi ao ar aos pedaços.** Reestruturado na 4ª auditoria (achados REAL-BUG-4 e RISK-8): as Tasks 10-13 só mudaram CÓDIGO e COMMITARAM — nada foi buildado com restart, nem a automação foi ativada. A ordem abaixo é a única sequência segura: build único (carrega TUDO — engine com `start_flow`, rota do Cal.com, marcador `[ia-whatsapp]`, gate de véspera — de uma vez, sem janela parcial) → restart wacrm → restart intake.js (só agora, com a rota já existindo pro lado que ele chama) → SÓ ENTÃO a ativação de dado (automações), porque só agora o motor entende `start_flow` de verdade.

- [ ] **Step 1:** `ssh root@100.85.48.50 "cd /root/wacrm && npx vitest run"` — Expected: só as 2 falhas pré-existentes.
- [ ] **Step 2:** `ssh root@100.85.48.50 "cd /root/wacrm && npm run build"` — build limpo. Isto reconfirma o build já limpo da Task 11 Step 6, agora com as mudanças das Tasks 12 (marcador `[ia-whatsapp]`) e 13 (gate de véspera) também dentro — se alguma delas quebrar o tipo, é AQUI que aparece, antes de qualquer restart.
- [ ] **Step 3:** `ssh root@100.85.48.50 "pm2 restart wacrm"` — SÓ AGORA o Fluxo, a rota `/api/flows/calcom-booking`, o marcador e o gate de véspera vão ao ar, todos juntos. Checar `pm2 list`, `wacrm` `online`.
- [ ] **Step 4:** `ssh root@100.85.48.50 "pm2 restart intake"` (Task 12 já editou o arquivo e commitou — o restart de verdade é AQUI, depois de a rota que ele chama já existir; reiniciar antes disso não quebra nada — `fluxoDonoDoContato` falha aberto pra 404/erro de rede, achado REAL-BUG-5 — mas reiniciar depois evita chamadas inúteis até este ponto). Checar `pm2 list`, `intake` `online`.
- [ ] **Step 5: Testar a rota do Cal.com (adiado da Task 11, Step 7)**

```bash
ssh root@100.85.48.50 "curl -s -X POST http://localhost:3000/api/flows/calcom-booking -H 'content-type: application/json' -H \"x-engine-secret: \$(grep AUTOMATION_ENGINE_SECRET /root/wacrm/.env.local | cut -d= -f2-)\" -d '{\"contactId\":\"00000000-0000-0000-0000-000000000000\",\"accountId\":\"2569c0e9-5f2e-4d04-957c-e2f158e7a87e\",\"event\":\"created\"}'"
```
(`cut -d= -f2-`, não `-f2` — achado K4 da 3ª auditoria.) Expected: `{"decision":"dispatched_to_automations"}`. Repetir sem o header e confirmar `401`.

- [ ] **Step 6: Ativação de dado (movida da Task 10, achado RISK-8)**

```bash
ssh root@100.85.48.50 "cd /root/wacrm && node scripts/wire-automacoes-fluxo-agendamento.js --flow-agendamento-id=<uuid-task8> --flow-noshow-id=<uuid-task9>"
```
Expected: `ativação aplicada: Agendou + Perdeu Confirmação ON.` seguido do aviso de que a "Follow up No-show antiga" continua ativa de propósito (achado RISK-9 — ver Task 15). Só roda AGORA porque o motor só entende `case 'start_flow'` a partir do restart do Step 3; rodar isto mais cedo (como uma versão anterior deste plano fazia, na Task 10) abriria uma janela onde um card em "Follow up No-show" cairia no `unknown step` silencioso do motor.

- [ ] **Step 7:** Verificação manual (Steps 3-4 originais da Task 12, adiados pra cá pela 5ª auditoria — só agora fazem sentido, com wacrm E intake.js já reiniciados) — simular `[[AGENDAR]]` num contato PF qualificado com um número de teste, deixar o Fluxo reservar, confirmar `outcome:'started'`, conferir `flow_run_events`; conferir no log do `intake.js` (`pm2 logs intake`) que a linha `Fluxo ativo pra este contato... intake nao mexe` aparece; confirmar no banco que `contact_custom_values` NÃO ganhou uma nova entrada pro campo `e482845b-...` e que o card NÃO foi movido pra etapa `fd70e3b2-...` (Reunião Agendada antiga). ⚠️ Achado RISK da 5ª auditoria, checar também: a automação "Remarcado via No-show (Fluxo)" dispara `start_flow` na tag `Remarcado`, aplicada pelo próprio Fluxo No-show (`marcar_remarcado`) ANTES de esse run terminar (`fim_remarcado`, um nó depois) — se o webhook da tag chegar antes do fim do run, `insertAndStartRun` pode bater no índice único (`23505`) e devolver `duplicate_inbound_ignored`, e o Fluxo de Agendamento nunca inicia pro remarcado. Não é um bug pra corrigir agora (a corrida é rara — o avanço em processo é bem mais rápido que o round-trip HTTP), mas conferir em `flow_run_events` durante este Step que isso não aconteceu no teste real.
- [ ] **Step 8:** Reportar ao titular: build/testes/deploy OK (wacrm E intake.js); template pendente de aprovação Meta; Canal A completo no ar (Fluxo de Agendamento + Fluxo No-show + `[[AGENDAR]]` + proteção contra o `intake.js`/webhook antigo colidirem com reserva nova do Fluxo). **A Task 15 (migrar as 37 reuniões já agendadas + desativar as automações antigas) NÃO rodou** — a 3ª auditoria achou que mandaria zero mensagem pra ~20 dessas pessoas (motor de Fluxos não manda template, e a maioria está fora da janela de 24h do WhatsApp); as automações antigas continuam ATIVAS de propósito, cobrindo essas 37 reuniões normalmente enquanto a Task 15 é redesenhada numa sessão dedicada. ⚠️ **Correção RISK-9 (4ª auditoria) sobre esta mesma frase numa versão anterior:** das 4 automações "antigas" que ficam ativas, a "Follow up No-show — 3 toques e encerra" é uma 5ª, DISTINTA das 4 do lembrete de véspera — e o Step 6 acima já a mantém explicitamente ligada (não é mais desativada cedo, como acontecia quando o flip rodava na Task 10 antiga). Reportar os 5 nomes, não 4, se o titular perguntar quais automações antigas seguem cobrindo o quê. Não é pendência esquecida — é a decisão de não trocar cobertura real por uma migração que falharia silenciosamente. O gatilho `calcom_booking_*` (Task 11) fica pronto, sem Automação configurada ainda, esperando o Canal B (lead agenda direto no Cal.com, sem passar pela Márcia) ou a versão redesenhada da Task 15.
