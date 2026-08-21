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
  startManualFlowRun: vi.fn(),
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
    /** Todo `.insert()` feito em qualquer tabela, na ordem em que ocorreram. */
    inserts: [] as { table: string; rows: Record<string, unknown>[] }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('@/lib/flows/engine', () => ({ startManualFlowRun: h.startManualFlowRun }))
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
      // await direto na consulta, sem .limit()/.maybeSingle(). `count` sai
      // do tamanho das linhas da tabela — cobre o padrao
      // `.select('id', {count:'exact',head:true})` usado nos checks de tag
      // (temReuniaoAgora, applyAiCardMove, applyAiUrgente).
      chain.then = (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
        Promise.resolve({ data: linhas(), error: null, count: linhas().length }).then(ok, erro)
      chain.update = (payload: Record<string, unknown>) => {
        h.state.updatePayload = payload
        return { eq: () => Promise.resolve({ error: null }) }
      }
      // Registra o insert e devolve sucesso — o teste confere pelo que foi
      // gravado em h.state.inserts, nao pelo retorno.
      chain.insert = (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        h.state.inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] })
        return Promise.resolve({ error: null })
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
  h.state.inserts = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.startManualFlowRun.mockResolvedValue({
    consumed: true,
    outcome: 'started',
    flow_run_id: 'run-1',
  })
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

// Fase 3b: quando a IA sinaliza [[URGENTE]], além da tag "Urgente" (já
// coberto por `applyAiCardMove`/tags), agora dispara um handoff IMEDIATO em
// `notifications` — o titular não pode depender de abrir o card para saber
// que um lead falou de prazo real.
describe('dispatchInboundToAiReply — sinal de urgência ([[URGENTE]])', () => {
  it('insere em notifications com type urgent_lead e body com o texto do lead', async () => {
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, urgente: true })
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'preciso resolver isso até amanhã, é urgente' },
    ])
    h.state.porTabela.profiles = [{ user_id: 'user-a' }]

    await dispatchInboundToAiReply(ARGS)

    const notifInsert = h.state.inserts.find((i) => i.table === 'notifications')
    expect(notifInsert?.rows).toHaveLength(1)
    expect(notifInsert?.rows[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-a',
      type: 'urgent_lead',
      conversation_id: 'conv-1',
      contact_id: 'contact-1',
      title: 'Lead sinalizou urgência',
    })
    expect(notifInsert?.rows[0].body).toContain('urgente')
  })

  it('todos os membros da conta recebem uma linha — não só um "atribuído"', async () => {
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, urgente: true })
    h.state.porTabela.profiles = [
      { user_id: 'user-a' },
      { user_id: 'user-b' },
      { user_id: 'user-c' },
    ]

    await dispatchInboundToAiReply(ARGS)

    const notifInsert = h.state.inserts.find((i) => i.table === 'notifications')
    expect(notifInsert?.rows.map((r) => r.user_id).sort()).toEqual(['user-a', 'user-b', 'user-c'])
    expect(notifInsert?.rows.every((r) => r.type === 'urgent_lead')).toBe(true)
  })

  it('mesmo com a tag já aplicada antes, ainda dispara a notificação (não idempotente pro handoff)', async () => {
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, urgente: true })
    // `contact_tags` já tem uma linha → count > 0 → applyAiUrgente NAO
    // insere a tag de novo. A linha nao carrega `tags`, entao nao afeta o
    // calculo de isClient/hasMeeting (mesma tabela, consulta anterior).
    h.state.porTabela.contact_tags = [{ id: 'ja-tinha-a-tag' }]
    h.state.porTabela.profiles = [{ user_id: 'user-a' }]

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.inserts.find((i) => i.table === 'contact_tags')).toBeUndefined()
    const notifInsert = h.state.inserts.find((i) => i.table === 'notifications')
    expect(notifInsert?.rows).toHaveLength(1)
    expect(notifInsert?.rows[0]).toMatchObject({ type: 'urgent_lead', user_id: 'user-a' })
  })

  it('sem membros na conta, nao insere notificacao nenhuma (mas nao quebra)', async () => {
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, urgente: true })
    h.state.porTabela.profiles = []

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.inserts.find((i) => i.table === 'notifications')).toBeUndefined()
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('sem sinal de urgência, não grava nada em notifications', async () => {
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, urgente: false })
    h.state.porTabela.profiles = [{ user_id: 'user-a' }]

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.inserts.find((i) => i.table === 'notifications')).toBeUndefined()
  })
})

