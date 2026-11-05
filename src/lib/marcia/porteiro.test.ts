import { describe, expect, it } from 'vitest'
import { decidir, type Decisao, type Fatos } from './porteiro'

const fatos = (o: Partial<Fatos> = {}): Fatos => ({
  produto: 'RCPCC',
  ehCliente: false,
  cardPerdido: false,
  etapaSensivel: false,
  temReuniao: false,
  horarioJaEscolhido: false,
  emailNoCadastro: null,
  segmentoGravado: null,
  abaixoPisoGravado: false,
  horariosLivres: [1, 2, 3],
  textoDoCliente: 'tenho uma divida de 7010 reais no consignado | 20 mil | dois contratos',
  ...o,
})
const dec = (o: Partial<Decisao> = {}): Decisao => ({
  mensagem: 'ok',
  valorTotal: null,
  valorRelacao: null,
  valorTipo: 'total',
  valorTrecho: 'divida',
  segmento: null,
  intencao: 'conversar',
  horarioN: null,
  email: null,
  ...o,
})

describe('porteiro — portas fechadas', () => {
  it('cliente vai para humano', () => {
    expect(decidir(dec(), fatos({ ehCliente: true })).acao).toEqual({ tipo: 'handoff', motivo: 'cliente', silencioso: false })
  })
  it('card em Perdido vai para humano, em silêncio (04/11)', () => {
    expect(decidir(dec(), fatos({ cardPerdido: true })).acao).toEqual({ tipo: 'handoff', motivo: 'perdido', silencioso: true })
  })
  it('pedido de humano', () => {
    expect(decidir(dec({ intencao: 'pedir_humano' }), fatos()).acao).toMatchObject({ tipo: 'handoff', motivo: 'pedido_do_lead' })
  })
  it('processo judicial passa à equipe, menos no DBC', () => {
    expect(decidir(dec({ intencao: 'processo_judicial' }), fatos()).acao).toMatchObject({ tipo: 'handoff', motivo: 'processo' })
    expect(decidir(dec({ intencao: 'processo_judicial', valorTotal: 8000 }), fatos({ produto: 'DBC' })).acao.tipo).toBe('enviar')
  })
})

describe('porteiro — piso (caso 04/11: consignado 7010, RCPCC)', () => {
  it('7010 em RCPCC recusa e grava abaixo do piso', () => {
    const r = decidir(dec({ valorTotal: 7010 }), fatos())
    expect(r.acao).toEqual({ tipo: 'recusa', motivo: 'piso' })
    expect(r.gravarAbaixoPiso).toBe(true)
  })
  it('valor igual ao piso qualifica e limpa a trava', () => {
    const r = decidir(dec({ valorTotal: 50_000 }), fatos({ abaixoPisoGravado: true }))
    expect(r.acao.tipo).toBe('enviar')
    expect(r.gravarAbaixoPiso).toBe(false)
  })
  it('pisos por produto', () => {
    expect(decidir(dec({ valorTotal: 12_000 }), fatos({ produto: 'GPIX' })).acao.tipo).toBe('enviar')
    expect(decidir(dec({ valorTotal: 12_000 }), fatos({ produto: 'DEF' })).acao.tipo).toBe('recusa')
    expect(decidir(dec({ valorTotal: 99_000 }), fatos({ produto: 'GPASS' })).acao.tipo).toBe('recusa')
  })
  it('sem produto: PF 50 mil, PJ 100 mil', () => {
    expect(decidir(dec({ valorTotal: 70_000 }), fatos({ produto: null })).acao.tipo).toBe('enviar')
    expect(decidir(dec({ valorTotal: 70_000, segmento: 'PJ' }), fatos({ produto: null })).acao.tipo).toBe('recusa')
  })
  it('recusa gravada vale em turno sem valor novo', () => {
    expect(decidir(dec(), fatos({ abaixoPisoGravado: true })).acao).toEqual({ tipo: 'recusa', motivo: 'piso' })
  })
  it('FALHA FECHADA: sem valor lido, oferecer horário vira pergunta do valor', () => {
    expect(decidir(dec({ intencao: 'oferecer_horarios' }), fatos()).acao).toEqual({ tipo: 'perguntar_valor' })
    expect(decidir(dec({ intencao: 'confirmar_agendamento', horarioN: 1, email: 'a@b.com' }), fatos()).acao).toEqual({ tipo: 'perguntar_valor' })
  })
  it('conversa comum sem valor segue normalmente', () => {
    expect(decidir(dec(), fatos()).acao).toMatchObject({ tipo: 'enviar', efeito: 'nenhum' })
  })
  it('piso não vale com reunião marcada, etapa sensível ou horário já escolhido', () => {
    for (const o of [{ temReuniao: true }, { etapaSensivel: true }, { horarioJaEscolhido: true }]) {
      expect(decidir(dec({ valorTotal: 7010 }), fatos(o)).acao.tipo).toBe('enviar')
    }
  })
  it('etapa sensível acolhe e entrega à equipe depois', () => {
    expect(decidir(dec(), fatos({ etapaSensivel: true })).handoffDepois).toBe(true)
  })
})

