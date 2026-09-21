// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Card move the AI requested via a control marker, or null. */
  move: 'qualified' | 'super' | 'reagendar' | 'perdido' | null
  /** A pessoa avisou que não vem no horário marcado: desfazer a reserva no
   *  Cal.com e desligar os lembretes. Independente do destino do card. */
  desmarcar: boolean
  /** Recusou marcar agora: mandar a despedida com o botão "Agendar agora". */
  portaAberta: boolean
  /** Horário da agenda que a IA pediu para RESERVAR (1 = o primeiro da lista
   *  mostrada nesta resposta), ou null. É índice, nunca data: o modelo escolhe
   *  da lista lida do Cal.com e assim não tem como inventar horário. */
  agendar: number | null
  /** 20/09/2026 (caso Douglas Santos): a pessoa acabou de ESCOLHER um horário
   *  da lista, nesta mesma resposta, mas a IA ainda não tem o resto (e-mail,
   *  nome) pra fechar com `[[AGENDAR:N]]` na mesma mensagem — ou null se
   *  este turno não tratou disso. Mesmo índice do campo `agendar` acima,
   *  mas capturado MAIS CEDO: quem chama grava o horário resolvido
   *  (`conversations.horario_escolhido_iso`) na hora, pra nunca depender da
   *  IA lembrar a escolha num turno seguinte — mesma razão de `segmento`/
   *  `valor` existirem. */
  horarioEscolhido: number | null
  /** A pessoa acabou de confirmar se a dívida é pessoa física ou jurídica,
   *  nesta mesma resposta — ou null se este turno não tratou disso. Quem
   *  chama persiste a tag na hora; a trava de agendamento (auto-reply.ts)
   *  lê a tag persistida, não este campo, porque a confirmação pode ter
   *  vindo num turno anterior. */
  segmento: 'PF' | 'PJ' | null
  /** O valor aproximado/exato da dívida que a IA acabou de determinar,
   *  nesta mesma resposta — ou null se este turno não tratou disso. A
   *  trava de piso (auto-reply.ts) usa este campo pra decidir, na hora, se
   *  troca a resposta inteira por uma recusa — antes de qualquer coisa
   *  sair pro cliente. Mesmo padrão do `segmento` acima. */
  valor: number | null
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
