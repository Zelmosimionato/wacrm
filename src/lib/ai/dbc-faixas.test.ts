import { describe, it, expect } from 'vitest'
import {
  DBC_FAIXA_MAX_RESPOSTAS,
  PERGUNTA_NATUREZA_DBC,
  PERGUNTA_PROCESSO_DBC,
  PERGUNTA_VALOR_EXATO_DBC,
  VALOR_ABAIXO_DBC,
  blocoPromptDbc,
  classificaFaixaDbc,
  deveEncaminharFaixaDbc,
  estadoDbcDaConversa,
  proximaPerguntaFaixaDbc,
  textoIncompativelComFaixaDbc,
  valorBloqueadoDeclarado,
} from './dbc-faixas'
import { citacoesDeCorte, validarSaida } from './sdr-guards'

const lead = (content: string) => ({ role: 'user', content })
const ia = (content: string) => ({ role: 'assistant', content })

// Regra do titular (15/10/2026): < 3.000 recusa suave; 3.000 a 5.000 vai ao titular;
// > 5.000 qualifica e agenda; valor vago => pergunta o valor exato antes de classificar.
describe('classificaFaixaDbc — limites', () => {
  it.each([
    [2_999, 'abaixo'],
    [3_000, 'faixa_intermediaria'],
    [4_968, 'faixa_intermediaria'],
    [4_999, 'faixa_intermediaria'],
    [5_000, 'qualificado'],
    [5_001, 'qualificado'],
  ] as const)('R$ %i => %s', (valor, esperado) => {
    expect(classificaFaixaDbc(valor)).toBe(esperado)
  })

  it('valor ausente ou vago nunca é classificado', () => {
    expect(classificaFaixaDbc(null)).toBe('indefinida')
    expect(classificaFaixaDbc(4_000, true)).toBe('indefinida')
  })
})

describe('valorBloqueadoDeclarado — o que o lead escreveu', () => {
  it.each([
    ['o banco bloqueou R$ 2.999 da minha conta', 2_999],
    ['foram bloqueados R$ 3.000,00', 3_000],
    ['bloquearam 3000', 3_000],
    ['bloquearam 4.968', 4_968],
    ['bloqueou 4968 reais', 4_968],
    ['foi bloqueado 5 mil', 5_000],
    ['R$ 5.001 bloqueados', 5_001],
    ['bloquearam 4,5 mil', 4_500],
    ['uns 4 mil bloqueados', 4_000],
    ['cerca de R$ 3.800', 3_800],
  ])('lê "%s" como %i, sem dúvida', (texto, esperado) => {
    expect(valorBloqueadoDeclarado([lead(texto)])).toEqual({ valor: esperado, vago: false })
  })

  it.each([
    'Mais de 3000',
    'mais de 3 mil',
    'acima de R$ 3.000',
    'pelo menos 3000',
    'uns 3 mil e pouco',
    '3000 ou mais',
    'entre 3 e 5 mil',
    'de 3000 a 5000',
    'quase 5 mil',
    'bloquearam 4.968 e mais 2.000 de outra conta',
  ])('"%s" é vago: pergunta o valor exato', (texto) => {
    const r = valorBloqueadoDeclarado([lead(texto)])
    expect(r.vago).toBe(true)
    expect(classificaFaixaDbc(r.valor, r.vago)).toBe('indefinida')
  })

  it('número de salário/parcela sem menção a bloqueio não é o valor bloqueado', () => {
    expect(valorBloqueadoDeclarado([lead('meu salário é 3000')])).toEqual({ valor: null, vago: true })
    expect(valorBloqueadoDeclarado([lead('meu salário é 3000 e bloquearam tudo')])).toEqual({
      valor: 3_000,
      vago: false,
    })
  })

  it('ignora telefone, número de processo, data, hora e parcelas', () => {
    expect(valorBloqueadoDeclarado([lead('meu zap é 5511900000004')]).valor).toBeNull()
    expect(valorBloqueadoDeclarado([lead('processo 1234567-89.2024.8.26.0100')]).valor).toBeNull()
    expect(valorBloqueadoDeclarado([lead('foi dia 10/10/2026 às 14:30')]).valor).toBeNull()
    expect(valorBloqueadoDeclarado([lead('pago 60 x 1.458')]).valor).toBeNull()
    expect(valorBloqueadoDeclarado([lead('isso foi em 2026')]).valor).toBeNull()
  })

  it('vale a mensagem mais recente do lead, nunca o que a IA escreveu', () => {
    expect(
      valorBloqueadoDeclarado([
        lead('bloquearam 2.000'),
        ia('Entendi, R$ 9.000 então?'),
        lead('na verdade foram 4.200'),
      ]),
    ).toEqual({ valor: 4_200, vago: false })
    expect(valorBloqueadoDeclarado([ia('qual valor? R$ 9.000?')]).valor).toBeNull()
  })

  it('uma mensagem posterior sem número não apaga o valor já dito', () => {
    expect(
      valorBloqueadoDeclarado([lead('bloquearam 4.968'), ia('Há processo?'), lead('não tem')]),
    ).toEqual({ valor: 4_968, vago: false })
  })
})