// Task 4 do plano de agendamento: [[AGENDAR]] (sem número) não reserva nada
// sozinha — entrega o bastão pro Fluxo de Agendamento via `startManualFlowRun`.
// Trocou o [[AGENDAR:N]] antigo depois de um incidente ao vivo em 20/08/2026
// (a IA confirmou reunião sem o lead ter escolhido horário). A IA só marca
// o marcador; quem decide se o Fluxo roda de verdade é este bloco de código —
// por isso os testes aqui exercitam o gate (qualificado / PF-only), não o
// parser (já coberto em generate.test.ts).
describe('dispatchInboundToAiReply — [[AGENDAR]] entrega o bastão pro Fluxo', () => {
  beforeEach(() => {
    // A IA só aprende/age sobre o marcador com a chave ligada — mesmo
    // interruptor que já protegia o mecanismo antigo.
    vi.stubEnv('IA_AGENDA_ATIVA', '1')
  })

  it('sem [[AGENDAR]] na resposta, não chama o Fluxo nem mexe no card', async () => {
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, agendar: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.startManualFlowRun).not.toHaveBeenCalled()
  })

  it('[[AGENDAR]] + contato SEM tag/etapa de qualificado → não chama o Fluxo, loga o aviso', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Sem `move` nesta resposta e sem card em `deals` (porTabela.deals vazio
    // → `etapaDoCard` devolve null) — nada indica que este lead qualificou.
    h.generateReply.mockResolvedValue({ text: 'Perfeito, já te mostro os horários!', handoff: false, agendar: true })

    await dispatchInboundToAiReply(ARGS)

    expect(h.startManualFlowRun).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ainda não está qualificado'))
    warn.mockRestore()
  })

  it('[[AGENDAR]] + qualificado (nesta resposta) + PF → chama o Fluxo com os args certos', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Perfeito, já te mostro os horários!',
      handoff: false,
      move: 'qualified',
      agendar: true,
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.startManualFlowRun).toHaveBeenCalledTimes(1)
    expect(h.startManualFlowRun).toHaveBeenCalledWith(expect.anything(), '', {
      accountId: 'acct-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
    })
  })

  it('[[AGENDAR]] + já qualificado (card em etapa avançada) + PF → chama o Fluxo', async () => {
    // "Lead Qualificado" — mesmo id de AI_STAGE_QUALIFICADO — sem o `move`
    // desta resposta apontar qualificação: o card JÁ tinha avançado antes.
    h.state.porTabela.deals = [{ stage_id: '57bed09e-bc01-4691-8272-dcd8c3c078df' }]
    h.generateReply.mockResolvedValue({
      text: 'Perfeito, já te mostro os horários!',
      handoff: false,
      agendar: true,
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.startManualFlowRun).toHaveBeenCalledTimes(1)
  })

  // ⚠️ O mock de `contact_tags` é genérico por tabela (não filtra por
  // `.eq()`): qualquer linha ali também conta como "tem reunião marcada" para
  // `temReuniaoAgora`. Por isso o cenário usa [[DESMARCAR]] junto — desliga
  // essa releitura de propósito (`hasMeetingAgora = desmarcar ? false : ...`)
  // e é uma combinação real: lead PJ que acabou de desmarcar e já tenta
  // remarcar na mesma mensagem.
  it('[[AGENDAR]] + qualificado + PJ → não chama o Fluxo, loga o aviso de rollout faseado', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    h.state.porTabela.contact_tags = [{ tags: { name: 'PJ' } }]
    h.generateReply.mockResolvedValue({
      text: 'Perfeito, já te mostro os horários!',
      handoff: false,
      move: 'super',
      agendar: true,
      desmarcar: true,
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.startManualFlowRun).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('é PJ, fora do rollout faseado'),
    )
    log.mockRestore()
  })

  // FLUXO_AGENDAMENTO_ID está vazio até o plano de montagem do grafo rodar —
  // nesta fase `startManualFlowRun` sempre devolve `no_match`. Sem este
  // fallback, o cliente ficaria com a frase de transição da IA e nada vindo
  // a seguir.
  it('Fluxo não encontrado (id ainda não existe) → troca a resposta pelo fallback, não deixa a transição solta', async () => {
    h.startManualFlowRun.mockResolvedValue({ consumed: false, outcome: 'no_match' })
    h.generateReply.mockResolvedValue({
      text: 'Perfeito, já vou te mostrar os horários disponíveis!',
      handoff: false,
      move: 'qualified',
      agendar: true,
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.startManualFlowRun).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('cal.com/simionato-advogados-n4sm0p'),
      }),
    )
  })
})
