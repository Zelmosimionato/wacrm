import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

import { loadAiConfig } from './config'

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

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
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

describe('loadAiConfig — configuração armazenada do CRM', () => {
  const ROW_COM_PROMPT_PROPRIO = { ...ROW, system_prompt: 'prompt antigo do ai_configs' }

  it('preserva systemPrompt e model do ai_configs para o contexto enviado ao Agent', async () => {
    const config = await loadAiConfig(dbReturning(ROW_COM_PROMPT_PROPRIO), 'acct', {
      requireActive: false,
    })
    expect(config!.systemPrompt).toBe('prompt antigo do ai_configs')
    expect(config!.model).toBe('gpt-x')
  })

  it('não faz chamada de descoberta ao Agent ao carregar a configuração', async () => {
    const config = await loadAiConfig(dbReturning(ROW_COM_PROMPT_PROPRIO), 'acct', {
      requireActive: false,
    })
    expect(config!.systemPrompt).toBe('prompt antigo do ai_configs')
    expect(config!.model).toBe('gpt-x')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('provider anthropic também não busca o Agent ao carregar a configuração', async () => {
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
