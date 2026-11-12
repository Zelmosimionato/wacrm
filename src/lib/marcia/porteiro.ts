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
  /** Já recusado antes e nada novo: não responde (a recusa saiu uma vez só). */
  | { tipo: 'silencio' }
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

/** Valor escrito pelo lead em reais (aceita 1.662,29 · 322,15 · 322.15 · 1662). */
function reais(s: string): number {
  if (s.includes(',')) return Number(s.replace(/\./g, '').replace(',', '.'))
  if (/\.\d{2}$/.test(s)) return Number(s)
  return Number(s.replace(/\./g, ''))
}

/**
 * 09/11/2026 (lead que respondeu "19 parcelas de 275,37" e "72 parcelas de 322,15" ≈ R$ 28,4 mil e foi agendado):
 * saldo aproximado = soma de (quantidade × parcela) que o PRÓPRIO lead escreveu. Conta do sistema, não do modelo.
 * Mesmo par repetido conta uma vez. null se não houver nenhum par.
 */
export function saldoPorParcelas(textoDoCliente: string): number | null {
  const t = norm(textoDoCliente)
  const re = /(\d{1,3})\s*(?:x|vezes|parcelas?|prestacoes|prestacao)\s*(?:de|x)?\s*(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g
  const vistos = new Set<string>()
  let total = 0
  for (const m of t.matchAll(re)) {
    const n = Number(m[1])
    const v = reais(m[2])
    if (!(n >= 2 && n <= 480 && v >= 50 && v <= 200_000)) continue
    const chave = `${n}|${v}`
    if (vistos.has(chave)) continue
    vistos.add(chave)
    total += n * v
  }
  return vistos.size ? Math.round(total * 100) / 100 : null
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
        // 09/11: recusa já enviada (tag gravada) e nenhum valor novo: silêncio, não repete a recusa a cada mensagem.
        if (f.abaixoPisoGravado) return pronto({ tipo: 'silencio' })
        if (AGENDA.has(d.intencao)) return pronto({ tipo: 'perguntar_valor' })
      }
    } else {
      const piso = pisoDe(f, d)
      let valorNovo = valorUtil(d, piso)
      // 09/11: sem total explícito, o saldo pelas parcelas que o lead escreveu vale como total, mas só na hora de
      // agendar (o modelo já confirmou que são todos os contratos). No meio da conversa não decide nada.
      const totalExplicito = d.valorTipo === 'total' && valorNovo !== null
      const saldo = totalExplicito ? null : saldoPorParcelas(f.textoDoCliente)
      const porSaldo = saldo !== null && AGENDA.has(d.intencao)
      if (porSaldo) valorNovo = saldo
      if (valorNovo !== null) {
        if (valorNovo < piso) {
          // Recusa só com total explícito e trecho conferido, ou com o saldo calculado das parcelas; senão pergunta o total.
          if (!porSaldo && !recusaConfirmada(d, f)) return pronto({ tipo: 'perguntar_valor' })
          return pronto({ tipo: 'recusa', motivo: 'piso' }, { gravarAbaixoPiso: true })
        }
        gravar = false
      } else if (f.abaixoPisoGravado) {
        // 09/11 (lead de 07/11 recebeu a recusa 3x, até no "obg"): já recusado e sem valor novo = silêncio.
        return pronto({ tipo: 'silencio' })
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

  // 06/11/2026 (casos Clecius e Adilia): quem JA tem reuniao marcada nao reserva de novo. O modelo devolveu
  // 'confirmar_agendamento' (num "Obrigado, ate segunda" e num "Isso"), o executor tentou reservar, achou a reuniao
  // existente, moveu o card para Reagendar e a automacao CANCELOU a reuniao e mandou "vi que voce cancelou".
  // Remarcar de verdade e a intencao 'reagendar' (tratada abaixo); aqui so se conversa, sem efeito.
  if (f.temReuniao && AGENDA.has(d.intencao)) return enviar('nenhum')
  // 09/11/2026 (Adilia de novo, 07/11): quem ja tem reuniao e se despede ("ok, obrigada") so conversa; nunca o
  // "Se mudar de ideia... escolher o melhor horario" com link/botao de agenda, que soa como se nao estivesse agendada.
  if (f.temReuniao && d.intencao === 'encerrar_porta_aberta') return enviar('nenhum')

  switch (d.intencao) {
    case 'horario_escolhido':
      if (!horarioValido) return pronto({ tipo: 'horario_indisponivel' }, { gravarAbaixoPiso: gravar })
      // 09/11 (lead que deu o e-mail ANTES de escolher): com e-mail conhecido, escolher o horário já reserva.
      // Antes só registrava e esperava um "confirmo" que o texto não pedia; a conversa parava sem reserva.
      if (email) return enviar('agendar', { horarioN: d.horarioN!, email })
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
