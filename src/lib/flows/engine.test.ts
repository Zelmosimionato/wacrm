import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared mock state for the service-role client, used only by the
// dispatchInboundToFlows/handleReplyForActiveRun suite below. Lives in a
// hoisted block so the vi.mock factory can close over it. Mirrors the
// pattern in src/lib/automations/engine.test.ts.
const h = vi.hoisted(() => ({
  state: {
    activeRun: null as Record<string, unknown> | null,
    nodeRows: [] as Record<string, unknown>[],
    flow: null as Record<string, unknown> | null,
    flowRunUpdates: [] as Record<string, unknown>[],
    pendingResumeUpdates: [] as {
      payload: unknown;
      filters: [string, string, unknown][];
    }[],
    // offer_slots — cada teste seta o retorno que quer que
    // horariosLivres devolva (o mock nunca bate no Cal.com de verdade).
    horariosLivresReturn: [] as { iso: string; rotulo: string }[],
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type, payload, filters } = ops;
    if (table === "flow_runs") {
      if (type === "update") {
        state.flowRunUpdates.push(payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      // Both loadActiveRunForContact and isDuplicateInbound read from
      // flow_runs — the fixture run satisfies both (id is all
      // isDuplicateInbound needs from the row).
      return { data: state.activeRun ? [state.activeRun] : [], error: null };
    }
    if (table === "flow_run_events") {
      // insert() is logEvent(); the bare select() is the
      // isDuplicateInbound count query — always "not a duplicate" here.
      return { data: [], error: null, count: 0 };
    }
    if (table === "flow_nodes") {
      return { data: state.nodeRows, error: null };
    }
    if (table === "flow_pending_resumes") {
      if (type === "update") {
        state.pendingResumeUpdates.push({ payload, filters });
      }
      return { data: null, error: null };
    }
    if (table === "flows") {
      return { data: state.flow, error: null };
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
      eq: (k: string, v: unknown) => (ops.filters.push(["eq", k, v]), b),
      in: (k: string, v: unknown) => (ops.filters.push(["in", k, v]), b),
      filter: (k: string, op: string, v: unknown) => (
        ops.filters.push([`filter:${op}`, k, v]), b
      ),
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
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

vi.mock("@/lib/appointments/calcom-slots", () => {
  const { state } = h;
  return {
    horariosLivres: vi.fn(async () => state.horariosLivresReturn),
  };
});

import { engineSendInteractiveList } from "./meta-send";
import { horariosLivres } from "@/lib/appointments/calcom-slots";
import {
  matchReplyId,
  matchesKeywordTrigger,
  isAutoAdvancing,
  isSuspending,
  isTerminal,
  evaluateConditionPredicate,
  waitMs,
  rotuloCurto,
  dispatchInboundToFlows,
} from "./engine";

describe("matchReplyId", () => {
  it("returns null for nodes without options", () => {
    expect(
      matchReplyId({ node_type: "start", config: { next_node_key: "x" } }, "y"),
    ).toBeNull();
    expect(
      matchReplyId({ node_type: "send_message", config: {} }, "y"),
    ).toBeNull();
    expect(matchReplyId({ node_type: "end", config: {} }, "y")).toBeNull();
  });

  it("matches the buttons array on a send_buttons node", () => {
    const node = {
      node_type: "send_buttons",
      config: {
        text: "Pick one",
        buttons: [
          { reply_id: "yes", title: "Yes", next_node_key: "confirmed" },
          { reply_id: "no", title: "No", next_node_key: "declined" },
        ],
      },
    };
    expect(matchReplyId(node, "yes")).toBe("confirmed");
    expect(matchReplyId(node, "no")).toBe("declined");
  });

  it("returns null when no button reply_id matches", () => {
    const node = {
      node_type: "send_buttons",
      config: {
        text: "Pick",
        buttons: [
          { reply_id: "a", title: "A", next_node_key: "to_a" },
          { reply_id: "b", title: "B", next_node_key: "to_b" },
        ],
      },
    };
    expect(matchReplyId(node, "c")).toBeNull();
    expect(matchReplyId(node, "")).toBeNull();
  });

  it("searches across all sections in a send_list node", () => {
    const node = {
      node_type: "send_list",
      config: {
        text: "Pick an order",
        button_label: "View",
        sections: [
          {
            title: "Recent",
            rows: [
              { reply_id: "o1", title: "Order 1", next_node_key: "ord_1" },
            ],
          },
          {
            title: "Older",
            rows: [
              { reply_id: "o2", title: "Order 2", next_node_key: "ord_2" },
              { reply_id: "o3", title: "Order 3", next_node_key: "ord_3" },
            ],
          },
        ],
      },
    };
    expect(matchReplyId(node, "o1")).toBe("ord_1");
    expect(matchReplyId(node, "o2")).toBe("ord_2");
    expect(matchReplyId(node, "o3")).toBe("ord_3");
    expect(matchReplyId(node, "o99")).toBeNull();
  });

  it("returns null when send_list has no sections / empty sections", () => {
    expect(
      matchReplyId(
        { node_type: "send_list", config: { text: "x", sections: [] } },
        "x",
      ),
    ).toBeNull();
    expect(
      matchReplyId(
        {
          node_type: "send_list",
          config: { text: "x", sections: [{ rows: [] }] },
        },
        "x",
      ),
    ).toBeNull();
  });
});

describe("matchesKeywordTrigger", () => {
  it("returns false for empty text", () => {
    expect(matchesKeywordTrigger("", { keywords: ["hi"] })).toBe(false);
  });

  it("returns false when keywords array is empty", () => {
    expect(matchesKeywordTrigger("anything", { keywords: [] })).toBe(false);
  });

  it("default match_type='contains' does case-insensitive substring", () => {
    const cfg = { keywords: ["support"] };
    expect(matchesKeywordTrigger("I need SUPPORT please", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Support is great", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Help me", cfg)).toBe(false);
  });

  it("match_type='exact' compares the whole string case-insensitively", () => {
    const cfg = { keywords: ["help"], match_type: "exact" as const };
    expect(matchesKeywordTrigger("help", cfg)).toBe(true);
    expect(matchesKeywordTrigger("HELP", cfg)).toBe(true);
    expect(matchesKeywordTrigger("help me", cfg)).toBe(false);
  });

  it("case_sensitive=true preserves case", () => {
    const cfg = {
      keywords: ["Support"],
      case_sensitive: true,
    };
    expect(matchesKeywordTrigger("I need Support", cfg)).toBe(true);
    expect(matchesKeywordTrigger("I need support", cfg)).toBe(false);
  });

  it("matches any one of multiple keywords", () => {
    const cfg = { keywords: ["help", "support", "issue"] };
    expect(matchesKeywordTrigger("I have an issue", cfg)).toBe(true);
    expect(matchesKeywordTrigger("I need Help!", cfg)).toBe(true);
    expect(matchesKeywordTrigger("nothing to see here", cfg)).toBe(false);
  });

  it("skips empty strings in the keywords array", () => {
    const cfg = { keywords: ["", "support", ""] };
    expect(matchesKeywordTrigger("support center", cfg)).toBe(true);
    expect(matchesKeywordTrigger("nope", cfg)).toBe(false);
  });
});

describe("node classification helpers", () => {
  it("isAutoAdvancing covers start + send_message + send_media + condition + set_tag", () => {
    expect(isAutoAdvancing("start")).toBe(true);
    expect(isAutoAdvancing("send_message")).toBe(true);
    expect(isAutoAdvancing("send_media")).toBe(true);
    expect(isAutoAdvancing("condition")).toBe(true);
    expect(isAutoAdvancing("set_tag")).toBe(true);
    expect(isAutoAdvancing("send_buttons")).toBe(false);
    expect(isAutoAdvancing("send_list")).toBe(false);
    expect(isAutoAdvancing("collect_input")).toBe(false);
    expect(isAutoAdvancing("handoff")).toBe(false);
    expect(isAutoAdvancing("end")).toBe(false);
  });

  it("isSuspending covers the input-requiring nodes", () => {
    expect(isSuspending("send_buttons")).toBe(true);
    expect(isSuspending("send_list")).toBe(true);
    expect(isSuspending("collect_input")).toBe(true);
    expect(isSuspending("start")).toBe(false);
    expect(isSuspending("send_message")).toBe(false);
    expect(isSuspending("condition")).toBe(false);
    expect(isSuspending("set_tag")).toBe(false);
    expect(isSuspending("handoff")).toBe(false);
    expect(isSuspending("end")).toBe(false);
  });

  it("isTerminal covers handoff + end", () => {
    expect(isTerminal("handoff")).toBe(true);
    expect(isTerminal("end")).toBe(true);
    expect(isTerminal("start")).toBe(false);
    expect(isTerminal("send_buttons")).toBe(false);
    expect(isTerminal("condition")).toBe(false);
  });

  it("the three classifications are mutually exclusive for known node types", () => {
    const types = [
      "start",
      "send_message",
      "send_buttons",
      "send_list",
      "send_media",
      "collect_input",
      "condition",
      "set_tag",
      "handoff",
      "end",
    ];
    for (const t of types) {
      const flags = [isAutoAdvancing(t), isSuspending(t), isTerminal(t)];
      // Exactly one of the three should be true for every known node.
      expect(flags.filter(Boolean).length).toBe(1);
    }
  });
});

describe("evaluateConditionPredicate", () => {
  it("present: true when subject has a value", () => {
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: "alice@example.com",
        configValue: undefined,
      }),
    ).toBe(true);
  });

  it("present: false when subject is undefined or empty", () => {
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: undefined,
        configValue: undefined,
      }),
    ).toBe(false);
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: "",
        configValue: undefined,
      }),
    ).toBe(false);
  });

  it("absent: inverse of present", () => {
    expect(
      evaluateConditionPredicate({
        operator: "absent",
        subjectValue: undefined,
        configValue: undefined,
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "absent",
        subjectValue: "x",
        configValue: undefined,
      }),
    ).toBe(false);
  });

  it("equals: exact string comparison; case-sensitive", () => {
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: "VIP",
        configValue: "VIP",
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: "vip",
        configValue: "VIP",
      }),
    ).toBe(false);
  });

  it("equals: undefined subject never matches (even against empty)", () => {
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: undefined,
        configValue: "",
      }),
    ).toBe(false);
  });

  it("contains: substring match", () => {
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: "support@example.com",
        configValue: "@example.com",
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: "support@other.com",
        configValue: "@example.com",
      }),
    ).toBe(false);
  });

  it("contains: undefined subject never matches", () => {
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: undefined,
        configValue: "anything",
      }),
    ).toBe(false);
  });
});

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

