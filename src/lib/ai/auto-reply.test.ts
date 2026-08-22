import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'
import { AFIRMA_QUE_AGENDOU, PESSOA_AFIRMA_REUNIAO, emailNaConversa } from './auto-reply'

describe('emailNaConversa', () => {
  // O e-mail chega colado em outra coisa, com maiúscula, ou sozinho. Ler do
  // lugar errado custou 5 repetições da mesma frase numa conversa real: o
  // titular mandou o e-mail e ouviu "preciso do seu e-mail" cinco vezes.
  it('acha o e-mail mesmo colado a outro texto, e normaliza', () => {
    expect(
      emailNaConversa([
        { role: 'assistant', content: 'Qual horário?' },
        { role: 'user', content: '16:17 Zelmosimionato@gmail.com' },
      ]),
    ).toBe('zelmosimionato@gmail.com')
  })

  it('vale o último que a pessoa mandou', () => {
    expect(
      emailNaConversa([
        { role: 'user', content: 'zelmo@aasp.org.br' },
        { role: 'user', content: 'na verdade use contato@simionatoadvogados.com.br' },
      ]),
    ).toBe('contato@simionatoadvogados.com.br')
  })

  it('ignora e-mail que a própria IA escreveu', () => {
    expect(
      emailNaConversa([{ role: 'assistant', content: 'mande para contato@escritorio.com' }]),
    ).toBeNull()
  })

  it('sem e-mail nenhum, devolve null', () => {
    expect(emailNaConversa([{ role: 'user', content: 'pode ser quarta às 14h' }])).toBeNull()
  })
})

// A trava do sentido CONTRARIO: impede a IA de NEGAR reuniao que a pessoa diz
// ter. Em 10/08/2026 um lead escreveu "desejo confirmar meu agendamento", deu
// data e hora, e ela respondeu "nao temos esse horario disponivel no nosso
// sistema" — oferecendo datas 7 e 14 dias depois. A reuniao era real; so nao
// estava no CRM, porque a reserva veio por um canal que ele nao capta.
// Ausencia de registro nao e prova de ausencia.
describe('PESSOA_AFIRMA_REUNIAO', () => {
  it.each([
    'Desejo confirmar meu agendamento',
    'Quero confirmar minha reuniao',
    'minha reunião é amanhã',
    'Nossa reunião é somente amanhã....',
    'gostaria de confirmar o horario',
    'ja estou agendado',
    'https://meet.google.com/jxt-qfgz-rbj',
    'meu horário é quarta',
  ])('pega a afirmação: %s', (frase) => {
    expect(PESSOA_AFIRMA_REUNIAO.test(frase)).toBe(true)
  })

  // ⛔ Quem quer MARCAR não pode ser confundido com quem já tem: esse cai no
  // fluxo normal de agendamento, e passar para humano seria perder o lead.
  it.each([
    'Oi, tudo bem?',
    'quero agendar uma reuniao',
    'posso marcar um horario?',
    'quero marcar uma reunião',
    'Como funciona?',
    'tenho uma divida no banco',
    'quais horarios voces tem?',
    'Bom dia',
  ])('não pega quem quer AGENDAR: %s', (frase) => {
    expect(PESSOA_AFIRMA_REUNIAO.test(frase)).toBe(false)
  })
})

// A trava que impede a IA de anunciar reunião que não marcou. Erro para os dois
// lados é caro: deixar passar faz a pessoa aparecer para uma sala vazia; pegar
// demais substitui mensagem legítima por um pedido de confirmação sem sentido.
describe('AFIRMA_QUE_AGENDOU', () => {
  it.each([
    'Prontinho, Zelmo! Agendei para quarta-feira, 12/08, às 16:15.',
    'Remarquei para quinta, tudo certo!',
    'Sua reunião está confirmada para amanhã.',
    'O convite com o link da videochamada já foi enviado para você.',
    'Reservei o horário das 14h para você.',
    // Escapou em 09/08/2026: ela respondeu isto a "tá agendada?" sem ter
    // reservado nada — a lista de verbos não tinha "remarcada".
    'Sua reunião está remarcada para quinta-feira, 20/08, às 13h.',
    'Sua reunião segue confirmada para quarta.',
    'A reunião ficou marcada para o dia 20.',
  ])('pega a afirmação: %s', (frase) => {
    expect(AFIRMA_QUE_AGENDOU.test(frase)).toBe(true)
  })

  it.each([
    'Qual horário fica melhor para você?',
    'Posso agendar para quarta às 14h?',
    'Assim que você confirmar, eu reservo o horário.',
    'Me passa seu e-mail que eu já deixo tudo certo.',
    'Temos horários na quarta-feira: 14:00, 14:45 ou 15:30.',
    'Vou verificar a agenda e te retorno.',
    'Quer que eu já remarque para quinta às 13h?',
    'Tenho quarta às 13h ou quinta às 13h — qual fica melhor?',
    'Ainda não há horário reservado. Quer que eu marque agora?',
  ])('não pega a frase legítima: %s', (frase) => {
    expect(AFIRMA_QUE_AGENDOU.test(frase)).toBe(false)
  })
})

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    /** Linhas devolvidas por ultimaEntrada(); mesma resposta nas duas leituras
     *  = nao chegou mensagem nova durante a espera = segue o fluxo. */
    ultimaEntrada: [] as { id: string }[],
    /** Linhas por tabela, para consultas sem campo dedicado. */
    porTabela: {} as Record<string, unknown[]>,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    // Encadeador GENERICO. Antes havia um ramo por tabela, e qualquer consulta
    // nova no codigo derrubava o teste com "x is not a function" — foi assim
    // que 5 testes ficaram vermelhos por dois dias, justo os do caminho de
    // envio, que eram a rede da guarda de rajada. Agora a forma da consulta e
    // livre; o teste controla so o DADO que cada tabela devolve.
    from: (table: string) => {
      const linhas = () => {
        if (table === 'automations') return h.state.autoResponders
        if (table === 'messages') return h.state.ultimaEntrada
        return h.state.porTabela[table] ?? []
      }
      const chain: Record<string, unknown> = {}
      for (const passo of ['select', 'eq', 'in', 'order', 'neq', 'gte', 'lte', 'not']) {
        chain[passo] = () => chain
      }
      chain.limit = () => Promise.resolve({ data: linhas(), error: null })
      chain.maybeSingle = () =>
        Promise.resolve({
          data: table === 'conversations' ? h.state.conv : (linhas() as unknown[])[0] ?? null,
          error: null,
        })
      chain.single = chain.maybeSingle
      // await direto na consulta, sem .limit()/.maybeSingle()
      chain.then = (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
        Promise.resolve({ data: linhas(), error: null }).then(ok, erro)
      chain.update = (payload: Record<string, unknown>) => {
        h.state.updatePayload = payload
        return { eq: () => Promise.resolve({ error: null }) }
      }
      return chain
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  // Zera a espera da rajada: o teste nao precisa dos 6s reais de produção.
  vi.stubEnv('AI_ESPERA_RAJADA_MS', '0')
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.ultimaEntrada = [{ id: 'msg-entrada-1' }]
  h.state.porTabela = {}
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  // ⛔ Este teste afirmava o contrario ("stands down when an active
  // message-level automation exists") e por isso a suite ficou verde enquanto
  // a Marcia estava muda: bastava UMA automacao de palavra-chave ativa na
  // conta para a IA calar em toda mensagem. Quem cala a IA e o webhook, e so
  // quando a automacao casa de verdade — aqui dentro ela responde.
  it('still replies when the account merely HAS a message-level automation', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})
