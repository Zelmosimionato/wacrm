import { AiError, type ProviderResult } from '../types'
import {
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

// Base URL configurável: aponta o provider "openai" a QUALQUER endpoint compatível com OpenAI.
// Para usar o hermes local via Ollama na VPS, definir no ambiente do servidor:
//   OPENAI_BASE_URL=http://localhost:11434/v1
// Sem a variável, mantém o comportamento original (OpenAI na nuvem). Server-only (não NEXT_PUBLIC).
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
const SESSION_POLL_INTERVAL_MS = 350

function getOpenAiAgentId(): string | undefined {
  return process.env.OPENAI_AGENT_ID
}

interface AgentSession {
  id?: string
  status?: string
  last_error?: { message?: string } | null
  error?: { message?: string } | null
}

interface AgentItem {
  type?: string
  role?: string
  content?: Array<{ type?: string; text?: string }>
}

interface AgentItemsResponse {
  data?: AgentItem[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Run the saved Márcia 2.0 agent through the hosted Agents API.
 * The VPS is only a client: `environment: none` deliberately prevents any
 * agent runtime, model, or sandbox from being created on the server.
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, systemPrompt, messages, timeoutMs } = args

  const agentId = getOpenAiAgentId()
  if (!agentId) {
    throw new AiError('OpenAI Agent ID is not configured.', {
      code: 'missing_agent_id',
      status: 503,
    })
  }

  const transcript = [
    'Contexto operacional do CRM (não altere as regras do agente hospedado):',
    systemPrompt || '(nenhum contexto adicional)',
    '',
    'Histórico da conversa:',
    ...messages.map((message) => `${message.role === 'assistant' ? 'Márcia' : 'Cliente'}: ${message.content}`),
  ].join('\n')

  let sessionResponse: Response
  try {
    sessionResponse = await fetch(`${OPENAI_BASE}/agents/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'agents=v1',
      },
      body: JSON.stringify({
        agent_id: agentId,
        environment: { type: 'none' },
        input: [{
          role: 'user',
          content: [{ type: 'input_text', text: transcript }],
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!sessionResponse.ok) {
    throw await providerHttpError('OpenAI Agents', sessionResponse)
  }

  const session = (await sessionResponse.json().catch(() => null)) as AgentSession | null
  if (!session?.id) {
    throw new AiError('OpenAI Agents returned no session ID.', { code: 'provider_error', status: 502 })
  }

  const deadline = Date.now() + timeoutMs
  let status = session.status
  let current = session
  while (status === 'in_progress' || status === 'running' || status === 'queued' || status === 'requires_action') {
    if (Date.now() >= deadline) {
      throw new AiError('The Márcia 2.0 session took too long to respond.', { code: 'timeout', status: 504 })
    }
    await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_INTERVAL_MS))
    let pollResponse: Response
    try {
      pollResponse = await fetch(`${OPENAI_BASE}/agents/sessions/${encodeURIComponent(session.id)}`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'agents=v1' },
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!pollResponse.ok) throw await providerHttpError('OpenAI Agents', pollResponse)
    current = (await pollResponse.json().catch(() => null)) as AgentSession
    status = current?.status
  }

  if (status === 'failed' || status === 'cancelled' || status === 'expired') {
    const detail = current.last_error?.message || current.error?.message || `status ${status}`
    throw new AiError(`Márcia 2.0 session failed: ${detail}`, { code: 'provider_error', status: 502 })
  }

  let itemsResponse: Response
  try {
    itemsResponse = await fetch(`${OPENAI_BASE}/agents/sessions/${encodeURIComponent(session.id)}/items`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'agents=v1' },
      signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!itemsResponse.ok) throw await providerHttpError('OpenAI Agents', itemsResponse)

  const data = (await itemsResponse.json().catch(() => null)) as AgentItemsResponse | null
  const assistantItems = (data?.data || []).filter((item) => item.role === 'assistant')
  const text = assistantItems
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('Márcia 2.0 returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}
