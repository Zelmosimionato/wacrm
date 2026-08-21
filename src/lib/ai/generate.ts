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
  URGENTE_SENTINEL,
  AGENDAR_SENTINEL,
  AGENDAR_SENTINEL_ANTIGO,
  DESMARCAR_SENTINEL,
  PERDIDO_SENTINEL,
  PORTA_ABERTA_SENTINEL,
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
  // Prazo/urgência real na conversa: independente do destino do card, pode
  // vir junto com SUPER/QUALIFICADO na mesma resposta.
  const urgente = raw.includes(URGENTE_SENTINEL)
  // `[[AGENDAR]]` → a IA decidiu que é hora de mostrar horário pro lead. Não
  // reserva nada sozinha: quem marca (auto-reply) entrega o bastão pro Fluxo
  // de Agendamento, que mostra a lista real (WhatsApp) e reserva.
  const agendar = raw.includes(AGENDAR_SENTINEL)
  const text = [
    HANDOFF_SENTINEL,
    SUPER_SENTINEL,
    QUALIFIED_SENTINEL,
    REAGENDAR_SENTINEL,
    DESMARCAR_SENTINEL,
    PERDIDO_SENTINEL,
    PORTA_ABERTA_SENTINEL,
    URGENTE_SENTINEL,
    AGENDAR_SENTINEL,
  ]
    .reduce((acc, s) => acc.split(s).join(''), raw)
    // Limpeza DEFENSIVA do marcador ANTIGO (I2 da revisão de 20/08/2026): ele
    // não dispara mais ação nenhuma, mas se a IA ainda o escrever por inércia
    // de fine-tuning/exemplos antigos, isto evita que vaze literalmente pro
    // WhatsApp do cliente.
    .replace(AGENDAR_SENTINEL_ANTIGO, '')
    .trim()
  return { text, handoff, move, agendar, desmarcar, portaAberta, urgente, usage }
}