// ============================================================
// dispatchInboundToFlows — interrupção por palavra-chave num nó wait.
// Vai pela entrada pública (não handleReplyForActiveRun direto, que não
// é exportada) com o admin-client mockado — mesmo padrão hoisted-mock
// de src/lib/automations/engine.test.ts.
// ============================================================

const NOW = new Date().toISOString();

function waitRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    flow_id: "flow-1",
    account_id: "acct-1",
    user_id: "user-1",
    contact_id: "contact-1",
    conversation_id: "conv-1",
    status: "active",
    current_node_key: "wait1",
    last_prompt_message_id: null,
    vars: {},
    reprompt_count: 0,
    started_at: NOW,
    last_advanced_at: NOW,
    ended_at: null,
    end_reason: null,
    ...overrides,
  };
}

function node(overrides: Record<string, unknown>) {
  return {
    id: `n-${overrides.node_key}`,
    flow_id: "flow-1",
    position_x: 0,
    position_y: 0,
    created_at: NOW,
    ...overrides,
  };
}

const WAIT_NODES = [
  node({
    node_key: "wait1",
    node_type: "wait",
    config: {
      unit: "hours",
      amount: 24,
      next_node_key: "timeout_end",
      keyword_branches: [
        {
          trigger: { keywords: ["remarcar"], match_type: "contains" },
          next_node_key: "kw_end",
        },
      ],
    },
  }),
  node({ node_key: "kw_end", node_type: "end", config: {} }),
  node({ node_key: "timeout_end", node_type: "end", config: {} }),
];

