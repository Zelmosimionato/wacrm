import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AiConfig } from './types'
import {
  AFIRMA_QUE_AGENDOU,
  PESSOA_AFIRMA_REUNIAO,
  emailNaConversa,
  VALOR_ABAIXO_DO_PISO,
  valorDeclaradoPeloCliente,
} from './auto-reply'

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

// Rede da trava de piso (01/09/2026, caso Rogério): quando a IA não emite
// [[VALOR:N]], é isto que procura o valor direto na mensagem do cliente.
describe('valorDeclaradoPeloCliente', () => {
  it('lê valor com R$', () => {
    expect(
      valorDeclaradoPeloCliente([{ role: 'user', content: 'R$ 450,00 na época' }]),
    ).toBe(450)
  })

  it('lê valor com "mil"', () => {
    expect(
      valorDeclaradoPeloCliente([{ role: 'user', content: 'devo uns 25 mil' }]),
    ).toBe(25000)
  })

  it('lê valor com "reais"', () => {
    expect(
      valorDeclaradoPeloCliente([{ role: 'user', content: 'são 9000 reais' }]),
    ).toBe(9000)
  })

  it('normaliza ponto de milhar e vírgula decimal (padrão BR)', () => {
    expect(
      valorDeclaradoPeloCliente([{ role: 'user', content: 'já paguei R$ 47.500,00' }]),
    ).toBe(47500)
  })

  // 18/09/2026, caso Tatá: "R$ 90 mil" caía inteiro no ramo "R$ + número" e
  // capturava só "90" — o "mil" ficava sem casar com nenhum ramo (o ramo
  // "número mil" exige o número colado nele mesmo, sem R$ na frente). O
  // valor real (R$90.000) virava 90, e um lead qualificado, já com reunião
  // sendo marcada, caía "abaixo do piso" por engano.
  it('lê "R$ X mil" como X*1000, não perde o "mil" (bug real, caso Tatá)', () => {
    expect(
      valorDeclaradoPeloCliente([{ role: 'user', content: 'acredito que o total esteja em torno de R$ 90 mil ou mais' }]),
    ).toBe(90000)
  })

  it('lê "R$Xmil" grudado, sem espaço, do mesmo jeito', () => {
    expect(
      valorDeclaradoPeloCliente([{ role: 'user', content: 'tenho uma dívida de R$70mil' }]),
    ).toBe(70000)
  })

  it('"R$ X" sem "mil" continua lendo o valor literal (não multiplica à toa)', () => {
    expect(
      valorDeclaradoPeloCliente([{ role: 'user', content: 'a parcela é de R$ 90' }]),
    ).toBe(90)
  })

  it('vale o último valor que a pessoa mandou', () => {
    expect(
      valorDeclaradoPeloCliente([
        { role: 'user', content: 'acho que é uns R$ 30 mil' },
        { role: 'user', content: 'na verdade conferi, são R$ 45.000,00' },
      ]),
    ).toBe(45000)
  })

  it('ignora o que a própria IA escreveu', () => {
    expect(
      valorDeclaradoPeloCliente([{ role: 'assistant', content: 'nosso piso é R$ 50.000' }]),
    ).toBeNull()
  })

  // Número sem contexto de moeda é telefone, data ou contagem de parcela —
  // nunca o valor da dívida. Exigir R$/mil/reais evita esse falso positivo.
  it('ignora número solto sem contexto de moeda', () => {
    expect(
      valorDeclaradoPeloCliente([
        { role: 'user', content: '48 parcelas, terminou em 2023, meu telefone é 11987654321' },
      ]),
    ).toBeNull()
  })

  it('sem nenhum valor na conversa, devolve null', () => {
    expect(
      valorDeclaradoPeloCliente([{ role: 'user', content: 'quero saber sobre meu processo' }]),
    ).toBeNull()
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
  enviarPeloSegundoNumero: vi.fn(),
  registrarEnvioSegundoNumero: vi.fn(),
  horariosLivres: vi.fn(),
  criarReserva: vi.fn(),
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
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText, engineSendCtaUrl: vi.fn() }))
vi.mock('@/lib/whatsapp/segundo-numero', () => ({
  enviarPeloSegundoNumero: h.enviarPeloSegundoNumero,
  registrarEnvioSegundoNumero: h.registrarEnvioSegundoNumero,
}))
vi.mock('@/lib/appointments/calcom-slots', () => ({ horariosLivres: h.horariosLivres }))
vi.mock('@/lib/appointments/calcom-book', () => ({ criarReserva: h.criarReserva }))
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
      // Suporte a .delete() — precisava pro destrave da trava persistente de
      // piso (11/09/2026): quando o cliente declara um valor novo igual/acima
      // do piso, o código apaga a tag TAG_ABAIXO_PISO em vez de só ignorá-la.
      // Aplica o filtro na hora (dentro do próprio .eq() encadeado, não atrás
      // de um .then() — o resto do encadeador também não usa .then() real
      // pros deletes existentes, e "await objetoQualquer" resolve sozinho).
      chain.delete = () => {
        const d: Record<string, unknown> = {}
        d.eq = (campo: string, valor: unknown) => {
          if (campo === 'tag_id') {
            h.state.porTabela[table] = (h.state.porTabela[table] ?? []).filter(
              (linha) => (linha as { tag_id?: string }).tag_id !== valor,
            )
          }
          return d
        }
        return d
      }
      // Generico igual ao resto do encadeador: só grava o que foi inserido
      // em `porTabela`, pra qualquer teste que precise conferir. Faltava
      // isto — o handoff decidido pelo modelo (25/08/2026) foi o primeiro
      // caminho a chamar `.insert()` em `notifications` de dentro deste
      // teste, e o encadeador não tinha esse passo.
      chain.insert = (payload: unknown) => {
        const linhasNovas = Array.isArray(payload) ? payload : [payload]
        h.state.porTabela[table] = [...(h.state.porTabela[table] ?? []), ...linhasNovas]
        return Promise.resolve({ error: null })
      }
      // Mesmo padrão do insert acima — faltava pro caminho do marcador de
      // segmento PF/PJ (01/09/2026), que grava a tag com `.upsert()` assim
      // que a IA confirma no turno. Sem isto, todo teste que exercitasse
      // esse caminho quebrava com "upsert is not a function" (achado
      // montando o teste da trava de piso de valor — 0 chamadas a
      // engineSendText, sem exceção visível).
      chain.upsert = (payload: unknown) => {
        const linhasNovas = Array.isArray(payload) ? payload : [payload]
        h.state.porTabela[table] = [...(h.state.porTabela[table] ?? []), ...linhasNovas]
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
  channel: 'api' as const,
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
  h.enviarPeloSegundoNumero.mockResolvedValue(true)
  h.registrarEnvioSegundoNumero.mockResolvedValue(undefined)
  h.horariosLivres.mockResolvedValue([])
  h.criarReserva.mockResolvedValue({ ok: false, motivo: 'recusado' })
})