describe('porteiro — Desbloqueio de Conta (faixas 3 mil / 5 mil)', () => {
  const dbc = (o: Partial<Fatos> = {}) => fatos({ produto: 'DBC', ...o })
  it('abaixo de 3 mil recusa suave', () => {
    expect(decidir(dec({ valorTotal: 2_999 }), dbc()).acao).toEqual({ tipo: 'recusa', motivo: 'dbc_abaixo' })
  })
  it('de 3 mil a 4.999 passa à equipe', () => {
    expect(decidir(dec({ valorTotal: 3_000 }), dbc()).acao).toEqual({ tipo: 'encaminhar_equipe' })
    expect(decidir(dec({ valorTotal: 4_999 }), dbc()).acao).toEqual({ tipo: 'encaminhar_equipe' })
  })
  it('a partir de 5 mil qualifica e pode agendar', () => {
    expect(decidir(dec({ valorTotal: 5_000, intencao: 'oferecer_horarios' }), dbc()).acao).toMatchObject({ tipo: 'enviar', efeito: 'oferecer_horarios' })
  })
  it('valor vago (null) não agenda: pergunta o valor exato', () => {
    expect(decidir(dec({ intencao: 'oferecer_horarios' }), dbc()).acao).toEqual({ tipo: 'perguntar_valor' })
  })
  it('recusa gravada sem valor novo mantém a recusa', () => {
    expect(decidir(dec(), dbc({ abaixoPisoGravado: true })).acao).toEqual({ tipo: 'recusa', motivo: 'dbc_abaixo' })
  })
})

describe('porteiro — agenda', () => {
  const ok = { valorTotal: 80_000 }
  it('horário fora da lista é indisponível', () => {
    expect(decidir(dec({ ...ok, intencao: 'horario_escolhido', horarioN: 9 }), fatos()).acao).toEqual({ tipo: 'horario_indisponivel' })
  })
  it('registra horário válido', () => {
    expect(decidir(dec({ ...ok, intencao: 'horario_escolhido', horarioN: 2 }), fatos()).acao).toMatchObject({ tipo: 'enviar', efeito: 'registrar_horario', horarioN: 2 })
  })
  it('confirmar sem e-mail pede o e-mail', () => {
    expect(decidir(dec({ ...ok, intencao: 'confirmar_agendamento', horarioN: 1 }), fatos()).acao).toEqual({ tipo: 'pedir_email' })
  })
  it('confirmar com e-mail do cadastro agenda; PF/PJ não é exigido', () => {
    const r = decidir(dec({ ...ok, intencao: 'confirmar_agendamento', horarioN: 1 }), fatos({ emailNoCadastro: 'x@y.com' }))
    expect(r.acao).toMatchObject({ tipo: 'enviar', efeito: 'agendar', horarioN: 1, email: 'x@y.com' })
  })
  it('desmarcar, reagendar, recusar e porta aberta', () => {
    const f = fatos({ temReuniao: true })
    expect(decidir(dec({ intencao: 'desmarcar' }), f).acao).toMatchObject({ efeito: 'desmarcar' })
    expect(decidir(dec({ intencao: 'reagendar' }), f).acao).toMatchObject({ efeito: 'reagendar' })
    expect(decidir(dec({ intencao: 'recusou' }), f).acao).toMatchObject({ efeito: 'perdido' })
    expect(decidir(dec({ intencao: 'encerrar_porta_aberta' }), f).acao).toMatchObject({ efeito: 'porta_aberta' })
  })
})

