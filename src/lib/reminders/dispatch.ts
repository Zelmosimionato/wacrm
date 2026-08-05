import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendTemplate } from '@/lib/automations/meta-send'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

// ============================================================
// Appointment reminders — the CRM's "relógio".
//
// Runs from the same 60s instrumentation tick as the broadcast
// dispatcher (no external cron). For every contact tagged "Agendou"
// with a future meeting (CF_DATA_ISO), it sends:
//   - lembrete_1h_antes  -> ~1h before the meeting;
//   - the véspera reminder -> afternoon (12h–18h SP) of the day before.
//
// Idempotency is read straight off the `messages` table (a reminder
// template already sent within the relevant window = skip), so there is
// no extra bookkeeping table to migrate. Brazil dropped DST in 2019, so
// São Paulo is a fixed UTC-3.
// ============================================================

const TAG_AGENDOU = 'c0278b4c-8f17-416e-a7e4-b66b6e78315a'
const CF_DATA = 'e7935f62-b9f6-414b-9cde-b3c7315c0f11' // "Data agendamento" (humano)
const CF_DATA_ISO = 'e482845b-8ed4-4f4d-ae0e-0eed9dafbe4e' // ISO cru
const CF_LOCAL = '62721dd7-92f9-4587-b3db-65a8e1a51120' // link/local do Meet
const SP_OFFSET_MS = 3 * 60 * 60_000 // UTC-3, sem horário de verão

const HOUR = 60 * 60_000
const MIN = 60_000

interface ReminderDef {
  key: string
  enabled: boolean
  template: string
  due: (nowMs: number, meetingMs: number) => boolean
  dedupSinceMs: (meetingMs: number) => number
}

const REMINDERS: ReminderDef[] = [
  {
    key: '1h',
    enabled: true,
    template: 'lembrete_1h_antes',
    due: (now, m) => now >= m - 60 * MIN && now <= m - 30 * MIN,
    dedupSinceMs: (m) => m - 2 * HOUR,
  },
  {
    key: 'vespera',
    // Liga quando `lembrete_vespera_confirma` (com botões) for aprovado na Meta.
    enabled: true,
    template: 'lembrete_vespera_confirma',
    due: (now, m) => vesperaDue(now, m),
    dedupSinceMs: (m) => m - 25 * HOUR,
  },
]

// Véspera: 12h–18h (São Paulo) do dia anterior à reunião.
function vesperaDue(nowMs: number, meetingMs: number): boolean {
  if (nowMs >= meetingMs) return false
  const sp = new Date(meetingMs - SP_OFFSET_MS) // lê os campos UTC como hora de SP
  const y = sp.getUTCFullYear()
  const mo = sp.getUTCMonth()
  const d = sp.getUTCDate()
  const start = Date.UTC(y, mo, d - 1, 12) + SP_OFFSET_MS
  const end = Date.UTC(y, mo, d - 1, 18) + SP_OFFSET_MS
  return nowMs >= start && nowMs <= end
}

function firstName(name: string | null): string {
  return name ? name.trim().split(/\s+/)[0] : ''
}

export async function dispatchDueReminders(): Promise<void> {
  const active = REMINDERS.filter((r) => r.enabled)
  if (active.length === 0) return

  const db = supabaseAdmin()
  const now = Date.now()
  const nowISO = new Date(now).toISOString()
  const horizonISO = new Date(now + 31 * HOUR).toISOString()

  // Reuniões candidatas: CF_DATA_ISO em [agora, agora+31h]. ISO-Z ordena
  // lexicograficamente, então gte/lte no texto funciona como filtro de tempo.
  const { data: rows } = await db
    .from('contact_custom_values')
    .select('contact_id, value')
    .eq('custom_field_id', CF_DATA_ISO)
    .gte('value', nowISO)
    .lte('value', horizonISO)
  const candidates = (rows ?? []) as { contact_id: string; value: string }[]
  if (candidates.length === 0) return

  let userId: string | null = null

  for (const cand of candidates) {
    const meetingMs = new Date(cand.value).getTime()
    if (!Number.isFinite(meetingMs)) continue
    const due = active.find((r) => r.due(now, meetingMs))
    if (!due) continue

    // Ainda é um agendamento ativo? (tag "Agendou" presente; cancelar a remove)
    const { data: tag } = await db
      .from('contact_tags')
      .select('contact_id')
      .eq('contact_id', cand.contact_id)
      .eq('tag_id', TAG_AGENDOU)
      .maybeSingle()
    if (!tag) continue

    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('contact_id', cand.contact_id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    const conversationId = conv?.id as string | undefined
    if (!conversationId) continue

    // Idempotência: já mandei esse template dentro da janela dessa reunião?
    const { data: already } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('template_name', due.template)
      .gte('created_at', new Date(due.dedupSinceMs(meetingMs)).toISOString())
      .limit(1)
      .maybeSingle()
    if (already) continue

    const { data: contact } = await db
      .from('contacts')
      .select('id, name, account_id')
      .eq('id', cand.contact_id)
      .maybeSingle()
    const accountId = contact?.account_id as string | undefined
    if (!accountId) continue

    // Os dois campos que os templates precisam: data (humana) + link.
    const { data: cvs } = await db
      .from('contact_custom_values')
      .select('custom_field_id, value')
      .eq('contact_id', cand.contact_id)
      .in('custom_field_id', [CF_DATA, CF_LOCAL])
    const byField: Record<string, string> = {}
    for (const cv of (cvs ?? []) as { custom_field_id: string; value: string }[]) {
      byField[cv.custom_field_id] = cv.value
    }
    const dataHuman = byField[CF_DATA] ?? cand.value
    const link = byField[CF_LOCAL] ?? ''

    if (!userId) userId = await resolveAuditUserId(db, accountId)

    try {
      await engineSendTemplate({
        accountId,
        userId,
        conversationId,
        contactId: contact!.id as string,
        templateName: due.template,
        language: 'pt_BR',
        params: [firstName((contact!.name as string | null) ?? null), dataHuman, link],
      })
      console.log(`[reminders] ${due.key} -> ${due.template} enviado (contact ${contact!.id})`)
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      console.error(`[reminders] falha ${due.key} contact ${contact!.id}:`, m)
    }
  }
}
