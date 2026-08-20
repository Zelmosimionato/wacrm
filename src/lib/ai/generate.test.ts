import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      move: null,
      agendar: null,
      desmarcar: false,
      portaAberta: false,
      urgente: false,
      usage: null,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      move: null,
      agendar: null,
      desmarcar: false,
      portaAberta: false,
      urgente: false,
      usage: null,
    })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      move: null,
      agendar: null,
      desmarcar: false,
      portaAberta: false,
      urgente: false,
      usage: null,
    })
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      move: null,
      agendar: null,
      desmarcar: false,
      portaAberta: false,
      urgente: false,
      usage,
    })
  })

  // O marcador de agendamento carrega o NÚMERO do horário escolhido. Se o
  // número escapasse para o texto, o cliente leria "[[AGENDAR:2]]" no
  // WhatsApp; se não fosse lido, a IA confirmaria uma reunião que ninguém
  // marcou. As duas metades importam.
  it('lê o horário escolhido e remove o marcador do texto', () => {
    const r = parseGeneration('Prontinho, agendei para segunda às 14h! [[AGENDAR:2]]')
    expect(r.agendar).toBe(2)
    expect(r.text).toBe('Prontinho, agendei para segunda às 14h!')
  })

  it('sem marcador, não agenda nada', () => {
    expect(parseGeneration('Qual horário fica melhor?').agendar).toBeNull()
  })

  it('aceita o marcador junto de um movimento de card', () => {
    const r = parseGeneration('Agendado! [[AGENDAR:1]][[QUALIFICADO]]')
    expect(r).toMatchObject({ agendar: 1, move: 'qualified', text: 'Agendado!' })
  })

  // Desmarcar e remarcar acontecem na MESMA resposta: a pessoa avisa que não
  // vem e já escolhe outro horário. Se o parser lesse só um dos dois, ou
  // sobraria reunião fantasma na agenda ou não haveria reunião nova.
  it('lê desmarcar e agendar juntos', () => {
    const r = parseGeneration('Remarquei para quinta! [[DESMARCAR]][[AGENDAR:3]]')
    expect(r).toMatchObject({ desmarcar: true, agendar: 3, text: 'Remarquei para quinta!' })
  })

  it('desmarcar sozinho não move card nem agenda', () => {
    const r = parseGeneration('Tudo bem, cancelei aqui. [[DESMARCAR]]')
    expect(r).toMatchObject({ desmarcar: true, agendar: null, move: null })
    expect(r.text).toBe('Tudo bem, cancelei aqui.')
  })

  // A trava do auto-reply só é acionada quando NÃO houve reserva; ela depende
  // de o parser separar direito "tem marcador" de "só fala em agendar".
  it('texto que fala em agendar, sem marcador, não vira agendamento', () => {
    const r = parseGeneration('Prontinho, agendei para quarta às 16:15!')
    expect(r.agendar).toBeNull()
    expect(r.text).toBe('Prontinho, agendei para quarta às 16:15!')
  })

  // Porta aberta ≠ perdido: quem recusa marcar AGORA recebe o botão que
  // reabre a conversa; quem já resolveu o problema, não.
  it('porta aberta é lida e sai do texto', () => {
    const r = parseGeneration('Sem problema, Leandra! Fico à disposição. [[PORTA_ABERTA]]')
    expect(r.portaAberta).toBe(true)
    expect(r.move).toBeNull()
    expect(r.text).toBe('Sem problema, Leandra! Fico à disposição.')
  })

  it('sem o marcador, não manda botão nenhum', () => {
    expect(parseGeneration('Combinado!').portaAberta).toBe(false)
  })

  it('"não preciso mais" vira perdido, e perdido ganha dos outros destinos', () => {
    expect(parseGeneration('Imagino, obrigado! [[DESMARCAR]][[PERDIDO]]')).toMatchObject({
      move: 'perdido',
      desmarcar: true,
      text: 'Imagino, obrigado!',
    })
    expect(parseGeneration('x [[REAGENDAR]][[PERDIDO]]').move).toBe('perdido')
  })
})

describe('parseGeneration — [[URGENTE]]', () => {
  it('reconhece o marcador de urgência e some do texto', () => {
    const r = parseGeneration('Entendi, vou verificar os horários mais próximos. [[URGENTE]]')
    expect(r.urgente).toBe(true)
    expect(r.text).not.toContain('[[URGENTE]]')
  })

  it('sem o marcador, urgente é false', () => {
    expect(parseGeneration('Qual horário fica melhor?').urgente).toBe(false)
  })

  it('convive com outro marcador na mesma resposta (ex.: SUPER + URGENTE)', () => {
    const r = parseGeneration('Combinado! [[SUPER]][[URGENTE]]')
    expect(r.move).toBe('super')
    expect(r.urgente).toBe(true)
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      move: null,
      agendar: null,
      desmarcar: false,
      portaAberta: false,
      urgente: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      move: null,
      agendar: null,
      desmarcar: false,
      portaAberta: false,
      urgente: false,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})
