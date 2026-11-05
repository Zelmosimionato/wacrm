// Márcia v2 — PORTEIRO: só conta e regra exata sobre a decisão estruturada do modelo.
// Nenhuma leitura de texto do cliente aqui: o valor chega como número (ou null) pronto.
// Nenhum texto ao lead aqui: recusa/encaminhamento são tipos de ação; o texto vem da plataforma.

export type Produto = 'RCPCC' | 'DBC' | 'GPIX' | 'GPASS' | 'DEF'

/** Cortes duros (mesmos números do código atual; ver PISO_POR_PRODUTO em auto-reply.ts). */
export const PISOS: Record<Exclude<Produto, 'DBC'>, number> = {
  RCPCC: 50_000,
  GPIX: 10_000,
  GPASS: 100_000,
  DEF: 50_000,
}
/** Sem tag de produto: genérico por segmento, PF como padrão de segurança. */
export const PISO_SEM_PRODUTO = { PF: 50_000, PJ: 100_000 } as const
export const DBC_RECUSA_ABAIXO = 3_000
export const DBC_QUALIFICA_A_PARTIR = 5_000

export type Intencao =
  | 'conversar'
  | 'oferecer_horarios'
  | 'horario_escolhido'
  | 'confirmar_agendamento'
  | 'desmarcar'
  | 'reagendar'
  | 'recusou'
  | 'pedir_humano'
  | 'processo_judicial'
  | 'encerrar_porta_aberta'

/** O que o modelo devolve a cada mensagem (saída estruturada). */
export interface Decisao {
  mensagem: string
  /** Valor total informado pelo cliente, em reais inteiros; null se ainda não disse. */
  valorTotal: number | null
  /** Como ler valorTotal: igual (valor ou aproximado), acima_de (piso do valor), abaixo_de (teto do valor). */
  valorRelacao: 'igual' | 'acima_de' | 'abaixo_de' | null
  /** O que o número é: total da dívida/contrato/bloqueio, parcela ou outra coisa. Só 'total' pode recusar. */
  valorTipo: 'total' | 'parcela' | 'outro' | null
  /** Palavras exatas do cliente que sustentam o valor; conferidas contra o texto real. */
  valorTrecho: string | null
  segmento: 'PF' | 'PJ' | null
  intencao: Intencao
  /** Número do horário na lista livre enviada ao modelo. */
  horarioN: number | null
  email: string | null
}

/** Fatos que a VPS lê do banco antes de chamar o modelo. */
export interface Fatos {
  produto: Produto | null
  ehCliente: boolean
  /** Card aberto na etapa Perdido. */
  cardPerdido: boolean
  etapaSensivel: boolean
  temReuniao: boolean
  horarioJaEscolhido: boolean
  emailNoCadastro: string | null
  segmentoGravado: 'PF' | 'PJ' | null
  /** Veredito "abaixo do piso" gravado em turno anterior. */
  abaixoPisoGravado: boolean
  /** Números válidos na lista de horários livres enviada ao modelo. */
  horariosLivres: number[]
  /** Tudo o que o cliente escreveu na conversa (para conferir o trecho citado). */
  textoDoCliente: string
}

export type MotivoHandoff = 'cliente' | 'perdido' | 'pedido_do_lead' | 'processo'

export type Acao =
  | { tipo: 'handoff'; motivo: MotivoHandoff; silencioso: boolean }
  | { tipo: 'recusa'; motivo: 'piso' | 'dbc_abaixo' }
  | { tipo: 'encaminhar_equipe' }
  | { tipo: 'perguntar_valor' }
  | { tipo: 'pedir_email' }
  | { tipo: 'horario_indisponivel' }
  | {
      tipo: 'enviar'
      texto: string
      efeito:
        | 'nenhum'
        | 'oferecer_horarios'
        | 'registrar_horario'
        | 'agendar'
        | 'desmarcar'
        | 'reagendar'
        | 'perdido'
        | 'porta_aberta'
      horarioN?: number
      email?: string
    }

export interface Resultado {
  acao: Acao
  /** Veredito a gravar: true/false = grava/limpa a tag "abaixo do piso"; null = não mexe. */
  gravarAbaixoPiso: boolean | null
  /** Depois de enviar, passar o caso à equipe (etapa sensível: acolhe e entrega). */
  handoffDepois: boolean
}

const AGENDA = new Set<Intencao>(['oferecer_horarios', 'horario_escolhido', 'confirmar_agendamento'])

type Faixa = 'abaixo' | 'intermediaria' | 'qualifica' | 'indefinida'

function faixaDbc(valor: number | null): Faixa {
  if (valor === null) return 'indefinida'
  if (valor < DBC_RECUSA_ABAIXO) return 'abaixo'
  if (valor < DBC_QUALIFICA_A_PARTIR) return 'intermediaria'
  return 'qualifica'
}

export function pisoDe(f: Fatos, d: Decisao): number {
  if (f.produto && f.produto !== 'DBC') return PISOS[f.produto]
  const seg = d.segmento ?? f.segmentoGravado
  return seg === 'PJ' ? PISO_SEM_PRODUTO.PJ : PISO_SEM_PRODUTO.PF
}

