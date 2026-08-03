/**
 * Next.js instrumentation hook — runs once when the server process
 * boots (dev and `next start` alike). We use it to start the in-app
 * broadcast dispatcher: a 60 s tick that delivers scheduled broadcasts
 * without needing anyone's browser tab open.
 *
 * This is the "native cron" for the CRM — it lives inside the same
 * process pm2 already runs, so there is no external cron or loose
 * script to maintain.
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

  // Kick once on boot so a broadcast whose time passed during a deploy
  // isn't stuck waiting a full tick.
  dispatchDueBroadcasts().catch((e) =>
    console.error('[dispatch] boot run failed:', e),
  );

  setInterval(() => {
    dispatchDueBroadcasts().catch((e) =>
      console.error('[dispatch] tick failed:', e),
    );
  }, 60_000);
}
