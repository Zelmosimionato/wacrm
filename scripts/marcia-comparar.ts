// Compara o log do MODO SOMBRA (o que a v2 faria) com o que a Márcia atual REALMENTE fez em seguida. Só leitura.
// Uso: tsx scripts/marcia-comparar.ts [arquivoDeLog]
import { existsSync, readFileSync } from 'node:fs'

for (const l of readFileSync('/root/wacrm/.env.local', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

interface Linha { quando: string; conversa: string; produto?: string | null; intencao?: string; valor?: number | null; tipo?: string | null; acao?: string; ms?: number; erro?: string }

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const arquivo = process.argv[2] ?? '/root/marcia-v2-sombra.log'
  if (!existsSync(arquivo)) throw new Error('sem log de sombra ainda: ' + arquivo)
  const linhas = readFileSync(arquivo, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Linha)
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  const c = { total: 0, erros: 0, ambosOferecem: 0, ambosRecusam: 0, v2BarraAtualOferece: 0, v2PassaAtualRecusa: 0, outros: 0, semResposta: 0 }
  const barrados: string[] = []
  const passaria: string[] = []
  let ms = 0, nms = 0

  for (const l of linhas) {
    if (l.erro) { c.erros++; continue }
    c.total++
    if (l.ms) { ms += l.ms; nms++ }
    const ate = new Date(new Date(l.quando).getTime() + 15 * 60_000).toISOString()
    const { data } = await db
      .from('messages')
      .select('sender_type, ai_generated, content_text')
      .eq('conversation_id', l.conversa)
      .gte('created_at', l.quando)
      .lte('created_at', ate)
      .order('created_at', { ascending: true })
      .limit(6)
    const bot = ((data ?? []) as { sender_type: string; ai_generated: boolean | null; content_text: string | null }[])
      .filter((m) => m.sender_type === 'bot' && m.ai_generated)
      .map((m) => m.content_text ?? '')
      .join('\n')
    if (!bot) { c.semResposta++; continue }
    const atualOferece = /Tenho estes hor[aá]rios|\[1\]\s*dia/i.test(bot)
    const atualRecusa = /n[aã]o se enquadra no perfil/i.test(bot)
    const v2Barra = ['recusa', 'perguntar_valor', 'encaminhar_equipe', 'handoff'].includes(l.acao ?? '')
    const v2Oferece = l.acao === 'enviar' && ['oferecer_horarios', 'horario_escolhido', 'confirmar_agendamento'].includes(l.intencao ?? '')
    const rot = `[${l.conversa.slice(0, 8)}|${l.produto ?? '-'}] ${l.quando.slice(0, 16)} valor=${l.valor} tipo=${l.tipo} v2=${l.acao}`
    if (atualOferece && v2Barra) { c.v2BarraAtualOferece++; barrados.push(rot) }
    else if (atualRecusa && !v2Barra) { c.v2PassaAtualRecusa++; passaria.push(rot) }
    else if (atualOferece && v2Oferece) c.ambosOferecem++
    else if (atualRecusa && v2Barra) c.ambosRecusam++
    else c.outros++
  }
  console.log(`linhas ${linhas.length} | decisões ${c.total} | erros da v2 ${c.erros} | média ${nms ? Math.round(ms / nms) : 0} ms`)
  console.log(`sem resposta da atual em 15 min: ${c.semResposta} | concordam oferecendo: ${c.ambosOferecem} | concordam barrando: ${c.ambosRecusam} | outros: ${c.outros}`)
  console.log(`\nA ATUAL OFERECEU HORÁRIO e a v2 teria BARRADO: ${c.v2BarraAtualOferece}`)
  barrados.forEach((x) => console.log('  ' + x))
  console.log(`\nA ATUAL RECUSOU e a v2 teria DEIXADO PASSAR: ${c.v2PassaAtualRecusa}`)
  passaria.forEach((x) => console.log('  ' + x))
}
main().catch((e) => { console.error('falhou:', (e as Error).message); process.exit(1) })
