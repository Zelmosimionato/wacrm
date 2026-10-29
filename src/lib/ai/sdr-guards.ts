/**
 * Guardas puros da Márcia: detecção de processo citado, validador de saída,
 * guardas da trava de piso e do marcador PERDIDO. Sem imports; sintaxe TypeScript
 * apagável (roda com `node --test` no Node 24).
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Mensagem fixa enviada ao lead quando a IA para e passa para o humano. */
export const ACOLHIMENTO_HANDOFF =
  'Entendi. Vou chamar alguém da nossa equipe para continuar o atendimento por aqui, só um instante.'

/** Texto seguro quando a regeneração do validador de saída ainda reprova só
 *  por excesso de perguntas (falha "leve"). Uma única pergunta, sem cifra. */
export const TEXTO_SEGURO_FALLBACK =
  'Só para eu te ajudar do jeito certo: pode me contar, com suas palavras, o que está acontecendo?'

/** Valores de corte (PISO_POR_PRODUTO + genérico PF/PJ + faixa DBC de 3 mil) que
 *  NUNCA podem sair em mensagem ao lead. 500 mil (limite de "super") NÃO é corte de
 *  qualificação e não entra aqui. */
export const VALORES_DE_CORTE: number[] = [3_000, 5_000, 10_000, 50_000, 100_000]

/** Palavras que denunciam o critério interno de qualificação. Comparadas sem
 *  acento e sem caixa. */
export const PALAVRAS_PROIBIDAS_SAIDA: string[] = [
  'piso',
  'corte',
  'valor minimo',
  'minimo que atendemos',
]

/** Limite de caracteres por balão (acima disso é só AVISO). */
export const LIMITE_BALAO = 400

/** Janela em que uma mensagem de humano (sender_type 'agent') pausa a IA. */
export const PAUSA_HUMANO_MS = 10 * 60_000

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** minúsculas, sem acento. Mantém o comprimento do texto (só remove marcas
 *  combinantes), então índices continuam válidos. */
export function normaliza(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

// ---------------------------------------------------------------------------
// detecção de processo / ação / penhora / etc.
// ---------------------------------------------------------------------------

/** Padrão CNJ: NNNNNNN-DD.AAAA.J.TR.OOOO (aceita sem pontuação). */
const RE_CNJ = /\b\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}\b/

/** Mensagem pré-preenchida dos sites ("Vim do site de Execução Fiscal e
 *  gostaria de mais informações [ref: utm_source=...]"): NÃO conta como citar
 *  processo. Trabalha sobre texto já normalizado. */
