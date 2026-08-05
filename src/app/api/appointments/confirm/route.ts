import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendText, engineSendTemplate } from '@/lib/automations/meta-send'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

// ============================================================
// Appointment confirmation — sent BY the CRM when a booking lands.
//
// The Cal.com intake used to fire the `confirmacao_agendamento`
// template itself. That send now lives here so the CRM owns it:
//   - inside the 24h customer-service window  -> a natural free-text
//     message, logged in the inbox like any bot reply;
//   - outside the window (lead booked without ever messaging us) ->
//     Meta only allows an approved template, so we fall back to
//     `confirmacao_agendamento`.
//
// Auth: the shared `x-engine-secret` (same as /api/automations/engine),
// since the caller (intake) has no session. The account is resolved
// from the contact, never trusted from the request body.
// ============================================================

const CONFIRM_TEMPLATE = 'confirmacao_agendamento'
const WINDOW_MS = 24 * 60 * 60 * 1000

interface ConfirmBody {
  contact_id?: string
  /** Human date already formatted by the caller, e.g. "05/08/2026, 17:00". */
  date?: string
  /** Meeting URL (all events have one). */
  link?: string
}

function firstName(name: string | null): string {
  return name ? name.trim().split(/\s+/)[0] : ''
}

function buildText(name: string | null, date: string, link: string): string {
  const first = firstName(name)
  const hi = first ? `Olá, ${first}!` : 'Olá!'
  const full = (name && name.trim()) || first || 'Você'
  return [
    '✅ *Reunião confirmada!*',
    '',
    `${hi} Seu horário com o Simionato Advogados está reservado:`,
    '',
    `📅 ${date}`,
    `👤 ${full} — Simionato Advogados`,
    `🔗 ${link}`,
    '',
    'Separamos esse horário exclusivamente para analisar o seu caso com um advogado especializado. Por isso, contamos com a sua presença. 🙏 Se precisar remarcar, é só me avisar por aqui.',
  ].join('\n')
}

export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_ENGINE_SECRET
  const supplied = request.headers.get('x-engine-secret')
  if (!secret || supplied !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as ConfirmBody | null
  if (!body?.contact_id || !body.date) {
    return NextResponse.json(
      { error: 'contact_id and date required' },
      { status: 400 },
    )
  }
  const date = String(body.date)
  const link = String(body.link ?? '').trim()

  const db = supabaseAdmin()

  // Account is derived from the contact — the secret authenticates the
  // caller, but tenancy is never taken from the body.
  const { data: contact } = await db
    .from('contacts')
    .select('id, account_id, phone, name')
    .eq('id', body.contact_id)
    .maybeSingle()
  if (!contact?.account_id || !contact.phone) {
    return NextResponse.json({ error: 'contact not found' }, { status: 404 })
  }
  const accountId = contact.account_id as string
  const contactName = (contact.name as string | null) ?? null

  // Find-or-create the conversation + resolve the audit user with the
  // same helpers the public send path uses.
  const { conversationId, contactId } = await resolveConversationByPhone(
    db,
    accountId,
    contact.phone as string,
    contactName,
  )
  const userId = await resolveAuditUserId(db, accountId)

  // 24h window = time since the contact's last inbound ('customer')
  // message. Never messaged us -> treat as closed (template only).
  const { data: lastIn } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const windowOpen =
    !!lastIn?.created_at &&
    Date.now() - new Date(lastIn.created_at as string).getTime() < WINDOW_MS

  const common = { accountId, userId, conversationId, contactId }

  try {
    if (windowOpen) {
      try {
        await engineSendText({ ...common, text: buildText(contactName, date, link) })
        return NextResponse.json({ ok: true, mode: 'text' })
      } catch (err) {
        // The window may have just closed, or Meta rejected the
        // free-form send — fall through to the approved template so a
        // confirmation still lands.
        const m = err instanceof Error ? err.message : String(err)
        console.warn('[appointments/confirm] free-text failed, using template:', m)
      }
    }
    await engineSendTemplate({
      ...common,
      templateName: CONFIRM_TEMPLATE,
      language: 'pt_BR',
      params: [firstName(contactName), date, link],
    })
    return NextResponse.json({ ok: true, mode: 'template' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[appointments/confirm]', message)
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
