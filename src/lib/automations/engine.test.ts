import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared mock state for the service-role client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    owned: null as { id: string } | null,
    ownedCustomField: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as { table: string; filters: [string, string, unknown][] }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
    notificationsInserted: [] as Record<string, unknown>[],
  },
  startManualFlowRun: vi.fn(),
}));

vi.mock("./admin-client", () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type } = ops;
    if (table === "contacts") {
      if (type === "update") {
        state.updateCalls.push({ table, filters: ops.filters });
        return { data: null, error: null };
      }
      // ownership guard / condition read
      return { data: state.owned, error: null };
    }
    if (table === "custom_fields") {
      // account-scoped ownership lookup for a custom field definition
      return { data: state.ownedCustomField, error: null };
    }
    if (table === "contact_custom_values") {
      if (type === "upsert") {
        state.upsertCalls.push({ table, payload: ops.payload });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === "automations") return { data: state.automations, error: null };
    if (table === "automation_logs") {
      if (type === "insert") return { data: { id: "log1" }, error: null };
      if (type === "update") return { data: null, error: null };
      return { data: { steps_executed: [], status: "success" }, error: null };
    }
    if (table === "automation_steps") return { data: state.steps, error: null };
    if (table === "notifications") {
      if (type === "insert") {
        const rows = Array.isArray(ops.payload) ? ops.payload : [ops.payload];
        state.notificationsInserted.push(...(rows as Record<string, unknown>[]));
        return { data: rows, error: null };
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: "select",
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = "update"), (ops.payload = p), b),
      delete: () => ((ops.type = "delete"), b),
      upsert: (p: unknown) => ((ops.type = "upsert"), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(["eq", k, v]), b),
      in: (k: string, v: unknown) => (ops.filters.push(["in", k, v]), b),
      gte: () => b,
      is: () => b,
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => {
        state.fromCalls.push(t);
        return builder(t);
      },
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

vi.mock("@/lib/flows/engine", () => ({ startManualFlowRun: h.startManualFlowRun }));

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

import { runAutomationsForTrigger, triggerMatches, automacaoVaiResponder, tituloDoCard } from "./engine";
import type { Automation } from "@/types";

const ACCOUNT = "acct-1";

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
  h.state.notificationsInserted = [];
  h.startManualFlowRun.mockReset();
});

describe("runAutomationsForTrigger — tenant isolation", () => {
  it("refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)", async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "victim-contact-uuid",
      context: { message_text: "manual trigger" },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain("contacts");
    expect(h.state.fromCalls).not.toContain("automations");
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("proceeds past the guard when the contact belongs to the account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.fromCalls).toContain("automations");
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(1);
    const filters = h.state.updateCalls[0].filters;
    expect(filters).toContainEqual(["eq", "id", "c1"]);
    expect(filters).toContainEqual(["eq", "account_id", ACCOUNT]);
  });
});

describe("update_contact_field — custom fields", () => {
  it("upserts contact_custom_values when the field is account-owned", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "Premium")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].payload).toEqual({
      contact_id: "c1",
      custom_field_id: "cf1",
      value: "Premium",
    });
  });

  it("interpolates {{ vars.* }} into the custom value", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "{{ vars.source }}")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { vars: { source: "WhatsApp Ad" } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(
      (h.state.upsertCalls[0].payload as { value: string }).value,
    ).toBe("WhatsApp Ad");
  });

  it("refuses to write a custom field from another account", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:foreign-cf", "x")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

describe("send_webhook — SSRF guard (GHSA-8jqh-598v-rfxc)", () => {
  it("refuses a private / link-local destination and never calls fetch", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    // Aimed at the cloud metadata endpoint — the classic SSRF target.
    h.state.steps = [webhookStep("http://169.254.169.254/latest/meta-data/")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The automation matched and its steps were loaded (so we genuinely
    // reached the send_webhook case)...
    expect(h.state.fromCalls).toContain("automation_steps");
    // ...yet the guard blocked it before any outbound request left the box.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

function webhookStep(url: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "send_webhook",
    position: 0,
    parent_step_id: null,
    step_config: { url, headers: { "Metadata-Flavor": "Google" }, body_template: "{}" },
  };
}

function automationWithUpdateStep() {
  return {
    id: "a1",
    account_id: ACCOUNT,
    user_id: "u1",
    trigger_type: "new_message_received",
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field: "company", value: "pwned-by-automation" },
  };
}

function customStep(field: string, value: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}

describe("triggerMatches — interactive_reply", () => {
  function automation(reply_ids: string[]): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "menu step",
      trigger_type: "interactive_reply",
      trigger_config: { reply_ids },
      is_active: true,
      execution_count: 0,
      created_at: "",
      updated_at: "",
    };
  }

  it("matches when the tapped id is in reply_ids (exact)", () => {
    expect(
      triggerMatches(automation(["yes", "no"]), { interactive_reply_id: "yes" }),
    ).toBe(true);
  });

  it("does not match a different id", () => {
    expect(
      triggerMatches(automation(["yes"]), { interactive_reply_id: "maybe" }),
    ).toBe(false);
  });

  it("does not match on a substring (exact only)", () => {
    expect(
      triggerMatches(automation(["yes"]), { interactive_reply_id: "yes_please" }),
    ).toBe(false);
  });

  it("does not match when no reply id is present or config is empty", () => {
    expect(triggerMatches(automation(["yes"]), {})).toBe(false);
    expect(triggerMatches(automation([]), { interactive_reply_id: "yes" })).toBe(false);
  });
});

describe("triggerMatches — tag_added", () => {
  const SUPERQUALIFICADO = "tag-super";
  const NOVO_LEAD = "tag-novo-lead";

  function automation(tag_id: string): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "Superqualificado — primeiro toque",
      trigger_type: "tag_added",
      trigger_config: { tag_id },
      is_active: true,
      execution_count: 0,
      created_at: "",
      updated_at: "",
    };
  }

  it("⛔ 20/08/2026: NAO bate quando a tag adicionada é outra (era o bug — batia sempre)", () => {
    expect(
      triggerMatches(automation(SUPERQUALIFICADO), { tag_id: NOVO_LEAD }),
    ).toBe(false);
  });

  it("bate só quando a tag adicionada é exatamente a configurada", () => {
    expect(
      triggerMatches(automation(SUPERQUALIFICADO), { tag_id: SUPERQUALIFICADO }),
    ).toBe(true);
  });

  it("não bate sem tag_id no contexto ou sem tag_id configurado", () => {
    expect(triggerMatches(automation(SUPERQUALIFICADO), {})).toBe(false);
    expect(
      triggerMatches(automation(""), { tag_id: SUPERQUALIFICADO }),
    ).toBe(false);
  });
});

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

