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
    // book_meeting — a linha de `contacts` que a leitura de e-mail/nome/
    // telefone lê, e o retorno que criarReserva devolve (também nunca
    // bate no Cal.com de verdade).
    contactRow: null as Record<string, unknown> | null,
    criarReservaReturn: { ok: true, uid: "uid-1", inicio: "2026-08-12T18:00:00.000Z" } as
      | { ok: true; uid: string; inicio: string }
      | { ok: false; motivo: "indisponivel" | "email_invalido" | "recusado" },
    // book_meeting — quando true, o UPDATE de flow_runs que grava
    // booking_uid/booking_inicio_iso (identificado pelo payload) falha,
    // pra exercitar o log de erro sem derrubar o UPDATE anterior do
    // collect_input (que precisa continuar passando).
    forceBookingVarsUpdateError: false,
    // offer_slots (I-4) — quando true, o UPDATE de flow_runs que grava
    // _offered_slots falha, pra provar que a run ABORTA (não avança com
    // a lista já enviada mas a persistência divergente).
    forceOfferSlotsVarsPersistError: false,
    // offer_slots reply matching (M-1) — quando true, o UPDATE de
    // flow_runs que grava vars[result_var_key] no ramo de resposta falha,
    // pra provar que o erro é logado (não silencioso).
    forceOfferSlotsReplyVarsPersistError: false,
    // cancel_meeting — o retorno que cancelCalcomBooking devolve (nunca
    // bate no Cal.com de verdade); cada teste seta o que quer.
    cancelCalcomBookingReturn: true as boolean,
    // Todo insert em flow_run_events (= toda chamada a logEvent).
    flowRunEvents: [] as { event_type: string; node_key: unknown; payload: unknown }[],
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
        const p = payload as { vars?: Record<string, unknown> } | undefined;
        if (
          state.forceBookingVarsUpdateError &&
          p?.vars &&
          "booking_uid" in p.vars
        ) {
          return { data: null, error: { message: "connection reset" } };
        }
        if (
          state.forceOfferSlotsVarsPersistError &&
          p?.vars &&
          "_offered_slots" in p.vars
        ) {
          return { data: null, error: { message: "offer_slots vars persist failed" } };
        }
        if (
          state.forceOfferSlotsReplyVarsPersistError &&
          p?.vars &&
          "horario_escolhido" in p.vars
        ) {
          return { data: null, error: { message: "offer_slots reply vars persist failed" } };
        }
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
      if (type === "insert") {
        state.flowRunEvents.push(
          payload as { event_type: string; node_key: unknown; payload: unknown },
        );
      }
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
    if (table === "contacts") {
      return { data: state.contactRow, error: null };
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

vi.mock("@/lib/appointments/calcom-book", () => {
  const { state } = h;
  return {
    criarReserva: vi.fn(async () => state.criarReservaReturn),
  };
});

vi.mock("@/lib/appointments/calcom-cancel", () => {
  const { state } = h;
  return {
    cancelCalcomBooking: vi.fn(async () => state.cancelCalcomBookingReturn),
  };
});

import { engineSendInteractiveList } from "./meta-send";
import { horariosLivres } from "@/lib/appointments/calcom-slots";
import { criarReserva } from "@/lib/appointments/calcom-book";
import { cancelCalcomBooking } from "@/lib/appointments/calcom-cancel";
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
  it("isAutoAdvancing covers start + send_message + send_media + condition + set_tag + book_meeting + cancel_meeting", () => {
    expect(isAutoAdvancing("start")).toBe(true);
    expect(isAutoAdvancing("send_message")).toBe(true);
    expect(isAutoAdvancing("send_media")).toBe(true);
    expect(isAutoAdvancing("condition")).toBe(true);
    expect(isAutoAdvancing("set_tag")).toBe(true);
    expect(isAutoAdvancing("book_meeting")).toBe(true);
    expect(isAutoAdvancing("cancel_meeting")).toBe(true);
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
    expect(isSuspending("book_meeting")).toBe(false);
    expect(isSuspending("cancel_meeting")).toBe(false);
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

  it("keyword_match: matches when subject contains any keyword (case-insensitive contains by default)", () => {
    expect(
      evaluateConditionPredicate({
        operator: "keyword_match",
        subjectValue: "tenho um prazo correndo",
        configValue: undefined,
        keywords: { keywords: ["urgente", "prazo"] },
      }),
    ).toBe(true);
  });

  it("keyword_match: no match when subject doesn't contain any keyword", () => {
    expect(
      evaluateConditionPredicate({
        operator: "keyword_match",
        subjectValue: "não, tudo tranquilo",
        configValue: undefined,
        keywords: { keywords: ["urgente", "prazo"] },
      }),
    ).toBe(false);
  });

  it("keyword_match: undefined subject never matches", () => {
    expect(
      evaluateConditionPredicate({
        operator: "keyword_match",
        subjectValue: undefined,
        configValue: undefined,
        keywords: { keywords: ["urgente"] },
      }),
    ).toBe(false);
  });

  it("keyword_match: missing keywords config defaults to empty array, always false", () => {
    expect(
      evaluateConditionPredicate({
        operator: "keyword_match",
        subjectValue: "qualquer texto",
        configValue: undefined,
        keywords: undefined,
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
  h.state.contactRow = null;
  h.state.criarReservaReturn = { ok: true, uid: "uid-1", inicio: "2026-08-12T18:00:00.000Z" };
  h.state.forceBookingVarsUpdateError = false;
  h.state.forceOfferSlotsVarsPersistError = false;
  h.state.forceOfferSlotsReplyVarsPersistError = false;
  h.state.cancelCalcomBookingReturn = true;
  h.state.flowRunEvents = [];
  vi.unstubAllEnvs();
  vi.mocked(engineSendInteractiveList).mockClear();
  vi.mocked(horariosLivres).mockClear();
  vi.mocked(criarReserva).mockClear();
  vi.mocked(cancelCalcomBooking).mockClear();
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
        {
          id: "slot_0",
          iso: "2026-08-11T17:00:00.000Z",
          rotulo: "segunda-feira, 11/08 às 14:00",
        },
        {
          id: "slot_1",
          iso: "2026-08-12T18:00:00.000Z",
          rotulo: "terça-feira, 12/08 às 15:00",
        },
      ],
    });
  });

  it("I-1: horariosLivres lança (rejeita) — loga offer_slots_slots_threw e cai no no_slots_next_node_key, sem mandar a lista", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    vi.mocked(horariosLivres).mockRejectedValueOnce(new Error("timeout"));

    const result = await sendOfferSlotsReply();

    // no_slots_end é nó "end" — a rejeição foi tratada como "sem horário
    // disponível", não subiu por advanceFromNodeKey inteiro.
    expect(result.outcome).toBe("completed");
    expect(engineSendInteractiveList).not.toHaveBeenCalled();

    const threwEvent = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "error" &&
        (e.payload as { reason?: string } | undefined)?.reason ===
          "offer_slots_slots_threw",
    );
    expect(threwEvent).toBeDefined();
    expect((threwEvent?.payload as { detail?: string }).detail).toBe("timeout");
  });

  it("I-4: falha ao persistir _offered_slots — ABORTA a run (failed/offer_slots_vars_persist_failed) em vez de avançar com a lista divergente", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.horariosLivresReturn = [
      { iso: "2026-08-11T17:00:00.000Z", rotulo: "segunda-feira, 11/08 às 14:00" },
    ];
    h.state.forceOfferSlotsVarsPersistError = true;

    const result = await sendOfferSlotsReply();

    // A lista já saiu pro WhatsApp (não dá pra desmandar), mas a run é
    // encerrada como failed em vez de seguir com _offered_slots
    // divergente do que o cliente está vendo — o risco de casar o
    // horário ERRADO numa resposta futura.
    expect(engineSendInteractiveList).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("completed");
    expect(
      h.state.flowRunUpdates.some(
        (u) =>
          u.status === "failed" &&
          u.end_reason === "offer_slots_vars_persist_failed",
      ),
    ).toBe(true);
    const errEvent = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "error" &&
        (e.payload as { reason?: string } | undefined)?.reason ===
          "offer_slots_vars_persist_failed",
    );
    expect(errEvent).toBeDefined();
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

// ============================================================
// dispatchInboundToFlows — casa o tap na lista com o horário
// oferecido (Task 3). Simula o estado pós-offer_slots: run já parada
// no nó offer_slots, com vars._offered_slots gravado pelo Task 2.
// ============================================================

const OFFERED_SLOTS_VARS = {
  _offered_slots: [
    {
      id: "slot_0",
      iso: "2026-08-11T17:00:00.000Z",
      rotulo: "segunda-feira, 11/08 às 14:00",
    },
    {
      id: "slot_1",
      iso: "2026-08-12T18:00:00.000Z",
      rotulo: "terça-feira, 12/08 às 15:00",
    },
  ],
};

function sendOfferSlotsTap(replyId: string, metaMessageId = "m-tap-1") {
  h.state.activeRun = waitRun({
    current_node_key: "offer1",
    vars: OFFERED_SLOTS_VARS,
  });
  h.state.nodeRows = OFFER_SLOTS_NODES;
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "user-1",
    contactId: "contact-1",
    conversationId: "conv-1",
    message: {
      kind: "interactive_reply",
      reply_id: replyId,
      reply_title: "t",
      meta_message_id: metaMessageId,
    },
    isFirstInboundMessage: false,
  });
}

