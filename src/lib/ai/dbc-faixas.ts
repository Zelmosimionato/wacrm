/**
 * Desbloqueio de Conta (DBC): faixas de valor bloqueado (regra do titular, 15/10/2026).
 *
 *   abaixo de R$ 3.000      -> recusa mantida, em mensagem mais suave (VALOR_ABAIXO_DBC)
 *   de R$ 3.000 a R$ 4.999  -> NÃO dispensa: coleta valor exato, processo e natureza do
 *                              dinheiro e passa ao Dr. Zelmo (handoff com acolhimento e bip)
 *   a partir de R$ 5.000   -> qualifica e agenda, como antes
 *   valor vago ("mais de 3000") ou ausente -> pergunta o valor exato ANTES de classificar
 *
 * ⛔ Os cortes (3 mil / 5 mil) NUNCA aparecem em mensagem ao lead (decisão de 09/10).
 *    Os textos daqui não citam número; o validador de saída (sdr-guards) trata 3.000 e
 *    5.000 como valores de corte.
 *
 * Funções puras, sem I/O: quem consulta tag de produto, grava tag e envia é auto-reply.ts.
 */

import { normaliza } from './sdr-guards'

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Abaixo disto: recusa suave. Início da faixa de encaminhamento ao titular. */
export const DBC_CORTE_RECUSA = 3_000
/** A partir deste valor (inclusive) qualifica e agenda; abaixo dele (e desde 3.000) vai ao titular. */
export const DBC_CORTE_QUALIFICA = 5_000
/** Respostas do lead, depois de entrar na faixa, a partir das quais o código passa ao titular.
 *  0 = assim que o valor exato está na faixa de 3 a 5 mil (decisão do titular em 16/10/2026: a
 *  qualificação é só pelo valor; processo, origem do dinheiro etc. não condicionam nada). */
export const DBC_FAIXA_MAX_RESPOSTAS = 0

export type FaixaDbc = 'abaixo' | 'faixa_intermediaria' | 'qualificado' | 'indefinida'

const LINKS_BLOG =
  'Blog: https://simionatoadvogados.com.br/blog/ · Materiais: https://simionatoadvogados.com.br/materiais-gratuitos/'

/** Recusa suave (valor bloqueado abaixo de R$ 3.000). Sem número e sem "inviável"; acolhe, explica o
 *  custo-benefício do processo, deixa a porta aberta e dá o caminho dos materiais. Texto aprovado em 16/10/2026. */
export const VALOR_ABAIXO_DBC =
  'Entendi, e sinto muito pelo transtorno de ter a conta bloqueada.\n\n' +
  'Como trabalhamos com processos judiciais, precisamos olhar os custos em relação ao benefício. No seu caso, um processo judicial ficaria mais caro do que o ganho que você teria, então não compensaria para você.\n\n' +
  'A porta continua aberta: se surgir qualquer novidade sobre o bloqueio, é só me chamar por aqui.\n\n' +
  'Enquanto isso, deixo conteúdos que podem ajudar você a entender seus direitos. ' +
  LINKS_BLOG

/** Pergunta fixa usadas só quando a IA gerou texto que dispensa/agenda um lead da faixa. */
export const PERGUNTA_PROCESSO_DBC =
  'Para eu passar o seu caso direitinho à nossa equipe: já existe algum processo ou ação em andamento sobre esse bloqueio?'
export const PERGUNTA_NATUREZA_DBC =
  'E o dinheiro que foi bloqueado era salário, poupança ou de outra origem?'
export const PERGUNTA_VALOR_EXATO_DBC =
  'Para eu entender direitinho o seu caso, qual foi o valor exato que o banco bloqueou?'

// ---------------------------------------------------------------------------
// Classificação por valor
// ---------------------------------------------------------------------------

/** Valor nulo ou vago nunca é classificado: a IA precisa perguntar o valor exato. */
export function classificaFaixaDbc(valor: number | null, vago = false): FaixaDbc {
  if (valor === null || vago) return 'indefinida'
  if (valor < DBC_CORTE_RECUSA) return 'abaixo'
  if (valor < DBC_CORTE_QUALIFICA) return 'faixa_intermediaria'
  return 'qualificado'
}

