import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Send a message — text or media — through the second number (WhatsApp Web).
 *
 * The gateway is transport only: it knows how to put text or a file on the
 * wire and nothing about conversations. Ownership of the data stays here:
 * this route resolves the contact, asks the gateway to send, and only
 * then writes the row. A message that never left is never shown as sent.
 *
 * Unlike the official number there is no 24-hour window and no template:
 * that is the whole reason this channel exists. Attachments were blocked
 * client-side until 19/08/2026 ("Anexos só saem pelo número oficial") —
 * the gateway only spoke text. Now it speaks both.
 */

const GATEWAY = process.env.WAZAP_URL ?? 'http://127.0.0.1:3002'

// Best-effort mimetype from the file extension — Evolution wants one, and
// nothing upstream of this route tracks it (SendMediaPayload only carries
// kind/mediaUrl/filename). Falls back to a generic type per media kind so
// an unknown extension still sends instead of failing outright.
const MIME_POR_EXTENSAO: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const MIME_PADRAO_POR_TIPO: Record<string, string> = {
  image: 'image/jpeg', video: 'video/mp4', audio: 'audio/mpeg', document: 'application/octet-stream',
}
function adivinharMimetype(nomeOuUrl: string | undefined, tipo: string): string {
  const ext = (nomeOuUrl ?? '').split(/[?#]/)[0].split('.').pop()?.toLowerCase()
  return (ext && MIME_POR_EXTENSAO[ext]) || MIME_PADRAO_POR_TIPO[tipo] || 'application/octet-stream'
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let corpo: {
    conversation_id?: string
    content_text?: string
    message_type?: string
    media_url?: string
    filename?: string
  }
  try {
    corpo = await request.json()
  } catch {
    return NextResponse.json({ erro: 'corpo inválido' }, { status: 400 })
  }

  const conversationId = corpo.conversation_id
  const texto = (corpo.content_text ?? '').trim()
  const mediaUrl = (corpo.media_url ?? '').trim() || undefined
  const mediaKind = mediaUrl ? corpo.message_type || 'document' : undefined
  if (!conversationId || (!texto && !mediaUrl)) {
    return NextResponse.json(
      { erro: 'conversation_id e (content_text ou media_url) são obrigatórios' },
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
      body: JSON.stringify({
        telefone,
        texto,
        media: mediaUrl
          ? {
              url: mediaUrl,
              mediatype: mediaKind,
              mimetype: adivinharMimetype(corpo.filename || mediaUrl, mediaKind!),
              filename: corpo.filename,
            }
          : undefined,
      }),
      signal: AbortSignal.timeout(60_000),
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
  const contentType = mediaKind ?? 'text'
  // Documents show their filename in the bubble when there's no caption —
  // same convention the official-channel send already uses.
  const contentText =
    contentType === 'document' ? texto || corpo.filename || 'Document' : texto

  const { data: mensagem, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: contentType,
      content_text: contentText || null,
      media_url: mediaUrl ?? null,
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
    .update({
      last_message_text: contentText || (mediaKind ? `[${mediaKind}]` : texto),
      last_message_at: agora,
      last_channel: 'web',
    })
    .eq('id', conversationId)

  return NextResponse.json({ ok: true, message: mensagem })
}