afterEach(() => {
  vi.unstubAllEnvs()
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

  // 20/09/2026: o canal de resposta usava `conversations.last_channel`, um
  // campo "grudento" só escrito pelo caminho do segundo número — um lead que
  // volta a escrever pelo número OFICIAL depois de ter usado o segundo
  // número antes ainda lia `last_channel: 'web'` (obsoleto), e a resposta
  // saía pelo canal errado (caso real: titular testando, resposta chegou
  // por outro número). Corrigido: o chamador (webhook oficial vs
  // segundo-número) passa o próprio canal explicitamente — sem depender de
  // nenhuma leitura de banco.
  it('channel "api" always replies via the official Meta channel (engineSendText)', async () => {
    await dispatchInboundToAiReply({ ...ARGS, channel: 'api' })
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
    expect(h.enviarPeloSegundoNumero).not.toHaveBeenCalled()
  })

  it('channel "web" always replies via the segundo número, never engineSendText — regardless of last_channel', async () => {
    // last_channel deliberadamente OMITIDO/errado aqui: a decisão tem que
    // vir só do parâmetro `channel`, nunca do banco.
    h.state.porTabela.contacts = [{ phone: '+5511999999999', name: 'Lead Teste' }]
    await dispatchInboundToAiReply({ ...ARGS, channel: 'web' })
    expect(h.enviarPeloSegundoNumero).toHaveBeenCalledWith('+5511999999999', 'Hello!')
    expect(h.registrarEnvioSegundoNumero).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'Hello!')
    expect(h.engineSendText).not.toHaveBeenCalled()
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

// Trava GENÉRICA de PISO DE VALOR — histórico: criada 01/09/2026 (caso
// Andreia), reforçada em 01/09 (Rogério), 11/09 (rafinhamoreiradebarros) e
// 18/09 (Babi Blumer). Desativada em 21/09 (auditoria do prompt mestre: não
// sabia diferenciar produto, barrava DBC/GPIX com corte errado). RELIGADA em
// 23/09/2026 (caso Claudete: a IA "concluiu" acima do critério com valores
// reais abaixo do piso, sem checagem nenhuma) — agora consultando a tag de
// PRODUTO gravada por automação do CRM (produtoPersistido) antes de cair no
// genérico PF/PJ, pra não repetir o erro de 21/09.
describe('dispatchInboundToAiReply — piso de valor por produto (religada em 23/09/2026)', () => {
  const TAG_PF = '9f870fd7-1155-4ede-9da8-8678360c0ae9'
  const TAG_PJ = 'ea69a90c-407b-411c-953c-2d9920ef6a5e'
  const TAG_PRODUTO_RCPCC = '6b2df561-a2fd-497b-91b9-4eaede9ad917'
  const TAG_PRODUTO_DBC = '8a749c20-e504-46d0-8e56-92c8abc10de0'
  const TAG_PRODUTO_GPIX = 'd2b4ae5e-874d-4553-9fc1-b64fdb6a381d'

  it('sem tag de produto, cai no genérico PF e trava valor abaixo do piso (R$50k)', async () => {
    h.state.porTabela['contact_tags'] = [{ tag_id: TAG_PF }]
    h.generateReply.mockResolvedValue({
      text: 'Entendi, você tem R$9.000 em aberto. Tenho horário amanhã às 14h ou quinta às 15h — qual prefere?',
      handoff: false,
      move: 'qualified',
      agendar: null,
      segmento: null,
      valor: 9000,
      desmarcar: false,
      portaAberta: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: expect.stringContaining('não se enquadra no perfil de atendimento'),
      }),
    )
  })

  it('sem tag de produto, cai no genérico PJ e deixa passar valor acima do piso (R$100k)', async () => {
    h.state.porTabela['contact_tags'] = [{ tag_id: TAG_PJ }]
    const textoIa = 'Perfeito, com esse valor faz sentido conversarmos. Tenho horário amanhã às 14h.'
    h.generateReply.mockResolvedValue({
      text: textoIa,
      handoff: false,
      move: 'qualified',
      agendar: null,
      segmento: null,
      valor: 150000,
      desmarcar: false,
      portaAberta: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: textoIa }),
    )
  })

  it('caso Claudete: tag de produto RCPCC, valor real do texto do cliente (regex, sem marcador) abaixo do piso R$50k trava mesmo a IA achando que está acima', async () => {
    h.state.porTabela['contact_tags'] = [{ tag_id: TAG_PRODUTO_RCPCC }]
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'Vim do site de Direito Bancário e gostaria de mais informações' },
      { role: 'assistant', content: 'Pode me contar um pouco do seu caso?' },
      { role: 'user', content: 'Acredito que mais perto de 20 mil' },
    ])
    h.generateReply.mockResolvedValue({
      text: 'Pelo que você me explicou, os valores somam acima do critério interno de qualificação — posso te encaminhar pra uma reunião.',
      handoff: false,
      move: null,
      agendar: null,
      segmento: null,
      valor: null,
      desmarcar: false,
      portaAberta: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: expect.stringContaining('não se enquadra no perfil de atendimento'),
      }),
    )
  })

  it('tag de produto DBC: R$9.000 fica ACIMA do piso real (R$5k) mesmo estando abaixo do genérico PF (R$50k)', async () => {
    h.state.porTabela['contact_tags'] = [{ tag_id: TAG_PRODUTO_DBC }, { tag_id: TAG_PF }]
    const textoIa = 'Entendi, R$9.000 bloqueado. Isso já dá pra seguir — posso te passar horários.'
    h.generateReply.mockResolvedValue({
      text: textoIa,
      handoff: false,
      move: 'qualified',
      agendar: null,
      segmento: null,
      valor: 9000,
      desmarcar: false,
      portaAberta: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: textoIa }),
    )
  })

  it('tag de produto GPIX: R$3.000 fica ABAIXO do piso real (R$10k) e trava, mesmo a IA tentando seguir', async () => {
    h.state.porTabela['contact_tags'] = [{ tag_id: TAG_PRODUTO_GPIX }]
    h.generateReply.mockResolvedValue({
      text: 'Entendi, R$3.000 de prejuízo no golpe. Posso te passar horários pra conversarmos.',
      handoff: false,
      move: 'qualified',
      agendar: null,
      segmento: null,
      valor: 3000,
      desmarcar: false,
      portaAberta: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: expect.stringContaining('não se enquadra no perfil de atendimento'),
      }),
    )
  })

  it('grava a trava persistente (TAG_ABAIXO_PISO) quando o valor vem abaixo do piso', async () => {
    const TAG_ABAIXO_PISO = '72923bee-2b12-4093-9aa9-cb773aae3928'
    h.generateReply.mockResolvedValue({
      text: 'Entendi, R$9.614,69 em aberto. Quer que eu agende uma reunião?',
      handoff: false,
      move: null,
      agendar: null,
      segmento: null,
      valor: 9614,
      desmarcar: false,
      portaAberta: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    const gravado = (h.state.porTabela['contact_tags'] ?? []).some(
      (l) => (l as { tag_id?: string }).tag_id === TAG_ABAIXO_PISO,
    )
    expect(gravado).toBe(true)
  })
})