describe('estadoDbcDaConversa — por faixa', () => {
  it.each([
    ['R$ 2.999', 'abaixo'],
    ['R$ 3.000', 'faixa_intermediaria'],
    ['4.968', 'faixa_intermediaria'],
    ['R$ 4.999', 'faixa_intermediaria'],
    ['R$ 5.000', 'qualificado'],
    ['R$ 5.001', 'qualificado'],
    ['Mais de 3000', 'indefinida'],
  ] as const)('"%s" => %s', (texto, faixa) => {
    expect(estadoDbcDaConversa([lead(`bloquearam ${texto}`)]).faixa).toBe(faixa)
  })

  it('caso Lead M (15/10): "Mais de 3000" fica indefinido; o valor exato classifica', () => {
    const conversa = [
      lead('Vim do site de Desbloqueio de Conta e gostaria de mais informações'),
      ia('Qual foi o valor total bloqueado pelo banco?'),
      lead('Mais de 3000'),
    ]
    expect(estadoDbcDaConversa(conversa)).toMatchObject({ faixa: 'indefinida', vago: true })
    const depois = [...conversa, ia('Qual foi o valor exato?'), lead('R$ 3.450')]
    expect(estadoDbcDaConversa(depois)).toMatchObject({ faixa: 'faixa_intermediaria', valor: 3_450 })
  })

  it('conta as respostas do lead depois que a faixa passou a valer', () => {
    const base = [lead('bloquearam 4.000')]
    expect(estadoDbcDaConversa(base).respostasAposFaixa).toBe(0)
    const dois = [...base, ia('Há processo?'), lead('não'), ia('Era salário?'), lead('sim')]
    expect(estadoDbcDaConversa(dois).respostasAposFaixa).toBe(2)
  })

  it('o contador recomeça quando a faixa muda (valor corrigido)', () => {
    const c = [
      lead('bloquearam 2.000'),
      ia('ok'),
      lead('ah, na verdade foram 4.000'),
      ia('Há processo?'),
      lead('não'),
    ]
    expect(estadoDbcDaConversa(c)).toMatchObject({ faixa: 'faixa_intermediaria', respostasAposFaixa: 1 })
  })
})

describe('deveEncaminharFaixaDbc — rede contra loop', () => {
  const faixa = (respostasAposFaixa: number) => ({
    faixa: 'faixa_intermediaria' as const,
    valor: 4_000,
    vago: false,
    respostasAposFaixa,
  })
  it(`só na faixa intermediária e a partir de ${DBC_FAIXA_MAX_RESPOSTAS} respostas`, () => {
    expect(deveEncaminharFaixaDbc(faixa(DBC_FAIXA_MAX_RESPOSTAS - 1))).toBe(false)
    expect(deveEncaminharFaixaDbc(faixa(DBC_FAIXA_MAX_RESPOSTAS))).toBe(true)
    expect(
      deveEncaminharFaixaDbc({ faixa: 'qualificado', valor: 9_000, vago: false, respostasAposFaixa: 9 }),
    ).toBe(false)
  })
})

