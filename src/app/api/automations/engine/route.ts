import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import type { AutomationTriggerType } from '@/types'

/**
 * Fire automations for a trigger. Two auth paths:
 *
 *  (1) Logged-in agent (UI / manual test) — account_id comes from session.
 *  (2) Trusted service caller presenting the shared secret in the
 *      `x-engine-secret` header (matches AUTOMATION_ENGINE_SECRET). Has no
 *      session, so account_id is resolved from the contact. This is what
 *      makes `tag_added` actually fire natively for tags added ANYWHERE —
 *      the wacrm template shipped the trigger in the UI but never
 *      dispatched it. A Supabase Database Webhook on `contact_tags` INSERT
 *      points here, so every tag-add (UI, API, import, the Cal.com/form
 *      intake) wakes the native automations.
 *
 * The Supabase DB-webhook payload shape is handled directly:
 *   { type:'INSERT', table:'contact_tags', record:{ contact_id, tag_id } }
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const secret = process.env.AUTOMATION_ENGINE_SECRET
  const supplied = request.headers.get('x-engine-secret')
  const isService = !!secret && supplied === secret

  if (isService) {
    const record = (body.record ?? {}) as Record<string, unknown>
    // A contact_tags INSERT webhook implies a tag_added trigger.
    const triggerType =
      (body.trigger_type as AutomationTriggerType | undefined) ??
      (body.table === 'contact_tags' ? 'tag_added' : undefined)
    const contactId =
      (body.contact_id as string | undefined) ??
      (record.contact_id as string | undefined) ??
      null
    const tagId =
      (body.tag_id as string | undefined) ??
      (record.tag_id as string | undefined) ??
      undefined

    if (!triggerType || !contactId) {
      return NextResponse.json(
        { error: 'service call needs trigger_type (or contact_tags table) and a contact' },
        { status: 400 },
      )
    }

    // No session on a webhook — resolve the tenant from the contact.
    const admin = supabaseAdmin()
    const { data: contact } = await admin
      .from('contacts')
      .select('account_id')
      .eq('id', contactId)
      .maybeSingle()
    const accountId = contact?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json({ error: 'contact not found' }, { status: 404 })
    }

    const context =
      (body.context as Record<string, unknown> | undefined) ??
      (tagId ? { tag_id: tagId } : {})

    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId,
      context,
    })
    return NextResponse.json({ ok: true })
  }

  // Session path (UI / manual test). Firing sends outbound WhatsApp — a
  // write action — so require at least `agent`.
  let accountId: string
  try {
    const ctx = await requireRole('agent')
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  if (!body.trigger_type) {
    return NextResponse.json({ error: 'trigger_type required' }, { status: 400 })
  }

  await runAutomationsForTrigger({
    accountId,
    triggerType: body.trigger_type as AutomationTriggerType,
    contactId: body.contact_id ?? null,
    context: body.context ?? {},
  })

  return NextResponse.json({ ok: true })
}