describe("dispatchInboundToFlows — offer_slots reply matching", () => {
  it("reply_id bate com um item de _offered_slots — avança pro next_node_key e grava vars[result_var_key] com o iso", async () => {
    const result = await sendOfferSlotsTap("slot_1");

    // book1 é nó "end" (next_node_key do offer1) → advanceFromNodeKey
    // encerra a run.
    expect(result.outcome).toBe("completed");

    const varsUpdate = h.state.flowRunUpdates.find(
      (u) => u.vars !== undefined && "horario_escolhido" in (u.vars as object),
    ) as { vars: Record<string, unknown>; reprompt_count?: number } | undefined;
    expect(varsUpdate?.vars).toEqual({
      ...OFFERED_SLOTS_VARS,
      horario_escolhido: "2026-08-12T18:00:00.000Z",
      horario_escolhido_rotulo: "terça-feira, 12/08 às 15:00",
    });
    expect(varsUpdate?.reprompt_count).toBe(0);
  });

  it("M-1: UPDATE de vars[result_var_key] falha — loga offer_slots_reply_vars_persist_failed e cai no fallback normal (não trava a run)", async () => {
    h.state.forceOfferSlotsReplyVarsPersistError = true;

    const result = await sendOfferSlotsTap("slot_1");

    // Sem abortar — diferente do I-4, esta é uma resposta que ainda pode
    // ser reperguntada pelo reprompt normal.
    expect(result.outcome).toBe("fallback_fired");
    const errEvent = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "error" &&
        (e.payload as { reason?: string } | undefined)?.reason ===
          "offer_slots_reply_vars_persist_failed",
    );
    expect(errEvent).toBeDefined();
    expect((errEvent?.payload as { detail?: string }).detail).toBe(
      "offer_slots reply vars persist failed",
    );
  });

  it("reply_id não bate com nenhum item de _offered_slots — cai no fallback normal, vars inalterado", async () => {
    const result = await sendOfferSlotsTap("slot_9");

    expect(result.outcome).toBe("fallback_fired");
    expect(
      h.state.flowRunUpdates.some(
        (u) => u.vars !== undefined && "horario_escolhido" in (u.vars as object),
      ),
    ).toBe(false);
  });

  it("nó atual não é offer_slots — ramo novo não interfere no send_buttons já existente", async () => {
    h.state.activeRun = waitRun({ current_node_key: "btn1" });
    h.state.nodeRows = [
      node({
        node_key: "btn1",
        node_type: "send_buttons",
        config: {
          text: "Confirma?",
          buttons: [
            { reply_id: "yes", title: "Sim", next_node_key: "end_yes" },
            { reply_id: "no", title: "Não", next_node_key: "end_no" },
          ],
        },
      }),
      node({ node_key: "end_yes", node_type: "end", config: {} }),
      node({ node_key: "end_no", node_type: "end", config: {} }),
    ];

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "user-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      message: {
        kind: "interactive_reply",
        reply_id: "yes",
        reply_title: "Sim",
        meta_message_id: "m-btn-1",
      },
      isFirstInboundMessage: false,
    });

    // matchReplyId (ramo pré-existente) resolveu normalmente — o ramo
    // novo exige node_type === "offer_slots" e nunca dispara aqui.
    expect(result.outcome).toBe("completed");
  });
});

