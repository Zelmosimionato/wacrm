// Márcia v2 — MODELO: uma chamada, uma decisão estruturada. Sem marcadores em texto, sem regex no texto do cliente.
// O comportamento (tom, roteiro, agenda) vem das instruções da plataforma; aqui só entram o formato e a
// leitura do valor, que são técnicos.
import type { Decisao, Intencao, Produto } from './porteiro'

export const INTENCOES: Intencao[] = [
  'conversar',
  'oferecer_horarios',
  'horario_escolhido',
  'confirmar_agendamento',
  'desmarcar',
  'reagendar',
  'recusou',
  'pedir_humano',
  'processo_judicial',
  'encerrar_porta_aberta',
]

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mensagem', 'valor_total', 'valor_relacao', 'valor_tipo', 'valor_trecho', 'segmento', 'intencao', 'horario_n', 'email'],
  properties: {
    mensagem: { type: 'string' },
    valor_total: { type: ['integer', 'null'] },
    valor_relacao: { type: ['string', 'null'], enum: ['igual', 'acima_de', 'abaixo_de', null] },
    valor_tipo: { type: ['string', 'null'], enum: ['total', 'parcela', 'outro', null] },
    valor_trecho: { type: ['string', 'null'] },
    segmento: { type: ['string', 'null'], enum: ['PF', 'PJ', null] },
    intencao: { type: 'string', enum: INTENCOES },
    horario_n: { type: ['integer', 'null'] },
    email: { type: ['string', 'null'] },
  },
} as const

const LEITURA_DO_VALOR = [
  'valor_total é o VALOR TOTAL da dívida, do contrato ou do bloqueio que o CLIENTE informou, em reais inteiros.',
  'Se houver mais de um contrato ou dívida, some os totais informados.',
  'Use null quando o cliente ainda não informou o total, ou quando o número é só parcela, prestação, entrada, saldo restante, telefone, data ou outro dado.',
  'Uma resposta curta só com número vale como o valor que a atendente acabou de perguntar.',
  'Se o número já tem milhar completo e vem seguido de "mil" (ex.: "8000mil"), o valor é o próprio número, nunca multiplicado de novo.',
]
const VALOR_DBC =
  'Produto bloqueio de conta: valor vago ("mais de X", "uns X", "cerca de X") ou faixa ("entre X e Y") NÃO é valor exato: valor_total = null. Só devolva número quando o cliente disser o valor bloqueado de forma exata.'
const VALOR_OUTROS =
  'Valor aproximado ("uns X", "quase X", "cerca de X") vale X com valor_relacao igual; em faixa ("entre X e Y") use o limite superior.'

/** Formato técnico da resposta; vai DEPOIS das instruções da plataforma e prevalece sobre qualquer menção a marcadores. */
export function formatoDaResposta(produto: Produto | null): string {
  return [
    'FORMATO DA RESPOSTA (técnico, prevalece sobre qualquer menção a marcadores [[...]] acima): responda só com o objeto estruturado pedido. Nunca escreva marcadores [[...]] na mensagem.',
    'mensagem: o texto exato que o lead vai ler (vazio se a decisão for só passar à equipe).',
    'intencao: conversar (padrão) | oferecer_horarios (está oferecendo horários da lista) | horario_escolhido (o lead escolheu um horário) | confirmar_agendamento (o lead confirmou e dá para reservar) | desmarcar | reagendar | recusou (recusa explícita do lead) | pedir_humano | processo_judicial (relatou processo em andamento) | encerrar_porta_aberta (despedida sem agendar).',
    'horario_n: número do horário escolhido na lista de horários livres, ou null. email: e-mail que o cliente informou nesta conversa, ou null. segmento: PF ou PJ só se o cliente confirmou, senão null.',
    'valor_relacao: igual (valor dito ou aproximado: "20 mil", "uns 15 mil"), acima_de ("mais de X", "acima de X", "maior que X": X é o mínimo), abaixo_de ("menos de X", "menor que X", "até X": X é o máximo); null se valor_total é null. Nunca devolva 0: sem valor informado use null.',
    'valor_tipo: total (o cliente disse expressamente o valor TOTAL da dívida, do contrato ou do bloqueio), parcela (é valor de parcela, prestação ou desconto mensal), outro (salário, saldo restante, entrada, soma que você mesmo calculou etc.); null se valor_total é null. valor_trecho: copie literalmente, do que o CLIENTE escreveu, as palavras que dizem o valor (se somou vários, separe os trechos com " | "); null se valor_total é null. Na dúvida entre total e parcela, use parcela.',
    ...LEITURA_DO_VALOR,
    produto === 'DBC' ? VALOR_DBC : VALOR_OUTROS,
    'Você não conhece valores de corte e nunca decide sozinha desqualificar: apenas registre o valor lido.',
  ].join('\n')
}

export interface ChamadaArgs {
  apiKey: string
  model: string
  /** Instruções da plataforma (agente). */
  instrucoes: string
  fatosTexto: string
  conversa: { role: 'user' | 'assistant'; content: string }[]
  produto: Produto | null
  timeoutMs?: number
}

