import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { horariosLivres } from '@/lib/appointments/calcom-slots'

/** Horários livres do escritório, em rótulo pronto para a frase. Silencioso por
 *  desenho: sem chave, sem tipo de evento ou com a API fora, devolve [] e a IA
 *  simplesmente não fala de horário. */
async function horariosDoEscritorio(): Promise<string[]> {
  const chave = process.env.CALCOM_API_KEY
  const evento = process.env.CALCOM_EVENT_TYPE_ID
  if (!chave || !evento) return []
  const slots = await horariosLivres(evento, chave)
  return slots.map((s) => s.rotulo)
}

// Fase 3: the AI moves the deal card from the conversation (qualified /
// super / reschedule). The templates are sent by the STAGE automations;
// here we only MOVE the card and fire the stage trigger so they run.
const AI_VENDAS_PIPELINE = '8e89e154-763c-4cf8-b73b-42f7368c59c3'
const AI_STAGE_NOVO = 'f6c4e8c1-f13a-442a-9668-414cadb81c01'
const AI_STAGE_QUALIFICADO = '57bed09e-bc01-4691-8272-dcd8c3c078df'
const AI_STAGE_REAGENDAR = 'f2b7e7f6-c7d6-4d2b-ac6d-ad7842ab7045'
const AI_TAG_SUPER = 'b9298582-dcc7-46a3-ae34-f54b3c6fece1'

async function applyAiCardMove(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    accountId: string
    contactId: string
    move: 'qualified' | 'super' | 'reagendar'
  },
): Promise<void> {
  const { accountId, contactId, move } = args
  const { data: deals } = await db
    .from('deals')
    .select('id, stage_id')
    .eq('contact_id', contactId)
    .eq('pipeline_id', AI_VENDAS_PIPELINE)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
  const deal = (deals as { id: string; stage_id: string }[] | null)?.[0]
  if (!deal) return

  if (move === 'super') {
    const { count } = await db
      .from('contact_tags')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', contactId)
      .eq('tag_id', AI_TAG_SUPER)
    if (!count) {
      await db
        .from('contact_tags')
        .insert({ contact_id: contactId, tag_id: AI_TAG_SUPER })
    }
    // Alert the team by email - the CRM has no SMTP, so relay via the
    // intake mailer (shared secret). Fire-and-forget; never blocks.
    const notifySecret = process.env.AUTOMATION_ENGINE_SECRET
    if (notifySecret) {
      const { data: c } = await db
        .from('contacts')
        .select('name, phone')
        .eq('id', contactId)
        .maybeSingle()
      const contact = c as { name: string | null; phone: string | null } | null
      void fetch('http://127.0.0.1:3001/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-engine-secret': notifySecret },
        body: JSON.stringify({
          subject: `Lead SUPERQUALIFICADO (IA): ${contact?.name ?? 'sem nome'}`,
          body: `A IA identificou um lead SUPERQUALIFICADO (divida >= R$ 500 mil) na conversa. Nome: ${contact?.name ?? '-'} | WhatsApp: ${contact?.phone ?? '-'} | Card em Lead Qualificado + tag Superqualificado. Ver: https://crm.simionatoadvogados.com.br`,
        }),
      }).catch(() => {})
    }
  }

  let target: string | null = null
  if (move === 'qualified' || move === 'super') {
    // Only advance from the initial stage; never drag a booked lead back.
    if (deal.stage_id === AI_STAGE_NOVO) target = AI_STAGE_QUALIFICADO
  } else if (move === 'reagendar') {
    if (deal.stage_id !== AI_STAGE_REAGENDAR) target = AI_STAGE_REAGENDAR
  }
  if (!target) return

  await db.from('deals').update({ stage_id: target }).eq('id', deal.id)
  await runAutomationsForTrigger({
    accountId,
    triggerType: 'deal_stage_changed',
    contactId,
    context: { stage_id: target, pipeline_id: AI_VENDAS_PIPELINE },
  })
}

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

const CLIENT_MODE_BLOCK =
  'ATENCAO - MODO CLIENTE (prioridade maxima, sobrepoe QUALQUER instrucao de qualificacao acima): este contato JA E CLIENTE do escritorio, nao e um lead novo. NUNCA faca qualificacao com ele: nao pergunte o nome, nao pergunte o valor da divida, nao peca dados, nao aplique criterio de valor e nao envie link de agendamento. Trate como atendimento de cliente: acolha com empatia, confirme que recebemos a mensagem e informe que a equipe/o advogado responsavel vai verificar o andamento do caso dele e retornar em breve. Responda em no maximo 2 frases curtas e cordiais. Nao prometa prazos nem resultados, nao invente nada sobre o processo. Mesmo que o cliente esteja aflito ou reclamando, RESPONDA com esse acolhimento - NAO use o protocolo de transferencia ([[HANDOFF]]); o encaminhamento para um humano e feito automaticamente pelo sistema depois da sua resposta.'