// ============================================================
// dispatchInboundToFlows — nó book_meeting (Task 4). Entra pelo mesmo
// caminho já usado acima pro collect_input: collect1 (collect_input,
// só pra ter um nó suspenso que dispara o avanço) → book1
// (book_meeting) → um dos ends. O vars pré-existente na run já traz
// o slot escolhido (o que um offer_slots real teria gravado). Nem
// criarReserva nem a leitura de `contacts` batem no mundo real —
// ambos mockados via h.state.
// ============================================================

const BOOK_MEETING_CFG = {
  slot_var_key: "horario_escolhido",
  email_var_key: "email_capturado",
  success_next_node_key: "booked_end",
  failure_next_node_keys: {
    indisponivel: "indisponivel_end",
    sem_email: "sem_email_end",
    generico: "generico_end",
    // "email_invalido" e "recusado" ficam de fora de propósito — cobre
    // o fallback pro ramo generico quando o motivo não tem ramo próprio.
  },
};

const BOOK_MEETING_NODES = [
  node({
    node_key: "collect1",
    node_type: "collect_input",
    config: { prompt_text: "Qual seu nome?", var_key: "nome", next_node_key: "book1" },
  }),
  node({ node_key: "book1", node_type: "book_meeting", config: BOOK_MEETING_CFG }),
  node({ node_key: "booked_end", node_type: "end", config: {} }),
  node({ node_key: "indisponivel_end", node_type: "end", config: {} }),
  node({ node_key: "sem_email_end", node_type: "end", config: {} }),
  node({ node_key: "generico_end", node_type: "end", config: {} }),
];