export interface ChamadaResultado {
  decisao: Decisao
  ms: number
  tokensEntrada: number
  tokensSaida: number
}

export async function decidirComModelo(a: ChamadaArgs): Promise<ChamadaResultado> {
  const t0 = Date.now()
  const historico = a.conversa.map((m) => `${m.role === 'assistant' ? 'Márcia' : 'Cliente'}: ${m.content}`).join('\n')
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${a.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(a.timeoutMs ?? 60_000),
    body: JSON.stringify({
      model: a.model,
      instructions: `${a.instrucoes}\n\n${formatoDaResposta(a.produto)}`,
      input: `${a.fatosTexto}\n\nHistórico da conversa:\n${historico}`,
      text: { format: { type: 'json_schema', name: 'decisao_marcia', strict: true, schema: SCHEMA } },
    }),
  })
  const j = (await r.json().catch(() => null)) as any
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${j?.error?.message ?? 'erro'}`)
  const texto = (j.output ?? []).flatMap((o: any) => o.content ?? []).find((p: any) => p.type === 'output_text')?.text
  if (!texto) throw new Error('resposta vazia do modelo')
  const o = JSON.parse(texto)
  const decisao: Decisao = {
    mensagem: o.mensagem,
    valorTotal: o.valor_total,
    valorRelacao: o.valor_relacao,
    valorTipo: o.valor_tipo,
    valorTrecho: o.valor_trecho,
    segmento: o.segmento,
    intencao: o.intencao,
    horarioN: o.horario_n,
    email: o.email,
  }
  return { decisao, ms: Date.now() - t0, tokensEntrada: j.usage?.input_tokens ?? 0, tokensSaida: j.usage?.output_tokens ?? 0 }
}

/** Leitura FOCADA do valor: uma chamada curta, só com a regra de leitura (sem a persona). No replay de 04/11 a leitura
 *  dentro do prompt grande oscilou entre rodadas; esta é a mesma usada nos 22 casos (22/22 em 3 rodadas). */
export async function lerValorFocado(a: {
  apiKey: string
  model: string
  produto: Produto | null
  conversa: { role: 'user' | 'assistant'; content: string }[]
  timeoutMs?: number
}): Promise<{ valorTotal: number | null; valorRelacao: Decisao['valorRelacao']; valorTipo: Decisao['valorTipo']; valorTrecho: string | null; ms: number }> {
  const t0 = Date.now()
  const transcript = a.conversa.slice(-30).map((m) => `${m.role === 'assistant' ? 'Atendente' : 'Cliente'}: ${m.content}`).join('\n')
  const instrucoes = [
    'Você lê uma conversa de WhatsApp entre uma atendente e um cliente com dívida bancária ou bloqueio de conta e extrai o valor.',
    'valor_relacao: igual (valor dito ou aproximado: "20 mil", "uns 15 mil"), acima_de ("mais de X", "acima de X", "maior que X": X é o mínimo), abaixo_de ("menos de X", "menor que X", "até X": X é o máximo); null se valor_total é null.',
    'valor_tipo: total (o cliente disse expressamente o valor TOTAL da dívida, do contrato ou do bloqueio), parcela (é valor de parcela, prestação ou desconto mensal), outro (salário, saldo restante, entrada, soma que você mesmo calculou etc.); null se valor_total é null. valor_trecho: copie literalmente, do que o CLIENTE escreveu, as palavras que dizem o valor (se somou vários, separe os trechos com " | "); null se valor_total é null. Na dúvida entre total e parcela, use parcela.',
    ...LEITURA_DO_VALOR,
    a.produto === 'DBC' ? VALOR_DBC : VALOR_OUTROS,
    'Considere a conversa inteira: se o cliente já informou o total antes, continue devolvendo esse valor. Nunca devolva 0.',
  ].join('\n')
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${a.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(a.timeoutMs ?? 30_000),
    body: JSON.stringify({
      model: a.model,
      instructions: instrucoes,
      input: transcript,
      text: {
        format: {
          type: 'json_schema',
          name: 'leitura_valor',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['valor_total', 'valor_relacao', 'valor_tipo', 'valor_trecho'],
            properties: {
              valor_total: { type: ['integer', 'null'] },
              valor_relacao: { type: ['string', 'null'], enum: ['igual', 'acima_de', 'abaixo_de', null] },
              valor_tipo: { type: ['string', 'null'], enum: ['total', 'parcela', 'outro', null] },
              valor_trecho: { type: ['string', 'null'] },
            },
          },
        },
      },
    }),
  })
  const j = (await r.json().catch(() => null)) as any
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${j?.error?.message ?? 'erro'}`)
  const texto = (j.output ?? []).flatMap((o: any) => o.content ?? []).find((p: any) => p.type === 'output_text')?.text
  if (!texto) throw new Error('resposta vazia do modelo')
  const o = JSON.parse(texto)
  return { valorTotal: o.valor_total, valorRelacao: o.valor_relacao, valorTipo: o.valor_tipo, valorTrecho: o.valor_trecho, ms: Date.now() - t0 }
}
