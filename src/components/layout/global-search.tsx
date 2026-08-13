"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, MessageSquare, User, Briefcase, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

/**
 * Busca global — um campo que procura em CONTATOS, CONVERSAS e CARDS.
 *
 * Nasceu de um erro real (13/08/2026): o titular digitou "paula" na Caixa de
 * entrada, nao veio nada, e concluiu que o lead nao tinha chegado no CRM. Tinha
 * — como contato e como card, mas sem conversa, porque a pessoa preencheu o
 * formulario e nunca escreveu. A busca daquela tela so olha conversas, entao
 * respondeu "nada" com cara de resposta completa.
 *
 * Por isso o cabecalho do resultado mostra SEMPRE a contagem dos tres tipos,
 * mesmo quando um deles e zero: "0 conversas" e informacao, e e justamente a
 * que faltou naquele dia.
 */

const MIN_CARACTERES = 2;
const ESPERA_MS = 250;
const POR_GRUPO = 6;

interface Achado {
  id: string;
  titulo: string;
  detalhe?: string;
  href: string;
}

interface Resultado {
  contatos: Achado[];
  conversas: Achado[];
  cards: Achado[];
}

const VAZIO: Resultado = { contatos: [], conversas: [], cards: [] };

export function GlobalSearch() {
  const router = useRouter();
  const [termo, setTermo] = useState("");
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [res, setRes] = useState<Resultado>(VAZIO);
  const caixaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fora = (e: MouseEvent) => {
      if (caixaRef.current && !caixaRef.current.contains(e.target as Node)) {
        setAberto(false);
      }
    };
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, []);

  useEffect(() => {
    const q = termo.trim();
    if (q.length < MIN_CARACTERES) {
      setRes(VAZIO);
      setCarregando(false);
      return;
    }

    let cancelado = false;
    setCarregando(true);

    const t = setTimeout(async () => {
      const supabase = createClient();
      const like = "%" + q + "%";

      try {
        // Duas consultas em vez de uma: quem COMECA com o termo vem antes de
        // quem so o contem. Sem isso o limite corta o mais relevante — buscar
        // "paula" trazia seis "Ana paula" e deixava "Paula do rocio", o lead
        // do dia, de fora (13/08/2026). E dentro de cada grupo o mais recente
        // vem primeiro: sem ORDER BY o banco devolve em ordem indefinida, e o
        // corte vira sorteio.
        const [prefixo, contendo] = await Promise.all([
          supabase
            .from("contacts")
            .select("id, name, phone, email, created_at")
            .ilike("name", q + "%")
            .order("created_at", { ascending: false })
            .limit(POR_GRUPO),
          supabase
            .from("contacts")
            .select("id, name, phone, email, created_at")
            .or("name.ilike." + like + ",phone.ilike." + like + ",email.ilike." + like)
            .order("created_at", { ascending: false })
            .limit(POR_GRUPO * 3),
        ]);

        const vistosContato = new Set<string>();
        const contatos: Record<string, unknown>[] = [];
        for (const c of [
          ...((prefixo.data ?? []) as Record<string, unknown>[]),
          ...((contendo.data ?? []) as Record<string, unknown>[]),
        ]) {
          const cid = c.id as string;
          if (vistosContato.has(cid)) continue;
          vistosContato.add(cid);
          contatos.push(c);
          if (contatos.length >= POR_GRUPO) break;
        }

        const ids = contatos.map((c) => c.id as string);

        const [porPessoa, porTexto] = await Promise.all([
          ids.length
            ? supabase
                .from("conversations")
                .select("id, contact_id, last_message_text, contact:contacts(name, phone)")
                .in("contact_id", ids)
                .order("last_message_at", { ascending: false, nullsFirst: false })
                .limit(POR_GRUPO)
            : Promise.resolve({ data: [] as unknown[] }),
          supabase
            .from("conversations")
            .select("id, contact_id, last_message_text, contact:contacts(name, phone)")
            .ilike("last_message_text", like)
            .order("last_message_at", { ascending: false, nullsFirst: false })
            .limit(POR_GRUPO),
        ]);

        const { data: cards } = await supabase
          .from("deals")
          .select("id, title")
          .ilike("title", like)
          .order("created_at", { ascending: false })
          .limit(POR_GRUPO);

        if (cancelado) return;

        const vistas = new Set<string>();
        const conversas: Achado[] = [];
        const linhas = [
          ...((porPessoa.data ?? []) as Record<string, unknown>[]),
          ...((porTexto.data ?? []) as Record<string, unknown>[]),
        ];
        for (const linha of linhas) {
          const id = linha.id as string;
          if (vistas.has(id)) continue;
          vistas.add(id);
          const contato = linha.contact as { name?: string; phone?: string } | null;
          conversas.push({
            id,
            titulo: contato?.name || contato?.phone || "(sem nome)",
            detalhe: (linha.last_message_text as string) || undefined,
            href: "/inbox?c=" + id,
          });
        }

        setRes({
          contatos: contatos.map((c) => ({
            id: c.id as string,
            titulo: (c.name as string) || (c.phone as string) || "(sem nome)",
            detalhe:
              [c.phone, c.email].filter(Boolean).join(" - ") || undefined,
            href: "/contacts?contact=" + c.id,
          })),
          conversas: conversas.slice(0, POR_GRUPO),
          cards: (cards ?? []).map((d) => ({
            id: d.id as string,
            titulo: (d.title as string) || "(sem titulo)",
            href: "/pipelines",
          })),
        });
      } catch {
        if (!cancelado) setRes(VAZIO);
      } finally {
        if (!cancelado) setCarregando(false);
      }
    }, ESPERA_MS);

    return () => {
      cancelado = true;
      clearTimeout(t);
    };
  }, [termo]);

  const total = res.contatos.length + res.conversas.length + res.cards.length;
  const mostrar = aberto && termo.trim().length >= MIN_CARACTERES;

  const grupos = useMemo(
    () => [
      { chave: "contatos", rotulo: "Contatos", icone: User, itens: res.contatos },
      { chave: "conversas", rotulo: "Conversas", icone: MessageSquare, itens: res.conversas },
      { chave: "cards", rotulo: "Cards", icone: Briefcase, itens: res.cards },
    ],
    [res],
  );

  const ir = (href: string) => {
    setAberto(false);
    setTermo("");
    router.push(href);
  };

  return (
    <div ref={caixaRef} className="relative ml-2 hidden min-w-0 flex-1 md:flex">
      <div className="relative w-full max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={termo}
          onChange={(e) => {
            setTermo(e.target.value);
            setAberto(true);
          }}
          onFocus={() => setAberto(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setAberto(false);
          }}
          placeholder="Buscar em contatos, conversas e cards..."
          aria-label="Busca global"
          className="h-9 w-full rounded-md border border-border bg-muted/40 pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        {carregando ? (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {mostrar ? (
        <div className="absolute top-11 z-50 w-full max-w-md overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            {res.contatos.length} contatos - {res.conversas.length} conversas -{" "}
            {res.cards.length} cards
          </div>

          {total === 0 && !carregando ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              Nada encontrado para {termo.trim()}.
            </p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              {grupos.map((g) =>
                g.itens.length === 0 ? null : (
                  <div key={g.chave} className="py-1">
                    <p className="px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {g.rotulo}
                    </p>
                    {g.itens.map((it) => (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => ir(it.href)}
                        className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-muted"
                      >
                        <g.icone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-foreground">
                            {it.titulo}
                          </span>
                          {it.detalhe ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {it.detalhe}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    ))}
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