beforeEach(() => {
  h.state.activeRun = null;
  h.state.nodeRows = [];
  h.state.flow = null;
  h.state.flowRunUpdates = [];
  h.state.pendingResumeUpdates = [];
  h.state.horariosLivresReturn = [];
  vi.unstubAllEnvs();
  vi.mocked(engineSendInteractiveList).mockClear();
  vi.mocked(horariosLivres).mockClear();
});

describe("dispatchInboundToFlows — wait node keyword interrupt", () => {
  it("texto que casa com keyword_branches avança pro next_node_key do ramo e cancela a retomada agendada", async () => {
    h.state.activeRun = waitRun();
    h.state.nodeRows = WAIT_NODES;

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "quero remarcar", meta_message_id: "m-1" },
      isFirstInboundMessage: false,
    });

    expect(result.consumed).toBe(true);
    expect(result.flow_run_id).toBe("run-1");
    // O ramo de palavra-chave levou pro nó "kw_end" (type "end") →
    // advanceFromNodeKey encerra a run como "completed".
    expect(result.outcome).toBe("completed");

    // Cancelou a retomada pendente daquele nó específico.
    expect(h.state.pendingResumeUpdates).toHaveLength(1);
    const cancel = h.state.pendingResumeUpdates[0];
    expect(cancel.payload).toEqual({ status: "cancelled" });
    expect(cancel.filters).toEqual([
      ["eq", "flow_run_id", "run-1"],
      ["eq", "node_key", "wait1"],
      ["eq", "status", "pending"],
    ]);

    // A run terminou pelo end_node do ramo de keyword, não pelo timeout.
    expect(
      h.state.flowRunUpdates.some(
        (u) => u.status === "completed" && u.end_reason === "end_node",
      ),
    ).toBe(true);
  });

  it("texto que não casa com nenhuma keyword cai no fallback normal, sem cancelar a retomada", async () => {
    h.state.activeRun = waitRun();
    h.state.nodeRows = WAIT_NODES;

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "oi, tudo bem?", meta_message_id: "m-2" },
      isFirstInboundMessage: false,
    });

    expect(result.consumed).toBe(true);
    expect(result.flow_run_id).toBe("run-1");
    // Sem match → fallback (policy default = reprompt; nó "wait" não
    // tem reenvio próprio, então só sinaliza fallback_fired).
    expect(result.outcome).toBe("fallback_fired");

    // Nada de cancelamento — a retomada por tempo continua de pé.
    expect(h.state.pendingResumeUpdates).toHaveLength(0);
  });

  it("nó atual não é wait — ramo novo não interfere no collect_input já existente", async () => {
    h.state.activeRun = waitRun({ current_node_key: "collect1" });
    h.state.nodeRows = [
      node({
        node_key: "collect1",
        node_type: "collect_input",
        config: { prompt_text: "Qual seu nome?", var_key: "nome", next_node_key: "end2" },
      }),
      node({ node_key: "end2", node_type: "end", config: {} }),
    ];

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: { kind: "text", text: "Zelmo", meta_message_id: "m-3" },
      isFirstInboundMessage: false,
    });

    expect(result.consumed).toBe(true);
    // collect_input capturou e avançou pro end2 — comportamento
    // pré-existente, inalterado pelo ramo novo (que exige node_type
    // === "wait" e nunca dispara aqui).
    expect(result.outcome).toBe("completed");
    expect(h.state.pendingResumeUpdates).toHaveLength(0);
  });
});

