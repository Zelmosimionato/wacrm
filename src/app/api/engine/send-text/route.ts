import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendText } from '@/lib/flows/meta-send'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

// ============================================================
// Engine text sender — irmão do /api/engine/send-hsm, para mensagem de
// TEXTO LIVRE dentro da janela de 24h.
//
// Por que existe: o CRM sabia mandar template pela engine (send-hsm) e
// texto pela interface (sessão de usuário), mas não havia caminho para
// uma automação — ou para um atendimento assistido — mandar texto livre
// e ele APARECER no inbox. Sem isso, a alternativa era chamar a Meta
// direto e a mensagem sumia da conversa, que é justamente o problema
// que o send-hsm nasceu para resolver.
//
// ⚠️ Texto livre só é entregue dentro da janela de 24h desde a última
// mensagem da pessoa. Fora dela, a Meta recusa — use um template.
//
// Auth: mesmo `x-engine-secret` do send-hsm. A conta vem do contato,
// nunca do corpo da requisição.
// ============================================================

interface Body {
  contact_id?: string
  text?: string
}

export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_ENGINE_SECRET
  const supplied = request.headers.get('x-engine-secret')
  if (!secret || supplied !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as Body | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!body?.contact_id || !text) {
    return NextResponse.json(
      { error: 'contact_id and text required' },
      { status: 400 },
    )
  }

  const db = supabaseAdmin()

  const { data: contact } = await db
    .from('contacts')
    .select('id, account_id, phone, name')
    .eq('id', body.contact_id)
    .maybeSingle()
  if (!contact?.account_id || !contact.phone) {
    return NextResponse.json({ error: 'contact not found' }, { status: 404 })
  }
  const accountId = contact.account_id as string

  try {
    const { conversationId, contactId } = await resolveConversationByPhone(
      db,
      accountId,
      contact.phone as string,
      (contact.name as string | null) ?? null,
    )
    const userId = await resolveAuditUserId(db, accountId)
    const res = await engineSendText({
      accountId,
      userId,
      conversationId,
      contactId,
      text,
    })
    return NextResponse.json({ ok: true, whatsapp_message_id: res.whatsapp_message_id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[engine/send-text]', message)
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