function sendBookMeetingReply(
  vars: Record<string, unknown> = {},
  metaMessageId = "m-bm-1",
) {
  h.state.activeRun = waitRun({ current_node_key: "collect1", vars });
  h.state.nodeRows = BOOK_MEETING_NODES;
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "user-1",
    contactId: "contact-1",
    conversationId: "conv-1",
    message: { kind: "text", text: "Zelmo", meta_message_id: metaMessageId },
    isFirstInboundMessage: false,
  });
}

describe("dispatchInboundToFlows — book_meeting node", () => {
  it("reserva com sucesso — grava booking_uid/booking_inicio_iso em vars e avança pro success_next_node_key", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.contactRow = { name: "Zelmo Simionato", phone: "+5511999999999", email: "zelmo@example.com" };
    h.state.criarReservaReturn = { ok: true, uid: "uid-abc", inicio: "2026-08-12T18:00:00.000Z" };

    const result = await sendBookMeetingReply({ horario_escolhido: "2026-08-12T18:00:00.000Z" });

    // booked_end é nó "end" → advanceFromNodeKey encerra a run.
    expect(result.outcome).toBe("completed");
    expect(criarReserva).toHaveBeenCalledWith({
      eventTypeId: "42",
      apiKey: "sk_test",
      iso: "2026-08-12T18:00:00.000Z",
      nome: "Zelmo Simionato",
      email: "zelmo@example.com",
      telefone: "+5511999999999",
    });

    const varsUpdate = h.state.flowRunUpdates.find(
      (u) => u.vars !== undefined && "booking_uid" in (u.vars as object),
    ) as { vars: Record<string, unknown> } | undefined;
    expect(varsUpdate?.vars).toEqual({
      nome: "Zelmo",
      horario_escolhido: "2026-08-12T18:00:00.000Z",
      booking_uid: "uid-abc",
      booking_inicio_iso: "2026-08-12T18:00:00.000Z",
      // I-2: sem `horario_escolhido_rotulo` em vars (este fluxo de teste
      // não passou por um offer_slots real que o gravasse), cai no
      // fallback formatado a partir do próprio reserva.inicio via
      // rotuloCurto — "2026-08-12T18:00:00.000Z" = 15:00 em America/Sao_Paulo.
      booking_rotulo: "12/08 15:00",
    });
  });

  it("I-2: rótulo legível de offer_slots (vars[`${slot_var_key}_rotulo`]) sobrevive como booking_rotulo quando presente", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.contactRow = { name: "Zelmo", phone: "+5511999999999", email: "zelmo@example.com" };
    h.state.criarReservaReturn = { ok: true, uid: "uid-abc", inicio: "2026-08-12T18:00:00.000Z" };

    await sendBookMeetingReply({
      horario_escolhido: "2026-08-12T18:00:00.000Z",
      horario_escolhido_rotulo: "terça-feira, 12/08 às 15:00",
    });

    const varsUpdate = h.state.flowRunUpdates.find(
      (u) => u.vars !== undefined && "booking_uid" in (u.vars as object),
    ) as { vars: Record<string, unknown> } | undefined;
    expect(varsUpdate?.vars.booking_rotulo).toBe("terça-feira, 12/08 às 15:00");
  });

  it("e-mail vem de vars[email_var_key], não do contato, quando presente", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.contactRow = { name: "Zelmo", phone: "+5511999999999", email: "do-contato@example.com" };
    h.state.criarReservaReturn = { ok: true, uid: "uid-abc", inicio: "2026-08-12T18:00:00.000Z" };

    await sendBookMeetingReply({
      horario_escolhido: "2026-08-12T18:00:00.000Z",
      email_capturado: "digitado@example.com",
    });

    expect(criarReserva).toHaveBeenCalledWith(
      expect.objectContaining({ email: "digitado@example.com" }),
    );
  });

  it("criarReserva devolve falha com motivo mapeado (indisponivel) — avança pro ramo correspondente, sem gravar booking_uid", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.contactRow = { name: "Zelmo", phone: "+5511999999999", email: "zelmo@example.com" };
    h.state.criarReservaReturn = { ok: false, motivo: "indisponivel" };

    const result = await sendBookMeetingReply({ horario_escolhido: "2026-08-12T18:00:00.000Z" });

    expect(result.outcome).toBe("completed");
    expect(
      h.state.flowRunUpdates.some(
        (u) => u.vars !== undefined && "booking_uid" in (u.vars as object),
      ),
    ).toBe(false);
  });

  it("motivo de falha sem ramo próprio configurado (recusado) — cai no fallback generico", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.contactRow = { name: "Zelmo", phone: "+5511999999999", email: "zelmo@example.com" };
    h.state.criarReservaReturn = { ok: false, motivo: "recusado" };

    // Sem ramo "recusado" no BOOK_MEETING_CFG.failure_next_node_keys —
    // a ramificação em si (generico_end) não é observável só pelo
    // outcome (generico_end também é "end"), então a prova é o evento
    // logado com o motivo real antes do fallback.
    const result = await sendBookMeetingReply({ horario_escolhido: "2026-08-12T18:00:00.000Z" });

    expect(result.outcome).toBe("completed");
    expect(criarReserva).toHaveBeenCalledTimes(1);
    const falhaEvent = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "node_entered" &&
        (e.payload as { result?: string; motivo?: string } | undefined)?.result === "falha",
    );
    expect((falhaEvent?.payload as { motivo?: string } | undefined)?.motivo).toBe("recusado");
  });

  it("sem slot_var_key em vars — avança pro ramo generico sem chamar criarReserva", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.contactRow = { name: "Zelmo", phone: "+5511999999999", email: "zelmo@example.com" };

    const result = await sendBookMeetingReply({});

    expect(result.outcome).toBe("completed");
    expect(criarReserva).not.toHaveBeenCalled();
  });

  it("sem CALCOM_API_KEY/CALCOM_EVENT_TYPE_ID configurados — avança pro ramo generico sem chamar criarReserva", async () => {
    vi.stubEnv("CALCOM_API_KEY", "");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "");
    h.state.contactRow = { name: "Zelmo", phone: "+5511999999999", email: "zelmo@example.com" };

    const result = await sendBookMeetingReply({ horario_escolhido: "2026-08-12T18:00:00.000Z" });

    expect(result.outcome).toBe("completed");
    expect(criarReserva).not.toHaveBeenCalled();
  });

  it("sem e-mail (nem em vars, nem no contato) — avança pro ramo sem_email sem chamar criarReserva", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.contactRow = { name: "Zelmo", phone: "+5511999999999", email: null };

    const result = await sendBookMeetingReply({ horario_escolhido: "2026-08-12T18:00:00.000Z" });

    expect(result.outcome).toBe("completed");
    expect(criarReserva).not.toHaveBeenCalled();
  });

  it("update de flow_runs falha ao gravar booking_uid/booking_inicio_iso — loga o erro (padrão de offer_slots_vars_persist_failed) mas ainda avança pro success_next_node_key", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.contactRow = { name: "Zelmo", phone: "+5511999999999", email: "zelmo@example.com" };
    h.state.criarReservaReturn = { ok: true, uid: "uid-abc", inicio: "2026-08-12T18:00:00.000Z" };
    h.state.forceBookingVarsUpdateError = true;

    const result = await sendBookMeetingReply({ horario_escolhido: "2026-08-12T18:00:00.000Z" });

    // Booking já existe no Cal.com — só a gravação local falhou, o que
    // NÃO deve travar o avanço (best-effort, igual offer_slots).
    expect(result.outcome).toBe("completed");

    const errEvent = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "error" &&
        (e.payload as { reason?: string } | undefined)?.reason ===
          "book_meeting_vars_persist_failed",
    );
    expect(errEvent).toBeDefined();
    expect((errEvent?.payload as { detail?: string }).detail).toBe("connection reset");

    // run.vars em memória não espelhou o UPDATE que falhou — mas o
    // node_entered de sucesso ainda foi logado (a reserva de fato
    // aconteceu no Cal.com, só a gravação local que falhou).
    const successEvent = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "node_entered" &&
        (e.payload as { result?: string } | undefined)?.result === "sucesso",
    );
    expect(successEvent).toBeDefined();
  });

  it("criarReserva lança (rejeita) — loga o erro e cai no ramo generico, igual reserva.ok===false sem motivo mapeado", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.contactRow = { name: "Zelmo", phone: "+5511999999999", email: "zelmo@example.com" };
    vi.mocked(criarReserva).mockRejectedValueOnce(new Error("fetch failed"));

    const result = await sendBookMeetingReply({ horario_escolhido: "2026-08-12T18:00:00.000Z" });

    // generico_end também é "end" — a prova da ramificação são os
    // eventos logados, não o outcome (mesma observação já feita no
    // teste do motivo "recusado" acima).
    expect(result.outcome).toBe("completed");
    expect(criarReserva).toHaveBeenCalledTimes(1);

    const threwEvent = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "error" &&
        (e.payload as { reason?: string } | undefined)?.reason ===
          "book_meeting_criarreserva_threw",
    );
    expect(threwEvent).toBeDefined();
    expect((threwEvent?.payload as { detail?: string }).detail).toBe("fetch failed");

    const falhaEvent = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "node_entered" &&
        (e.payload as { result?: string; motivo?: string } | undefined)?.result === "falha",
    );
    expect((falhaEvent?.payload as { motivo?: string } | undefined)?.motivo).toBe("generico");

    // Não gravou booking_uid — a reserva nunca chegou a resolver.
    expect(
      h.state.flowRunUpdates.some(
        (u) => u.vars !== undefined && "booking_uid" in (u.vars as object),
      ),
    ).toBe(false);
  });

  it('M-3: ramo de falha configurado como string vazia ("") cai no generico via ||, não fica preso num next_node_key vazio', async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.stubEnv("CALCOM_EVENT_TYPE_ID", "42");
    h.state.contactRow = { name: "Zelmo", phone: "+5511999999999", email: "zelmo@example.com" };
    // reserva.motivo === "indisponivel", mas o editor salvou esse ramo
    // como "" em vez de deixar undefined — o bug (`??`) não pegaria isso.
    h.state.criarReservaReturn = { ok: false, motivo: "indisponivel" };
    h.state.nodeRows = [
      node({
        node_key: "collect1",
        node_type: "collect_input",
        config: { prompt_text: "Qual seu nome?", var_key: "nome", next_node_key: "book1" },
      }),
      node({
        node_key: "book1",
        node_type: "book_meeting",
        config: {
          ...BOOK_MEETING_CFG,
          failure_next_node_keys: {
            ...BOOK_MEETING_CFG.failure_next_node_keys,
            indisponivel: "",
          },
        },
      }),
      node({ node_key: "booked_end", node_type: "end", config: {} }),
      node({ node_key: "generico_end", node_type: "end", config: {} }),
    ];

    const result = await sendBookMeetingReply({ horario_escolhido: "2026-08-12T18:00:00.000Z" });

    // Prova indireta (generico_end também é "end"): o node_entered de
    // falha registra o motivo real ANTES do || decidir o destino.
    const falhaEvent = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "node_entered" &&
        (e.payload as { result?: string } | undefined)?.result === "falha",
    );
    expect((falhaEvent?.payload as { motivo?: string } | undefined)?.motivo).toBe(
      "indisponivel",
    );
    // Prova direta do bug vs fix: com `??` (bug), currentKey vira "" —
    // que o advance loop trata como nextKey ausente e aborta a run como
    // failed/missing_next_node. Com `||` (fix), cai no generico_end (que
    // EXISTE) e a run completa normalmente via end_node.
    expect(
      h.state.flowRunUpdates.some(
        (u) => u.status === "failed" && u.end_reason === "missing_next_node",
      ),
    ).toBe(false);
    expect(
      h.state.flowRunUpdates.some(
        (u) => u.status === "completed" && u.end_reason === "end_node",
      ),
    ).toBe(true);
    expect(result.outcome).toBe("completed");
  });
});

