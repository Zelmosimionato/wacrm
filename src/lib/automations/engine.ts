import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  DealStageTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  MoveDealStepConfig,
  AssignConversationStepConfig,
} from '@/types'
import { supabaseAdmin } from './admin-client'
import { engineSendText, engineSendTemplate, engineSendInteractive } from './meta-send'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string
  /** The stage a deal entered, for deal_stage_changed. */
  stage_id?: string
  /** The deal's pipeline, for deal_stage_changed scoping. */
  pipeline_id?: string
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
/**
 * Alguma automação vai RESPONDER a esta mensagem?
 *
 * `new_message_received` entra junto de `keyword_match` porque ele casa com
 * TODA mensagem por definição — se tem passo que fala, fala sempre.
 *
 * O webhook pergunta isto antes de acordar a IA. Sem a pergunta, os dois
 * respondem a mesma frase: a automação manda a confirmação e a Márcia
 * manda a dela por cima, e o lead recebe duas mensagens dizendo a mesma
 * coisa com palavras diferentes.
 *
 * Só silencia a IA quem de fato FALA. Automação que apenas move card ou
 * põe etiqueta não tem por que calar a conversa — o lead perguntou algo e
 * continua sem resposta se ninguém falar.
 */
export async function automacaoVaiResponder(
  accountId: string,
  texto: string,
): Promise<boolean> {
  if (!texto) return false
  try {
    const db = supabaseAdmin()
    const { data: automations, error } = await db
      .from('automations')
      .select('*, automation_steps(step_type)')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['keyword_match', 'new_message_received'])
    if (error || !automations?.length) return false

    // ⛔ Os quatro passos que FALAM com o cliente. `send_interactive` nao
    // existe no motor (os nomes sao `send_buttons` e `send_list`): estava
    // nesta lista e nenhum dos dois entrava, entao automacao de botao nao
    // calava a IA e o lead levava resposta dobrada.
    const FALAM = ['send_message', 'send_template', 'send_buttons', 'send_list']
    for (const a of automations) {
      const passos = (a as { automation_steps?: { step_type: string }[] }).automation_steps ?? []
      if (!passos.some((p) => FALAM.includes(p.step_type))) continue
      if (triggerMatches(a as Automation, { message_text: texto })) return true
    }
    return false
  } catch (e) {
    // Na dúvida, a IA fala. Ficar mudo por causa de uma falha de consulta
    // deixaria o lead sem resposta nenhuma — pior que uma resposta a mais.
    console.error('[automations] checagem de resposta falhou:', e)
    return false
  }
}

/** Etapa "Perdido" do funil de vendas. */
const STAGE_PERDIDO = '0d0382a5-f15d-4e43-88aa-0c70337d94d4'

/** Passos que FALAM com o cliente. Os outros (etiqueta, card, webhook) seguem. */
const PASSOS_QUE_FALAM = ['send_message', 'send_template', 'send_buttons', 'send_list']

/**
 * Este contato está dado por PERDIDO?
 *
 * ⛔ Perdido é mudo. É decisão do escritório, e nenhuma automação tem o direito
 * de furá-la — em 12/08/2026 um lead perdido recebeu "vi que você precisou
 * cancelar o horário, pode reagendar por aqui", porque uma automação de etapa
 * disparou numa cadeia que ninguém tinha mapeado. Convidar de volta quem foi
 * dispensado é pior que não falar: contradiz o escritório na frente do cliente.
 *
 * Olha o card MAIS RECENTE, não "existe algum aberto": cliente fechado (won)
 * continua recebendo o que precisa receber.
 *
 * ⛔ Na dúvida — erro de consulta —, deixa FALAR. Uma trava que cala por falha
 * de leitura vira silêncio invisível, que é o defeito mais caro que tivemos.
 */
async function estaPerdido(contactId: string | null): Promise<boolean> {
  if (!contactId) return false
  try {
    const { data, error } = await supabaseAdmin()
      .from('deals')
      .select('status, stage_id')
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false })
      .limit(1)
    if (error || !data?.length) return false
    const card = data[0] as { status?: string; stage_id?: string }
    return card.status === 'lost' || card.stage_id === STAGE_PERDIDO
  } catch {
    return false
  }
}