describe('porteiro — valor com relação (acima de / abaixo de) e valor inválido', () => {
  it('valor 0 ou negativo é tratado como não informado (replay 04/11: modelo devolveu 0)', () => {
    expect(decidir(dec({ valorTotal: 0 }), fatos()).acao.tipo).toBe('enviar')
    expect(decidir(dec({ valorTotal: 0, intencao: 'oferecer_horarios' }), fatos()).acao).toEqual({ tipo: 'perguntar_valor' })
  })
  it('"acima de 60 mil" em RCPCC qualifica', () => {
    expect(decidir(dec({ valorTotal: 60_000, valorRelacao: 'acima_de', intencao: 'oferecer_horarios' }), fatos()).acao.tipo).toBe('enviar')
  })
  it('"acima de 10 mil" em RCPCC não decide: pergunta o valor antes de agendar', () => {
    expect(decidir(dec({ valorTotal: 10_000, valorRelacao: 'acima_de', intencao: 'oferecer_horarios' }), fatos()).acao).toEqual({ tipo: 'perguntar_valor' })
    expect(decidir(dec({ valorTotal: 10_000, valorRelacao: 'acima_de' }), fatos()).acao.tipo).toBe('enviar')
  })
  it('"menos de 50 mil" em RCPCC recusa; "menos de 200 mil" não decide', () => {
    expect(decidir(dec({ valorTotal: 50_000, valorRelacao: 'abaixo_de' }), fatos()).acao).toEqual({ tipo: 'recusa', motivo: 'piso' })
    expect(decidir(dec({ valorTotal: 200_000, valorRelacao: 'abaixo_de', intencao: 'oferecer_horarios' }), fatos()).acao).toEqual({ tipo: 'perguntar_valor' })
  })
  it('DBC só aceita valor exato (vago não decide faixa)', () => {
    expect(decidir(dec({ valorTotal: 2_000, valorRelacao: 'abaixo_de' }), fatos({ produto: 'DBC' })).acao.tipo).toBe('enviar')
    expect(decidir(dec({ valorTotal: 2_000, valorRelacao: 'igual' }), fatos({ produto: 'DBC' })).acao).toEqual({ tipo: 'recusa', motivo: 'dbc_abaixo' })
  })
})

describe('porteiro — recusa só com total explícito e trecho conferido (replay 04/11)', () => {
  it('parcela lida como total NÃO recusa: pergunta o total', () => {
    const d = dec({ valorTotal: 1009, valorTipo: 'parcela', valorTrecho: 'tenho uma divida' })
    expect(decidir(d, fatos()).acao).toEqual({ tipo: 'perguntar_valor' })
  })
  it('total sem trecho NÃO recusa', () => {
    expect(decidir(dec({ valorTotal: 7010, valorTipo: 'total', valorTrecho: null }), fatos()).acao).toEqual({ tipo: 'perguntar_valor' })
  })
  it('trecho inventado (não está no texto do cliente) NÃO recusa', () => {
    expect(decidir(dec({ valorTotal: 7010, valorTipo: 'total', valorTrecho: 'devo 7010 de cartao' }), fatos()).acao).toEqual({ tipo: 'perguntar_valor' })
  })
  it('total + trecho real recusa e grava', () => {
    const r = decidir(dec({ valorTotal: 7010, valorTipo: 'total', valorTrecho: '7010 reais' }), fatos())
    expect(r.acao).toEqual({ tipo: 'recusa', motivo: 'piso' })
    expect(r.gravarAbaixoPiso).toBe(true)
  })
  it('trecho com acento/maiúscula é conferido normalizado; vários trechos com |', () => {
    const f = fatos({ textoDoCliente: 'Tenho uma DÍVIDA de 7010' })
    expect(decidir(dec({ valorTotal: 7010, valorTipo: 'total', valorTrecho: 'nada disso | dívida de 7010' }), f).acao.tipo).toBe('recusa')
  })
  it('DBC abaixo e faixa intermediária também exigem confirmação', () => {
    const f = fatos({ produto: 'DBC', textoDoCliente: 'bloquearam 2.000' })
    expect(decidir(dec({ valorTotal: 2000, valorTipo: 'outro', valorTrecho: 'bloquearam 2.000' }), f).acao).toEqual({ tipo: 'perguntar_valor' })
    expect(decidir(dec({ valorTotal: 2000, valorTipo: 'total', valorTrecho: 'bloquearam 2.000' }), f).acao).toEqual({ tipo: 'recusa', motivo: 'dbc_abaixo' })
  })
  it('qualificar (acima do piso) não exige confirmação', () => {
    expect(decidir(dec({ valorTotal: 80_000, valorTipo: 'outro', valorTrecho: null, intencao: 'oferecer_horarios' }), fatos()).acao.tipo).toBe('enviar')
  })
})
