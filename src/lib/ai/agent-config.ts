// Márcia 2.0 (19-20/09/2026): instruções e modelo vivem no Agent da própria
// plataforma OpenAI (platform.openai.com → Agents), não duplicados no
// ai_configs do Supabase. Editar o Agent lá já vale na próxima mensagem
// (cache de 60s abaixo). Consumido por `loadAiConfig` (config.ts) — NÃO
// pelo provider (openai.ts): o texto do Agent precisa passar pelo mesmo
// `buildSystemPrompt()` que monta o protocolo de marcadores + agenda real +
// contexto do contato, senão a Márcia perde a capacidade de agendar/
// qualificar/mover card (achado real, 20/09: o texto do Agent sozinho não
// tem os marcadores `[[...]]` que o resto do sistema lê).
//
// Se o fetch do Agent falhar (rede, ID revogado, sem permissão), o chamador
// cai pro systemPrompt/model do ai_configs como rede de segurança — nunca
// quebra o atendimento por causa disso.
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
const OPENAI_AGENT_ID =
  process.env.OPENAI_AGENT_ID || 'agent_be0189f56bb44fc8910073e66814e6b1e36a6c8eee164a968d'
const AGENT_CONFIG_CACHE_MS = 60_000

export interface AgentConfig {
  instructions: string
  model: string
}

let agentConfigCache: { value: AgentConfig; fetchedAt: number } | null = null

/** Test-only: limpa o cache do Agent entre casos de teste. */
export function _resetAgentConfigCacheForTests(): void {
  agentConfigCache = null
}

export async function fetchAgentConfig(apiKey: string): Promise<AgentConfig | null> {
  if (agentConfigCache && Date.now() - agentConfigCache.fetchedAt < AGENT_CONFIG_CACHE_MS) {
    return agentConfigCache.value
  }
  try {
    const res = await fetch(`${OPENAI_BASE}/agents/${OPENAI_AGENT_ID}`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'agents=v1' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      console.warn(
        `[ai config] falha ao buscar Agent ${OPENAI_AGENT_ID} (HTTP ${res.status}) — usando systemPrompt/model do ai_configs como fallback`,
      )
      return null
    }
    const data = (await res.json()) as { instructions?: string; model?: string }
    if (!data.instructions || !data.model) return null
    const value: AgentConfig = { instructions: data.instructions, model: data.model }
    agentConfigCache = { value, fetchedAt: Date.now() }
    return value
  } catch (err) {
    console.warn(`[ai config] erro de rede buscando Agent ${OPENAI_AGENT_ID} — usando fallback:`, err)
    return null
  }
}
