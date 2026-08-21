import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

/**
 * O intake.js (script EXTERNO, webhook do Cal.com) já resolveu o
 * contato e os dados da reserva — chama aqui pra o CRM DECIDIR o que
 * fazer. Se um Fluxo já é dono do contato, não faz nada (o Fluxo já
 * cuida de tudo). Se não, dispara o gatilho `calcom_booking_*` — a
 * regra de negócio de verdade (tag, etapa, confirmação) mora numa
 * Automação configurada na tela, não neste arquivo.
 */
export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_ENGINE_SECRET
  const supplied = request.headers.get('x-engine-secret')
  if (!secret || supplied !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const { contactId, accountId, event, bookingUid, startIso, bookingLabel } = body ?? {}
  if (!contactId || !accountId || !event) {
    return NextResponse.json({ error: 'contactId, accountId e event sao obrigatorios' }, { status: 400 })
  }

  const db = supabaseAdmin()
  const { data: activeRun, error } = await db
    .from('flow_runs')
    .select('id')
    .eq('account_id', accountId) // achado MINOR (4ª auditoria) — sem isto, inconsistente com o resto do arquivo (achado #16 já corrigido)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[calcom-booking] lookup failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (activeRun) {
    // Achado bloqueante B5 (3ª auditoria): quando um Fluxo é dono do
    // contato, esta rota simplesmente NÃO FAZ NADA — o que é certo pra
    // 'created'/'rescheduled' via WhatsApp com o Fluxo (ele já trata
    // tudo sozinho), mas deixa um buraco real pro cancelamento/
    // reagendamento feito pelo LEAD diretamente no Cal.com (e-mail),
    // por fora do WhatsApp: o Fluxo continua com o `booking_inicio_iso`
    // ANTIGO, manda lembrete de uma reunião que já não existe (ou já
    // mudou de hora), e pode até cancelar uma reserva que o lead acabou
    // de remarcar por conta própria. Não dá pra resolver isso com
    // automação de dado nesta rodada (o motor de Fluxos não tem como
    // ser "empurrado" um evento externo no meio de um run) — o mínimo
    // seguro é AVISAR um humano em vez de falhar em silêncio, mesmo
    // padrão que o resto do projeto já usa quando a automação completa
    // não é segura de construir na hora.
    if (event === 'cancelled' || event === 'rescheduled') {
      const { data: perfis } = await db.from('profiles').select('user_id').eq('account_id', accountId)
      const destinatarios = (perfis ?? []).map((p) => p.user_id as string)
      if (destinatarios.length > 0) {
        await db.from('notifications').insert(
          destinatarios.map((uid) => ({
            account_id: accountId,
            user_id: uid,
            type: 'awaiting_reply',
            contact_id: contactId,
            title: event === 'cancelled' ? 'Reserva cancelada no Cal.com — Fluxo de Agendamento ainda ativo' : 'Reserva reagendada no Cal.com — Fluxo de Agendamento ainda ativo',
            body: 'O lead mexeu na reserva direto no Cal.com enquanto o Fluxo de Agendamento (WhatsApp) ainda está com ele — o Fluxo não sabe disso sozinho. Conferir a conversa e, se precisar, encerrar ou ajustar o Fluxo manualmente.',
          })),
        )
      }
    }
    return NextResponse.json({ decision: 'flow_owns_this', flow_run_id: activeRun.id })
  }

  const triggerType =
    event === 'cancelled' ? 'calcom_booking_cancelled' :
    event === 'rescheduled' ? 'calcom_booking_rescheduled' :
    'calcom_booking_created'

  await runAutomationsForTrigger({
    accountId,
    triggerType,
    contactId,
    // Achado bloqueante B3 (3ª auditoria): AutomationContext é uma
    // interface FECHADA (message_text/conversation_id/vars/tag_id/
    // agent_id/esperando_desde/interactive_reply_id/stage_id/
    // pipeline_id — nada além disso) — um objeto literal com chaves
    // extras (booking_uid/booking_inicio_iso/booking_rotulo direto no
    // nível de cima) estoura o excess-property check do TypeScript e
    // `npm run build` falha. `vars` já é `Record<string, unknown>` —
    // aninhar ali passa pelo compilador sem alargar o tipo.
    context: {
      vars: {
        booking_uid: bookingUid,
        booking_inicio_iso: startIso,
        booking_rotulo: bookingLabel,
      },
    },
  })

  return NextResponse.json({ decision: 'dispatched_to_automations' })
}
