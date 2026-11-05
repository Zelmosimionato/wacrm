// Roda a Márcia v2 em MODO SOMBRA numa conversa (não envia, não grava no CRM). Uso: tsx scripts/marcia-sombra.ts <conversationId|prefixo>
import { readFileSync } from 'node:fs'
for (const l of readFileSync('/root/wacrm/.env.local', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const { processarMensagem } = await import('../src/lib/marcia/processar')
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const alvo = process.argv[2]
  const { data } = await db.from('conversations').select('id, account_id, user_id, contact_id, last_channel').order('created_at', { ascending: false }).limit(500)
  const c = (data ?? []).find((r: any) => r.id.startsWith(alvo)) as any
  if (!c) throw new Error('conversa não encontrada')
  const r = await processarMensagem({
    db, accountId: c.account_id, userId: c.user_id, contactId: c.contact_id, conversationId: c.id,
    canal: c.last_channel === 'web' ? 'web' : 'api', modo: 'sombra',
  })
  console.log(JSON.stringify({ erro: r.erro, intencao: r.decisao?.intencao, valor: r.decisao?.valorTotal, tipo: r.decisao?.valorTipo, trecho: r.decisao?.valorTrecho, acao: r.resultado?.acao.tipo, execucao: r.execucao }, null, 2))
}
main().catch((e) => { console.error('falhou:', (e as Error).message); process.exit(1) })