// ============================================================
// rotuloCurto — título curto de linha de lista (≤ 24 chars, exigência
// da Meta), a partir do ISO cru que horariosLivres devolve.
// ============================================================

describe("rotuloCurto", () => {
  it("formata dia/mês hora:minuto, sempre dentro do limite de 24 caracteres da Meta", () => {
    const r = rotuloCurto("2026-08-11T17:00:00.000Z"); // 14:00 BRT (UTC-3)
    expect(r).toBe("11/08 14:00");
    expect(r.length).toBeLessThanOrEqual(24);
  });
});

// ============================================================
// dispatchInboundToFlows — nó offer_slots. Entra pelo mesmo caminho já
// usado acima pro collect_input (reply de texto que captura e avança):
// collect1 (collect_input) → offer1 (offer_slots) → book1/no_slots_end
// (end). horariosLivres é mockado (não bate no Cal.com de verdade).
// ============================================================

const OFFER_SLOTS_CFG = {
  prompt_text: "Temos estes horários disponíveis:",
  button_label: "Ver horários",
  result_var_key: "horario_escolhido",
  next_node_key: "book1",
  no_slots_next_node_key: "no_slots_end",
};

const OFFER_SLOTS_NODES = [
  node({
    node_key: "collect1",
    node_type: "collect_input",
    config: { prompt_text: "Qual seu nome?", var_key: "nome", next_node_key: "offer1" },
  }),
  node({ node_key: "offer1", node_type: "offer_slots", config: OFFER_SLOTS_CFG }),
  node({ node_key: "book1", node_type: "end", config: {} }),
  node({ node_key: "no_slots_end", node_type: "end", config: {} }),
];

