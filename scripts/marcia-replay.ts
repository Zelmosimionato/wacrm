// REPLAY (só leitura): passa conversas reais antigas pela Márcia v2 e compara com o que a Márcia atual fez.
// Não envia nada, não grava nada. Uso: tsx scripts/marcia-replay.ts [dias=45] [maxChamadas=120] [modelo]
import { readFileSync } from 'node:fs'

for (const l of readFileSync('/root/wacrm/.env.local', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const DIAS = Number(process.argv[2] ?? 45)
const MAX = Number(process.argv[3] ?? 120)

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const { decrypt } = await import('../src/lib/whatsapp/encryption')
  const { carregarInstrucoes } = await import('../src/lib/marcia/instrucoes')
  const { lerFatos, fatosParaTexto } = await import('../src/lib/marcia/fatos')
  const { decidirComModelo, lerValorFocado } = await import('../src/lib/marcia/modelo')
  const { decidir } = await import('../src/lib/marcia/porteiro')

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: cfg } = await db.from('ai_configs').select('model, api_key').eq('is_active', true).limit(1)
  const apiKey = decrypt(cfg![0].api_key)
  const model = process.argv[4] ?? cfg![0].model
  const ins = await carregarInstrucoes(apiKey, null)
  if (!ins.texto) throw new Error('não consegui ler as instruções (plataforma)')
  const agente = { instructions: ins.texto }
  console.log('instruções:', ins.origem, '| caracteres', ins.texto.length)
  const amostra: string[] = []

  const desde = new Date(Date.now() - DIAS * 86_400_000).toISOString()
  const { data: convs } = await db
    .from('conversations')
    .select('id, contact_id')
    .gte('created_at', desde)
    .order('created_at', { ascending: false })
    .limit(400)

  const HORARIOS = ['dia 09, segunda-feira, às 14:00', 'dia 09, segunda-feira, às 14:45', 'dia 09, segunda-feira, às 16:15']
  let chamadas = 0, convsUsadas = 0
  let ms = 0, tin = 0, tout = 0
  const barrariaOffered: string[] = []
  const deixariaPassar: string[] = []
  let ambosBarram = 0, ambosPassam = 0, erros = 0, divergiu = 0

  for (const c of (convs ?? []) as { id: string; contact_id: string }[]) {
    if (chamadas >= MAX) break
    const { data: msgs } = await db
      .from('messages')
      .select('sender_type, content_text, ai_generated, created_at')
      .eq('conversation_id', c.id)
      .order('created_at', { ascending: true })
      .limit(80)
    const lista = (msgs ?? []) as { sender_type: string; content_text: string | null; ai_generated: boolean | null }[]
    if (!lista.some((m) => m.sender_type === 'bot' && m.ai_generated)) continue
    const lidos = await lerFatos(db, { contactId: c.contact_id, conversationId: c.id, horariosLivres: [1, 2, 3] })
    if (lidos.fatos.ehCliente || lidos.fatos.temReuniao) continue
    // Estado de hoje não vale para o passado: só valor e agenda são comparados.
    const textoDoCliente = lista.filter((m) => m.sender_type === 'customer').map((m) => m.content_text ?? '').join('\n')
    const fatos = { ...lidos.fatos, textoDoCliente, cardPerdido: false, etapaSensivel: false, abaixoPisoGravado: false, horarioJaEscolhido: false }
    convsUsadas++

    for (let i = 0; i < lista.length - 1 && chamadas < MAX; i++) {
      const atual = lista[i], prox = lista[i + 1]
      if (atual.sender_type !== 'customer' || prox.sender_type !== 'bot' || !prox.ai_generated) continue
      const proxTexto = lista.slice(i + 1).slice(0, 4).filter((m, k, arr) => k === 0 || arr.slice(0, k).every((x) => x.sender_type === 'bot')).filter((m) => m.sender_type === 'bot').map((m) => m.content_text ?? '').join('\n')
      const velhoOfereceu = /Tenho estes hor[aá]rios|\[1\]\s*dia/i.test(proxTexto)
      const velhoRecusou = /n[aã]o se enquadra no perfil/i.test(proxTexto)
      if (!velhoOfereceu && !velhoRecusou) continue

      const conversa = lista
        .slice(0, i + 1)
        .filter((m) => m.content_text)
        .map((m) => ({ role: (m.sender_type === 'customer' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content_text! }))
      try {
        const r = await decidirComModelo({
          apiKey, model, instrucoes: agente.instructions, fatosTexto: fatosParaTexto(lidos, HORARIOS),
          conversa, produto: fatos.produto,
        })
        chamadas++; ms += r.ms; tin += r.tokensEntrada; tout += r.tokensSaida
        const foc = await lerValorFocado({ apiKey, model, produto: fatos.produto, conversa })
        ms += foc.ms
        if (foc.valorTotal !== r.decisao.valorTotal) divergiu++
        const decisaoGrande = r.decisao
        r.decisao = { ...r.decisao, valorTotal: foc.valorTotal, valorRelacao: foc.valorRelacao, valorTipo: foc.valorTipo, valorTrecho: foc.valorTrecho }
        void decisaoGrande
        const res = decidir(r.decisao, fatos)
        if (amostra.length < 14) amostra.push(`[${c.id.slice(0, 8)}] cliente: "${(atual.content_text ?? '').replace(/\s+/g, ' ').slice(0, 60)}"\n    REAL:  ${(prox.content_text ?? '').replace(/\s+/g, ' ').slice(0, 130)}\n    V2:    (${r.decisao.intencao}) ${r.decisao.mensagem.replace(/\s+/g, ' ').slice(0, 130)}`)
        const barra = ['recusa', 'perguntar_valor', 'encaminhar_equipe', 'handoff'].includes(res.acao.tipo)
        const rotulo = `[${c.id.slice(0, 8)}|${fatos.produto ?? 'sem produto'}] valor lido=${r.decisao.valorTotal} v2=${res.acao.tipo} | cliente: "${(atual.content_text ?? '').replace(/\s+/g, ' ').slice(0, 70)}"`
        if (velhoOfereceu && barra) barrariaOffered.push(rotulo)
        else if (velhoRecusou && !barra) deixariaPassar.push(rotulo)
        else if (velhoOfereceu) ambosPassam++
        else ambosBarram++
      } catch (e) {
        erros++
        console.error('erro:', (e as Error).message.slice(0, 120))
      }
    }
  }
  console.log(`\nmodelo ${model} | conversas usadas ${convsUsadas} | chamadas ${chamadas} | erros ${erros}`)
  console.log(`média ${Math.round(ms / Math.max(chamadas, 1))} ms/chamada | tokens médios entrada ${Math.round(tin / Math.max(chamadas, 1))} saída ${Math.round(tout / Math.max(chamadas, 1))}`)
  console.log(`leitura focada diferente da leitura dentro do prompt grande: ${divergiu} de ${chamadas}`)
  console.log(`concordam (ambos oferecem horário): ${ambosPassam} | concordam (ambos recusam): ${ambosBarram}`)
  console.log('\nAMOSTRA DE MENSAGENS (real × v2):')
  amostra.forEach((l) => console.log(l))
  console.log(`\nA ATUAL OFERECEU HORÁRIO e a v2 teria BARRADO: ${barrariaOffered.length}`)
  barrariaOffered.forEach((l) => console.log('  ' + l))
  console.log(`\nA ATUAL RECUSOU e a v2 teria DEIXADO PASSAR: ${deixariaPassar.length}`)
  deixariaPassar.forEach((l) => console.log('  ' + l))
}
main().catch((e) => { console.error('falhou:', (e as Error).message); process.exit(1) })
