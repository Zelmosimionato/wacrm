import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import {
  HANDOFF_SENTINEL,
  QUALIFIED_SENTINEL,
  SUPER_SENTINEL,
  REAGENDAR_SENTINEL,
  AGENDAR_SENTINEL_RE,
  DESMARCAR_SENTINEL,
  PERDIDO_SENTINEL,
  PORTA_ABERTA_SENTINEL,
  PF_SENTINEL,
  PJ_SENTINEL,
  VALOR_SENTINEL_RE,
  aiRequestTimeoutMs,
} from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  // Ordem = precedência. "Perdido" ganha de tudo: se a pessoa disse que não
  // precisa mais, nenhum outro destino do card faz sentido.
  const move: GenerateResult['move'] = raw.includes(PERDIDO_SENTINEL)
    ? 'perdido'
    : raw.includes(SUPER_SENTINEL)
      ? 'super'
      : raw.includes(QUALIFIED_SENTINEL)
        ? 'qualified'
        : raw.includes(REAGENDAR_SENTINEL)
          ? 'reagendar'
          : null
  // Desmarcar é independente do destino do card: convive com o AGENDAR (desfaz
  // a antiga e marca a nova) e com o REAGENDAR (desfaz e o card espera).
  const desmarcar = raw.includes(DESMARCAR_SENTINEL)
  // Recusou marcar agora: a despedida sai com o botão "Agendar agora" atrás.
  const portaAberta = raw.includes(PORTA_ABERTA_SENTINEL)
  // `[[AGENDAR:2]]` → reservar o 2º horário da agenda desta resposta. Guardamos só o
  // número: quem marca (auto-reply) casa com a lista que ELE leu, e um número fora da
  // lista morre ali — o modelo nunca escreve a data.
  const mAgendar = raw.match(AGENDAR_SENTINEL_RE)
  const agendar = mAgendar ? Number(mAgendar[1]) : null
  // Segmento: PF/PJ confirmado NESTE turno. PJ ganha se, por algum motivo, os
  // dois vierem juntos (não deveria acontecer, mas a resposta não pode virar
  // "nenhum dos dois" por causa disso).
  const segmento: GenerateResult['segmento'] = raw.includes(PJ_SENTINEL)
    ? 'PJ'
    : raw.includes(PF_SENTINEL)
      ? 'PF'
      : null
  // `[[VALOR:9000]]` → valor da dívida que a IA acabou de determinar nesta
  // resposta. Mesmo padrão do AGENDAR: guardamos só o número.
  const mValor = raw.match(VALOR_SENTINEL_RE)
  const valor = mValor ? Number(mValor[1]) : null
  const text = [
    HANDOFF_SENTINEL,
    SUPER_SENTINEL,
    QUALIFIED_SENTINEL,
    REAGENDAR_SENTINEL,
    DESMARCAR_SENTINEL,
    PERDIDO_SENTINEL,
    PORTA_ABERTA_SENTINEL,
    PF_SENTINEL,
    PJ_SENTINEL,
  ]
    .reduce((acc, s) => acc.split(s).join(''), raw)
    .replace(new RegExp(AGENDAR_SENTINEL_RE.source, 'gi'), '')
    .replace(new RegExp(VALOR_SENTINEL_RE.source, 'gi'), '')
    .trim()
  return { text, handoff, move, agendar, segmento, valor, desmarcar, portaAberta, usage }
}