// ---------------------------------------------------------------------------
// Leitura do valor bloqueado declarado pelo lead
// ---------------------------------------------------------------------------

interface MsgSimples {
  role: string
  content: string
}

export interface ValorBloqueado {
  /** Valor lido (inteiro, em reais). Em faixa/lista, o MAIOR. null = nenhum número útil. */
  valor: number | null
  /** true = não dá para classificar (mais de X, entre X e Y, vários valores, só renda/parcela). */
  vago: boolean
}

type TipoToken = 'direto' | 'qualificado' | 'contexto'

const RE_CNJ = /\b\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}\b/g

/** Número com R$ / sufixo opcional. Roda sobre texto normalizado (sem acento, minúsculo). */
const RE_DINHEIRO =
  /(r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?(?!\d)|\d+(?:,\d{1,2})?(?!\d))(\s*(?:mil|k|reais)\b)?/g

const RE_QUALIFICADOR_ANTES =
  /\b(?:mais\s+de|mais\s+que|acima\s+de|passa\s+de|passou\s+de|passando\s+de|ultrapass\w*|superior\s+a|pelo\s+menos|no\s+minimo|minimo\s+de|a\s+partir\s+de|menos\s+de|abaixo\s+de|ate|no\s+maximo|maximo\s+de|quase|entre)\s*(?:r\$\s*)?$/
/** Segundo extremo de faixa ("entre 3 e 5 mil", "de 3 a 5 mil"): o primeiro número, curto
 *  demais para ser lido sozinho, só aparece aqui na janela anterior. */
const RE_FAIXA_ANTES =
  /\b(?:entre|de)\s+(?:r\$\s*)?[\d.,]+\s*(?:mil|k|reais)?\s*(?:e|a|ate)\s*(?:r\$\s*)?$/
const RE_QUALIFICADOR_DEPOIS =
  /^\s*(?:reais\s*)?(?:ou\s+mais|ou\s+menos|e\s+pouco|e\s+poucos|e\s+tanto|pra\s+mais|para\s+mais|\+)/
const RE_FAIXA_DEPOIS = /^\s*(?:a|e|ate|ou|-)\s*(?:r\$\s*)?\d/

const RE_CONTEXTO_NAO_BLOQUEIO =
  /\b(?:salario|renda|recebo|ganho|aposentadoria|beneficio|pensao|divida|devo|parcela|prestacao|emprestimo|financiamento|contrato|honorario|aluguel)\b/
const RE_CONTEXTO_BLOQUEIO = /bloque|retid|penhor|travad|congelad|sumiu|tirou|pegou|levou|zerou/

function paraNumero(bruto: string): number | null {
  const limpo = bruto.replace(/\./g, '').replace(',', '.')
  const n = Number(limpo)
  return Number.isFinite(n) ? n : null
}

interface Token {
  valor: number
  tipo: TipoToken
}