function sendOfferSlotsReply(metaMessageId = "m-os-1") {
  h.state.activeRun = waitRun({ current_node_key: "collect1" });
  h.state.nodeRows = OFFER_SLOTS_NODES;
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "user-1",
    contactId: "contact-1",
    conversationId: "conv-1",
    message: { kind: "text", text: "Zelmo", meta_message_id: metaMessageId },
    isFirstInboundMessage: false,
  });
}

describe("dispatchInboundToFlows — offer_slots node", () => {
  it("sem CALCOM_API_KEY/CALCOM_EVENT_TYPE_ID configurados — avança direto pro no_slots_next_node_key, sem chamar horariosLivres nem a lista", async () => {
    vi.stubEnv("CALCOM_API_KEY", "");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "");

    const result = await sendOfferSlotsReply();

    // no_slots_end é nó "end" → advanceFromNodeKey encerra a run.
    expect(result.outcome).toBe("completed");
    expect(horariosLivres).not.toHaveBeenCalled();
    expect(engineSendInteractiveList).not.toHaveBeenCalled();
  });

  it("horariosLivres devolve lista vazia — avança direto pro no_slots_next_node_key, sem mandar a lista", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.horariosLivresReturn = [];

    const result = await sendOfferSlotsReply();

    expect(result.outcome).toBe("completed");
    expect(horariosLivres).toHaveBeenCalledTimes(1);
    expect(engineSendInteractiveList).not.toHaveBeenCalled();
  });

  it("com horários disponíveis — manda a lista formatada (título=rotuloCurto, descrição=rotulo completo) e grava _offered_slots", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.horariosLivresReturn = [
      { iso: "2026-08-11T17:00:00.000Z", rotulo: "segunda-feira, 11/08 às 14:00" },
      { iso: "2026-08-12T18:00:00.000Z", rotulo: "terça-feira, 12/08 às 15:00" },
    ];

    const result = await sendOfferSlotsReply();

    // offer_slots suspende aguardando o tap na lista (Task 3 casa a
    // resposta) — não é terminal.
    expect(result.outcome).toBe("advanced");
    expect(horariosLivres).toHaveBeenCalledWith("42", "sk_test", 45, 10);
    expect(engineSendInteractiveList).toHaveBeenCalledTimes(1);

    const args = vi.mocked(engineSendInteractiveList).mock.calls[0][0] as {
      bodyText: string;
      buttonLabel: string;
      sections: { rows: { id: string; title: string; description?: string }[] }[];
    };
    expect(args.bodyText).toBe(OFFER_SLOTS_CFG.prompt_text);
    expect(args.buttonLabel).toBe(OFFER_SLOTS_CFG.button_label);
    expect(args.sections[0].rows).toEqual([
      { id: "slot_0", title: "11/08 14:00", description: "segunda-feira, 11/08 às 14:00" },
      { id: "slot_1", title: "12/08 15:00", description: "terça-feira, 12/08 às 15:00" },
    ]);

    // vars gravados: a captura do collect_input ("nome") sobrevive, e
    // _offered_slots entra com o mapeamento id → iso. Duas UPDATEs de
    // "vars" acontecem (a captura do collect_input, depois esta) —
    // pega a que já tem _offered_slots.
    const varsUpdate = h.state.flowRunUpdates.find(
      (u) => u.vars !== undefined && "_offered_slots" in (u.vars as object),
    ) as { vars: Record<string, unknown> } | undefined;
    expect(varsUpdate?.vars).toEqual({
      nome: "Zelmo",
      _offered_slots: [
        { id: "slot_0", iso: "2026-08-11T17:00:00.000Z" },
        { id: "slot_1", iso: "2026-08-12T18:00:00.000Z" },
      ],
    });
  });

  it("engineSendInteractiveList lança erro — loga o erro, encerra a run como failed e devolve outcome completed", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.horariosLivresReturn = [
      { iso: "2026-08-11T17:00:00.000Z", rotulo: "segunda-feira, 11/08 às 14:00" },
    ];
    vi.mocked(engineSendInteractiveList).mockImplementationOnce(async () => {
      throw new Error("meta 400");
    });

    const result = await sendOfferSlotsReply();

    expect(result.outcome).toBe("completed");
    expect(
      h.state.flowRunUpdates.some(
        (u) => u.status === "failed" && u.end_reason === "offer_slots_send_failed",
      ),
    ).toBe(true);
  });
});