describe('texto da IA na faixa', () => {
  it.each([
    'Infelizmente o seu caso não se enquadra no perfil de atendimento.',
    'Esses custos podem não compensar, tornando a medida judicial inviável.',
    'Tenho horário amanhã às 14h ou quinta às 15h.',
    'Vamos agendar uma reunião com o Dr. Zelmo?',
  ])('dispensa/agenda é incompatível: %s', (t) => {
    expect(textoIncompativelComFaixaDbc(t)).toBe(true)
  })

  it.each([
    'Já existe algum processo ou ação em andamento sobre esse bloqueio?',
    'O dinheiro bloqueado era salário, poupança ou de outra origem?',
    'Qual foi o valor exato que o banco bloqueou?',
  ])('pergunta de coleta é compatível: %s', (t) => {
    expect(textoIncompativelComFaixaDbc(t)).toBe(false)
  })

  it('a pergunta fixa segue o que a IA já perguntou', () => {
    expect(proximaPerguntaFaixaDbc([lead('bloquearam 4.000')])).toBe(PERGUNTA_PROCESSO_DBC)
    expect(
      proximaPerguntaFaixaDbc([lead('bloquearam 4.000'), ia('Já existe algum processo em andamento?')]),
    ).toBe(PERGUNTA_NATUREZA_DBC)
  })
})

// ⛔ Decisão de 09/10: o corte NUNCA aparece como número na conversa com o lead.
describe('o corte não vaza em texto nenhum', () => {
  const NUMERO_DE_CORTE = /3\.?000|5\.?000|3\s*mil|5\s*mil|tres\s+mil|cinco\s+mil/i

  it('mensagem de recusa suave não cita número, não fala em custo/inviabilidade e passa no validador', () => {
    expect(VALOR_ABAIXO_DBC).not.toMatch(NUMERO_DE_CORTE)
    expect(VALOR_ABAIXO_DBC).not.toMatch(/inviabilidade|inviável|economicamente|corte|piso/i)
    expect(VALOR_ABAIXO_DBC).toMatch(/mais caro/)
    expect(VALOR_ABAIXO_DBC).toMatch(/não compensaria/)
    expect(validarSaida(VALOR_ABAIXO_DBC).ok).toBe(true)
    for (const balao of VALOR_ABAIXO_DBC.split(/\n\s*\n/)) expect(balao.length).toBeLessThanOrEqual(400)
  })

  it('perguntas fixas passam no validador (uma pergunta, sem corte)', () => {
    for (const t of [PERGUNTA_PROCESSO_DBC, PERGUNTA_NATUREZA_DBC, PERGUNTA_VALOR_EXATO_DBC]) {
      expect(t).not.toMatch(NUMERO_DE_CORTE)
      expect(validarSaida(t).ok).toBe(true)
    }
  })

  it('o bloco de instrução de cada faixa não carrega número de corte', () => {
    for (const faixa of ['abaixo', 'faixa_intermediaria', 'qualificado', 'indefinida'] as const) {
      const bloco = blocoPromptDbc({ faixa, valor: 4_000, vago: false, respostasAposFaixa: 0 })
      expect(bloco).not.toMatch(NUMERO_DE_CORTE)
    }
  })

  it('o validador de saída barra 3 mil como valor de corte, nas várias grafias', () => {
    for (const t of ['Você precisa ter acima de 3 mil.', 'a partir de R$ 3.000', 'mínimo de três mil', 'R$3000 é o piso']) {
      expect(citacoesDeCorte(t).some((c) => c.valor === 3_000)).toBe(true)
      expect(validarSaida(t).ok).toBe(false)
    }
    // eco do valor que o próprio lead disse continua permitido
    expect(validarSaida('Entendi, R$ 3.000 bloqueados.', { textoLead: 'bloquearam R$ 3.000' }).ok).toBe(true)
    // 30 mil e 3.500 não são corte
    expect(citacoesDeCorte('R$ 30.000 e R$ 3.500')).toEqual([])
  })
})