/**
 * A contact counts as "returning" if their newest-but-one message in the
 * (reused) conversation is at least this far before the current inbound —
 * i.e. they went quiet and came back, rather than double-texting.
 */
const RETURNING_GAP_MS = 6 * 60 * 60 * 1000

/**
 * Contact tags that represent qualification we already did — echoed back
 * to the model so it doesn't re-ask what the funnel already knows. (Life-
 * cycle tags like "Novo Lead" / "Agendou" / "Cliente" are handled by the
 * state logic, not listed here.)
 */
const QUAL_TAGS = ['Superqualificado', 'Desqualificado', 'Bancário', 'Tributário', 'PF', 'PJ']

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Pull a usable first name from the stored contact name. The inbound
 * webhook stores the WhatsApp profile name in `contacts.name`, falling
 * back to the phone when the profile has none — so a "name" that is just
 * the phone (or otherwise has no letters) is treated as illegible.
 */
export function legibleFirstName(
  name?: string | null,
  phone?: string | null,
): string | null {
  if (!name) return null
  const n = name.trim()
  if (n.length < 2) return null
  if (!/\p{L}/u.test(n)) return null // no letters → junk / a bare number
  const digitsOnly = (s: string) => s.replace(/\D/g, '')
  if (phone && digitsOnly(n) && digitsOnly(n) === digitsOnly(phone)) return null
  const token = n.split(/\s+/)[0]
  // Normalise an ALL-CAPS or all-lower token to Title case for the
  // greeting ("DANUZE" → "Danuze"); leave mixed-case names untouched.
  if (token === token.toUpperCase() || token === token.toLowerCase()) {
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
  }
  return token
}

/**
 * Build the per-conversation context block appended to the system prompt.
 * Mirrors the CLIENT_MODE_BLOCK pattern: it augments the account's saved
 * SDR prompt with what we already know about THIS contact, without
 * editing it.
 *
 * States (highest first): client (its own block), already-had-a-meeting,
 * known/returning lead (has data but hasn't closed), brand-new. The whole
 * point: never re-ask data the CRM already has, and never treat a known
 * contact as a first-timer.
 */
export function buildContactContextBlock(args: {
  firstName: string | null
  email: string | null
  qualTags: string[]
  isClient: boolean
  hasMeeting: boolean
  isReturning: boolean
}): string | null {
  const { firstName, email, qualTags, isClient, hasMeeting, isReturning } = args

  // Client mode already has CLIENT_MODE_BLOCK — just give it the name.
  if (isClient) {
    if (!firstName) return null
    return (
      'CONTEXTO DO CONTATO (prioridade alta):\n' +
      `- O nome do contato (pelo WhatsApp) é "${firstName}". Trate-o pelo primeiro nome.`
    )
  }

  const knownLead =
    hasMeeting || isReturning || !!email || qualTags.length > 0

  // Brand-new inbound: only the WhatsApp name is known.
  if (!knownLead) {
    if (!firstName) return null
    return (
      'CONTEXTO DO CONTATO (prioridade alta):\n' +
      `- O nome do contato (identificado pelo WhatsApp) é "${firstName}". Trate-o pelo primeiro nome e NÃO pergunte o nome — você já o conhece (isto SOBREPÕE qualquer instrução acima de pedir o nome).`
    )
  }

  // Known lead: list what we already have and forbid re-collecting it.
  const lines: string[] = [
    'DADOS QUE JÁ TEMOS DESTE CONTATO (use isto; NÃO peça de novo o que já está aqui e NÃO recomece a qualificação do zero — continue de onde parou):',
  ]
  if (firstName) lines.push(`- Nome: ${firstName} — trate pelo nome; não pergunte o nome.`)
  if (email) lines.push(`- E-mail: ${email} — não peça de novo.`)
  if (qualTags.length > 0)
    lines.push(`- Já classificado: ${qualTags.join(', ')} — não repita essa qualificação.`)

  if (hasMeeting) {
    lines.push(
      `- Situação: JÁ agendou/teve uma reunião com o escritório. Não requalifique. Se for dúvida simples/logística (reagendar, horário, documentos), ajude com naturalidade; se for sobre o caso/andamento ou precisar do advogado, acolha e explique que a equipe responsável vai retornar — nunca invente nada sobre o processo.`,
    )
  } else {
    lines.push(
      `- Situação: já falou com o escritório antes e ainda não fechou. Cumprimente reconhecendo o retorno${firstName ? ` (ex.: "Que bom te ver de novo, ${firstName}!")` : ''}; não recomece a coleta de dados; ajude a avançar — se ainda não há reunião marcada, conduza ao agendamento; se tiver dúvida, responda ou encaminhe.`,
    )
  }

  return lines.join('\n')
}

