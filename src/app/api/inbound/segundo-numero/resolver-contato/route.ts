import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { SendMessageError } from '@/lib/whatsapp/send-message'

/**
 * Encontra (ou cria) o contato + conversa pro segundo número (Evolution),
 * quando `guardarRecebida` (wazap.js) topa um telefone que ainda não é
 * contato no CRM.
 *
 * Por que existe: até 10/09/2026 esse caso era só descartado — comentário
 * original dizia "o CRM tem regra própria de criação de contato, e
 * duplicar essa regra aqui geraria dois donos". A regra permanece — só
 * que agora o segundo número CHAMA a regra do CRM em vez de reimplementá-
 * la: reusa `resolveConversationByPhone`, a mesma função que a API pública
 * (`/api/v1/messages`) e o webhook oficial usam pra achar-ou-criar contato,
 * com a MESMA tolerância de dedupe (`findExistingContact`/`phonesMatch`).
 *
 * Conta: o segundo número não tem `whatsapp_config` próprio (não é canal
 * Meta). Como hoje só a conta com WhatsApp oficial conectado usa esse
 * canal na prática, herdamos o `account_id` de lá em vez de fixar um UUID
 * no código — se um dia outra conta conectar o WhatsApp oficial, decidir
 * qual delas é "dona" do segundo número volta a ser uma escolha humana,
 * não um bug silencioso.
 *
 * Mesmo contrato de "trusted service caller" que `/api/inbound/segundo-numero`
 * já usa (segredo compartilhado via header, lido do .env do wacrm).
 */
export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_ENGINE_SECRET
  const supplied = request.headers.get('x-engine-secret')
  if (!secret || supplied !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const phone = (body?.phone as string | undefined)?.trim()
  const name = (body?.name as string | null | undefined) || null
  if (!phone) {
    return NextResponse.json({ error: 'phone é obrigatório' }, { status: 400 })
  }

  const db = supabaseAdmin()

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('account_id')
    .limit(1)
    .maybeSingle()
  if (configError || !config) {
    console.error('[inbound/segundo-numero/resolver-contato] sem whatsapp_config —', configError)
    return NextResponse.json({ error: 'nenhuma conta com WhatsApp configurado' }, { status: 400 })
  }

  try {
    const resolved = await resolveConversationByPhone(db, config.account_id, phone, name)

    const { data: contato, error: contatoError } = await db
      .from('contacts')
      .select('user_id')
      .eq('id', resolved.contactId)
      .single()
    if (contatoError || !contato) {
      console.error('[inbound/segundo-numero/resolver-contato] contato criado mas não achei o user_id —', contatoError)
      return NextResponse.json({ error: 'internal error' }, { status: 500 })
    }

    return NextResponse.json({
      accountId: config.account_id,
      userId: contato.user_id,
      contactId: resolved.contactId,
      conversationId: resolved.conversationId,
      contactCreated: resolved.contactCreated,
    })
  } catch (err) {
    if (err instanceof SendMessageError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('[inbound/segundo-numero/resolver-contato] erro:', err)
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
