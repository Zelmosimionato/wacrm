// wacrm — definição CANÔNICA do processo PM2 de produção.
//
// 19/09/2026: o CRM caiu porque o processo PM2 "wacrm" foi apontado (via
// comando avulso, digitado na hora) para /root/wacrm-marcia2 — uma pasta de
// teste. Este arquivo existe pra isso nunca mais acontecer por digitação:
// o restart de produção SEMPRE lê a config DAQUI, versionada no próprio
// repo, nunca de um comando `pm2 start` montado à mão.
//
// ⛔⛔ REGRA: o nome "wacrm" neste arquivo é RESERVADO para cwd=/root/wacrm.
// Nunca aponte este processo para outra pasta. Testando código novo
// (branch, worktree)? Suba com OUTRO nome (ex.: "wacrm-teste") e OUTRA
// porta — nunca reutilize "wacrm" nem a porta 3000 pra experimento.
//
// Deploy de produção (sempre, sem exceção):
//   cd /root/wacrm
//   npx tsc --noEmit && npx vitest run && npm run build
//   pm2 startOrRestart ecosystem.config.js
//
// Antes de QUALQUER pm2 restart/start que toque produção, confirme o
// shell está limpo (nenhuma env de teste/CI vazada):
//   echo $SUPABASE_URL        # tem que vir vazio
//   env | grep -i CODEX       # tem que vir vazio
module.exports = {
  apps: [
    {
      name: 'wacrm',
      cwd: '/root/wacrm',
      script: 'node_modules/next/dist/bin/next',
      interpreter: 'node',
      args: 'start -H 100.85.48.50 -p 3000',
      autorestart: true,
      watch: false,
    },
  ],
}