function tokensDoTexto(textoOriginal: string): Token[] {
  const norm = normaliza(textoOriginal ?? '').replace(RE_CNJ, ' ')
  const tokens: Token[] = []
  RE_DINHEIRO.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RE_DINHEIRO.exec(norm))) {
    if (m[0].length === 0) {
      RE_DINHEIRO.lastIndex++
      continue
    }
    const temRs = !!m[1]
    const numStr = m[2]
    const sufixo = m[3]?.trim()
    const ini = m.index
    const fim = m.index + m[0].length
    const antes = norm.slice(Math.max(0, ini - 30), ini)
    const depois = norm.slice(fim, fim + 25)
    const charAntes = norm[ini - 1] ?? ''
    const charDepois = norm[fim] ?? ''

    // Datas (10/10/2026), horas (14:30), parcelas (60 x 1.458), números colados em outro.
    if (charAntes === '/' || charDepois === '/' || charDepois === ':' || charAntes === ':') continue
    if (/\bx\s*$/.test(antes) || /^\s*x\b/.test(depois)) continue

    const dotted = /\d\.\d{3}/.test(numStr)
    const digitos = numStr.replace(/\D/g, '').length
    // Sem R$, sem sufixo e sem milhar: só vale número com 4+ dígitos (3000, 4968);
    // telefone/identificador (10+ dígitos) nunca é valor.
    if (!temRs && !sufixo && !dotted && digitos < 4) continue
    if (digitos >= 10) continue
    // ano solto ("em 2026", "de 2025")
    if (!temRs && !sufixo && !dotted && /^(?:19|20)\d{2}$/.test(numStr) && /\b(?:em|de|ano|desde)\s*$/.test(antes)) continue

    let valor = paraNumero(numStr)
    if (valor === null) continue
    if (sufixo === 'mil' || sufixo === 'k') valor *= 1000
    valor = Math.round(valor)

    // Janela da oração (o ponto de milhar não encerra frase).
    const clausulas = norm.split(/(?<!\d)\.(?!\d)|[;!?\n]/)
    const clausula = clausulas.find((c) => c.includes(m![0])) ?? norm

    let tipo: TipoToken = 'direto'
    if (RE_CONTEXTO_NAO_BLOQUEIO.test(clausula) && !RE_CONTEXTO_BLOQUEIO.test(clausula)) {
      tipo = 'contexto'
    } else if (
      RE_QUALIFICADOR_ANTES.test(antes) ||
      RE_FAIXA_ANTES.test(antes) ||
      RE_QUALIFICADOR_DEPOIS.test(depois) ||
      RE_FAIXA_DEPOIS.test(depois)
    ) {
      tipo = 'qualificado'
    }
    tokens.push({ valor, tipo })
  }
  return tokens
}

/**
 * Valor bloqueado declarado pelo PRÓPRIO lead (nunca o que a IA escreveu).
 * Vale a mensagem mais recente que traga um valor utilizável; números ligados a
 * salário/parcela/dívida sem menção a bloqueio são ignorados (e, se forem os únicos,
 * o resultado é "vago"). Vários valores na mesma mensagem, "mais de X", "entre X e Y",
 * "X e pouco" => vago: a IA pergunta o valor exato (decisão de 13/10: na dúvida, pergunta).
 */
export function valorBloqueadoDeclarado(messages: MsgSimples[]): ValorBloqueado {
  let viuContexto = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const tokens = tokensDoTexto(m.content ?? '')
    if (tokens.some((t) => t.tipo === 'contexto')) viuContexto = true
    const uteis = tokens.filter((t) => t.tipo !== 'contexto')
    if (uteis.length === 0) continue
    const distintos = new Set(uteis.map((t) => t.valor))
    const maior = Math.max(...uteis.map((t) => t.valor))
    const vago = distintos.size > 1 || uteis.some((t) => t.tipo === 'qualificado')
    return { valor: maior, vago }
  }
  return { valor: null, vago: viuContexto }
}

// ---------------------------------------------------------------------------
// Estado da conversa DBC
// ---------------------------------------------------------------------------

export interface EstadoDbc {
  faixa: FaixaDbc
  valor: number | null
  vago: boolean
  /** Mensagens do lead depois do ponto em que a faixa atual passou a valer. */
  respostasAposFaixa: number
}

/** Classifica a conversa e conta quantas mensagens do lead vieram depois que a
 *  faixa atual passou a valer (serve à rede `deveEncaminharFaixaDbc`). */
export function estadoDbcDaConversa(messages: MsgSimples[]): EstadoDbc {
  const atual = valorBloqueadoDeclarado(messages)
  const faixa = classificaFaixaDbc(atual.valor, atual.vago)

  // Índice (em `messages`) onde a faixa atual começou: anda para trás enquanto o
  // prefixo da conversa ainda dá a mesma faixa.
  let inicio = 0
  for (let fim = messages.length - 1; fim >= 1; fim--) {
    if (messages[fim].role !== 'user') continue
    const prefixo = messages.slice(0, fim)
    const v = valorBloqueadoDeclarado(prefixo)
    if (classificaFaixaDbc(v.valor, v.vago) !== faixa) {
      inicio = fim
      break
    }
  }
  const respostasAposFaixa = messages.slice(inicio + 1).filter((m) => m.role === 'user').length
  return { faixa, valor: atual.valor, vago: atual.vago, respostasAposFaixa }
}

