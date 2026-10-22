import { describe, it, expect } from 'vitest'
import { horasCitadas, horaDoRotulo, respostaConfirmaHorario } from './horario-confirmado'

const ROTULO = 'dia 26, segunda-feira, às 13:15'

describe('horasCitadas', () => {
  it('normaliza 13:15, 13h15 e 13h', () => {
    expect(horasCitadas('às 13:15')).toEqual(['13:15'])
    expect(horasCitadas('às 13h15')).toEqual(['13:15'])
    expect(horasCitadas('às 14h')).toEqual(['14:00'])
  })
  it('não confunde data com hora', () => {
    expect(horasCitadas('dia 26/10, segunda')).toEqual([])
  })
})

describe('horaDoRotulo', () => {
  it('extrai a hora do rótulo da agenda', () => {
    expect(horaDoRotulo(ROTULO)).toBe('13:15')
    expect(horaDoRotulo(null)).toBeNull()
  })
})

describe('respostaConfirmaHorario', () => {
  it('o caso da Lead H: "sigo com o dia 26 às 13:15" confirma', () => {
    expect(respostaConfirmaHorario('Perfeito, Lead H. Então sigo com o dia 26 às 13:15.', ROTULO)).toBe(true)
  })
  it('aceita 13h15 escrito de outro jeito', () => {
    expect(respostaConfirmaHorario('Combinado, dia 26 às 13h15.', ROTULO)).toBe(true)
  })
  it('lista de opções não confirma', () => {
    expect(
      respostaConfirmaHorario('No dia 26 tenho estes horários: [3] 13:15, [4] 14:00 ou [5] 14:45.', ROTULO),
    ).toBe(false)
  })
  it('pergunta não confirma', () => {
    expect(respostaConfirmaHorario('Fica bom dia 26 às 13:15?', ROTULO)).toBe(false)
  })
  it('horário diferente do escolhido não confirma', () => {
    expect(respostaConfirmaHorario('Perfeito, sigo com o dia 26 às 14:00.', ROTULO)).toBe(false)
  })
  it('sem horário escolhido não confirma', () => {
    expect(respostaConfirmaHorario('Perfeito, sigo com o dia 26 às 13:15.', null)).toBe(false)
  })
  it('texto sem hora nenhuma não confirma', () => {
    expect(respostaConfirmaHorario('Perfeito, Lead H. Me passa seu e-mail.', ROTULO)).toBe(false)
  })
})