/** Valor utilizável, ou null se o cliente ainda não deu o suficiente para comparar com o corte. */
export function valorUtil(d: Decisao, corte: number, exatoApenas = false): number | null {
  const v = d.valorTotal
  if (v === null || v <= 0) return null
  const rel = d.valorRelacao ?? 'igual'
  if (rel === 'igual') return v
  if (exatoApenas) return null
  if (rel === 'acima_de') return v >= corte ? v : null
  return v <= corte ? Math.max(v - 1, 0) : null
}

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** Recusar exige: o modelo disse que é o TOTAL e citou palavras que realmente estão no que o cliente escreveu. */
export function recusaConfirmada(d: Decisao, f: Fatos): boolean {
  if (d.valorTipo !== 'total' || !d.valorTrecho) return false
  const texto = norm(f.textoDoCliente)
  return d.valorTrecho
    .split('|')
    .map(norm)
    .some((t) => t.length >= 2 && texto.includes(t))
}

function pronto(acao: Acao, extra: Partial<Resultado> = {}): Resultado {
  return { acao, gravarAbaixoPiso: null, handoffDepois: false, ...extra }
}

export function decidir(d: Decisao, f: Fatos): Resultado {
  // 1) Portas fechadas — nada disso depende de valor.
  if (f.ehCliente) return pronto({ tipo: 'handoff', motivo: 'cliente', silencioso: false })
  if (f.cardPerdido) return pronto({ tipo: 'handoff', motivo: 'perdido', silencioso: true })
  if (d.intencao === 'pedir_humano') {
    return pronto({ tipo: 'handoff', motivo: 'pedido_do_lead', silencioso: false })
  }
  // Processo em andamento passa à equipe, exceto no DBC (lá qualifica pelo valor).
  if (d.intencao === 'processo_judicial' && f.produto !== 'DBC') {
    return pronto({ tipo: 'handoff', motivo: 'processo', silencioso: false })
  }

  // 2) Piso. Não vale para etapa sensível, reunião marcada ou horário já escolhido.
  const protegido = f.etapaSensivel || f.temReuniao || f.horarioJaEscolhido
  let gravar: boolean | null = null

  if (!protegido) {
    if (f.produto === 'DBC') {
      const faixa = faixaDbc(valorUtil(d, DBC_RECUSA_ABAIXO, true))
      if ((faixa === 'abaixo' || faixa === 'intermediaria') && !recusaConfirmada(d, f)) return pronto({ tipo: 'perguntar_valor' })
      if (faixa === 'abaixo') return pronto({ tipo: 'recusa', motivo: 'dbc_abaixo' }, { gravarAbaixoPiso: true })
      if (faixa === 'intermediaria') return pronto({ tipo: 'encaminhar_equipe' }, { gravarAbaixoPiso: false })
      if (faixa === 'qualifica') gravar = false
      if (faixa === 'indefinida') {
        if (f.abaixoPisoGravado) return pronto({ tipo: 'recusa', motivo: 'dbc_abaixo' })
        if (AGENDA.has(d.intencao)) return pronto({ tipo: 'perguntar_valor' })
      }
    } else {
      const piso = pisoDe(f, d)
      const valorNovo = valorUtil(d, piso)
      if (valorNovo !== null) {
        if (valorNovo < piso) {
          // Recusa só com total explícito e trecho conferido; senão pergunta o total (nunca recusa à toa).
          if (!recusaConfirmada(d, f)) return pronto({ tipo: 'perguntar_valor' })
          return pronto({ tipo: 'recusa', motivo: 'piso' }, { gravarAbaixoPiso: true })
        }
        gravar = false
      } else if (f.abaixoPisoGravado) {
        return pronto({ tipo: 'recusa', motivo: 'piso' })
      } else if (AGENDA.has(d.intencao)) {
        // Falha fechada: sem valor lido, não agenda.
        return pronto({ tipo: 'perguntar_valor' })
      }
    }
  }

  // 3) Agenda.
  const email = d.email ?? f.emailNoCadastro
  const horarioValido = d.horarioN !== null && f.horariosLivres.includes(d.horarioN)
  const enviar = (efeito: Extract<Acao, { tipo: 'enviar' }>['efeito'], extra: { horarioN?: number; email?: string } = {}): Resultado =>
    pronto({ tipo: 'enviar', texto: d.mensagem, efeito, ...extra }, { gravarAbaixoPiso: gravar, handoffDepois: f.etapaSensivel })

  switch (d.intencao) {
    case 'horario_escolhido':
      if (!horarioValido) return pronto({ tipo: 'horario_indisponivel' }, { gravarAbaixoPiso: gravar })
      return enviar('registrar_horario', { horarioN: d.horarioN! })
    case 'confirmar_agendamento':
      if (!email) return pronto({ tipo: 'pedir_email' }, { gravarAbaixoPiso: gravar })
      if (!horarioValido) return pronto({ tipo: 'horario_indisponivel' }, { gravarAbaixoPiso: gravar })
      return enviar('agendar', { horarioN: d.horarioN!, email })
    case 'oferecer_horarios':
      return enviar('oferecer_horarios')
    case 'desmarcar':
      return enviar('desmarcar')
    case 'reagendar':
      return enviar('reagendar')
    case 'recusou':
      return enviar('perdido')
    case 'encerrar_porta_aberta':
      return enviar('porta_aberta')
    default:
      return enviar('nenhum')
  }
}
