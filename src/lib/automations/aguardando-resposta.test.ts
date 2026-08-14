import { describe, it, expect } from 'vitest'
import { esperandoDesde, type MsgResumo } from './aguardando-resposta'

const m = (sender_type: string, iso: string): MsgResumo => ({ sender_type, created_at: iso })
const t = (iso: string) => new Date(iso).getTime()

describe('esperandoDesde', () => {
  it('nao espera quando nos respondemos por ultimo', () => {
    expect(esperandoDesde([
      m('customer', '2026-08-13T13:00:00Z'),
      m('agent', '2026-08-13T13:05:00Z'),
    ])).toBeNull()
  })

  it('⭐ espera desde a PRIMEIRA do cliente, nao a ultima', () => {
    // três seguidas: ele aguarda desde 13:00, não desde 13:10.
    expect(esperandoDesde([
      m('agent', '2026-08-13T12:00:00Z'),
      m('customer', '2026-08-13T13:00:00Z'),
      m('customer', '2026-08-13T13:05:00Z'),
      m('customer', '2026-08-13T13:10:00Z'),
    ])).toBe(t('2026-08-13T13:00:00Z'))
  })

  it('⭐ resposta da IA encerra a espera (padrao)', () => {
    // quem foi atendido pela Márcia foi atendido — o sinal existe para não
    // deixar ninguém SEM atendimento, não para exigir humano em tudo.
    expect(esperandoDesde([
      m('customer', '2026-08-13T13:00:00Z'),
      m('bot', '2026-08-13T13:01:00Z'),
    ])).toBeNull()
  })

  it('a IA deixa de encerrar quando a automacao pede isso', () => {
    expect(esperandoDesde([
      m('customer', '2026-08-13T13:00:00Z'),
      m('bot', '2026-08-13T13:01:00Z'),
    ], false)).toBe(t('2026-08-13T13:00:00Z'))
  })

  it('conta desde a primeira do cliente quando nunca respondemos', () => {
    expect(esperandoDesde([
      m('customer', '2026-08-13T13:00:00Z'),
      m('customer', '2026-08-13T13:30:00Z'),
    ])).toBe(t('2026-08-13T13:00:00Z'))
  })

  it('nova pergunta depois da nossa resposta reinicia a espera', () => {
    expect(esperandoDesde([
      m('customer', '2026-08-13T13:00:00Z'),
      m('agent', '2026-08-13T13:05:00Z'),
      m('customer', '2026-08-13T15:00:00Z'),
    ])).toBe(t('2026-08-13T15:00:00Z'))
  })

  it('lida com lista vazia e ordem embaralhada', () => {
    expect(esperandoDesde([])).toBeNull()
    expect(esperandoDesde([
      m('customer', '2026-08-13T13:10:00Z'),
      m('agent', '2026-08-13T12:00:00Z'),
      m('customer', '2026-08-13T13:00:00Z'),
    ])).toBe(t('2026-08-13T13:00:00Z'))
  })
})
