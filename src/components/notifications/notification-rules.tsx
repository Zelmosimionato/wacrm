"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Loader2, Clock } from "lucide-react";
import { toast } from "sonner";

/**
 * Configuracao dos avisos, DENTRO da aba Notificacoes.
 *
 * O titular pediu isso explicitamente: a aba existia e "nao tinha por onde
 * configurar". A primeira versao deixou os campos so na tela de Automacoes e
 * aqui um botao que mandava embora — nao era o pedido.
 *
 * ⛔ Nao ha modelo de dados novo: cada regra E uma automacao com gatilho
 * `awaiting_reply` e um passo `notify`. O que muda e onde se mexe nela. Editar
 * aqui ou em Automacoes altera a mesma linha.
 */

interface Regra {
  id: string;
  name: string;
  is_active: boolean;
  horas_uteis: number;
  somente_horario_comercial: boolean;
  ia_conta_como_resposta: boolean;
  stepId: string | null;
  destinatario: string;
}

export function NotificationRules() {
  const [regras, setRegras] = useState<Regra[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    const supabase = createClient();
    const { data: autos, error } = await supabase
      .from("automations")
      .select("id, name, is_active, trigger_config")
      .eq("trigger_type", "awaiting_reply")
      .order("created_at", { ascending: true });

    if (error || !autos?.length) {
      setRegras([]);
      setCarregando(false);
      return;
    }

    const ids = autos.map((a) => a.id as string);
    const { data: passos } = await supabase
      .from("automation_steps")
      .select("id, automation_id, step_config")
      .in("automation_id", ids)
      .eq("step_type", "notify");

    const porAuto = new Map<string, { id: string; cfg: Record<string, unknown> }>();
    for (const p of passos ?? []) {
      porAuto.set(p.automation_id as string, {
        id: p.id as string,
        cfg: (p.step_config ?? {}) as Record<string, unknown>,
      });
    }

    setRegras(
      autos.map((a) => {
        const cfg = (a.trigger_config ?? {}) as Record<string, unknown>;
        const passo = porAuto.get(a.id as string);
        return {
          id: a.id as string,
          name: a.name as string,
          is_active: Boolean(a.is_active),
          horas_uteis: Number(cfg.horas_uteis ?? 0),
          somente_horario_comercial: cfg.somente_horario_comercial !== false,
          ia_conta_como_resposta: cfg.ia_conta_como_resposta !== false,
          stepId: passo?.id ?? null,
          destinatario: (passo?.cfg.destinatario as string) ?? "atribuido",
        };
      }),
    );
    setCarregando(false);
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const salvar = async (r: Regra, patch: Partial<Regra>) => {
    const novo = { ...r, ...patch };
    setRegras((prev) => prev.map((x) => (x.id === r.id ? novo : x)));
    setSalvando(r.id);
    const supabase = createClient();

    const { error: e1 } = await supabase
      .from("automations")
      .update({
        is_active: novo.is_active,
        trigger_config: {
          horas_uteis: novo.horas_uteis,
          somente_horario_comercial: novo.somente_horario_comercial,
          ia_conta_como_resposta: novo.ia_conta_como_resposta,
        },
      })
      .eq("id", r.id);

    let e2 = null;
    if (novo.stepId) {
      const res = await supabase
        .from("automation_steps")
        .update({
          step_config: {
            destinatario: novo.destinatario,
            fallback: "todos",
            titulo: novo.name,
            corpo: "",
          },
        })
        .eq("id", novo.stepId);
      e2 = res.error;
    }

    setSalvando(null);
    if (e1 || e2) {
      // ⛔ Volta ao estado anterior: mostrar ligado o que nao salvou seria
      // pior que o erro — o titular acharia que esta avisando e nao esta.
      setRegras((prev) => prev.map((x) => (x.id === r.id ? r : x)));
      toast.error("Nao foi possivel salvar: " + (e1?.message || e2?.message));
    }
  };

  if (carregando) {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando configuracao...
      </div>
    );
  }

  if (regras.length === 0) return null;

  return (
    <section className="mb-6 rounded-xl border border-border bg-muted/30 p-4">
      <div className="mb-1 flex items-center gap-2">
        <Clock className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">
          Quando avisar sobre conversa esperando resposta
        </h2>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Vale para conversas em que o cliente escreveu e ninguem do escritorio
        respondeu. Cada linha e um aviso independente — ligue so os que quiser.
      </p>

      <div className="space-y-3">
        {regras.map((r) => (
          <div
            key={r.id}
            className="rounded-lg border border-border bg-background p-3"
          >
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={r.is_active}
                  onChange={(e) => void salvar(r, { is_active: e.target.checked })}
                />
                <span className="text-sm font-medium text-foreground">
                  {r.name}
                </span>
              </label>

              {salvando === r.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : null}

              <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                avisar depois de
                <input
                  type="number"
                  min={0}
                  value={r.horas_uteis}
                  onChange={(e) =>
                    void salvar(r, { horas_uteis: Number(e.target.value) || 0 })
                  }
                  className="w-16 rounded-md border border-border bg-muted px-2 py-1 text-sm text-foreground"
                />
                horas
              </span>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-2">
                quem recebe:
                <select
                  value={r.destinatario}
                  onChange={(e) => void salvar(r, { destinatario: e.target.value })}
                  className="rounded-md border border-border bg-muted px-2 py-1 text-sm text-foreground"
                >
                  <option value="atribuido">quem tem a conversa (sem dono, todos)</option>
                  <option value="todos">todos da equipe</option>
                </select>
              </span>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={r.somente_horario_comercial}
                  onChange={(e) =>
                    void salvar(r, { somente_horario_comercial: e.target.checked })
                  }
                />
                so em horario comercial (seg-sex, 9h-12h e 13h-17h)
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={r.ia_conta_como_resposta}
                  onChange={(e) =>
                    void salvar(r, { ia_conta_como_resposta: e.target.checked })
                  }
                />
                resposta da IA encerra a espera (desligue so para exigir humano)
              </label>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