export async function runAutomationsForTrigger(input: DispatchInput): Promise<void> {
  try {
    const db = supabaseAdmin()

    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr)
        return
      }
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return
      }
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true)

    if (error) {
      console.error('[automations] fetch failed:', error)
      return
    }
    if (!automations || automations.length === 0) return

    for (const automation of automations as Automation[]) {
      if (!triggerMatches(automation, input.context)) continue
      try {
        await executeAutomation(automation, input)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
}): Promise<void> {
  const db = supabaseAdmin()
  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .single()

  if (error || !automation) {
    console.error('[automations] resume: missing automation', pending.automation_id, error)
    await markPending(pending.id, 'failed')
    return
  }

  try {
    await executeStepsFrom({
      automation: automation as Automation,
      contactId: pending.contact_id,
      context: pending.context ?? {},
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    })
    await markPending(pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(automation: Automation, input: DispatchInput) {
  const db = supabaseAdmin()

  const { data: log, error: logErr } = await db
    .from('automation_logs')
    .insert({
      automation_id: automation.id,
      // Tenancy: matches automation.account_id (NOT NULL post-017).
      account_id: automation.account_id,
      // Audit: keeps the historical "author of this automation"
      // pointer so logs still attribute to the right user even
      // after teammates join the account.
      user_id: automation.user_id,
      contact_id: input.contactId ?? null,
      trigger_event: input.triggerType,
      steps_executed: [],
      status: 'success',
    })
    .select()
    .single()

  if (logErr || !log) {
    console.error('[automations] cannot create log:', logErr)
    return
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  })

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  const { error: rpcErr } = await db.rpc('increment_automation_execution_count', {
    p_automation_id: automation.id,
  })
  if (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr)
  }
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
}

async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  const db = supabaseAdmin()

  const baseQuery = db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', args.automation.id)
    .gte('position', args.startPosition)
    .order('position', { ascending: true })

  const scoped =
    args.parentStepId === null
      ? baseQuery.is('parent_step_id', null)
      : baseQuery.eq('parent_step_id', args.parentStepId).eq('branch', args.branch ?? 'yes')

  const { data: steps, error: stepsErr } = await scoped

  if (stepsErr) {
    await finalizeLog(args.logId, 'failed', stepsErr.message)
    return
  }
  if (!steps || steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null)
    }
    return
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps as AutomationStep[]) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      await db.from('automation_pending_executions').insert({
        automation_id: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: args.parentStepId,
        branch: args.branch,
        next_step_position: step.position + 1,
        context: args.context,
        run_at: new Date(Date.now() + ms).toISOString(),
        status: 'pending',
      })
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      status = 'partial'
      await appendResults(args.logId, results, status, errorMessage)
      return
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        continue
      }

      const detail = await runStep(step, args)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(args.logId, results, null, errorMessage)
  }
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  if (PASSOS_QUE_FALAM.includes(step.step_type) && (await estaPerdido(args.contactId))) {
    console.log(
      `[automations] ${step.step_type} PULADO — contato ${args.contactId} está em Perdido`,
    )
    return 'pulado: contato em Perdido'
  }
  const db = supabaseAdmin()

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = interpolate(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as SendButtonsStepConfig | SendListStepConfig
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`)
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload)
      if (!check.ok) throw new Error(check.error)
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        payload,
      })
      return `interactive sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      // Personalisation: resolve {{contact.*}} / {{name}} / {{nome}} tokens
      // in the template variables against the contact — so a native
      // automation can send e.g. {{1}} = the contact's first name. Values
      // with no token are kept verbatim (static), preserving old behaviour.
      let tplContact: {
        name: string | null
        phone: string | null
        email: string | null
        company: string | null
      } | null = null
      // Auto-fill: if the automation left the template variables empty,
      // default {{1}} to the contact's first name -- so "just move the card"
      // works without configuring the variable on every automation.
      const tplVars: Record<string, unknown> =
        cfg.variables && Object.keys(cfg.variables).length > 0
          ? cfg.variables
          : { '1': '{{nome}}' }
      const varsHaveToken = Object.values(tplVars).some(
        (v) => typeof v === 'string' && v.includes('{{'),
      )
      if (varsHaveToken) {
        const { data } = await db
          .from('contacts')
          .select('name, phone, email, company')
          .eq('id', args.contactId)
          .maybeSingle()
        tplContact =
          (data as {
            name: string | null
            phone: string | null
            email: string | null
            company: string | null
          } | null) ?? null
      }
      // Campos personalizados: {{campo.Nome do campo}}.
      // ⛔ Sem isto a automacao nao alcanca a data da reuniao nem o link do
      // Meet — e a confirmacao de agendamento sai sem justamente o que a torna
      // util. Ate 10/08/2026 essas regras so existiam em codigo por causa
      // disso: a tela nao tinha como ler o que o intake grava no contato.
      const camposDoContato: Record<string, string> = {}
      const pedeCampo = Object.values(tplVars).some(
        (v) => typeof v === 'string' && v.includes('{{campo.'),
      )
      if (pedeCampo && args.contactId) {
        const { data: cvs } = await db
          .from('contact_custom_values')
          .select('value, custom_fields!inner(field_name)')
          .eq('contact_id', args.contactId)
        for (const row of cvs ?? []) {
          const r = row as {
            value?: string | null
            custom_fields?: { field_name?: string } | { field_name?: string }[]
          }
          const f = r.custom_fields
          const nome = Array.isArray(f) ? f[0]?.field_name : f?.field_name
          if (nome) camposDoContato[nome.trim().toLowerCase()] = String(r.value ?? '')
        }
      }

      const tpl = tplContact
      const resolveTplVar = (raw: unknown): string => {
        let s = String(raw ?? '')
        s = s.replace(
          /\{\{\s*campo\.\s*([^}]+?)\s*\}\}/gi,
          (_m, nomeCampo: string) =>
            camposDoContato[String(nomeCampo).trim().toLowerCase()] ?? '',
        )
        const c = tpl
        if (!c) return s
        const firstName = c.name ? c.name.trim().split(/\s+/)[0] : ''
        return s
          .replace(
            /\{\{\s*contact\.(name|phone|email|company)\s*\}\}/gi,
            (_m, f: string) =>
              String((c as Record<string, unknown>)[f] ?? ''),
          )
          .replace(
            /\{\{\s*(first_name|primeiro_nome|nome)\s*\}\}/gi,
            () => firstName,
          )
          .replace(/\{\{\s*name\s*\}\}/gi, () => c.name ?? '')
      }

      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = Object.keys(tplVars)
        .sort((a, b) => {
          const na = Number(a)
          const nb = Number(b)
          const aNum = Number.isFinite(na)
          const bNum = Number.isFinite(nb)
          if (aNum && bNum) return na - nb
          if (aNum) return -1
          if (bNum) return 1
          return a.localeCompare(b)
        })
        .map((k) => resolveTplVar(tplVars[k]))
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'add_tag': {
      // contact_tags has no account_id column; cross-tenant protection for
      // the attacker-supplied contactId comes from the ownership guard in
      // runAutomationsForTrigger.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      await db
        .from('contact_tags')
        .upsert(
          { contact_id: args.contactId, tag_id: cfg.tag_id },
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
        )
      return `tag ${cfg.tag_id} added`
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.tag_id)
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      let agentId = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        // Pick any member of the account. The existing implementation
        // only ever returned the automation's author; preserving that
        // shape until a real round-robin algorithm replaces it.
        const { data: profiles } = await db
          .from('profiles')
          .select('user_id')
          .eq('account_id', args.automation.account_id)
          .limit(1)
        agentId = profiles?.[0]?.user_id
      }
      if (!agentId) return 'no agent resolved'
      await db
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
      return `assigned to ${agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args)

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`
        }
        // Defense in depth: the service-role client bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const { data: field } = await db
          .from('custom_fields')
          .select('id')
          .eq('id', customFieldId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        if (!field) {
          return `field ${cfg.field} not writable from automations`
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        await db
          .from('contact_custom_values')
          .upsert(
            { contact_id: args.contactId, custom_field_id: customFieldId, value },
            { onConflict: 'contact_id,custom_field_id' },
          )
        return `custom field updated`
      }

      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      await db
        .from('contacts')
        .update({ [cfg.field]: value, updated_at: new Date().toISOString() })
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      // Guard (added): do not double-card. Skip when the contact already
      // has an open deal (e.g. a lead that arrived via the form intake
      // already got one) or is a client (tag "Cliente") — clients are
      // not new leads. Applies to every create_deal automation.
      if (args.contactId) {
        const { data: openDeal } = await db
          .from('deals')
          .select('id')
          .eq('contact_id', args.contactId)
          .eq('status', 'open')
          .limit(1)
        if (openDeal && openDeal.length > 0) return 'deal skipped (open deal exists)'
        const { data: tagRows } = await db
          .from('contact_tags')
          .select('tags!inner(name)')
          .eq('contact_id', args.contactId)
        let isClient = false
        for (const r of tagRows ?? []) {
          const t = (r as { tags?: { name?: string } | { name?: string }[] }).tags
          if (Array.isArray(t)) { if (t.some((x) => x?.name === 'Cliente')) isClient = true }
          else if (t?.name === 'Cliente') isClient = true
        }
        if (isClient) return 'deal skipped (contact is a client)'
      }
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.automation.account_id)
        .maybeSingle()
      await db.from('deals').insert({
        // Tenancy + audit, same split as automation_logs above.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: args.contactId,
        title: await tituloDoCard(cfg.title, args, async (id) => {
          const { data } = await db.from('contacts').select('name, phone').eq('id', id).maybeSingle()
          return data as { name?: string | null; phone?: string | null } | null
        }),
        value: cfg.value ?? 0,
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      })
      return 'deal created'
    }

    case 'move_deal': {
      const cfg = step.step_config as MoveDealStepConfig
      if (!cfg.stage_id) throw new Error('move_deal needs a stage')
      if (!args.contactId) throw new Error('move_deal needs a contact')
      let q = db
        .from('deals')
        .select('id, stage_id')
        .eq('contact_id', args.contactId)
        .eq('status', 'open')
      if (cfg.pipeline_id) q = q.eq('pipeline_id', cfg.pipeline_id)
      const { data: deals } = await q.order('created_at', { ascending: false }).limit(1)
      const deal = (deals as { id: string; stage_id: string }[] | null)?.[0]
      if (!deal) return 'move skipped (no open deal)'
      if (deal.stage_id === cfg.stage_id && !cfg.status) return 'move skipped (already there)'
      const patch: Record<string, unknown> = { stage_id: cfg.stage_id }
      if (cfg.status) patch.status = cfg.status
      await db.from('deals').update(patch).eq('id', deal.id)
      // NAO dispara o gatilho deal_stage_changed de proposito: automacao que
      // move card disparando automacao que move card e um laco, e laco num
      // motor de envio foi o que mandou 417 mensagens em 09/08/2026. Se voce
      // quer que algo saia junto com a mudanca de etapa, ponha o passo de
      // enviar NA MESMA automacao, logo depois deste.
      return cfg.status ? `deal moved and closed as ${cfg.status}` : 'deal moved'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts).
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error('send_webhook: destination not allowed')
      }
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung/slow internal host can't tie up the runner.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      await db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
      return 'conversation closed'
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
/**
 * The conversation an automation acts on — found, or opened.
 *
 * Requiring one to already exist was wrong, and it failed exactly where
 * it mattered: someone who booked a meeting and never wrote on WhatsApp
 * has no thread, so moving their card to No-show sent nothing. That is
 * the whole point of a template — it is what Meta allows precisely when
 * there is no open 24-hour window to reply into.
 *
 * Same find-or-create the manual send does from the contact screen
 * (api/whatsapp/send), so both doors behave alike.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')

  const db = supabaseAdmin()
  const { data, error } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId)
    .maybeSingle()
  if (error) throw new Error(`conversation lookup failed: ${error.message}`)
  if (data?.id) return data.id as string

  const { data: criada, error: erroCriar } = await db
    .from('conversations')
    .insert({
      account_id: args.automation.account_id,
      user_id: args.automation.user_id,
      contact_id: args.contactId,
    })
    .select('id')
    .single()
  if (erroCriar) {
    throw new Error(`could not open a conversation: ${erroCriar.message}`)
  }
  return criada.id as string
}

export function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig
    if (!cfg?.keywords || cfg.keywords.length === 0) return false
    const text = (ctx?.message_text ?? '').toString()
    if (!text) return false
    const haystack = cfg.case_sensitive ? text : text.toLowerCase()
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase()
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig
    const replyId = ctx?.interactive_reply_id
    if (!replyId || !Array.isArray(cfg?.reply_ids) || cfg.reply_ids.length === 0) {
      return false
    }
    return cfg.reply_ids.includes(replyId)
  }

  if (automation.trigger_type === 'deal_stage_changed') {
    const cfg = automation.trigger_config as DealStageTriggerConfig
    if (!cfg?.stage_id) return false
    if (ctx?.stage_id !== cfg.stage_id) return false
    if (cfg.pipeline_id && ctx?.pipeline_id && ctx.pipeline_id !== cfg.pipeline_id) return false
    return true
  }

  return true
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  const db = supabaseAdmin()
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      // contact_tags has no account_id column (its RLS keys off the parent
      // contact), so tenant scoping here relies on the contact-ownership
      // guard in runAutomationsForTrigger.
      const { count } = await db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.operand)
      return (count ?? 0) > 0
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const { data } = await db
        .from('contacts')
        .select(cfg.operand)
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      const v = (data as Record<string, unknown> | null)?.[cfg.operand]
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

/**
 * O nome do card.
 *
 * ⛔ Card nasce com NOME DE GENTE. Até 11/08/2026 o título saía de
 * `interpolate`, que só conhece {{message.text}} e {{vars.*}} e não faz ideia
 * de quem é o contato. A automação de primeiro contato tinha "Lead (WhatsApp)"
 * cravado no lugar do nome, então TODO card criado por ela se chamava assim: o
 * funil virava uma coluna de cards idênticos, e o nome da pessoa só aparecia
 * na linha de baixo, pequeno.
 *
 * Entende {{contact.name}} e {{contact.phone}}. Vazio no fim — configuração em
 * branco, contato ainda sem nome — cai no nome e depois no telefone: um número
 * no card ainda diz quem é; um card anônimo não diz nada.
 */