/**
 * Split an AI reply into separate WhatsApp bubbles on blank lines, so the
 * bot can send e.g. a greeting and then a question as two messages, like a
 * human types. Capped so a long reply cannot fan out into a wall of pings;
 * overflow is merged back into the last bubble rather than dropped.
 */
function splitBubbles(text: string): string[] {
  const parts = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length <= 1) return [text.trim()]
  const MAX = 4
  if (parts.length <= MAX) return parts
  return [...parts.slice(0, MAX - 1), parts.slice(MAX - 1).join('\n\n')]
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    // One read of this contact's tags drives three things: existing
    // clients (tag "Cliente") never get lead qualification; contacts who
    // already booked/attended a meeting (tag "Agendou") must not be
    // re-qualified; and any qualification tags are echoed back so the
    // model doesn't re-ask what we already know.
    let isClient = false
    let hasMeeting = false
    let qualTags: string[] = []
    {
      const { data: tagRows } = await db
        .from('contact_tags')
        .select('tags!inner(name)')
        .eq('contact_id', contactId)
      const names = new Set<string>()
      for (const r of tagRows ?? []) {
        const t = (r as { tags?: { name?: string } | { name?: string }[] }).tags
        if (Array.isArray(t)) t.forEach((x) => x?.name && names.add(x.name))
        else if (t?.name) names.add(t.name)
      }
      isClient = names.has('Cliente')
      hasMeeting = names.has('Agendou')
      qualTags = QUAL_TAGS.filter((t) => names.has(t))
    }

    // Contact's WhatsApp name + e-mail (used to greet by name and skip the
    // data-collection steps we already have) and whether they're returning.
    const { data: contactRow } = await db
      .from('contacts')
      .select('name, phone, email')
      .eq('id', contactId)
      .maybeSingle()
    const firstName = legibleFirstName(contactRow?.name, contactRow?.phone)
    const email = contactRow?.email?.trim() || null

    let isReturning = false
    if (!isClient && !hasMeeting) {
      // (a) we reached them in a past broadcast (e.g. a re-engagement
      //     disparo) and now they're replying.
      const { data: bc } = await db
        .from('broadcast_recipients')
        .select('id')
        .eq('contact_id', contactId)
        .in('status', ['sent', 'delivered', 'read', 'replied'])
        .limit(1)
      if (bc && bc.length > 0) isReturning = true

      // (b) or there's an earlier message session in this reused
      //     conversation (a real gap before the current inbound).
      if (!isReturning) {
        const { data: msgs } = await db
          .from('messages')
          .select('created_at')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: false })
          .limit(50)
        if (msgs && msgs.length > 1) {
          const newest = new Date(msgs[0].created_at).getTime()
          isReturning = msgs
            .slice(1)
            .some(
              (m) => newest - new Date(m.created_at).getTime() > RETURNING_GAP_MS,
            )
        }
      }
    }

    // AGENDA REAL — lida antes de responder, para a IA DIZER horário em vez de inventar.
    // ⛔ Falha na consulta devolve lista vazia, e o prompt então a proíbe de falar de
    // horário: melhor responder sem horário nenhum do que com horário que não existe.
    const horarios = await horariosDoEscritorio()

    let systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      horarios,
    })
    if (isClient) systemPrompt += '\n\n' + CLIENT_MODE_BLOCK
    const contextBlock = buildContactContextBlock({
      firstName,
      email,
      qualTags,
      isClient,
      hasMeeting,
      isReturning,
    })
    if (contextBlock) systemPrompt += '\n\n' + contextBlock

    const { text, handoff, move, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    // Send as one or more WhatsApp bubbles. The model separates bubbles
    // with a blank line (e.g. greeting, then the question). This is still
    // ONE logical reply — the per-conversation slot was claimed once
    // above, so extra bubbles do NOT each consume a slot. A short gap
    // between sends preserves order and feels human.
    const bubbles = splitBubbles(text)
    for (let i = 0; i < bubbles.length; i++) {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: bubbles[i],
        aiGenerated: true,
      })
      if (i < bubbles.length - 1) await sleep(900)
    }

    // Fase 3: act on the AI's card-move marker (after the reply is sent).
    if (move && !isClient) {
      try {
        await applyAiCardMove(db, { accountId, contactId, move })
      } catch (err) {
        console.error('[ai auto-reply] card move failed:', err)
      }
    }

    // Existing client: the AI acknowledged in client mode; now hand the
    // thread to a human - the bot must not field questions about the case.
    if (isClient) {
      const clientUpdate: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary:
          'Cliente existente - atendimento sobre o caso. A IA acolheu e encaminhou para um humano (nao qualifica cliente).',
      }
      if (config.handoffAgentId) clientUpdate.assigned_agent_id = config.handoffAgentId
      await db.from('conversations').update(clientUpdate).eq('id', conversationId)
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