// ============================================================
// dispatchInboundToFlows — nó cancel_meeting (Task 5). Mesmo caminho de
// entrada usado acima pro book_meeting: collect1 (collect_input, só pra
// ter um nó suspenso que dispara o avanço) → cancel1 (cancel_meeting) →
// cancel_end. `run.vars.booking_uid` já vem pré-populado na run (o que
// book_meeting real teria gravado). cancelCalcomBooking é mockado via
// h.state — nunca bate no Cal.com de verdade.
// ============================================================

const CANCEL_MEETING_CFG = { next_node_key: "cancel_end" };

const CANCEL_MEETING_NODES = [
  node({
    node_key: "collect1",
    node_type: "collect_input",
    config: { prompt_text: "Confirma o cancelamento?", var_key: "confirmacao", next_node_key: "cancel1" },
  }),
  node({ node_key: "cancel1", node_type: "cancel_meeting", config: CANCEL_MEETING_CFG }),
  node({ node_key: "cancel_end", node_type: "end", config: {} }),
];

function sendCancelMeetingReply(
  vars: Record<string, unknown> = {},
  metaMessageId = "m-cm-1",
) {
  h.state.activeRun = waitRun({ current_node_key: "collect1", vars });
  h.state.nodeRows = CANCEL_MEETING_NODES;
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "user-1",
    contactId: "contact-1",
    conversationId: "conv-1",
    message: { kind: "text", text: "sim", meta_message_id: metaMessageId },
    isFirstInboundMessage: false,
  });
}

