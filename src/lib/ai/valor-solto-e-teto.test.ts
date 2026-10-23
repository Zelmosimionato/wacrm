import { describe, expect, it } from 'vitest'
import { ehSoAgradecimento, valorDeclaradoPeloCliente } from './auto-reply'

const u = (content: string) => [{ role: 'user' as const, content }]

describe('valor solto sem R$ (caso do consignado de 7 contratos)', () => {
  it('le "31860,51" com contexto de contrato', () => {
    expect(valorDeclaradoPeloCliente(u('O valor dos 7 contratos 31860,51'))).toBe(31861)
  })
  it('le valor solto de 5 digitos com contexto de divida', () => {
    expect(valorDeclaradoPeloCliente(u('minha dívida total é 45000'))).toBe(45000)
  })
  it('nao le ano, telefone nem numero de contrato como valor', () => {
    expect(valorDeclaradoPeloCliente(u('fiz o contrato em 2026'))).toBeNull()
    expect(valorDeclaradoPeloCliente(u('meu contrato, whatsapp 5511999998888'))).toBeNull()
    expect(valorDeclaradoPeloCliente(u('contrato nº 1234567 do banco'))).toBeNull()
  })
  it('continua ignorando parcela', () => {
    expect(valorDeclaradoPeloCliente(u('a parcela do contrato é 1234,56'))).toBeNull()
  })
  it('continua lendo R$ e mil como antes', () => {
    expect(valorDeclaradoPeloCliente(u('minha dívida é de R$ 450,00'))).toBe(450)
    expect(valorDeclaradoPeloCliente(u('devo uns 25 mil'))).toBe(25000)
  })
})

describe('ehSoAgradecimento (teto de respostas com reuniao marcada)', () => {
  it.each(['Ok', 'ok!', 'Obrigado', 'Muito obrigada 🙏', 'valeu', 'Fico agradecido', '👍', 'Certo, combinado'])(
    'aceita %s',
    (t) => expect(ehSoAgradecimento(t)).toBe(true),
  )
  it.each(['Posso mudar o horário?', 'ok mas e se eu não puder ir', 'Qual o valor dos honorários', ''])(
    'recusa %s',
    (t) => expect(ehSoAgradecimento(t)).toBe(false),
  )
})
