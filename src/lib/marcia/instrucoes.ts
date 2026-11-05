// Márcia v2/3.0 — de onde vêm as instruções (texto da conversa). Ordem: agente 3.0 na plataforma (MARCIA_V3_AGENT_ID),
// depois arquivo (MARCIA_V2_INSTRUCOES_FILE, para testes), depois o agente vivo da Márcia atual.
// O texto mora NA PLATAFORMA; o código só o lê (cache de 60 s).
import { existsSync, readFileSync } from 'node:fs'
import { fetchAgentConfig } from '../ai/agent-config'

let cache: { id: string; texto: string; em: number } | null = null

async function lerAgente(apiKey: string, id: string): Promise<string | null> {
  if (cache && cache.id === id && Date.now() - cache.em < 60_000) return cache.texto
  try {
    const r = await fetch(`https://api.openai.com/v1/agents/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'agents=v1' },
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { instructions?: string }
    if (!j.instructions) return null
    cache = { id, texto: j.instructions, em: Date.now() }
    return j.instructions
  } catch {
    return null
  }
}

export async function carregarInstrucoes(apiKey: string, fallbackConta: string | null): Promise<{ texto: string; origem: string }> {
  const v3 = process.env.MARCIA_V3_AGENT_ID
  if (v3) {
    const t = await lerAgente(apiKey, v3)
    if (t) return { texto: t, origem: `agente ${v3.slice(0, 14)}…` }
    if (cache?.id === v3) return { texto: cache.texto, origem: 'agente 3.0 (cache)' }
  }
  const arq = process.env.MARCIA_V2_INSTRUCOES_FILE
  if (arq && existsSync(arq)) return { texto: readFileSync(arq, 'utf8'), origem: `arquivo ${arq}` }
  const vivo = await fetchAgentConfig(apiKey)
  return { texto: vivo?.instructions ?? fallbackConta ?? '', origem: 'agente vivo da Márcia atual' }
}
