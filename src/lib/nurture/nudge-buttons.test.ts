import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AI_STAGE_QUALIFICADO,
  AI_STAGE_PERDIDO,
  AI_ETAPAS_QUE_AVANCAM,
} from '@/lib/ai/auto-reply'

const h = vi.hoisted(() => ({
  deal: null as { id: string; stage_id: string } | null,
  patch: null as Record<string, unknown> | null,
  textos: [] as string[],
  gatilhos: [] as { stage_id: string }[],
  falharBanco: false,
}))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      for (const passo of ['select', 'eq', 'order']) chain[passo] = () => chain
      chain.limit = () => {
        if (h.falharBanco) throw new Error('banco fora')
        return Promise.resolve({ data: h.deal ? [h.deal] : [], error: null })
      }
      chain.update = (p: Record<string, unknown>) => {
        h.patch = p
        return { eq: () => Promise.resolve({ error: null }) }
      }
      return chain
    },
  }),
}))
vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: vi.fn(async (a: { text: string }) => { h.textos.push(a.text); return { whatsapp_message_id: 'm1' } }),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(async (a: { context: { stage_id: string } }) => { h.gatilhos.push(a.context) }),
}))

import { isNudgeButton, handleNudgeButton } from './nudge-buttons'

const FUP = [...AI_ETAPAS_QUE_AVANCAM][1]
const ARGS = {
  accountId: 'acct', userId: 'user', conversationId: 'conv',
  contactId: 'contato-1', contactName: 'Maria Silva', buttonText: '',
}

beforeEach(() => {
  h.deal = { id: 'deal-1', stage_id: FUP }
  h.patch = null; h.textos = []; h.gatilhos = []; h.falharBanco = false
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('reconhece os dois botões', () => {
  it.each(['Desejo prosseguir', 'Parar mensagens'])('reconhece "%s"', (t) => {
    expect(isNudgeButton(t)).toBe(true)
  })
  it.each(['Confirmar presença', 'oi', '', null, undefined])('ignora %s', (t) => {
    expect(isNudgeButton(t as string)).toBe(false)
  })
})

describe('Parar mensagens', () => {
  it('⭐ manda o card para Perdido e FECHA', async () => {
    const r = await handleNudgeButton({ ...ARGS, buttonText: 'Parar mensagens' })
    expect(h.patch).toEqual({ stage_id: AI_STAGE_PERDIDO, status: 'lost' })
    expect(r.chamarIa).toBe(false)
  })

  it('fechar é o que tira da régua: a nutrição só pesca card aberto', async () => {
    await handleNudgeButton({ ...ARGS, buttonText: 'Parar mensagens' })
    expect((h.patch as { status?: string }).status).toBe('lost')
  })

  it('despede-se em UMA frase, sem tentar reverter', async () => {
    await handleNudgeButton({ ...ARGS, buttonText: 'Parar mensagens' })
    expect(h.textos).toHaveLength(1)
    expect(h.textos[0]).toContain('Maria')
    // ⛔ nada de oferecer horário, link ou "tem certeza?"
    expect(h.textos[0]).not.toMatch(/horário|agendar|link|tem certeza/i)
  })

  it('⛔ NÃO entrega a conversa para a IA', async () => {
    const r = await handleNudgeButton({ ...ARGS, buttonText: 'Parar mensagens' })
    expect(r.chamarIa).toBe(false)
  })
})

describe('Desejo prosseguir', () => {
  it('⭐ tira o card da etapa dormente na hora', async () => {
    // Sem isto o relógio da régua continuaria correndo e a pessoa levaria o
    // encerramento por falta de retorno dias depois de ter dito que quer seguir.
    const r = await handleNudgeButton({ ...ARGS, buttonText: 'Desejo prosseguir' })
    expect(h.patch).toEqual({ stage_id: AI_STAGE_QUALIFICADO })
    expect(r.chamarIa).toBe(true)
  })

  it('⛔ não puxa de volta quem já avançou', async () => {
    h.deal = { id: 'deal-1', stage_id: 'etapa-adiante-qualquer' }
    const r = await handleNudgeButton({ ...ARGS, buttonText: 'Desejo prosseguir' })
    expect(h.patch).toBeNull()
    expect(r.chamarIa).toBe(true) // a conversa é dela de qualquer forma
  })

  it('não fecha o card', async () => {
    await handleNudgeButton({ ...ARGS, buttonText: 'Desejo prosseguir' })
    expect((h.patch as { status?: string }).status).toBeUndefined()
  })

  it('dispara o gatilho de etapa', async () => {
    await handleNudgeButton({ ...ARGS, buttonText: 'Desejo prosseguir' })
    expect(h.gatilhos).toEqual([expect.objectContaining({ stage_id: AI_STAGE_QUALIFICADO })])
  })
})

describe('nunca derruba o webhook', () => {
  it('banco fora: não lança', async () => {
    h.falharBanco = true
    await expect(handleNudgeButton({ ...ARGS, buttonText: 'Parar mensagens' })).resolves.toEqual({
      chamarIa: false,
    })
  })

  it('sem card aberto: segue sem quebrar', async () => {
    h.deal = null
    const r = await handleNudgeButton({ ...ARGS, buttonText: 'Desejo prosseguir' })
    expect(r.chamarIa).toBe(true)
    expect(h.patch).toBeNull()
  })
})
