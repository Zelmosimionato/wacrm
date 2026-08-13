import { describe, it, expect } from 'vitest'
import { minutosUteis, passaramHorasUteis, dentroDoExpediente } from './horario-comercial'

/** BRT = UTC−3. 13/08/2026 é quinta; 14 sexta; 15 sábado; 17 segunda. */
const brt = (iso: string) => new Date(iso).getTime()
const QUI_10H = brt('2026-08-13T13:00:00Z') // 10:00 BRT
const QUI_11H = brt('2026-08-13T14:00:00Z')
const QUI_1130 = brt('2026-08-13T14:30:00Z')
const QUI_1330 = brt('2026-08-13T16:30:00Z')
const QUI_07H = brt('2026-08-13T10:00:00Z')
const QUI_1630 = brt('2026-08-13T19:30:00Z')
const QUI_20H = brt('2026-08-13T23:00:00Z')
const QUI_1650 = brt('2026-08-13T19:50:00Z')
const SEX_16H = brt('2026-08-14T19:00:00Z')
const SEG_0930 = brt('2026-08-17T12:30:00Z')
const SEX_1049 = brt('2026-08-14T13:49:00Z')
const SEX_1050 = brt('2026-08-14T13:50:00Z')

describe('minutosUteis', () => {
  it('conta uma hora cheia dentro do expediente', () => {
    expect(minutosUteis(QUI_10H, QUI_11H)).toBe(60)
  })

  it('⛔ nao conta o intervalo do almoco', () => {
    // 11:30→13:30 são 2h de relógio, mas só 1h útil (30min antes + 30 depois).
    expect(minutosUteis(QUI_1130, QUI_1330)).toBe(60)
  })

  it('ignora o que vem antes da abertura', () => {
    expect(minutosUteis(QUI_07H, QUI_10H)).toBe(60)
  })

  it('ignora o que vem depois do fechamento', () => {
    expect(minutosUteis(QUI_1630, QUI_20H)).toBe(30)
  })

  it('⛔ pula o fim de semana inteiro', () => {
    // sexta 16h→17h = 60, sábado e domingo = 0, segunda 9h→9h30 = 30.
    expect(minutosUteis(SEX_16H, SEG_0930)).toBe(90)
  })

  it('devolve 0 quando o fim nao e depois do inicio', () => {
    expect(minutosUteis(QUI_11H, QUI_10H)).toBe(0)
    expect(minutosUteis(QUI_10H, QUI_10H)).toBe(0)
  })
})

describe('passaramHorasUteis', () => {
  it('⭐ 2h uteis a partir de quinta 16h50 caem na sexta 10h50, nao na quinta 18h50', () => {
    // é a razão de existir deste módulo: o aviso não pode cair com o
    // escritório fechado, senão vira ruído e a pessoa para de ler.
    expect(passaramHorasUteis(QUI_1650, 2, SEX_1049)).toBe(false)
    expect(passaramHorasUteis(QUI_1650, 2, SEX_1050)).toBe(true)
  })

  it('com 0 horas dispara na hora', () => {
    expect(passaramHorasUteis(QUI_1650, 0, QUI_1650)).toBe(true)
  })
})

describe('dentroDoExpediente', () => {
  it('reconhece dentro, almoco e fim de semana', () => {
    expect(dentroDoExpediente(QUI_10H)).toBe(true)
    expect(dentroDoExpediente(brt('2026-08-13T15:30:00Z'))).toBe(false) // 12:30 BRT
    expect(dentroDoExpediente(brt('2026-08-15T13:00:00Z'))).toBe(false) // sábado
  })
})
