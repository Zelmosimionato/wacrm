import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { startManualFlowRun } from '@/lib/flows/engine'

/**
 * Inicia um Fluxo pra um contato num ponto qualquer do grafo — usado
 * pela migração das reuniões já agendadas e, mais tarde, pelo Canal B
 * (lead agenda direto no Cal.com, sem passar pela Márcia) quando for
 * construído. Acha/cria a conversa sozinha — quem chama só precisa
 * saber o contactId.
 */
export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_ENGINE_SECRET
  const supplied = request.headers.get('x-engine-secret')
  if (!secret || supplied !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const { accountId, userId, contactId, flowId, entryNodeKey, initialVars } = body ?? {}
  if (!accountId || !userId || !contactId || !flowId) {
    return NextResponse.json({ error: 'accountId, userId, contactId e flowId sao obrigatorios' }, { status: 400 })
  }

  const db = supabaseAdmin()
  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  let conversationId = conv?.id as string | undefined
  if (!conversationId) {
    // Mesmas colunas que `resolveConversationId` (automations/engine.ts)
    // usa pra abrir conversa — nao inventar campo novo aqui.
    const { data: created, error } = await db
      .from('conversations')
      .insert({ account_id: accountId, user_id: userId, contact_id: contactId })
      .select('id')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    conversationId = created.id as string
  }

  const result = await startManualFlowRun(
    db, flowId, { accountId, contactId, conversationId }, { entryNodeKey, initialVars },
  )
  return NextResponse.json(result)
}
