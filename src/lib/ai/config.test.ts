import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

import { loadAiConfig } from './config'
import { _resetAgentConfigCacheForTests } from './agent-config'

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
}

// Márcia 2.0 (20/09/2026): `loadAiConfig` (provider openai) tenta buscar o
// Agent na plataforma antes de devolver a config — sem mockar `fetch` aqui
// esses testes bateriam de verdade na API da OpenAI. Por padrão devolve 404
// (cai no fallback systemPrompt/model da própria linha, preservando o
// comportamento que os testes abaixo já esperavam antes desse recurso existir).
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }))
  _resetAgentConfigCacheForTests()
})
afterEach(() => vi.unstubAllGlobals())

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })
})

describe('loadAiConfig — Márcia 2.0 (systemPrompt/model do Agent da plataforma)', () => {
  const ROW_COM_PROMPT_PROPRIO = { ...ROW, system_prompt: 'prompt antigo do ai_configs' }

  it('quando o Agent responde, systemPrompt e model vêm dele (não do ai_configs)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ instructions: 'instruções vindas do Agent', model: 'gpt-5.4-mini' }),
      }),
    )
    const config = await loadAiConfig(dbReturning(ROW_COM_PROMPT_PROPRIO), 'acct', {
      requireActive: false,
    })
    expect(config!.systemPrompt).toBe('instruções vindas do Agent')
    expect(config!.model).toBe('gpt-5.4-mini')
  })

  it('quando o Agent falha (404/erro de rede), cai pro systemPrompt/model do ai_configs', async () => {
    // beforeEach já stub o fetch pra 404 — comportamento default.
    const config = await loadAiConfig(dbReturning(ROW_COM_PROMPT_PROPRIO), 'acct', {
      requireActive: false,
    })
    expect(config!.systemPrompt).toBe('prompt antigo do ai_configs')
    expect(config!.model).toBe('gpt-x')
  })

  it('provider anthropic nunca busca o Agent (é recurso só do provider openai)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const config = await loadAiConfig(
      dbReturning({ ...ROW_COM_PROMPT_PROPRIO, provider: 'anthropic' }),
      'acct',
      { requireActive: false },
    )
    expect(config!.systemPrompt).toBe('prompt antigo do ai_configs')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
