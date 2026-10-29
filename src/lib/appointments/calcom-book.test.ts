import { describe, it, expect } from 'vitest'
import { telefoneParaCal } from './calcom-book'

describe('telefoneParaCal', () => {
  it('acrescenta o 9º dígito em celular de 8 dígitos (achado em 28/10/2026)', () => {
    expect(telefoneParaCal('551198765432')).toBe('+5511998765432')
    expect(telefoneParaCal('+551198765432')).toBe('+5511998765432')
  })
  it('mantém celular que já tem 9 dígitos', () => {
    expect(telefoneParaCal('5511998765432')).toBe('+5511998765432')
    expect(telefoneParaCal('+5521987654321')).toBe('+5521987654321')
  })
  it('não mexe em telefone fixo (começa com 2–5)', () => {
    expect(telefoneParaCal('551133334444')).toBe('+551133334444')
  })
  it('aceita número com formatação', () => {
    expect(telefoneParaCal('55 (11) 9876-5432')).toBe('+5511998765432')
  })
})
