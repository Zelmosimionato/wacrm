import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { supabaseAdmin } from '@/lib/automations/admin-client'

/**
 * Dispatch-only route: fire `deal_stage_changed` automations after a card
 * moved to a new stage. The client already persisted the stage change; this
 * route resolves the deal's contact/pipeline server-side (tenant-safe) and
 * runs the native automation engine in-process. Additive - it does not touch
 * the existing move/update path, so it cannot break the board.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let accountId: string
  try {
    const ctx = await requireRole('agent')
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  const admin = supabaseAdmin()
  const { data: deal } = await admin
    .from('deals')
    .select('id, contact_id, stage_id, pipeline_id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()

  if (!deal) {
    return NextResponse.json({ error: 'deal not found' }, { status: 404 })
  }

  await runAutomationsForTrigger({
    accountId,
    triggerType: 'deal_stage_changed',
    contactId: (deal.contact_id as string | null) ?? null,
    context: {
      stage_id: deal.stage_id as string,
      pipeline_id: deal.pipeline_id as string,
    },
  })

  return NextResponse.json({ ok: true })
}