const RE_PREFILL_REF_COLCHETES = /\[\s*ref\s*:[^\]]*\]/g
const RE_PREFILL_REF_SOLTO = /\bref\s*:\s*\S+/g
const RE_PREFILL_FRASE =
  /\bvim\s+(?:do|da|pelo|pela)\s+site[^\n.!?\[]*?gostaria\s+de\s+(?:mais\s+)?informacoes\b/g
/** Variante sem o "gostaria...": só vale se a mensagem INTEIRA for isso. */
const RE_PREFILL_SO_ISSO = /^\s*vim\s+(?:do|da|pelo|pela)\s+site\b[^\n.!?]*$/

/** Remove da mensagem do lead a parte pré-preenchida pelo site. Devolve o
 *  texto NORMALIZADO restante (só o que o lead escreveu além disso). */
export function removePrefillDoSite(texto: string): string {
  let t = normaliza(texto)
  t = t.replace(RE_PREFILL_REF_COLCHETES, ' ')
  t = t.replace(RE_PREFILL_REF_SOLTO, ' ')
  t = t.replace(RE_PREFILL_FRASE, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  if (RE_PREFILL_SO_ISSO.test(t)) return ''
  return t
}

interface PadraoProcesso {
  nome: string
  re: RegExp
}

/** Termos que indicam processo judicial. Sempre sobre texto normalizado. */
const PADROES_PROCESSO: PadraoProcesso[] = [
  { nome: 'processo', re: /\bprocess(?:o|os|ad[oa]s?)\b/g },
  {
    nome: 'acao',
    re: /\bacoes?\s+(?:judiciais?|de\s+(?:execucao|cobranca|busca|despejo|monitoria)|contra\s+(?:mim|nos|a\s+gente))\b/g,
  },
  {
    nome: 'acao',
    re: /\b(?:entrei|entrou|entraram|ajuizou|ajuizaram|moveu|moveram|propos|propuseram|abriu|abriram|sofro|sofri|respondo)\s+(?:com\s+|uma\s+|a\s+|essa\s+|esta\s+)*acao\b/g,
  },
  {
    nome: 'acao',
    re: /\b(?:tem|tenho|ha|existe|existem|temos)\s+(?:uma\s+|a\s+|essa\s+)*acao\s+(?:contra|em\s+andamento|na\s+justica|no\s+forum)\b/g,
  },
  { nome: 'execucao', re: /\bexecuc(?:ao|oes)\b/g },
  { nome: 'executado', re: /\bexecutad[oa]s?\b/g },
  { nome: 'penhora', re: /\bpenhor(?:a|as|ad[oa]s?|ar|aram|ou)\b/g },
  { nome: 'mandado', re: /\bmandados?\b/g },
  { nome: 'sisbajud', re: /\b(?:sisbajud|bacen\s*jud|bacenjud)\b/g },
  {
    nome: 'citacao',
    re: /\bcitac(?:ao|oes)\b|\b(?:fui|foi|estou|sou|serei|fomos)\s+(?:sendo\s+)?citad[oa]s?\b|\bcitad[oa]\s+(?:em|no|na|pelo|pela|para)\b/g,
  },
  { nome: 'intimacao', re: /\bintimac(?:ao|oes)\b|\bintimad[oa]s?\b/g },
  { nome: 'audiencia', re: /\baudienc(?:ia|ias)\b/g },
  { nome: 'bloqueio_judicial', re: /\bbloqueio\s+judicial\b|\boficial\s+de\s+justica\b|\barresto\b/g },
  { nome: 'juiz', re: /\bjuiz(?:a|o|ado)?\b/g },
  { nome: 'sentenca', re: /\bsentenca\b/g },
  { nome: 'justica', re: /\bna\s+justica\b|\bforum\b|\btribunal\b|\bvara\s+(?:civel|federal|da|do|de|empresarial|fazenda)\b/g },
]

const NEGADORES = new Set(['nao', 'nem', 'nunca', 'sem', 'nenhum', 'nenhuma', 'jamais', 'ninguem', 'tampouco'])
/** Palavras que "quebram" o alcance de uma negação ("não paguei E fui citado"). */
const CONJUNCOES = new Set(['e', 'mas', 'porem', 'pois', 'porque', 'so', 'entao'])

/** O trecho `idx` está sob negação simples? Olha até 3 palavras antes, dentro
 *  da mesma oração (pontuação zera), sem atravessar conjunção; e "nenhum(a)"
 *  logo depois ("processo nenhum"). */
function estaNegado(norm: string, idx: number, fim: number): boolean {
  const antes = norm.slice(0, idx)
  const ini =
    Math.max(
      antes.lastIndexOf('.'),
      antes.lastIndexOf(','),
      antes.lastIndexOf(';'),
      antes.lastIndexOf('!'),
      antes.lastIndexOf('?'),
      antes.lastIndexOf('\n'),
    ) + 1
  const palavras = antes
    .slice(ini)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  for (let i = palavras.length - 1, n = 0; i >= 0 && n < 3; i--, n++) {
    const p = palavras[i]
    if (CONJUNCOES.has(p)) break
    if (NEGADORES.has(p)) return true
  }
  if (/^\s*(?:nenhum|nenhuma)\b/.test(norm.slice(fim))) return true
  return false
}

export interface DeteccaoProcesso {
  gatilho: boolean
  /** Nomes dos padrões que dispararam (sem repetição). */
  termos: string[]
  /** Número CNJ encontrado, se houver. */
  cnj: string | null
  /** O que de fato foi avaliado (normalizado, sem o prefill do site). */
  textoAvaliado: string
}

export interface OpcoesDeteccao {
  /** Remove a mensagem pré-preenchida dos sites antes de avaliar (padrão true). */
  ignorarPrefillDoSite?: boolean
}

/**
 * O lead CITOU processo/ação/execução/penhora/mandado/SISBAJUD/citação/
 * intimação/audiência/número de processo?
 *
 * - Ignora a mensagem pré-preenchida dos sites (ex.: "Vim do site de Execução
 *   Fiscal e gostaria de mais informações [ref: ...]").
 * - Negação simples ("não tenho processo", "nunca fui processado", "sem
 *   processo", "nenhum processo") NÃO dispara.
 * - Número CNJ sempre dispara (é a citação em si).
 */
export function detectaProcesso(textoLead: string, opts: OpcoesDeteccao = {}): DeteccaoProcesso {
  const ignorar = opts.ignorarPrefillDoSite !== false
  const norm = ignorar ? removePrefillDoSite(textoLead ?? '') : normaliza(textoLead ?? '').replace(/\s+/g, ' ').trim()

  const termos: string[] = []
  const cnjM = norm.match(RE_CNJ)
  const cnj = cnjM ? cnjM[0] : null
  if (cnj) termos.push('cnj')

  for (const p of PADROES_PROCESSO) {
    p.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.re.exec(norm))) {
      if (m[0].length === 0) {
        p.re.lastIndex++
        continue
      }
      if (!estaNegado(norm, m.index, m.index + m[0].length)) {
        if (!termos.includes(p.nome)) termos.push(p.nome)
        break
      }
    }
  }
  return { gatilho: termos.length > 0, termos, cnj, textoAvaliado: norm }
}

