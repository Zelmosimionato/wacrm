import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
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
const OPENAI_URL = `${OPENAI_BASE}/responses`
const OPENAI_VECTOR_STORE_ID =
  process.env.OPENAI_VECTOR_STORE_ID || 'vs_6aadd769530081918605c3c6da360f30'

interface OpenAiResponse {
  output_text?: string
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Call OpenAI Responses with File Search over the configured Vector Store.
 * `model`/`systemPrompt` arrive already resolved by `loadAiConfig`
 * (config.ts) — which is where the Agent-vs-ai_configs decision lives, so
 * this stays a plain, stateless call. Returns the raw assistant text +
 * token usage (handoff parsing happens in `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        instructions: systemPrompt,
        input: mergeConsecutive(messages),
        tools: [{ type: 'file_search', vector_store_ids: [OPENAI_VECTOR_STORE_ID] }],
        max_output_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const text =
    data?.output_text ||
    data?.output
      ?.flatMap((item) => item.content || [])
      .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', {
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
