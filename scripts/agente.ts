// Gerencia o agente da Márcia 3.0 na plataforma OpenAI (API beta de agentes). A chave vem do ai_configs, nunca é impressa.
// Uso: tsx scripts/agente.ts ver [agentId]      -> mostra o agente (sem as instruções)
//      tsx scripts/agente.ts criar <arquivo>    -> cria um agente NOVO "Márcia 3.0" com o texto do arquivo (não mexe no vivo)
//      tsx scripts/agente.ts atualizar <agentId> <arquivo> -> troca só as instruções do agente indicado
import { readFileSync } from 'node:fs'
for (const l of readFileSync('/root/wacrm/.env.local', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const BASE = 'https://api.openai.com/v1'

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const { decrypt } = await import('../src/lib/whatsapp/encryption')
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data } = await db.from('ai_configs').select('api_key').eq('is_active', true).limit(1)
  const key = decrypt(data![0].api_key)
  const h = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'OpenAI-Beta': 'agents=v1' }
  const [cmd, a1, a2] = process.argv.slice(2)
  const vivo = process.env.OPENAI_AGENT_ID ?? 'agent_be0189f56bb44fc8910073e66814e6b1e36a6c8eee164a968d'

  const mostrar = (o: any) => {
    const { instructions, ...resto } = o
    console.log(JSON.stringify({ ...resto, instructions_caracteres: instructions?.length }, null, 2))
  }

  if (cmd === 'ver') {
    const r = await fetch(`${BASE}/agents/${a1 ?? vivo}`, { headers: h })
    const j = await r.json()
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`)
    mostrar(j)
  } else if (cmd === 'criar') {
    const rv = await fetch(`${BASE}/agents/${vivo}`, { headers: h })
    const base = (await rv.json()) as any
    if (!rv.ok) throw new Error('não li o agente vivo')
    const corpo: any = { name: 'Márcia 3.0', model: base.model, instructions: readFileSync(a1, 'utf8') }
    if (base.tools?.length) corpo.tools = base.tools
    if (base.tool_resources) corpo.tool_resources = base.tool_resources
    const r = await fetch(`${BASE}/agents`, { method: 'POST', headers: h, body: JSON.stringify(corpo) })
    const j = await r.json()
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 400)}`)
    mostrar(j)
  } else if (cmd === 'atualizar') {
    if (a1 === vivo) throw new Error('recusado: este é o agente VIVO da Márcia atual')
    const r = await fetch(`${BASE}/agents/${a1}`, { method: 'POST', headers: h, body: JSON.stringify({ instructions: readFileSync(a2, 'utf8') }) })
    const j = await r.json()
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 400)}`)
    mostrar(j)
  } else {
    console.log('comandos: ver | criar <arquivo> | atualizar <agentId> <arquivo>')
  }
}
main().catch((e) => { console.error('falhou:', (e as Error).message); process.exit(1) })
