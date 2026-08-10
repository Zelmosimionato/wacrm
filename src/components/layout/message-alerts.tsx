"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useRealtime } from "@/hooks/use-realtime";
import type { Message } from "@/types";

// Alerta sonoro (+ notificação de desktop) quando chega mensagem NOVA de
// cliente. Tocar som e notificar exige um gesto do usuário (política dos
// navegadores — inclusive o web app na tela inicial do iOS), então há um
// botão de sino que liga/desliga e DESTRAVA o áudio no clique. A
// preferência fica no localStorage. Em background o iOS suspende o app,
// então o som toca com o CRM em primeiro plano (push fechado é projeto à
// parte). O `new Notification` é ignorado no iOS — inofensivo (try/catch).

const STORAGE_KEY = "wacrm:alerts-enabled";

/** Mesma marca que o card e o resumo do handoff usam. */
const MARCA_ATENCAO = "[ATENÇÃO]";

/**
 * Bip LONGO — só para lead que escreveu estando em negociação, decisão ou
 * contrato. Som deliberadamente diferente do bip curto: mais grave, mais
 * demorado e em duas batidas. O curto diz "chegou mensagem"; este diz
 * "alguém precisa largar o que está fazendo". Se os dois soassem igual, o
 * segundo viraria ruído do primeiro.
 */
function bipLongo(ctx: AudioContext) {
  const now = ctx.currentTime;
  for (const [inicio, dur] of [
    [0, 0.55],
    [0.7, 0.9],
  ]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 440;
    gain.gain.setValueAtTime(0.0001, now + inicio);
    gain.gain.exponentialRampToValueAtTime(0.3, now + inicio + 0.04);
    gain.gain.setValueAtTime(0.3, now + inicio + dur - 0.12);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + inicio + dur);
    osc.start(now + inicio);
    osc.stop(now + inicio + dur + 0.02);
  }
}

function beep(ctx: AudioContext) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "sine";
  osc.frequency.value = 880;
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
  osc.start(now);
  osc.stop(now + 0.42);
}

export function MessageAlerts() {
  const [enabled, setEnabled] = useState(false);
  const enabledRef = useRef(false);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const on =
      typeof window !== "undefined" &&
      window.localStorage.getItem(STORAGE_KEY) === "1";
    setEnabled(on);
    enabledRef.current = on;
  }, []);

  const ensureAudio = useCallback(() => {
    if (!ctxRef.current) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (AC) ctxRef.current = new AC();
    }
    if (ctxRef.current && ctxRef.current.state === "suspended") {
      ctxRef.current.resume().catch(() => {});
    }
  }, []);

  const toggle = useCallback(() => {
    const next = !enabledRef.current;
    enabledRef.current = next;
    setEnabled(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (next) {
      ensureAudio(); // destrava o áudio no gesto do clique
      try {
        if (ctxRef.current) beep(ctxRef.current); // bip de confirmação
      } catch {
        /* ignore */
      }
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "default"
      ) {
        Notification.requestPermission().catch(() => {});
      }
    }
  }, [ensureAudio]);

  const onMessageEvent = useCallback(
    (event: {
      eventType: "INSERT" | "UPDATE" | "DELETE";
      new: Message;
      old: Partial<Message>;
    }) => {
      if (!enabledRef.current) return;
      if (event.eventType !== "INSERT") return;
      const row = event.new as { sender_type?: string; content_text?: string | null };
      if (row.sender_type !== "customer") return;

      try {
        ensureAudio();
        if (ctxRef.current) beep(ctxRef.current);
      } catch {
        /* ignore */
      }
      try {
        if (
          typeof Notification !== "undefined" &&
          Notification.permission === "granted" &&
          typeof document !== "undefined" &&
          document.visibilityState !== "visible"
        ) {
          new Notification("Nova mensagem no CRM", {
            body: row.content_text?.slice(0, 120) || "Você recebeu uma nova mensagem.",
          });
        }
      } catch {
        /* ignore */
      }
    },
    [ensureAudio],
  );

  // O lead escreveu estando em negociação, decisão ou contrato, e a IA parou
  // de propósito. Som diferente porque é urgência diferente: o bip curto avisa
  // que chegou mensagem; este avisa que alguém precisa levantar da cadeira.
  const onConversationEvent = useCallback(
    (event: {
      eventType: "INSERT" | "UPDATE" | "DELETE";
      new: { ai_handoff_summary?: string | null };
      old: { ai_handoff_summary?: string | null };
    }) => {
      if (!enabledRef.current) return;
      if (event.eventType !== "UPDATE") return;
      const agora = event.new?.ai_handoff_summary ?? "";
      const antes = event.old?.ai_handoff_summary ?? "";
      // Só na TRANSIÇÃO: sem isto, qualquer outra alteração na conversa
      // (ler, atribuir, contar resposta) refaria o alarme do mesmo caso.
      if (!agora.includes(MARCA_ATENCAO) || antes.includes(MARCA_ATENCAO)) return;

      try {
        ensureAudio();
        if (ctxRef.current) bipLongo(ctxRef.current);
      } catch {
        /* ignore */
      }
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("Um lead em negociação escreveu", {
            body: "A IA não conduziu — a conversa está aguardando você no CRM.",
          });
        }
      } catch {
        /* ignore */
      }
    },
    [ensureAudio],
  );

  useRealtime({ channelName: "message-alerts", onMessageEvent, onConversationEvent });

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={enabled ? "Desligar alerta sonoro" : "Ligar alerta sonoro"}
      title={
        enabled ? "Alerta sonoro ligado" : "Alerta sonoro desligado — clique para ligar"
      }
      className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {enabled ? <Bell className="h-5 w-5" /> : <BellOff className="h-5 w-5" />}
    </button>
  );
}
