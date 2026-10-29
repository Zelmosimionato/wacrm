import { describe, it, expect } from 'vitest'
import { falhaParaPrompt, herdarMarcadoresDeAgenda, validarSaida } from './sdr-guards'
import { textoFinalDoAssistente } from './providers/openai'

describe('validarSaida — narração de processo interno', () => {
  it('reprova as frases vazadas em 16/10', () => {
    for (const t of [
      'Já tenho o suficiente: vou fechar a qualificação e abrir a agenda.',
      'Vou checar o roteiro do DBC e responder sem repetir o que já sabemos.',
    ]) {
      const r = validarSaida(t)
      expect(r.ok).toBe(false)
      expect(r.gravidade).toBe('grave')
      expect(r.falhas.some((f) => f.codigo === 'narracao')).toBe(true)
    }
  })

  it('reprova narração por categoria (caso Lead N, 19/10)', () => {
    for (const t of [
      'Vou só ajustar o próximo passo da conversa, sem mexer nas regras.',
      'Vou só alinhar o próximo passo.',
      'Estou ajustando a abordagem para o seu caso.',
      'Preciso reorganizar o fluxo antes de responder.',
      'Vou consultar o file_search para responder.',
      'Sem mexer nas minhas regras, posso te ajudar com isso.',
      'Deixa eu revisar minha resposta rapidinho.',
    ]) {
      const r = validarSaida(t)
      expect(r.ok).toBe(false)
      expect(r.falhas.some((f) => f.codigo === 'narracao')).toBe(true)
    }
  })

  it('reprova falar sobre o lead em 3ª pessoa ou instruir um operador (caso Lead N, 19/10)', () => {
    for (const t of [
      'Perfeito — agora é só aguardar a resposta dela.\n\nQuando ela mandar o valor, siga com uma pergunta por vez, sem repetir a saudação.',
      'Aguarde a resposta dele.',
      'A lead já informou o valor do contrato.',
      'Quando o lead responder, siga com uma pergunta por vez.',
      'Sem repetir a apresentação, pergunte o valor.',
    ]) {
      const r = validarSaida(t)
      expect(r.ok).toBe(false)
      expect(r.falhas.some((f) => f.codigo === 'narracao')).toBe(true)
    }
  })

  it('não reprova fala normal ao lead', () => {
    for (const t of [
      'Tenho estes horários: dia 20, terça-feira, às 13:15, 14:00 ou 14:45. Qual fica melhor?',
      'Entendi. Me passa seu e-mail para eu já confirmar?',
      'Pode me contar o que está acontecendo?',
      'O próximo passo é uma conversa com o advogado. Qual horário fica melhor para você?',
      'Vou verificar a agenda e já te passo os horários.',
      'Vou passar o seu caso para o Dr. Zelmo, ele assume daqui.',
      'Vou conferir as regras do contrato com o advogado na reunião.',
      'Vou organizar os horários para você escolher.',
      'Agora é só aguardar a nossa reunião amanhã às 15h. Qualquer dúvida, é só me chamar.',
      'Quando você puder, me manda o valor aproximado, tudo bem?',
      'Nossa equipe vai verificar e retorna para você em breve.',
      'Na reunião o advogado vai explicar o roteiro da conversa, tudo bem?',
    ]) {
      expect(validarSaida(t).ok).toBe(true)
    }
  })

  it('segue reprovando o roteiro interno do produto', () => {
    for (const t of [
      'Seguindo o roteiro do RCPCC, qual é o valor total?',
      'Conforme o roteiro, me diga o valor total.',
      'Consultei o roteiro e já te respondo.',
    ]) {
      const r = validarSaida(t)
      expect(r.ok).toBe(false)
      expect(r.falhas.some((f) => f.codigo === 'narracao')).toBe(true)
    }
  })
})

