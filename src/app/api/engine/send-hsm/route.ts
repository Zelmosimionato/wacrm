import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendTemplate } from '@/lib/automations/meta-send'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

// ============================================================
// Engine HSM sender — sends an approved template to a contact FROM the
// CRM engine so the message is LOGGED in the inbox (messages table),
// instead of going straight to Meta invisibly.
//
// Motivation: the nurture cron (no-show / re-engagement) used to call
// the raw `wa.js` sendTemplate — the message reached WhatsApp but never
// appeared in the CRM conversation, so the team couldn't see what had
// been sent. Routing through `engineSendTemplate` fixes that (same path
// the bot replies + appointment confirmation already use).
//
// Auth: shared `x-engine-secret` (same as /api/automations/engine and
// /api/appointments/confirm) — the caller (nurture) has no session. The
// account is resolved from the contact, never trusted from the body.
// ============================================================

interface Body {
  contact_id?: string
  template?: string
  language?: string
  params?: string[]
}

export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_ENGINE_SECRET
  const supplied = request.headers.get('x-engine-secret')
  if (!secret || supplied !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as Body | null
  if (!body?.contact_id || !body.template) {
    return NextResponse.json(
      { error: 'contact_id and template required' },
      { status: 400 },
    )
  }
  const templateName = String(body.template)
  const language = String(body.language ?? 'pt_BR')
  const params = Array.isArray(body.params) ? body.params.map((p) => String(p)) : []

  const db = supabaseAdmin()

  // Tenancy comes from the contact, not the request body.
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

  try {
    const { conversationId, contactId } = await resolveConversationByPhone(
      db,
      accountId,
      contact.phone as string,
      contactName,
    )
    const userId = await resolveAuditUserId(db, accountId)
    const res = await engineSendTemplate({
      accountId,
      userId,
      conversationId,
      contactId,
      templateName,
      language,
      params,
    })
    return NextResponse.json({ ok: true, whatsapp_message_id: res.whatsapp_message_id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[engine/send-hsm]', templateName, message)
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
