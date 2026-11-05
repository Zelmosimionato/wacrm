import { describe, expect, it } from 'vitest'
import { decidir, type Decisao, type Fatos } from './porteiro'
import { executar, type Portas } from './executor'

const fatos = (o: Partial<Fatos> = {}): Fatos => ({
  produto: 'RCPCC', ehCliente: false, cardPerdido: false, etapaSensivel: false, temReuniao: false,
  horarioJaEscolhido: false, emailNoCadastro: null, segmentoGravado: null, abaixoPisoGravado: false,
  horariosLivres: [1, 2, 3], textoDoCliente: 'devo 7010 reais no consignado', ...o,
})
const dec = (o: Partial<Decisao> = {}): Decisao => ({
  mensagem: 'MENSAGEM-DO-MODELO', valorTotal: null, valorRelacao: null, valorTipo: 'total', valorTrecho: '7010 reais',
  segmento: null, intencao: 'conversar', horarioN: null, email: null, ...o,
})

function portasFalsas(over: Partial<Portas> = {}) {
  const log: string[] = []
  const p: Portas = {
    enviarTexto: async (t) => void log.push(`envia:${t}`),
    enviarPortaAberta: async () => void log.push('portaAberta'),
    passarParaHumano: async (m, ac) => void log.push(`humano:${m}:${ac}`),
    gravarAbaixoPiso: async (v) => void log.push(`piso:${v}`),
    registrarHorario: async (n) => void log.push(`horario:${n}`),
    reservar: async () => ({ ok: true, texto: 'FALHA', reagendar: false }),
    desmarcar: async () => void log.push('desmarcar'),
    moverCard: async (m) => void log.push(`card:${m}`),
    textoFixo: (c) => `FIXO-${c}`,
    perguntarValor: async (dbc) => (dbc ? 'PERGUNTA-DBC' : 'PERGUNTA-TOTAL'),
    saidaValida: () => true,
    ...over,
  }
  return { p, log }
}
const rodar = async (d: Decisao, f: Fatos, over: Partial<Portas> = {}) => {
  const { p, log } = portasFalsas(over)
  const r = await executar(decidir(d, f), d, f, p)
  return { r, log }
}

describe('executor — o que NUNCA pode sair', () => {
  it('recusa por piso envia só o texto fixo, nunca a mensagem do modelo', async () => {
    const { log } = await rodar(dec({ valorTotal: 7010, intencao: 'oferecer_horarios' }), fatos())
    expect(log).toEqual(['piso:true', 'envia:FIXO-recusa_piso'])
    expect(log.join()).not.toContain('MENSAGEM-DO-MODELO')
  })
  it('sem valor lido, a oferta de horário do modelo é descartada e pergunta-se o total', async () => {
    const { log } = await rodar(dec({ valorTotal: null, valorTipo: null, valorTrecho: null, intencao: 'oferecer_horarios' }), fatos())
    expect(log).toEqual(['envia:PERGUNTA-TOTAL'])
  })
  it('DBC sem valor pergunta o valor exato (texto fixo do DBC)', async () => {
    const { log } = await rodar(dec({ valorTotal: null, valorTipo: null, valorTrecho: null, intencao: 'oferecer_horarios' }), fatos({ produto: 'DBC' }))
    expect(log).toEqual(['envia:PERGUNTA-DBC'])
  })
  it('card em Perdido: passa à equipe em silêncio, sem mensagem', async () => {
    const { log } = await rodar(dec(), fatos({ cardPerdido: true }))
    expect(log).toEqual(['humano:perdido:false'])
  })
  it('cliente: passa à equipe com acolhimento', async () => {
    const { log } = await rodar(dec(), fatos({ ehCliente: true }))
    expect(log).toEqual(['humano:cliente:true'])
  })
  it('saída inválida (corte citado etc.) passa à equipe e não envia o texto', async () => {
    const { log } = await rodar(dec({ valorTotal: 80_000 }), fatos(), { saidaValida: () => false })
    expect(log).toEqual(['humano:saida_invalida:true'])
  })
})

describe('executor — fluxo normal', () => {
  const ok = { valorTotal: 80_000, valorTrecho: null, valorTipo: 'outro' as const }
  it('conversa sem efeito: limpa a trava e envia', async () => {
    const { log } = await rodar(dec(ok), fatos())
    expect(log).toEqual(['piso:false', 'envia:MENSAGEM-DO-MODELO'])
  })
  it('horário escolhido: registra antes de enviar', async () => {
    const { log } = await rodar(dec({ ...ok, intencao: 'horario_escolhido', horarioN: 2 }), fatos())
    expect(log).toEqual(['piso:false', 'horario:2', 'envia:MENSAGEM-DO-MODELO'])
  })
  it('agendar com sucesso envia o texto do modelo', async () => {
    const { log } = await rodar(dec({ ...ok, intencao: 'confirmar_agendamento', horarioN: 1, email: 'a@b.com' }), fatos())
    expect(log).toEqual(['piso:false', 'envia:MENSAGEM-DO-MODELO'])
  })
  it('agendar com falha na reserva envia o texto fixo de falha, nunca o do modelo', async () => {
    const { log } = await rodar(
      dec({ ...ok, intencao: 'confirmar_agendamento', horarioN: 1, email: 'a@b.com' }),
      fatos(),
      { reservar: async () => ({ ok: false, texto: 'HORARIO-TOMADO', reagendar: false }) },
    )
    expect(log).toEqual(['piso:false', 'envia:HORARIO-TOMADO'])
  })
  it('agendar sem e-mail pede o e-mail (texto fixo)', async () => {
    const { log } = await rodar(dec({ ...ok, intencao: 'confirmar_agendamento', horarioN: 1 }), fatos())
    expect(log).toEqual(['piso:false', 'envia:FIXO-pedir_email'])
  })
  it('desmarcar, reagendar, recusou (com reunião) e porta aberta', async () => {
    const f = fatos({ temReuniao: true })
    expect((await rodar(dec({ intencao: 'desmarcar' }), f)).log).toEqual(['desmarcar', 'envia:MENSAGEM-DO-MODELO'])
    expect((await rodar(dec({ intencao: 'reagendar' }), f)).log).toEqual(['envia:MENSAGEM-DO-MODELO', 'card:reagendar'])
    expect((await rodar(dec({ intencao: 'recusou' }), f)).log).toEqual(['desmarcar', 'envia:MENSAGEM-DO-MODELO', 'card:perdido'])
    expect((await rodar(dec({ intencao: 'encerrar_porta_aberta' }), f)).log).toEqual(['envia:MENSAGEM-DO-MODELO', 'portaAberta'])
  })
  it('etapa sensível: acolhe e entrega à equipe depois', async () => {
    const { log } = await rodar(dec(), fatos({ etapaSensivel: true }))
    expect(log).toEqual(['envia:MENSAGEM-DO-MODELO', 'humano:etapa_sensivel:false'])
  })
  it('DBC faixa intermediária passa à equipe com acolhimento, sem mensagem do modelo', async () => {
    const { log } = await rodar(dec({ valorTotal: 4000, valorTrecho: '7010 reais' }), fatos({ produto: 'DBC' }))
    expect(log).toEqual(['piso:false', 'humano:dbc_faixa_intermediaria:true'])
  })
})
