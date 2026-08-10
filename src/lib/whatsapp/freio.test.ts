import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Contagens que o banco devolve, por chamada, na ordem em que o freio pergunta:
// (1) mesmo template na última hora, (2) mesmo template no dia,
// (3) qualquer template na última hora.
const h = vi.hoisted(() => ({
  respostas: [] as ({ count: number } | { erro: string })[],
  chamadas: [] as { template?: string }[],
}))

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const registro: { template?: string } = {}
      const chain: Record<string, unknown> = {}
      for (const passo of ['select', 'gte', 'not']) chain[passo] = () => chain
      chain.eq = (campo: string, valor: string) => {
        if (campo === 'template_name') registro.template = valor
        return chain
      }
      chain.then = (ok: (v: unknown) => unknown) => {
        h.chamadas.push(registro)
        const r = h.respostas.shift() ?? { count: 0 }
        return Promise.resolve(
          'erro' in r
            ? { count: null, error: { message: r.erro } }
            : { count: r.count, error: null },
        ).then(ok)
      }
      return chain
    },
  }),
}))

import { conferirFreio, FreioError } from './freio'

const CONTATO = '11111111-1111-1111-1111-111111111111'

beforeEach(() => {
  h.respostas = []
  h.chamadas = []
  vi.stubEnv('FREIO_MESMO_TEMPLATE_HORA', '1')
  vi.stubEnv('FREIO_MESMO_TEMPLATE_DIA', '2')
  vi.stubEnv('FREIO_CONTATO_HORA', '3')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('o freio conta o que saiu, nao o que devia sair', () => {
  it('deixa passar o primeiro envio do template', async () => {
    h.respostas = [{ count: 0 }, { count: 0 }, { count: 0 }]
    await expect(conferirFreio(CONTATO, 'lembrete_vespera_confirma', 'teste')).resolves
      .toBeUndefined()
  })

  it('⭐ barra o SEGUNDO envio do mesmo template na mesma hora', async () => {
    // O incidente de 09/08: 225 mensagens iguais para a mesma pessoa. Com este
    // teto, a segunda ja nao sai — independente do que a logica de lembrete
    // tenha concluido.
    h.respostas = [{ count: 1 }]
    await expect(conferirFreio(CONTATO, 'lembrete_vespera_confirma', 'teste')).rejects.toThrow(
      FreioError,
    )
  })

  it('barra ao estourar o teto do dia, mesmo espacado', async () => {
    h.respostas = [{ count: 0 }, { count: 2 }]
    await expect(conferirFreio(CONTATO, 'confirmacao_agendamento', 'teste')).rejects.toThrow(
      /últimas 24h/,
    )
  })

  it('templates DIFERENTES nao se somam no teto do template', async () => {
    // Confirmacao + vespera + 1h no mesmo dia sao tres ocasioes distintas.
    h.respostas = [{ count: 0 }, { count: 0 }, { count: 2 }]
    await expect(conferirFreio(CONTATO, 'lembrete_1h_antes', 'teste')).resolves.toBeUndefined()
  })

  it('mas a segunda rede pega a fuga que cicla ENTRE templates', async () => {
    h.respostas = [{ count: 0 }, { count: 0 }, { count: 3 }]
    await expect(conferirFreio(CONTATO, 'qualquer', 'teste')).rejects.toThrow(/templates para o contato/)
  })
})

describe('falha fechada', () => {
  it('⛔ nao conseguiu contar = nao manda', async () => {
    // "Seguir sem conseguir verificar" e a forma exata do erro de 09/08.
    h.respostas = [{ erro: 'conexao caiu' }]
    await expect(conferirFreio(CONTATO, 'x', 'teste')).rejects.toThrow(/não consegui contar/)
  })
})

describe('os limites sao configuracao', () => {
  it('respeita o teto vindo do ambiente', async () => {
    vi.stubEnv('FREIO_MESMO_TEMPLATE_HORA', '5')
    h.respostas = [{ count: 4 }, { count: 0 }, { count: 0 }]
    await expect(conferirFreio(CONTATO, 'x', 'teste')).resolves.toBeUndefined()
  })

  it('pergunta pelo template nas duas primeiras, e por qualquer um na terceira', async () => {
    h.respostas = [{ count: 0 }, { count: 0 }, { count: 0 }]
    await conferirFreio(CONTATO, 'meu_template', 'teste')
    expect(h.chamadas.map((c) => c.template)).toEqual([
      'meu_template',
      'meu_template',
      undefined,
    ])
  })
})
