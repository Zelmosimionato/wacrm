import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Send a plain message through the second number (WhatsApp Web).
 *
 * The gateway is transport only — it knows how to put text on the wire
 * and nothing about conversations. Ownership of the data stays here:
 * this route resolves the contact, asks the gateway to send, and only
 * then writes the row. A message that never left is never shown as sent.
 *
 * Unlike the official number there is no 24-hour window and no template:
 * that is the whole reason this channel exists.
 */

const GATEWAY = process.env.WAZAP_URL ?? 'http://127.0.0.1:3002'

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let corpo: { conversation_id?: string; content_text?: string }
  try {
    corpo = await request.json()
  } catch {
    return NextResponse.json({ erro: 'corpo inválido' }, { status: 400 })
  }

  const conversationId = corpo.conversation_id
  const texto = (corpo.content_text ?? '').trim()
  if (!conversationId || !texto) {
    return NextResponse.json(
      { erro: 'conversation_id e content_text são obrigatórios' },
      { status: 400 }
    )
  }

  // RLS answers "may this user touch this conversation?" — no separate
  // ownership check is needed, an outsider simply gets no row.
  const { data: conversa } = await supabase
    .from('conversations')
    .select('id, contact_id, contacts(phone_normalized, phone)')
    .eq('id', conversationId)
    .maybeSingle()

  if (!conversa) {
    return NextResponse.json({ erro: 'conversa não encontrada' }, { status: 404 })
  }

  const contato = Array.isArray(conversa.contacts)
    ? conversa.contacts[0]
    : conversa.contacts
  const telefone = (contato?.phone_normalized || contato?.phone || '').replace(/\D/g, '')
  if (!telefone) {
    return NextResponse.json({ erro: 'contato sem telefone' }, { status: 422 })
  }

  let enviada: { ok?: boolean; idMensagem?: string; erro?: string }
  try {
    const res = await fetch(`${GATEWAY}/enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefone, texto }),
      signal: AbortSignal.timeout(30_000),
    })
    enviada = await res.json().catch(() => ({}))
    if (!res.ok) {
      return NextResponse.json(
        { erro: enviada?.erro ?? 'o segundo número recusou o envio' },
        { status: res.status }
      )
    }
  } catch {
    return NextResponse.json(
      { erro: 'gateway do WhatsApp Web fora do ar' },
      { status: 503 }
    )
  }

  const agora = new Date().toISOString()

  const { data: mensagem, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: 'text',
      content_text: texto,
      message_id: enviada?.idMensagem ?? null,
      status: 'sent',
      channel: 'web',
    })
    .select()
    .single()

  if (error) {
    // It really did go out — say so instead of reporting a failure the
    // recipient would contradict.
    return NextResponse.json(
      { erro: 'mensagem enviada, mas não foi possível registrá-la: ' + error.message },
      { status: 500 }
    )
  }

  await supabase
    .from('conversations')
    .update({ last_message_text: texto, last_message_at: agora, last_channel: 'web' })
    .eq('id', conversationId)

  return NextResponse.json({ ok: true, message: mensagem })
}