/** Junta as mensagens do lead na "rajada" atual: as últimas mensagens
 *  consecutivas de role 'user' (depois da última resposta da IA). */
export function textoDoLeadNaRajada(messages: { role: string; content: string }[]): string {
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') break
    out.unshift(messages[i].content ?? '')
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// validador de saída
// ---------------------------------------------------------------------------

export interface ContextoValidacao {
  /** Texto que o lead escreveu (rajada atual). Valores que ELE mesmo disse
   *  podem ser repetidos pela IA (eco) — desde que sem tom de critério. */
  textoLead?: string
}

export type CodigoFalha = 'corte' | 'palavra_proibida' | 'marcador' | 'narracao' | 'perguntas'

export interface ResultadoValidacao {
  ok: boolean
  /** 'grave' = vazamento/marcador (handoff se reprovar de novo);
   *  'leve' = só excesso de perguntas (texto seguro). null se ok. */
  gravidade: 'grave' | 'leve' | null
  falhas: { codigo: CodigoFalha; detalhe: string }[]
  avisos: string[]
}

interface CitacaoValor {
  valor: number
  idx: number
  trecho: string
}

const MIL_POR_EXTENSO: Record<string, number> = {
  tres: 3_000,
  cinco: 5_000,
  dez: 10_000,
  cinquenta: 50_000,
  cem: 100_000,
}

/** Acha, no texto, citações dos valores de corte em várias grafias:
 *  "R$ 5.000", "5 mil", "10k", "R$50000", "cinquenta mil"... */
export function citacoesDeCorte(texto: string): CitacaoValor[] {
  const norm = normaliza(texto)
  const achados: CitacaoValor[] = []
  const add = (valor: number, idx: number, trecho: string) => {
    if (VALORES_DE_CORTE.includes(valor)) achados.push({ valor, idx, trecho })
  }
  let m: RegExpExecArray | null

  // "50 mil", "50k", "R$ 50 mil"  (não pega 150 mil, 2,5 mil)
  const reMil = /(?<![\d.,])(3|5|10|50|100)\s*(?:mil|k)\b/g
  while ((m = reMil.exec(norm))) add(Number(m[1]) * 1000, m.index, m[0])

  // "50.000", "50.000,00"  (não pega 500.000 nem 5.000.000)
  const rePonto = /(?<![\d.,])(3|5|10|50|100)\.000(?:,\d{1,2})?(?!\d|\.\d)/g
  while ((m = rePonto.exec(norm))) add(Number(m[1]) * 1000, m.index, m[0])

  // "R$ 50000", "50000"
  const reCru = /(?<![\d.,])(3000|5000|10000|50000|100000)(?![\d])/g
  while ((m = reCru.exec(norm))) add(Number(m[1]), m.index, m[0])

  // "cinquenta mil", "cem mil"
  const reExt = /\b(tres|cinco|dez|cinquenta|cem)\s+mil\b/g
  while ((m = reExt.exec(norm))) add(MIL_POR_EXTENSO[m[1]], m.index, m[0])

  return achados
}

/** Tom de critério ao redor de um valor: aí nem o eco do lead é permitido. */
const RE_TOM_CRITERIO =
  /(minim|piso|corte|criterio|a partir de|acima de|abaixo de|maior que|menor que|superior a|inferior a|limite|atendemos)/

/** Narração do processo interno do agente ("já tenho o suficiente, vou fechar a
 *  qualificação", "vou ajustar o próximo passo da conversa, sem mexer nas regras").
 *  É pensamento em voz alta, nunca fala ao lead. Em vez de listar frases já vazadas,
 *  pega a CATEGORIA: (A) o agente anunciando o próprio trabalho — verbo de processo
 *  + objeto interno —, (B) o agente falando das próprias regras/instruções e
 *  (C) vocabulário de ferramenta/sistema. Comparado sobre texto normalizado
 *  (sem acento, minúsculas). */
const NARRA_AUXILIAR = '(?:vou|irei|vamos|preciso|so preciso|estou|to|deixa eu|deixe-me|deixe me)'
const NARRA_FOLGA = '(?:(?:so|apenas|somente|agora|rapidamente|um pouco) )*'
const NARRA_VERBO =
  '(?:(?:ajust|alinh|reorganiz|organiz|revis|reformul|recalcul|reavali|defin|decid|escolh|mont|chec|consult|verific|confer|segu|fech|encerr|finaliz|conclu)\\w*|ver|ler)'
// objeto interno; "regras/instruções/fluxo/roteiro..." seguidos de "do/da/de/no/na"
// são assunto do cliente (ex.: "as regras do contrato") e não narração.
const NARRA_OBJETO =
  '(?:(?:o )?proximo passo|(?:a )?proxima etapa|(?:a )?proxima pergunta|(?:o )?rumo da conversa|(?:o )?andamento da conversa|' +
  '(?:a |o |as |os )?(?:regras|instrucoes|fluxo|roteiro|script|prompt|qualificacao|abordagem|estrategia)(?! (?:d[oae]s?|n[oa]s?)\\b)|' +
  'minha (?:resposta|mensagem|abordagem|estrategia))'

const RE_NARRACAO: RegExp[] = [
  // (A) "vou/estou + verbo de processo + objeto interno"
  new RegExp(`\\b${NARRA_AUXILIAR} ${NARRA_FOLGA}${NARRA_VERBO} ${NARRA_OBJETO}`),
  /\bja tenho o suficiente\b/,
  /\b(?:sem|para nao|pra nao) repetir o que (?:ja|a gente) (?:sabemos|sabe|temos|tem)\b/,
  // "roteiro" só reprova quando é o roteiro INTERNO do produto ou quando o agente diz
  // que o está seguindo/consultando; "o roteiro da reunião" dito ao lead é fala normal.
  /\broteiro d[oae]s? (?:rcpcc|dbc|def|gpix|rcv|gpass|bancario|superendividamento|revisional|desbloqueio|passivos|produto|nicho|atendimento|qualificacao)\b/,
  /\b(?:seguindo|segundo|conforme|consultando|consultei|conferi|pelo) (?:o )?roteiro\b/,
  // (B) o agente falando das próprias regras e instruções
  /\b(?:sem|para nao|pra nao) (?:mexer|alterar|mudar|modificar|quebrar|violar|burlar|ferir) (?:n?as?|em) (?:minhas |suas )?(?:regras|instrucoes|diretrizes)\b/,
  /\bminhas (?:regras|instrucoes|diretrizes|configuracoes)\b/,
  /\bmeu (?:prompt|roteiro|script|fluxo)\b/,
  // (C) vocabulário de ferramenta/sistema
  /\b(?:system ?prompt|prompt do sistema|vector ?store|file[ _]?search|function ?call)\b/,
  // (D) falar SOBRE o lead em 3ª pessoa ou dar instrução a um operador
  /\bquando (?:ela|ele|a lead|o lead) (?:mandar|enviar|responder|informar|disser|falar|passar|escrever|retornar|voltar)\b/,
  /\b(?:aguardar|esperar|aguarde|espere) (?:a|o) (?:resposta|retorno|mensagem|valor|contato) (?:dela|dele|da lead|do lead)\b/,
  /\b(?:a|o|essa|esse|esta|este) lead\b/,
  /\b(?:siga|continue|prossiga|mantenha|retome) (?:com )?(?:uma|1) pergunta por vez\b/,
  /\bsem repetir a (?:saudacao|apresentacao)\b/,
  // (E) o agente narrando COMO vai responder (tom, fluxo, perguntas) em vez de responder
  new RegExp(
    `\\b${NARRA_AUXILIAR} ${NARRA_FOLGA}responder (?:de (?:forma|maneira|modo)|em tom|` +
      'com (?:acolhimento|empatia|cuidado|objetividade|clareza|uma pergunta|tom)|como (?:a )?marcia|' +
      'no fluxo|ao \\w+ com uma pergunta|sem (?:adiantar|repetir|fazer)|so pedir|curto)',
  ),
  /\bno fluxo certo\b/,
  /\b(?:sem|para nao|pra nao) (?:repetir|adiantar) (?:a |as |o |os )?(?:triagem|perguntas desnecessarias|qualificacao)\b/,
]

function dividirBaloes(texto: string): string[] {
  const parts = texto
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : [texto.trim()]
}

/**
 * Valida a resposta da IA ANTES de ir para o lead.
 * Reprova (falha): valor de corte, palavras 'piso'/'corte'/'valor mínimo'/
 * 'mínimo que atendemos', marcador [[...]] remanescente, mais de 1 pergunta.
 * Avisa (não reprova): balão acima de 400 caracteres.
 */
export function validarSaida(texto: string, contexto: ContextoValidacao = {}): ResultadoValidacao {
  const falhas: ResultadoValidacao['falhas'] = []
  const avisos: string[] = []
  const bruto = texto ?? ''
  const norm = normaliza(bruto)

  // 1) valores de corte (com exceção do eco de um valor que o PRÓPRIO lead disse)
  const doLead = new Set(citacoesDeCorte(contexto.textoLead ?? '').map((c) => c.valor))
  for (const c of citacoesDeCorte(bruto)) {
    const janela = norm.slice(Math.max(0, c.idx - 50), c.idx + c.trecho.length + 50)
    const eco = doLead.has(c.valor) && !RE_TOM_CRITERIO.test(janela)
    if (!eco) {
      falhas.push({ codigo: 'corte', detalhe: `valor de corte citado: "${c.trecho}"` })
    }
  }

  // 2) palavras que denunciam o critério
  for (const termo of PALAVRAS_PROIBIDAS_SAIDA) {
    const re = new RegExp(`\\b${termo.replace(/ /g, '\\s+')}\\b`)
    if (re.test(norm)) falhas.push({ codigo: 'palavra_proibida', detalhe: `palavra proibida: "${termo}"` })
  }

  // 3) marcadores [[...]] que sobraram
  if (/\[\[|\]\]/.test(bruto)) {
    falhas.push({ codigo: 'marcador', detalhe: 'marcador interno [[...]] sobrando na resposta' })
  }
  // 3b) narração do processo interno vazada na fala ao lead
  for (const re of RE_NARRACAO) {
    const mm = re.exec(norm)
    if (mm) {
      falhas.push({ codigo: 'narracao', detalhe: `narração de processo interno: "${mm[0]}"` })
      break
    }
  }

  // 4) no máximo 1 pergunta (saudação "Tudo bem?" não conta)
  const semSaudacao = norm.replace(
    /\b(?:tudo\s+(?:bem|bom|certo|joia|tranquilo)|como\s+(?:vai|voce\s+esta|vc\s+esta|esta))\s*\?+/g,
    ' ',
  )
  const nPerguntas = (semSaudacao.match(/\?+/g) ?? []).length
  if (nPerguntas > 1) {
    falhas.push({ codigo: 'perguntas', detalhe: `${nPerguntas} perguntas na mesma mensagem (máx. 1)` })
  }

  // 5) balão grande = aviso
  for (const b of dividirBaloes(bruto)) {
    if (b.length > LIMITE_BALAO) avisos.push(`balão com ${b.length} caracteres (> ${LIMITE_BALAO})`)
  }

  const grave = falhas.some((f) => f.codigo !== 'perguntas')
  return {
    ok: falhas.length === 0,
    gravidade: falhas.length === 0 ? null : grave ? 'grave' : 'leve',
    falhas,
    avisos,
  }
}

/** Texto anexado ao prompt para a UMA regeneração após reprovação. */
export function falhaParaPrompt(res: ResultadoValidacao): string {
  const itens = res.falhas.map((f) => `- ${f.detalhe}`).join('\n')
  return (
    'ATENÇÃO — a sua resposta anterior foi REPROVADA pelo controle de qualidade e NÃO foi enviada. Motivos:\n' +
    itens +
    '\nReescreva a resposta corrigindo isso: ⛔ nunca cite valor de corte, piso, mínimo ou critério de atendimento ' +
    '(peça apenas o valor total aproximado da dívida, sem dizer qual número qualifica); ⛔ no máximo UMA pergunta; ' +
    '⛔ sem marcadores entre colchetes duplos além dos permitidos no final; balões curtos. ' +
    'Se a pessoa acabou de escolher um horário da lista ou de confirmar a reserva, mantenha no final o marcador ' +
    'de agenda correspondente ([[HORARIO_ESCOLHIDO:N]] ou [[AGENDAR:N]]).'
  )
}

/**
 * Marcadores de agenda que a 1ª resposta trouxe e a regeneração perdeu.
 * Caso Lead J (19/10/2026): a resposta com [[HORARIO_ESCOLHIDO:N]]/[[AGENDAR:N]] foi
 * reprovada pelo validador de saída; o modelo não vê a resposta reprovada, então a
 * regeneração saiu sem o marcador e a reunião nunca foi reservada. A decisão do
 * lead (qual horário) não muda porque o TEXTO foi reprovado — por isso o marcador
 * da 1ª resposta vale quando a 2ª não trouxe o seu. O marcador da 2ª, se existir,
 * sempre prevalece. A reserva continua passando pelas travas de sempre (PF/PJ,
 * e-mail, piso de valor), que ficam a jusante.
 */
export function herdarMarcadoresDeAgenda<T extends { agendar: number | null; horarioEscolhido: number | null }>(
  anterior: T,
  novo: T,
): T {
  return {
    ...novo,
    agendar: novo.agendar ?? anterior.agendar,
    horarioEscolhido: novo.horarioEscolhido ?? anterior.horarioEscolhido,
  }
}

// ---------------------------------------------------------------------------
// guardas da trava de piso e do [[PERDIDO]]
// ---------------------------------------------------------------------------

export interface ContextoPiso {
  /** Contato tem a tag Cliente. */
  isClient: boolean
  /** Etapa do card é sensível (proposta, decisão, contrato). */
  etapaSensivel: boolean
  /** Há reunião marcada (tag Agendou). */
  hasMeeting: boolean
  /** O lead já escolheu/aceitou horário (conversations.horario_escolhido_* ou
   *  marcador HORARIO_ESCOLHIDO neste turno). */
  horarioEscolhido: boolean
}

/** Motivo pelo qual a trava de piso NÃO deve ser aplicada; null = pode aplicar. */
export function motivoBloqueioPiso(ctx: ContextoPiso): string | null {
  if (ctx.isClient) return 'contato é Cliente'
  if (ctx.etapaSensivel) return 'etapa sensível (proposta/decisão/contrato)'
  if (ctx.hasMeeting) return 'há reunião marcada'
  if (ctx.horarioEscolhido) return 'lead acabou de escolher/aceitar horário'
  return null
}

/** A trava de piso (override VALOR_ABAIXO_DO_PISO) pode ser aplicada? */
export function devePodeAplicarPiso(ctx: ContextoPiso): boolean {
  return motivoBloqueioPiso(ctx) === null
}

/** O marcador [[PERDIDO]] pode ser aplicado? Nunca em etapa sensível. */
export function podeMarcarPerdido(ctx: { etapaSensivel: boolean }): boolean {
  return !ctx.etapaSensivel
}

// ---------------------------------------------------------------------------
// tempos de espera antes de responder
// ---------------------------------------------------------------------------

export type OrigemDisparo = 'primeiro_toque' | 'debounce'

export const ESPERA_PRIMEIRO_TOQUE_PADRAO_MS = 6000
export const DEBOUNCE_PADRAO_MS = 12000
export const ESPERA_RAJADA_PADRAO_MS = 1500

type Ambiente = Record<string, string | undefined>

function numeroOuPadrao(valor: string | undefined, padrao: number): number {
  if (valor === undefined || valor.trim() === '') return padrao
  const n = Number(valor)
  return Number.isFinite(n) && n >= 0 ? n : padrao
}

/** Silêncio (ms) exigido após a última mensagem do lead nos toques seguintes. */
export function debounceMs(env: Ambiente): number {
  return numeroOuPadrao(env.AI_DEBOUNCE_MS, DEBOUNCE_PADRAO_MS)
}

/** Espera (ms) dentro do disparo, antes de gerar: 1º toque espera a janela
 *  própria; disparo vindo do debounce espera só o residual de rajada. */
export function esperaAntesDeGerarMs(origem: OrigemDisparo, env: Ambiente): number {
  return origem === 'primeiro_toque'
    ? numeroOuPadrao(env.AI_ESPERA_PRIMEIRO_TOQUE_MS, ESPERA_PRIMEIRO_TOQUE_PADRAO_MS)
    : numeroOuPadrao(env.AI_ESPERA_RAJADA_MS, ESPERA_RAJADA_PADRAO_MS)
}
