import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  envioBloqueado,
  abortarSeBloqueado,
  ContatoBloqueadoError,
  ContatoNaoResolvidoError,
} from './blocklist'

// ⛔ Dados fictícios de propósito. Quem está bloqueado de verdade é
// configuração (`.env.local`, fora do git), nunca código.
const BLOQUEADO_A = '11111111-1111-1111-1111-111111111111'
const BLOQUEADO_B = '22222222-2222-2222-2222-222222222222'
const LIVRE = '99999999-9999-9999-9999-999999999999'
const TEL_DE_BLOQUEADO = '+5511900000001' // sufixo 00000001
const TEL_LIVRE = '+5511977777777'

let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubEnv('WHATSAPP_BLOCKLIST_CONTACT_IDS', `${BLOQUEADO_A},${BLOQUEADO_B}`)
  vi.stubEnv('WHATSAPP_BLOCKLIST_ALARM_PHONES', TEL_DE_BLOQUEADO)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('a identidade é o contact_id', () => {
  it('bloqueia pelo id, qualquer que seja o telefone do envio', () => {
    // Mesmo contato, telefones diferentes, inclusive nenhum: o id decide.
    for (const tel of [TEL_DE_BLOQUEADO, TEL_LIVRE, '900000001', undefined]) {
      expect(() => abortarSeBloqueado(BLOQUEADO_A, 'teste', tel)).toThrow(ContatoBloqueadoError)
    }
  })

  it('não bloqueia contato ausente da lista', () => {
    expect(() => abortarSeBloqueado(LIVRE, 'teste', TEL_LIVRE)).not.toThrow()
  })

  it('o erro carrega motivo e id, para o log dizer qual contato', () => {
    try {
      abortarSeBloqueado(BLOQUEADO_B, 'teste')
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect(e).toBeInstanceOf(ContatoBloqueadoError)
      expect((e as ContatoBloqueadoError).motivo).toBe('blocked_by_contact_id')
      expect((e as ContatoBloqueadoError).contactId).toBe(BLOQUEADO_B)
    }
  })

  it('⛔ o log não vaza nome nem telefone — só o id', () => {
    expect(() => abortarSeBloqueado(BLOQUEADO_A, 'teste', TEL_DE_BLOQUEADO)).toThrow()
    const linha = warn.mock.calls.flat().join(' ')
    expect(linha).toContain(BLOQUEADO_A)
    expect(linha).not.toContain(TEL_DE_BLOQUEADO)
  })
})

describe('telefone não decide', () => {
  it('⭐ telefone de bloqueado + id NÃO bloqueado = envio SEGUE (só alarme)', () => {
    // O caso do cadastro duplicado. Antes o sufixo mandava e este envio morria.
    // Agora o id manda: passa, e grita no log para alguém deduplicar.
    expect(() => abortarSeBloqueado(LIVRE, 'teste', TEL_DE_BLOQUEADO)).not.toThrow()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('divergencia_id_x_telefone'))
  })

  it('não bloqueia por semelhança de sufixo com outro DDD', () => {
    // Mesmos 8 finais, DDD diferente: outra pessoa. A regra antiga (últimos 8
    // dígitos) barrava este envio; a nova nem olha para decidir.
    expect(() => abortarSeBloqueado(LIVRE, 'teste', '+5547900000001')).not.toThrow()
  })

  it('telefone sozinho nunca bloqueia', () => {
    // Aborta — mas por falta de id, não por causa do telefone. O motivo prova
    // qual regra atuou.
    try {
      abortarSeBloqueado(null, 'teste', TEL_DE_BLOQUEADO)
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect(e).toBeInstanceOf(ContatoNaoResolvidoError)
      expect((e as ContatoNaoResolvidoError).motivo).toBe('unresolved_contact_abortado')
    }
  })
})

describe('envio sem saber para quem', () => {
  it('aborta quando falta contact_id', () => {
    for (const vazio of [null, undefined, '']) {
      expect(() => abortarSeBloqueado(vazio, 'teste')).toThrow(ContatoNaoResolvidoError)
    }
  })

  it('⛔ falha FECHADA: aborta em vez de liberar', () => {
    // Decisão explícita. Os custos não são simétricos: uma mensagem legítima a
    // menos custa um alerta; uma a mais vai para quem pediu silêncio.
    expect(() => abortarSeBloqueado(undefined, 'nutricao', TEL_LIVRE)).toThrow()
  })
})

describe('a lista é configuração, não código', () => {
  it('lê os ids do ambiente', () => {
    expect(envioBloqueado(BLOQUEADO_A)).toBe(true)
    expect(envioBloqueado(LIVRE)).toBe(false)
  })

  it('variável AUSENTE grita no log — esquecer não pode passar calado', () => {
    vi.stubEnv('WHATSAPP_BLOCKLIST_CONTACT_IDS', undefined as unknown as string)
    expect(envioBloqueado(BLOQUEADO_A)).toBe(false)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('WHATSAPP_BLOCKLIST_CONTACT_IDS não está definida'),
    )
  })

  it('variável VAZIA é decisão deliberada — não grita', () => {
    vi.stubEnv('WHATSAPP_BLOCKLIST_CONTACT_IDS', '')
    expect(envioBloqueado(BLOQUEADO_A)).toBe(false)
    expect(error).not.toHaveBeenCalled()
  })

  it('não aceita telefone no lugar do id', () => {
    // Impede que alguém "conserte" a função voltando a passar telefone.
    expect(envioBloqueado(TEL_DE_BLOQUEADO)).toBe(false)
    expect(envioBloqueado(null)).toBe(false)
    expect(envioBloqueado(undefined)).toBe(false)
  })
})