// Quem decide se a IA cala. Precisa ser PRECISO: calar demais deixa o lead
// sem resposta nenhuma (foi o defeito de 10/08/2026), calar de menos manda
// duas mensagens dizendo a mesma coisa.
describe("automacaoVaiResponder", () => {
  const auto = (extra: Record<string, unknown> = {}) => ({
    id: "a1",
    account_id: "acc-1",
    is_active: true,
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["confirmar meu agendamento"], match_type: "contains" },
    automation_steps: [{ step_type: "send_template" }],
    ...extra,
  });

  beforeEach(() => {
    h.state.automations = [];
  });

  it("cala a IA quando a palavra-chave casa e a automacao fala", async () => {
    h.state.automations = [auto()];
    expect(await automacaoVaiResponder("acc-1", "quero confirmar meu agendamento")).toBe(true);
  });

  it("NAO cala quando a automacao existe mas nao casa com o texto", async () => {
    h.state.automations = [auto()];
    expect(await automacaoVaiResponder("acc-1", "vim do site e quero informacoes")).toBe(false);
  });

  it("cala tambem no gatilho de toda mensagem, que casa sempre", async () => {
    h.state.automations = [auto({ trigger_type: "new_message_received", trigger_config: {} })];
    expect(await automacaoVaiResponder("acc-1", "qualquer coisa")).toBe(true);
  });

  it("NAO cala por automacao que so move card ou etiqueta — ninguem responderia", async () => {
    h.state.automations = [auto({ automation_steps: [{ step_type: "move_deal" }, { step_type: "add_tag" }] })];
    expect(await automacaoVaiResponder("acc-1", "quero confirmar meu agendamento")).toBe(false);
  });

  it("cala por automacao de botoes — send_buttons tambem fala", async () => {
    h.state.automations = [auto({ automation_steps: [{ step_type: "send_buttons" }] })];
    expect(await automacaoVaiResponder("acc-1", "quero confirmar meu agendamento")).toBe(true);
  });

  it("texto vazio nunca cala", async () => {
    h.state.automations = [auto()];
    expect(await automacaoVaiResponder("acc-1", "")).toBe(false);
  });
});

// Card sem nome de gente é card que ninguém reconhece no funil.
describe("tituloDoCard", () => {
  const args = { contactId: "c1", context: {} } as unknown as Parameters<typeof tituloDoCard>[1];
  const contato = async () => ({ name: "Ademir Souza", phone: "5511999999999" });
  const semNome = async () => ({ name: "", phone: "5511999999999" });

  it("troca {{contact.name}} pelo nome do contato", async () => {
    expect(await tituloDoCard("{{contact.name}}", args, contato)).toBe("Ademir Souza");
  });

  it("aceita texto junto da variavel", async () => {
    expect(await tituloDoCard("Lead — {{contact.name}}", args, contato)).toBe("Lead — Ademir Souza");
  });

  it("titulo em branco cai no nome do contato", async () => {
    expect(await tituloDoCard("", args, contato)).toBe("Ademir Souza");
  });

  it("sem nome, usa o telefone — nunca card anonimo", async () => {
    expect(await tituloDoCard("{{contact.name}}", args, semNome)).toBe("5511999999999");
  });

  it("texto fixo continua valendo para quem quer texto fixo", async () => {
    expect(await tituloDoCard("Orçamento", args, contato)).toBe("Orçamento");
  });
});
