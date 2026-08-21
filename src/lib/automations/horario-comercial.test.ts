import { describe, it, expect } from 'vitest'
import {
  minutosUteis,
  passaramHorasUteis,
  dentroDoExpediente,
  proximoInstanteDeExpediente,
  fimDoExpedienteAPartir,
} from './horario-comercial'

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

describe('proximoInstanteDeExpediente', () => {
  it('já dentro do expediente: devolve o próprio instante', () => {
    expect(proximoInstanteDeExpediente(QUI_10H)).toBe(QUI_10H)
  })

  it('⭐ 20/08/2026: antes da abertura cai nas 9h do mesmo dia (era o caso do Clóvis, 3h20)', () => {
    // QUI_07H = quinta 07:00 BRT
    expect(proximoInstanteDeExpediente(QUI_07H)).toBe(brt('2026-08-13T12:00:00Z')) // 09:00 BRT
  })

  it('no intervalo do almoço, cai na reabertura das 13h do mesmo dia', () => {
    const almoco = brt('2026-08-13T15:30:00Z') // 12:30 BRT
    expect(proximoInstanteDeExpediente(almoco)).toBe(brt('2026-08-13T16:00:00Z')) // 13:00 BRT
  })

  it('depois do fechamento, cai nas 9h do próximo dia útil', () => {
    // QUI_20H = quinta 20:00 BRT → sexta 09:00 BRT
    expect(proximoInstanteDeExpediente(QUI_20H)).toBe(brt('2026-08-14T12:00:00Z'))
  })

  it('⛔ pula o fim de semana inteiro (sábado cai na segunda 9h)', () => {
    const sabado = brt('2026-08-15T13:00:00Z') // sábado, 10:00 BRT
    expect(proximoInstanteDeExpediente(sabado)).toBe(brt('2026-08-17T12:00:00Z')) // segunda 09:00 BRT
  })
})

describe("fimDoExpedienteAPartir", () => {
  it("dentro do expediente da tarde, devolve o fim do próprio bloco (17h BRT)", () => {
    const t = Date.parse("2026-08-11T17:00:00.000Z"); // terça 11/08, 14h BRT
    expect(new Date(fimDoExpedienteAPartir(t)).toISOString()).toBe("2026-08-11T20:00:00.000Z");
  });

  it("antes do expediente começar (mesmo dia útil), devolve o fim do EXPEDIENTE DO DIA (17h), não do 1º bloco", () => {
    const t = Date.parse("2026-08-11T10:00:00.000Z"); // terça 11/08, 07h BRT
    expect(new Date(fimDoExpedienteAPartir(t)).toISOString()).toBe("2026-08-11T20:00:00.000Z");
  });

  it("durante o almoço (mesmo dia útil), também devolve o fim do expediente do dia (17h)", () => {
    const t = Date.parse("2026-08-11T15:30:00.000Z"); // terça 11/08, 12h30 BRT (almoço)
    expect(new Date(fimDoExpedienteAPartir(t)).toISOString()).toBe("2026-08-11T20:00:00.000Z");
  });

  it("depois do expediente encerrar, devolve o fim do expediente do PRÓXIMO dia útil", () => {
    const t = Date.parse("2026-08-11T22:00:00.000Z"); // terça 11/08, 19h BRT
    expect(new Date(fimDoExpedienteAPartir(t)).toISOString()).toBe("2026-08-12T20:00:00.000Z");
  });

  it("num fim de semana (sábado), devolve o fim do expediente da segunda-feira seguinte", () => {
    const t = Date.parse("2026-08-15T15:00:00.000Z"); // sábado 15/08, meio-dia
    expect(new Date(fimDoExpedienteAPartir(t)).toISOString()).toBe("2026-08-17T20:00:00.000Z"); // segunda 17/08, 17h BRT
  });
});