// Marcador HORARIO_ESCOLHIDO (20/09/2026, caso Douglas Santos): o lead
// escolheu horário, deu o e-mail num turno seguinte, e a IA não reemitiu
// [[AGENDAR:N]] — só afirmou "agendei". A trava AFIRMA_QUE_AGENDOU pegou a
// mentira, mas só sabia reperguntar o horário sem saber qual já tinha sido
// escolhido. Estes testes provam: 1) o índice é gravado assim que a IA fala
// dele, mesmo sem fechar nada ainda; 2) a trava completa o agendamento de
// verdade com o que já tem, em vez de só reperguntar; 3) se a reserva falhar
// mesmo assim, ainda cai no reperguntar honesto — nunca finge que marcou.
describe('dispatchInboundToAiReply — HORARIO_ESCOLHIDO', () => {
  const SLOT = { iso: '2026-09-25T14:00:00-03:00', rotulo: 'quinta, 25/09 às 14h' }

  beforeEach(() => {
    vi.stubEnv('IA_AGENDA_ATIVA', '1')
    vi.stubEnv('CALCOM_API_KEY', 'chave-teste')
    vi.stubEnv('CALCOM_EVENT_TYPE_ID', 'evento-teste')
    h.horariosLivres.mockResolvedValue([SLOT])
  })

  it('grava o horário no instante em que a IA fala dele, mesmo sem fechar o agendamento ainda', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Show, esse horário funciona! Só preciso do seu e-mail pra deixar reservado.',
      handoff: false,
      move: null,
      agendar: null,
      horarioEscolhido: 1,
      segmento: null,
      valor: null,
      desmarcar: false,
      portaAberta: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({
      horario_escolhido_iso: SLOT.iso,
      horario_escolhido_rotulo: SLOT.rotulo,
    })
    // Sem AGENDAR nenhum, o próprio texto da IA sai normalmente.
    const enviado = h.engineSendText.mock.calls.map((c) => c[0].text).join('\n\n')
    expect(enviado).toBe(
      'Show, esse horário funciona! Só preciso do seu e-mail pra deixar reservado.',
    )
  })

  it('reescolher um horário novo sobrescreve o anterior', async () => {
    const SLOT2 = { iso: '2026-09-26T10:00:00-03:00', rotulo: 'sexta, 26/09 às 10h' }
    h.horariosLivres.mockResolvedValue([SLOT, SLOT2])
    h.generateReply.mockResolvedValue({
      text: 'Combinado, sexta às 10h então!',
      handoff: false,
      move: null,
      agendar: null,
      horarioEscolhido: 2,
      segmento: null,
      valor: null,
      desmarcar: false,
      portaAberta: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({
      horario_escolhido_iso: SLOT2.iso,
      horario_escolhido_rotulo: SLOT2.rotulo,
    })
  })

  it('trava AFIRMA_QUE_AGENDOU completa o agendamento de verdade com o horário já escolhido + e-mail que já tem', async () => {
    h.state.conv = {
      ...h.state.conv,
      horario_escolhido_iso: SLOT.iso,
      horario_escolhido_rotulo: SLOT.rotulo,
    }
    h.state.porTabela.contacts = [
      { name: 'Douglas Santos', phone: '+5511988887777', email: 'douglas@example.com' },
    ]
    // A IA não reemitiu [[AGENDAR:N]] neste turno — só afirmou que agendou.
    h.generateReply.mockResolvedValue({
      text: 'Prontinho, Douglas! Agendei pra você.',
      handoff: false,
      move: null,
      agendar: null,
      horarioEscolhido: null,
      segmento: null,
      valor: null,
      desmarcar: false,
      portaAberta: false,
      usage: null,
    })
    h.criarReserva.mockResolvedValue({ ok: true, uid: 'uid-douglas', inicio: SLOT.iso })

    await dispatchInboundToAiReply(ARGS)

    expect(h.criarReserva).toHaveBeenCalledWith(
      expect.objectContaining({ iso: SLOT.iso, email: 'douglas@example.com', nome: 'Douglas Santos' }),
    )
    const enviado = h.engineSendText.mock.calls.map((c) => c[0].text).join('\n\n')
    expect(enviado).toContain(SLOT.rotulo)
    expect(enviado).not.toBe('Prontinho, Douglas! Agendei pra você.')
    // A trava só serve para UM turno: sucesso ou falha, some depois de usada.
    expect(h.state.updatePayload).toEqual({
      horario_escolhido_iso: null,
      horario_escolhido_rotulo: null,
    })
  })

  it('se a reserva automática falhar mesmo assim, cai no reperguntar honesto — nunca finge que marcou', async () => {
    h.state.conv = {
      ...h.state.conv,
      horario_escolhido_iso: SLOT.iso,
      horario_escolhido_rotulo: SLOT.rotulo,
    }
    h.state.porTabela.contacts = [
      { name: 'Douglas Santos', phone: '+5511988887777', email: 'douglas@example.com' },
    ]
    h.generateReply.mockResolvedValue({
      text: 'Prontinho, Douglas! Agendei pra você.',
      handoff: false,
      move: null,
      agendar: null,
      horarioEscolhido: null,
      segmento: null,
      valor: null,
      desmarcar: false,
      portaAberta: false,
      usage: null,
    })
    // Horário caiu sob o pé entre os dois turnos.
    h.criarReserva.mockResolvedValue({ ok: false, motivo: 'indisponivel' })

    await dispatchInboundToAiReply(ARGS)

    const enviado = h.engineSendText.mock.calls.map((c) => c[0].text).join('\n\n')
    expect(enviado).toBe(
      'Só para eu não errar: me confirma qual horário você prefere que eu já deixo reservado?',
    )
    expect(h.state.updatePayload).toEqual({
      horario_escolhido_iso: null,
      horario_escolhido_rotulo: null,
    })
  })

  it('sem horário persistido de turno anterior, a trava cai direto no reperguntar (comportamento antigo preservado)', async () => {
    h.state.porTabela.contacts = [
      { name: 'Douglas Santos', phone: '+5511988887777', email: 'douglas@example.com' },
    ]
    h.generateReply.mockResolvedValue({
      text: 'Prontinho, agendei pra você!',
      handoff: false,
      move: null,
      agendar: null,
      horarioEscolhido: null,
      segmento: null,
      valor: null,
      desmarcar: false,
      portaAberta: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.criarReserva).not.toHaveBeenCalled()
    const enviado = h.engineSendText.mock.calls.map((c) => c[0].text).join('\n\n')
    expect(enviado).toBe(
      'Só para eu não errar: me confirma qual horário você prefere que eu já deixo reservado?',
    )
  })
})
