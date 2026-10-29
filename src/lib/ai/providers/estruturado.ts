// Saída estruturada do agente (Márcia 2.0): { mensagens, marcadores, notas_internas }.
// Só `mensagens` (balões) e `marcadores` seguem adiante; `notas_internas` é o lugar do
// raciocínio dela e nunca chega ao lead. Texto comum (formato antigo) passa intacto.

const RE_MARCADOR = /^\[\[[A-Z_]+(?::\d+)?\]\]$/

function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
    : []
}

function tentarJson(raw: string): Record<string, unknown> | null {
  let t = raw.trim()
  const cerca = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (cerca) t = cerca[1]
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  try {
    const o = JSON.parse(t)
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Converte a saída do agente no texto que o resto do código já entende: balões separados
 * por linha em branco e, no fim, os marcadores. Só aceita como marcador o que tem a
 * forma `[[NOME]]` ou `[[NOME:N]]` — qualquer outro texto nesse campo é descartado.
 * Se não for o JSON esperado, devolve `raw` sem alteração.
 */
export function textoParaOLead(raw: string): string {
  const o = tentarJson(raw)
  if (!o || !Array.isArray(o.mensagens)) return raw
  const baloes = strings(o.mensagens)
  const marcadores = strings(o.marcadores).filter((m) => RE_MARCADOR.test(m))
  const notas = typeof o.notas_internas === 'string' ? o.notas_internas.trim() : ''
  if (notas) console.log(`[sdr] notas internas (não enviadas): ${notas.slice(0, 300)}`)
  return [baloes.join('\n\n'), marcadores.join(' ')].filter(Boolean).join('\n')
}
