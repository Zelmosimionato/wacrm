import type { supabaseAdmin } from '@/lib/automations/admin-client'

/**
 * Envio pelo "segundo número" — WhatsApp Web/Evolution, sem a janela de
 * 24h nem template do número oficial (Meta). Extraído de `nutricao.ts`
 * (11/09/2026) pra ser reusado pelo motor de automações: qualquer passo
 * `send_message` que hoje só sabe falar com o oficial ganha o mesmo
 * fallback que a nutrição já usa havia semanas.
 */
const GATEWAY_SEGUNDO_NUMERO = process.env.WAZAP_URL ?? 'http://127.0.0.1:3002'

export async function enviarPeloSegundoNumero(telefone: string, texto: string): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY_SEGUNDO_NUMERO}/enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefone, texto }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      console.error('[segundo-numero] gateway recusou o envio:', res.status)
      return false
    }
    return true
  } catch (err) {
    console.error('[segundo-numero] gateway fora do ar:', err instanceof Error ? err.message : String(err))
    return false
  }
}

/** Registra no CRM uma mensagem que já saiu pelo segundo número — mesmo
 *  formato de linha que o envio pelo oficial deixaria, pra Inbox/relatório
 *  não distinguirem canal por acidente. */
export async function registrarEnvioSegundoNumero(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  texto: string,
): Promise<void> {
  await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'agent',
    content_type: 'text',
    content_text: texto,
    status: 'sent',
    channel: 'web',
  })
  await db
    .from('conversations')
    .update({ last_message_text: texto, last_message_at: new Date().toISOString(), last_channel: 'web' })
    .eq('id', conversationId)
}

/** A janela de 24h é sempre medida a partir da ÚLTIMA MENSAGEM DO LEAD
 *  (regra da Meta, não nossa) — nunca a partir de quando a conversa
 *  nasceu nem de quando nós escrevemos por último. */
export async function janelaAberta(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<boolean> {
  const { data: ultimaDoLead } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (
    !!ultimaDoLead &&
    Date.now() - new Date((ultimaDoLead as { created_at: string }).created_at).getTime() < 24 * 3600 * 1000
  )
}
