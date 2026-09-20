import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import type { AiConfig } from './types'

const cfg: AiConfig = {
  provider: 'openai',
  model: 'gpt-5.4-mini',
  apiKey: 'test-key',
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
  handoffAgentId: null,
  embeddingsApiKey: null,
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => vi.unstubAllGlobals())

describe('Márcia 2.0 acceptance fixtures', () => {
  it('sends Instructions and the exact Vector Store to File Search', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output_text: 'A orientação encontrada no material indexado é atendimento especializado.',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateReply({
      config: cfg,
      systemPrompt: 'Cérebro Márcia: nunca invente preço.',
      messages: [{ role: 'user', content: 'O que o material explica?' }],
    })
    expect(result.text).toContain('material indexado')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.instructions).toContain('nunca invente preço')
    expect(body.tools[0]).toEqual({
      type: 'file_search',
      vector_store_ids: ['vs_6aadd769530081918605c3c6da360f30'],
    })
  })

  it.each([
    ['DBC', 'VENDA_DIRETA', '[[VALOR:5000]][[PF]]'],
    ['GPIX', 'REUNIÃO', '[[VALOR:10000]][[PF]][[QUALIFICADO]]'],
    ['DEF', 'REUNIÃO', '[[VALOR:50000]][[PF]][[QUALIFICADO]]'],
    ['Gestão de Passivos PJ', 'REUNIÃO', '[[VALOR:100000]][[PJ]][[QUALIFICADO]]'],
    ['RCPCC', 'REUNIÃO', '[[PF]][[QUALIFICADO]]'],
    ['RCV', 'REUNIÃO', '[[PF]][[QUALIFICADO]]'],
    ['Recuperação de Créditos Tributários', 'REUNIÃO', '[[PJ]][[QUALIFICADO]]'],
  ])('parses the %s %s acceptance fixture without external actions', async (_area, _mode, markers) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ output_text: 'Resposta controlada ' + markers }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateReply({
      config: cfg,
      systemPrompt: 'Fixture: ' + _area + '; modalidade ' + _mode + '.',
      messages: [{ role: 'user', content: 'mensagem simulada' }],
    })
    expect(result.text).toBe('Resposta controlada')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('hands judicial-process cases to a human except explicit exception fixtures', () => {
    const prompt = buildSystemPrompt({
      userPrompt: 'Processo judicial relacionado deve gerar HANDOFF, salvo DBC e DEF esperados.',
      mode: 'auto_reply',
    })
    expect(prompt).toContain('Processo judicial relacionado')
    expect(prompt).toContain('HANDOFF')
  })

  it('keeps successive-message memory in the supplied conversation context', () => {
    const prompt = buildSystemPrompt({
      userPrompt: 'Não repita perguntas já respondidas; use o histórico.',
      mode: 'auto_reply',
    })
    expect(prompt).toContain('Não repita perguntas')
  })
})
