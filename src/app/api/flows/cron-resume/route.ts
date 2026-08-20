import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resumeWaitingFlow } from '@/lib/flows/engine'

/**
 * Drena `flow_pending_resumes` vencidos — o poller do nó `wait`.
 * Mesma autenticação e mesmo espírito do `/api/flows/cron` (sweep) e
 * do `/api/automations/cron`: URL própria, secret compartilhado.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('flow_pending_resumes')
    .select('id, flow_run_id, node_key')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('flow_pending_resumes')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      await resumeWaitingFlow(admin, row as { id: string; flow_run_id: string; node_key: string })
      await admin.from('flow_pending_resumes').update({ status: 'done' }).eq('id', row.id)
      processed++
    } catch (err) {
      console.error('[flows-cron-resume] resume failed:', row.id, err)
      await admin.from('flow_pending_resumes').update({ status: 'failed' }).eq('id', row.id)
    }
  }

  return NextResponse.json({ processed })
}