export async function tituloDoCard(
  bruto: string | undefined,
  args: ExecuteArgs,
  buscarContato: (id: string) => Promise<{ name?: string | null; phone?: string | null } | null>,
): Promise<string> {
  const cru = String(bruto ?? '')
  const precisaContato = /\{\{\s*contact\.(name|phone)\s*\}\}/i.test(cru) || !cru.trim()
  const contato = precisaContato && args.contactId ? await buscarContato(args.contactId) : null
  const nome = String(contato?.name ?? '').trim()
  const fone = String(contato?.phone ?? '').trim()

  // ⛔ O contato entra ANTES do interpolate: ele apaga toda {{chave}} que não
  // conhece, e comeria {{contact.name}} antes de qualquer troca feita depois.
  // Rodando na ordem errada, o título saía certo só por cair no fallback — e o
  // teste passava pelo motivo errado.
  const comContato = cru
    .replace(/\{\{\s*contact\.name\s*\}\}/gi, nome)
    .replace(/\{\{\s*contact\.phone\s*\}\}/gi, fone)
  const resolvido = interpolate(comContato, args).trim()

  return resolvido || nome || fone || 'Lead'
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    return ''
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  const db = supabaseAdmin()
  const { data: existing } = await db
    .from('automation_logs')
    .select('steps_executed, status')
    .eq('id', logId)
    .single()
  const merged = [
    ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ?? []),
    ...newItems,
  ]
  const update: Record<string, unknown> = { steps_executed: merged }
  // Only overwrite status on the outermost scope — nested branches pass null.
  if (status !== null) {
    update.status = status
  }
  if (errorMessage) update.error_message = errorMessage
  await db.from('automation_logs').update(update).eq('id', logId)
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  await supabaseAdmin()
    .from('automation_logs')
    .update({ status, error_message: errorMessage })
    .eq('id', logId)
}

async function markPending(id: string, status: 'done' | 'failed') {
  await supabaseAdmin()
    .from('automation_pending_executions')
    .update({ status })
    .eq('id', id)
}
