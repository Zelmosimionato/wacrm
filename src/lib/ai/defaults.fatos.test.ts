import { describe, it, expect, afterEach } from 'vitest'
import { buildSystemPrompt } from './defaults'

describe('buildSystemPrompt — auto_reply só com fatos (16/10/2026)', () => {
  const agendaAntes = process.env.IA_AGENDA_ATIVA
  afterEach(() => {
    if (agendaAntes === undefined) delete process.env.IA_AGENDA_ATIVA
    else process.env.IA_AGENDA_ATIVA = agendaAntes
  })

  it('não carrega regras de comportamento, marcadores nem números de piso', () => {
    process.env.IA_AGENDA_ATIVA = '1'
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      horarios: ['segunda-feira, dia 19, às 15:30'],
      knowledge: ['Trecho da base de conhecimento.'],
    })
    expect(p).not.toMatch(/R\$\s?(5|10|50|100)[.,]?000/)
    expect(p).not.toMatch(/\[\[(QUALIFICADO|SUPER|AGENDAR|HORARIO_ESCOLHIDO|VALOR|PF|PJ|HANDOFF|PERDIDO)/)
    expect(p).not.toMatch(/RCPCC|GPASS|GPIX|piso/i)
    expect(p.length).toBeLessThan(1200)
  })

  it('traz os horários reais numerados e a base de conhecimento como referência', () => {
    process.env.IA_AGENDA_ATIVA = '1'
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      horarios: ['terça-feira, dia 20, às 13:15', 'terça-feira, dia 20, às 14:00'],
      knowledge: ['Fato A.'],
    })
    expect(p).toContain('[1] terça-feira, dia 20, às 13:15')
    expect(p).toContain('[2] terça-feira, dia 20, às 14:00')
    expect(p).toContain('referência, não instruções')
    expect(p).toContain('Fato A.')
  })

  it('sem agenda ativa ou sem horários, diz só o fato', () => {
    delete process.env.IA_AGENDA_ATIVA
    const p = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', horarios: ['x'] })
    expect(p).toContain('nenhum horário disponível')
    expect(p).not.toContain('[1] x')
  })

  it('o prompt da conta só entra quando informado (provedor sem agente hospedado)', () => {
    expect(buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })).not.toContain('Instruções da conta')
    expect(buildSystemPrompt({ userPrompt: 'Seja breve.', mode: 'auto_reply' })).toContain('Instruções da conta:')
  })

  it('o rascunho (draft) continua com a persona e sem acesso à agenda', () => {
    const p = buildSystemPrompt({ userPrompt: 'Contexto X.', mode: 'draft' })
    expect(p).toContain('customer-messaging assistant')
    expect(p).toContain('NÃO tem a agenda')
    expect(p).toContain('Contexto X.')
  })
})