/** O código deve passar o lead da faixa ao titular, mesmo sem [[HANDOFF]] da IA? */
export function deveEncaminharFaixaDbc(
  estado: EstadoDbc,
  max: number = DBC_FAIXA_MAX_RESPOSTAS,
): boolean {
  return estado.faixa === 'faixa_intermediaria' && estado.respostasAposFaixa >= max
}

// ---------------------------------------------------------------------------
// Texto da IA na faixa intermediária
// ---------------------------------------------------------------------------

/** Texto que dispensa o lead ou oferece reunião: proibido na faixa intermediária. */
const RE_DISPENSA_OU_AGENDA =
  /n[aã]o\s+se\s+enquadra|economicamente\s+invi|custos?\s+(?:podem\s+)?n[aã]o\s+compens|n[aã]o\s+compensa|portas?\s+abertas|medida\s+judicial|infelizmente|\b\d{1,2}\s*(?:h|:\d{2})\b|hor[aá]rios?\b|agendar|reuni[aã]o\b/i

export function textoIncompativelComFaixaDbc(texto: string): boolean {
  return RE_DISPENSA_OU_AGENDA.test(texto ?? '')
}

/** Próxima pergunta fixa da faixa intermediária, conforme o que a IA já perguntou. */
export function proximaPerguntaFaixaDbc(messages: MsgSimples[]): string {
  const dita = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => normaliza(m.content ?? ''))
    .join('\n')
  const perguntouProcesso = /process|acao/.test(dita)
  if (!perguntouProcesso) return PERGUNTA_PROCESSO_DBC
  return PERGUNTA_NATUREZA_DBC
}

// ---------------------------------------------------------------------------
// Bloco de instruções injetado no prompt, por turno
// ---------------------------------------------------------------------------

/** Instrução do turno (em português, para o modelo). Sem número de corte: o modelo
 *  só recebe o estado, nunca os valores de referência. */
export function blocoPromptDbc(estado: EstadoDbc): string {
  switch (estado.faixa) {
    case 'indefinida':
      return (
        'DESBLOQUEIO DE CONTA — valor ainda não definido: o lead não disse o valor bloqueado, ou disse de forma vaga ("mais de X", "uns X", faixa). ' +
        'Pergunte, em UMA mensagem curta, o valor EXATO que o banco bloqueou, e não classifique, não recuse, não ofereça horário e não use [[PERDIDO]] antes de ter esse valor. ' +
        'Nunca cite número de corte.'
      )
    case 'faixa_intermediaria':
      return (
        'DESBLOQUEIO DE CONTA — encaminhamento à equipe (NÃO é recusa e NÃO é agendamento): o caso deve ser passado à equipe. ' +
        'Não faça perguntas de coleta. ⛔ Não recuse, não diga que o caso não compensa, não ofereça horário, não use [[AGENDAR]] nem [[PERDIDO]], e nunca cite número de corte. ' +
        'Responda exatamente com [[HANDOFF]] e mais nada (o sistema envia o acolhimento e avisa a equipe).'
      )
    case 'qualificado':
      return (
        'DESBLOQUEIO DE CONTA — valor bloqueado qualificado: siga o fluxo normal de qualificação e agendamento da conversa com o advogado. ' +
        'Se o lead citar processo ou ação, o sistema passa à equipe. Nunca cite número de corte.'
      )
    case 'abaixo':
    default:
      return (
        'DESBLOQUEIO DE CONTA — valor abaixo do atendido: o sistema envia a despedida. Não ofereça horário nem reunião.'
      )
  }
}