describe("dispatchInboundToFlows — cancel_meeting node", () => {
  it("booking_uid + CALCOM_API_KEY presentes — chama cancelCalcomBooking, loga cancelado:true e avança pro next_node_key", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    h.state.cancelCalcomBookingReturn = true;

    const result = await sendCancelMeetingReply({ booking_uid: "uid-abc" });

    // cancel_end é nó "end" → advanceFromNodeKey encerra a run.
    expect(result.outcome).toBe("completed");
    expect(cancelCalcomBooking).toHaveBeenCalledWith("uid-abc", "sk_test");

    // O loop do runner já loga um node_entered genérico {node_type} pra
    // TODO nó ao entrar nele (advanceFromNodeKey, antes do handler
    // específico rodar) — por isso o filtro exige a chave "cancelado",
    // que só o log específico do cancel_meeting grava, pra não pegar o
    // genérico por engano.
    const entered = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "node_entered" &&
        e.node_key === "cancel1" &&
        (e.payload as { cancelado?: boolean } | undefined)?.cancelado !== undefined,
    );
    expect(entered).toBeDefined();
    expect((entered?.payload as { cancelado?: boolean }).cancelado).toBe(true);
  });

  it("I-3: cancelamento bem-sucedido — limpa booking_uid/booking_inicio_iso/booking_rotulo de vars", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    h.state.cancelCalcomBookingReturn = true;

    const result = await sendCancelMeetingReply({
      booking_uid: "uid-abc",
      booking_inicio_iso: "2026-08-12T18:00:00.000Z",
      booking_rotulo: "terça-feira, 12/08 às 15:00",
    });

    expect(result.outcome).toBe("completed");
    // A 1ª UPDATE de vars (collect_input capturando "confirmacao") ainda
    // carrega as 3 chaves de booking. A 2ª (a limpeza do cancel_meeting)
    // é a que NÃO tem mais booking_uid — essa é a prova do fix.
    const clearUpdate = h.state.flowRunUpdates.find(
      (u) => u.vars !== undefined && !("booking_uid" in (u.vars as object)),
    ) as { vars: Record<string, unknown> } | undefined;
    expect(clearUpdate).toBeDefined();
    expect(clearUpdate?.vars).toEqual({ confirmacao: "sim" });
  });

  it("I-3: cancelamento falho (cancelCalcomBooking devolve false) — NÃO limpa booking_uid/booking_inicio_iso/booking_rotulo (best-effort só limpa em sucesso confirmado)", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    h.state.cancelCalcomBookingReturn = false;

    const result = await sendCancelMeetingReply({
      booking_uid: "uid-abc",
      booking_inicio_iso: "2026-08-12T18:00:00.000Z",
      booking_rotulo: "terça-feira, 12/08 às 15:00",
    });

    expect(result.outcome).toBe("completed");
    // Nenhuma UPDATE de vars ficou sem booking_uid — nada foi limpo.
    expect(
      h.state.flowRunUpdates.some(
        (u) => u.vars !== undefined && !("booking_uid" in (u.vars as object)),
      ),
    ).toBe(false);
  });

  it("cancelCalcomBooking devolve false — loga cancelado:false mas avança do mesmo jeito (best-effort, não ramifica)", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    h.state.cancelCalcomBookingReturn = false;

    const result = await sendCancelMeetingReply({ booking_uid: "uid-abc" });

    expect(result.outcome).toBe("completed");
    expect(cancelCalcomBooking).toHaveBeenCalledWith("uid-abc", "sk_test");

    const entered = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "node_entered" &&
        e.node_key === "cancel1" &&
        (e.payload as { cancelado?: boolean } | undefined)?.cancelado !== undefined,
    );
    expect((entered?.payload as { cancelado?: boolean }).cancelado).toBe(false);
  });

  it("cancelCalcomBooking lança (rejeita) — loga error com reason cancel_meeting_call_threw e avança do mesmo jeito", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");
    vi.mocked(cancelCalcomBooking).mockRejectedValueOnce(new Error("fetch failed"));

    const result = await sendCancelMeetingReply({ booking_uid: "uid-abc" });

    expect(result.outcome).toBe("completed");
    expect(cancelCalcomBooking).toHaveBeenCalledTimes(1);

    const threwEvent = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "error" &&
        (e.payload as { reason?: string } | undefined)?.reason === "cancel_meeting_call_threw",
    );
    expect(threwEvent).toBeDefined();
    expect((threwEvent?.payload as { detail?: string }).detail).toBe("fetch failed");

    // Best-effort: quando a chamada lança, o catch loga "error" — não
    // existe node_entered específico de cancel_meeting (nem cancelado
    // nem motivo) pra esse caso, só o genérico {node_type} que o loop
    // já grava pra todo nó. A run ainda avançou e encerrou normalmente.
    const specificEntered = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "node_entered" &&
        e.node_key === "cancel1" &&
        (e.payload as { cancelado?: boolean; motivo?: string } | undefined) &&
        ("cancelado" in (e.payload as object) || "motivo" in (e.payload as object)),
    );
    expect(specificEntered).toBeUndefined();
  });

  it("sem booking_uid em vars — não chama cancelCalcomBooking, loga motivo sem_booking_uid_ou_api_key, avança do mesmo jeito", async () => {
    vi.stubEnv("CALCOM_API_KEY", "sk_test");

    const result = await sendCancelMeetingReply({});

    expect(result.outcome).toBe("completed");
    expect(cancelCalcomBooking).not.toHaveBeenCalled();

    const entered = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "node_entered" &&
        e.node_key === "cancel1" &&
        (e.payload as { motivo?: string } | undefined)?.motivo !== undefined,
    );
    expect((entered?.payload as { motivo?: string }).motivo).toBe("sem_booking_uid_ou_api_key");
  });

  it("sem CALCOM_API_KEY configurado — não chama cancelCalcomBooking, loga motivo sem_booking_uid_ou_api_key, avança do mesmo jeito", async () => {
    vi.stubEnv("CALCOM_API_KEY", "");

    const result = await sendCancelMeetingReply({ booking_uid: "uid-abc" });

    expect(result.outcome).toBe("completed");
    expect(cancelCalcomBooking).not.toHaveBeenCalled();

    const entered = h.state.flowRunEvents.find(
      (e) =>
        e.event_type === "node_entered" &&
        e.node_key === "cancel1" &&
        (e.payload as { motivo?: string } | undefined)?.motivo !== undefined,
    );
    expect((entered?.payload as { motivo?: string }).motivo).toBe("sem_booking_uid_ou_api_key");
  });
});
