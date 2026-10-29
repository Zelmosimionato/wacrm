import { describe, it, expect } from 'vitest'
import { textoParaOLead } from './estruturado'
import { parseGeneration } from '../generate'

describe('textoParaOLead — saída estruturada', () => {
  it('texto comum passa intacto (formato antigo)', () => {
    expect(textoParaOLead('Olá, tudo bem?')).toBe('Olá, tudo bem?')
    expect(textoParaOLead('Oi [[VALOR:9000]]')).toBe('Oi [[VALOR:9000]]')
  })

  it('JSON malformado ou fora do formato passa intacto', () => {
    expect(textoParaOLead('{ "mensagens": [')).toBe('{ "mensagens": [')
    expect(textoParaOLead('{"outra":1}')).toBe('{"outra":1}')
  })

  it('envia só as mensagens e os marcadores; notas internas ficam de fora', () => {
    const raw = JSON.stringify({
      mensagens: ['Entendi, Dayana.', 'Esses são todos os contratos?'],
      marcadores: ['[[VALOR:170000]]'],
      notas_internas: 'Vou seguir a conversa e fechar a qualificação que ainda falta.',
    })
    const t = textoParaOLead(raw)
    expect(t).toBe('Entendi, Dayana.\n\nEsses são todos os contratos?\n[[VALOR:170000]]')
    expect(t).not.toContain('qualificação')
    const g = parseGeneration(t)
    expect(g.text).toBe('Entendi, Dayana.\n\nEsses são todos os contratos?')
    expect(g.valor).toBe(170000)
  })

  it('descarta do campo marcadores qualquer coisa que não seja marcador', () => {
    const raw = JSON.stringify({
      mensagens: ['Qual fica melhor?'],
      marcadores: ['vou responder de forma curta', '[[HORARIO_ESCOLHIDO:2]]', '[[ x ]]'],
    })
    expect(textoParaOLead(raw)).toBe('Qual fica melhor?\n[[HORARIO_ESCOLHIDO:2]]')
  })

  it('aceita JSON dentro de cerca ```json', () => {
    const raw = '```json\n{"mensagens":["Oi!"],"marcadores":[]}\n```'
    expect(textoParaOLead(raw)).toBe('Oi!')
  })

  it('handoff sozinho: só o marcador', () => {
    const raw = JSON.stringify({ mensagens: [], marcadores: ['[[HANDOFF]]'] })
    const g = parseGeneration(textoParaOLead(raw))
    expect(g.handoff).toBe(true)
    expect(g.text).toBe('')
  })

  it('sem mensagens nem marcadores válidos: texto vazio', () => {
    expect(textoParaOLead(JSON.stringify({ mensagens: ['  '], marcadores: ['x'] }))).toBe('')
  })
})
