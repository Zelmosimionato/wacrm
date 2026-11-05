// Avalia a LEITURA DO VALOR pelo modelo contra os casos reais. Uso: tsx scripts/marcia-avaliar.ts [modelo] [--listar]
// A chave vem do ai_configs (descriptografada em memória) e NUNCA é impressa.
import { readFileSync } from 'node:fs'

for (const l of readFileSync('/root/wacrm/.env.local', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY!

async function chave(): Promise<{ key: string; model: string }> {
  const r = await fetch(`${SB}/rest/v1/ai_configs?select=provider,model,api_key&is_active=eq.true&limit=1`, {
    headers: { apikey: SK, Authorization: `Bearer ${SK}` },
  })
  const rows = (await r.json()) as { provider: string; model: string; api_key: string }[]
  if (!rows[0]) throw new Error('sem ai_configs ativo')
  const { decrypt } = await import('../src/lib/whatsapp/encryption')
  return { key: decrypt(rows[0].api_key), model: rows[0].model }
}

const BASE = [
  'Você lê uma conversa de WhatsApp entre uma atendente (ia) e um cliente com dívida bancária ou bloqueio de conta.',
  'Devolva valor_total: o VALOR TOTAL da dívida, do contrato ou do bloqueio que o CLIENTE informou, em reais inteiros.',
  'Se houver mais de um contrato ou dívida, some os totais informados.',
  'Use null quando o cliente ainda não informou o total, ou quando o número é só parcela, prestação, entrada, saldo restante, telefone, data ou outro dado.',
  'Uma resposta curta só com número vale como o valor que a atendente acabou de perguntar.',
  'Se o número já tem milhar completo e vem seguido de "mil" (ex.: "8000mil"), o valor é o próprio número, nunca multiplicado de novo.',
].join(' ')
const POR_PRODUTO: Record<string, string> = {
  DBC: 'Produto: bloqueio de conta. Valor vago ("mais de X", "uns X", "cerca de X") ou faixa ("entre X e Y") NÃO é valor exato: devolva null. Só devolva número quando o cliente disser o valor bloqueado de forma exata.',
  OUTRO: 'Valor aproximado vale: "uns X", "quase X", "cerca de X" e "mais de X" valem X; em faixa ("entre X e Y") use o limite superior.',
}
const instrucoes = (area: string) => BASE + ' ' + (area === 'DBC' ? POR_PRODUTO.DBC : POR_PRODUTO.OUTRO)

type Caso = { id: string; area: string; conversa: [string, string][]; valorTotal?: number | null; valorTotalMinimo?: number }

const medidas = { ms: 0, entrada: 0, saida: 0, n: 0 }
async function chamar(key: string, model: string, c: Caso): Promise<number | null> {
  const t0 = Date.now()
  const transcript = c.conversa.map(([q, t]) => `${q === 'ia' ? 'Atendente' : 'Cliente'}: ${t}`).join('\n')
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      ...(process.env.EFFORT ? { reasoning: { effort: process.env.EFFORT } } : {}),
      instructions: instrucoes(c.area),
      input: transcript,
      text: {
        format: {
          type: 'json_schema',
          name: 'leitura_valor',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['valor_total'],
            properties: { valor_total: { type: ['integer', 'null'] } },
          },
        },
      },
    }),
  })
  const j = (await r.json()) as any
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${j?.error?.message ?? 'erro'}`)
  medidas.ms += Date.now() - t0; medidas.entrada += j.usage?.input_tokens ?? 0; medidas.saida += j.usage?.output_tokens ?? 0; medidas.n++
  const texto = (j.output ?? []).flatMap((o: any) => o.content ?? []).find((p: any) => p.type === 'output_text')?.text
  return JSON.parse(texto).valor_total
}

async function main() {
  const { key, model: modeloCfg } = await chave()
  if (process.argv.includes('--listar')) {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } })
    const j = (await r.json()) as any
    console.log('configurado no CRM:', modeloCfg)
    console.log((j.data ?? []).map((m: any) => m.id).filter((id: string) => /^(gpt|o\d)/.test(id)).sort().join('\n'))
    return
  }
  const model = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : modeloCfg
  const { casos } = JSON.parse(readFileSync(new URL('../src/lib/marcia/casos-avaliacao.json', import.meta.url), 'utf8')) as { casos: Caso[] }
  let ok = 0
  for (const c of casos) {
    let got: number | null | string
    try { got = await chamar(key, model, c) } catch (e) { got = `ERRO ${(e as Error).message}` }
    const bom =
      typeof got === 'string' ? false
      : c.valorTotalMinimo !== undefined ? got !== null && got >= c.valorTotalMinimo && got <= 100_000
      : got === (c.valorTotal ?? null) || (got !== null && c.valorTotal != null && Math.abs(got - c.valorTotal) <= 1)
    if (bom) ok++
    console.log(`${bom ? 'OK  ' : 'FALHA'} ${c.id}  esperado=${c.valorTotalMinimo !== undefined ? '>=' + c.valorTotalMinimo : c.valorTotal ?? null}  modelo=${got}`)
  }
  const esf = process.env.EFFORT ? ' esforço ' + process.env.EFFORT : ''
  console.log(`\nmodelo ${model}${esf}: ${ok}/${casos.length} | média ${Math.round(medidas.ms / medidas.n)} ms/chamada | tokens médios entrada ${Math.round(medidas.entrada / medidas.n)} saída ${Math.round(medidas.saida / medidas.n)}`)
}
main().catch((e) => { console.error('falhou:', (e as Error).message); process.exit(1) })
