import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAutomationsForTrigger, automacaoVaiResponder } from '@/lib/automations/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { loadAiConfig } from '@/lib/ai/config'
import { transcreverAudioBuffer } from '@/lib/ai/transcreve'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

/**
 * Ponte entrada do segundo número (Evolution/wazap) → o mesmo pipeline que o
 * webhook oficial já roda pra mensagem do WhatsApp Business (automações +
 * `automacaoVaiResponder` + `dispatchInboundToAiReply`).
 *
 * Por que existe: `guardarRecebida` (wazap.js, chamada pelo evo-adaptador)
 * só grava a mensagem no banco — nunca acordava a Márcia. Toda vez que algo
 * caía no fallback do segundo número (janela oficial de 24h fechada — é o
 * caso da nutrição pré-reunião) e o lead respondia por lá, a mensagem
 * aparecia no inbox mas ficava muda pra sempre, sem sinal nenhum de que
 * faltava resposta. Achado 24/08/2026: Thomázia (5517981123627), reunião
 * confirmada, mandou texto + áudio depois do toque de nutrição e não teve
 * UMA resposta — nem da automação, nem da IA, nem aviso pra um humano.
 *
 * Chamada pelo evo-adaptador.js (processo Node fora do Next.js, sem acesso
 * direto ao motor) via POST com o segredo compartilhado — mesmo contrato
 * de "trusted service caller" que `/api/automations/engine` já usa.
 */
export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_ENGINE_SECRET
  const supplied = request.headers.get('x-engine-secret')
  if (!secret || supplied !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const {
    accountId,
    userId,
    contactId,
    conversationId,
    messageId,
    text,
    contentType,
    mediaUrl,
  } = body as {
    accountId?: string
    userId?: string
    contactId?: string
    conversationId?: string
    messageId?: string
    text?: string | null
    contentType?: string
    mediaUrl?: string | null
  }

  if (!accountId || !userId || !contactId || !conversationId) {
    return NextResponse.json(
      { error: 'accountId, userId, contactId e conversationId são obrigatórios' },
      { status: 400 },
    )
  }

  const db = supabaseAdmin()
  const textoOriginal = (text || '').trim()

  // Mesmos dois gatilhos de conteúdo que o webhook oficial dispara pra toda
  // mensagem nova (new_contact_created/first_inbound_message não se aplicam
  // aqui — `guardarRecebida` só aceita contato já cadastrado no CRM).
  for (const triggerType of ['new_message_received', 'keyword_match'] as const) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId,
      context: { message_text: textoOriginal, conversation_id: conversationId },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // O áudio transcrito vale como texto pra IA — mesma regra do canal oficial.
  let textoParaIa = textoOriginal
  if (!textoParaIa && contentType === 'audio' && mediaUrl) {
    const aiCfg = await loadAiConfig(db, accountId)
    if (aiCfg?.apiKey) {
      try {
        const resp = await fetch(mediaUrl)
        if (resp.ok) {
          const buffer = await resp.arrayBuffer()
          const mimeType = resp.headers.get('content-type') || 'audio/ogg'
          const texto = await transcreverAudioBuffer({ buffer, mimeType, apiKey: aiCfg.apiKey })
          if (texto) {
            textoParaIa = texto
            if (messageId) {
              await db.from('messages').update({ content_text: texto }).eq('id', messageId)
            }
          }
        }
      } catch (err) {
        console.error(
          '[inbound/segundo-numero] transcrição falhou:',
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    if (!textoParaIa) {
      // Nunca fica mudo: mesmo tratamento do canal oficial — a própria
      // Márcia avisa que não entendeu, sem desligar a IA (25/08/2026:
      // desligar exigia um humano ouvir o áudio; pedir de novo pro lead
      // resolve a maioria dos casos sem depender de ninguém).
      await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: 'text',
        contentText: 'Desculpa, não consegui entender o áudio 🙏 Pode escrever a mensagem ou gravar de novo?',
      })
      return NextResponse.json({ ok: true, aiTriggered: false, reason: 'audio sem transcrição' })
    }
  }

  if (!textoParaIa) {
    return NextResponse.json({ ok: true, aiTriggered: false, reason: 'sem texto' })
  }

  // Automação que RESPONDE cala a IA (mesma checagem do webhook oficial) —
  // sem isto o lead levaria a resposta da automação e a da Márcia por cima.
  const automacaoResponde = await automacaoVaiResponder(accountId, textoParaIa)
  if (automacaoResponde) {
    return NextResponse.json({ ok: true, aiTriggered: false, reason: 'automação já responde' })
  }

  await dispatchInboundToAiReply({
    accountId,
    conversationId,
    contactId,
    configOwnerUserId: userId,
  })

  return NextResponse.json({ ok: true, aiTriggered: true })
}
