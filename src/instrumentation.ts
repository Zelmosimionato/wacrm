/**
 * Next.js instrumentation hook — runs once when the server process
 * boots (dev and `next start` alike). We use it to start the in-app
 * schedulers: a 60 s tick that delivers scheduled broadcasts and fires
 * appointment reminders without needing anyone's browser tab open.
 *
 * This is the "native cron" for the CRM — it lives inside the same
 * process pm2 already runs, so there is no external cron or loose
 * script to maintain.
 */
export async function register() {
  // Only the Node.js server runtime should run the dispatchers — never
  // the Edge runtime (no DB / crypto there).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const g = globalThis as unknown as { __broadcastDispatcherStarted?: boolean };
  if (g.__broadcastDispatcherStarted) return;
  g.__broadcastDispatcherStarted = true;

  const { dispatchDueBroadcasts } = await import('@/lib/broadcasts/dispatch');
  const { dispatchNutricaoPreReuniao } = await import('@/lib/reminders/nutricao');

  // ⛔ Lembretes de reunião (véspera/1h antes/segunda-chamada/cancelamento
  // por silêncio) NÃO rodam mais daqui. Até 01/09/2026 havia um pipeline
  // bespoke em `lib/reminders/dispatch.ts` rodando neste mesmo tick de 60s,
  // duplicando as automações nativas (`time_based`, cron de 5 min em
  // `/api/automations/tempo`) que já fazem o mesmo — os dois relógios sem
  // se conhecerem mandaram confirmação em dobro pra um cliente. Removido de
  // vez: automação de véspera/segunda-chamada/cancelamento agora é 100%
  // configuração nativa (`automations`/`automation_steps`), nunca código.

  console.log('[dispatch] broadcast + nutricao schedulers registered (60s tick)');

  const runBroadcasts = () =>
    dispatchDueBroadcasts().catch((e) =>
      console.error('[dispatch] tick failed:', e),
    );
  const runNutricao = () =>
    dispatchNutricaoPreReuniao().catch((e) =>
      console.error('[nutricao] tick failed:', e),
    );

  // Kick once on boot so anything whose time passed during a deploy
  // isn't stuck waiting a full tick.
  runBroadcasts();
  runNutricao();

  setInterval(() => {
    runBroadcasts();
    runNutricao();
  }, 60_000);
}