describe('validarSaida — roteiro do produto e narração do modo de responder (28/10)', () => {
  it('reprova roteiro do bancário/superendividamento e variantes', () => {
    for (const t of [
      'Vou checar o roteiro do bancário e seguir daí.',
      'Vou conferir o roteiro do bancário e seguir a conversa.',
      'Vou ver o roteiro do superendividamento.',
    ]) {
      const r = validarSaida(t)
      expect(r.ok).toBe(false)
      expect(r.falhas.some((f) => f.codigo === 'narracao')).toBe(true)
    }
  })

  it('reprova o agente narrando COMO vai responder', () => {
    for (const t of [
      'Vou responder no fluxo certo e sem adiantar perguntas desnecessárias.',
      'Vou responder com acolhimento e só pedir o que falta.',
      'Vou responder como a Márcia e seguir o fluxo de desbloqueio.',
      'Vou responder de forma curta e acolhedora, sem repetir a triagem.',
      'Entendi. Esse financiamento está no seu nome?Vou responder ao Bruno com uma pergunta objetiva.',
    ]) {
      const r = validarSaida(t)
      expect(r.ok).toBe(false)
      expect(r.falhas.some((f) => f.codigo === 'narracao')).toBe(true)
    }
  })

  it('não reprova "vou responder" dito ao lead sobre o caso dele', () => {
    for (const t of [
      'Vou responder sua dúvida: sim, é possível revisar esse contrato.',
      'Vou te responder assim que o advogado analisar o seu caso.',
      'Vou responder isso na reunião com o advogado, tudo bem?',
      'Como a Márcia, serei responsável pelo seu atendimento. Como posso te chamar?',
    ]) {
      expect(validarSaida(t).ok).toBe(true)
    }
  })
})

describe('regeneração do validador — marcadores de agenda (caso Lead J, 19/10)', () => {
  const base = { text: 'x', agendar: null as number | null, horarioEscolhido: null as number | null }

  it('mantém o horário escolhido da 1ª resposta quando a regeneração o perdeu', () => {
    const r = herdarMarcadoresDeAgenda({ ...base, horarioEscolhido: 3 }, { ...base, text: 'Perfeito, Lead J.' })
    expect(r.horarioEscolhido).toBe(3)
    expect(r.text).toBe('Perfeito, Lead J.')
  })

  it('mantém a reserva (AGENDAR) da 1ª resposta quando a regeneração a perdeu', () => {
    const r = herdarMarcadoresDeAgenda({ ...base, agendar: 2 }, { ...base })
    expect(r.agendar).toBe(2)
  })

  it('o marcador da regeneração prevalece sobre o da 1ª resposta', () => {
    const r = herdarMarcadoresDeAgenda(
      { ...base, agendar: 1, horarioEscolhido: 1 },
      { ...base, agendar: 3, horarioEscolhido: 2 },
    )
    expect(r.agendar).toBe(3)
    expect(r.horarioEscolhido).toBe(2)
  })

  it('sem marcador em nenhuma das duas, continua sem marcador', () => {
    const r = herdarMarcadoresDeAgenda({ ...base }, { ...base })
    expect(r.agendar).toBe(null)
    expect(r.horarioEscolhido).toBe(null)
  })

  it('a instrução de regeneração pede para manter o marcador de agenda', () => {
    const p = falhaParaPrompt({ ok: false, gravidade: 'grave', falhas: [{ codigo: 'narracao', detalhe: 'x' }], avisos: [] })
    expect(p).toContain('[[HORARIO_ESCOLHIDO:N]]')
    expect(p).toContain('[[AGENDAR:N]]')
  })
})

describe('textoFinalDoAssistente', () => {
  const item = (text: string, role = 'assistant') => ({
    role,
    content: [{ type: 'output_text', text }],
  })

  it('usa só o último item com texto (ignora comentário antes da ferramenta)', () => {
    const itens = [item('Vou checar o roteiro do DBC.'), { role: 'tool', content: [] }, item('Qual fica melhor?')]
    expect(textoFinalDoAssistente(itens)).toBe('Qual fica melhor?')
  })

  it('junta as partes de um único item', () => {
    const it1 = { role: 'assistant', content: [{ type: 'output_text', text: 'Olá, ' }, { type: 'output_text', text: 'tudo bem?' }] }
    expect(textoFinalDoAssistente([it1])).toBe('Olá, tudo bem?')
  })

  it('cai para o item anterior se o último vier vazio; vazio se nada', () => {
    expect(textoFinalDoAssistente([item('Oi'), item('   ')])).toBe('Oi')
    expect(textoFinalDoAssistente([item('x', 'user')])).toBe('')
  })
})
