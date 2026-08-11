import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Open the conversation for a contact who has never written.
 *
 * Someone who booked a meeting through a form and never messaged has no
 * thread, so there was nowhere to type — the card offered a template and
 * nothing else. With the second number that restriction is gone: the
 * thread can simply be opened and written into.
 *
 * Idempotent: an existing conversation is returned as-is, so pressing
 * the button twice never leaves two threads for the same person.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let corpo: { contact_id?: string }
  try {
    corpo = await request.json()
  } catch {
    return NextResponse.json({ erro: 'corpo inválido' }, { status: 400 })
  }
  if (!corpo.contact_id) {
    return NextResponse.json({ erro: 'contact_id é obrigatório' }, { status: 400 })
  }

  // RLS decides whether this contact is visible to the caller; an
  // outsider simply gets no row back.
  const { data: contato } = await supabase
    .from('contacts')
    .select('id, account_id')
    .eq('id', corpo.contact_id)
    .maybeSingle()
  if (!contato) {
    return NextResponse.json({ erro: 'contato não encontrado' }, { status: 404 })
  }

  const { data: existente } = await supabase
    .from('conversations')
    .select('id')
    .eq('contact_id', contato.id)
    .maybeSingle()
  if (existente) {
    return NextResponse.json({ conversation_id: existente.id, criada: false })
  }

  const { data: criada, error } = await supabase
    .from('conversations')
    .insert({
      contact_id: contato.id,
      account_id: contato.account_id,
      user_id: user.id,
      status: 'open',
    })
    .select('id')
    .single()

  if (error) {
    return NextResponse.json(
      { erro: 'não foi possível abrir a conversa: ' + error.message },
      { status: 500 }
    )
  }

  return NextResponse.json({ conversation_id: criada.id, criada: true })
}
