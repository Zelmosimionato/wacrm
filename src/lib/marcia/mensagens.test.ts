import { describe, expect, it } from 'vitest'
import { MENSAGENS } from './mensagens'

const CORTES = ['3.000', '5.000', '10.000', '50.000', '100.000', '3 mil', '5 mil', '10 mil', '50 mil', '100 mil']

describe('mensagens fixas', () => {
  it('nenhuma está vazia', () => {
    for (const [k, v] of Object.entries(MENSAGENS)) expect(v.trim().length, k).toBeGreaterThan(10)
  })
  it('nenhuma cita valor de corte nem usa as palavras proibidas', () => {
    for (const [k, v] of Object.entries(MENSAGENS)) {
      for (const c of CORTES) expect(v, `${k} cita ${c}`).not.toContain(c)
      expect(v.toLowerCase(), k).not.toMatch(/\b(piso|corte|valor m[ií]nimo)\b/)
    }
  })
  it('nenhuma tem marcador [[...]] nem fala do lead em terceira pessoa', () => {
    for (const [k, v] of Object.entries(MENSAGENS)) {
      expect(v, k).not.toContain('[[')
      expect(v.toLowerCase(), k).not.toMatch(/\b(o lead|a lead|o cliente)\b/)
    }
  })
})
