/**
 * Next.js instrumentation hook — runs once when the server process
 * boots (dev and `next start` alike). We use it to start the in-app
 * scheduler: a 60 s tick that delivers scheduled broadcasts without
 * needing anyone's browser tab open.
 *
 * This is the "native cron" for the CRM — it lives inside the same
 * process pm2 already runs, so there is no external cron or loose
 * script to maintain.
 *
 * ⛔ 20/08/2026: este tick TAMBÉM disparava lembrete de reunião
 * (`lib/reminders/dispatch.ts`, removido) — um segundo relógio,
 * paralelo e sem trava em comum com as automações "Reunião Agendada —
 * lembrete véspera/1h antes" (que já fazem o mesmo trabalho, com
 * dedup por `automation_logs` e horário comercial configurável na
 * tela). Os dois rodando juntos mandavam o mesmo lembrete duas vezes
 * — já tinha causado 417 envios pra 3 clientes em 09/08/2026, e foi o
 * que reconfirmou uma reunião já cancelada no card de teste do
 * titular em 19/08/2026. Lembrete de reunião agora só sai pela
 * automação nativa.
 */
export async function register() {
  // Only the Node.js server runtime should run the dispatcher — never
  // the Edge runtime (no DB / crypto there).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const g = globalThis as unknown as { __broadcastDispatcherStarted?: boolean };
  if (g.__broadcastDispatcherStarted) return;
  g.__broadcastDispatcherStarted = true;

  const { dispatchDueBroadcasts } = await import('@/lib/broadcasts/dispatch');

  console.log('[dispatch] broadcast scheduler registered (60s tick)');

  const runBroadcasts = () =>
    dispatchDueBroadcasts().catch((e) =>
      console.error('[dispatch] tick failed:', e),
    );

  // Kick once on boot so anything whose time passed during a deploy
  // isn't stuck waiting a full tick.
  runBroadcasts();

  setInterval(runBroadcasts, 60_000);
}
