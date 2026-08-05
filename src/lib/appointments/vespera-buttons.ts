import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendText, engineSendCtaUrl } from '@/lib/automations/meta-send'
import { cancelCalcomBooking } from './calcom-cancel'

// Trata os toques nos botões do lembrete de véspera (template
// `lembrete_vespera_confirma`, quick-reply). Chamado pelo webhook quando
// chega uma mensagem type:'button' com um destes títulos:
//   - "Confirmar presença" -> responde confirmando + tag "Confirmado".
//   - "Preciso remarcar"   -> tira a tag "Agendou" (para os lembretes),
//        CANCELA o booking no Cal.com (libera o slot; o BOOKING_CANCELLED faz
//        o intake mover o card p/ Reagendar), e manda um botão com o link de
//        novo agendamento. Se o cancelamento falhar mas houver uid, manda o
//        link de reschedule daquele booking; sem uid, cai no link genérico.
// Nunca lança: o webhook segue mesmo se algo aqui falhar.

const PIPELINE = '8e89e154-763c-4cf8-b73b-42f7368c59c3'
const STAGE_REAGENDAR = 'f2b7e7f6-c7d6-4d2b-ac6d-ad7842ab7045'
const TAG_AGENDOU = 'c0278b4c-8f17-416e-a7e4-b66b6e78315a'
const CF_CAL_UID = '9a4af810-d6d3-4201-b39d-9ed46648b5d9' // uid do booking Cal.com
const REAGENDAR_MARKER = '[reagendar-enviado]' // mesmo marcador do reagendar_watcher.js

// Link genérico de novo agendamento (usado quando cancelamos, ou sem uid).
const CAL_BOOK = 'https://cal.com/simionato-advogados-n4sm0p/45min'
// Base do link de reschedule de um booking específico: <base>/<uid>?changes=true
const CAL_BOOKING_BASE = 'https://cal.com/booking'

const CONFIRMAR = 'Confirmar presença'
const REMARCAR = 'Preciso remarcar'

export function isVesperaButton(text: string | null | undefined): boolean {
  return text === CONFIRMAR || text === REMARCAR
}

function firstName(name: string | null | undefined): string {
  return name ? name.trim().split(/\s+/)[0] : ''
}

// Lê o uid do Cal.com guardado pelo intake no campo personalizado do contato.
async function readCalUid(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
): Promise<string | null> {
  const { data } = await db
    .from('contact_custom_values')
    .select('value')
    .eq('contact_id', contactId)
    .eq('custom_field_id', CF_CAL_UID)
    .maybeSingle()
  const v = (data as { value?: string | null } | null)?.value
  return v && v.trim() ? v.trim() : null
}

interface HandleArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  buttonText: string
  contactName: string | null
}

export async function handleVesperaButton(args: HandleArgs): Promise<void> {
  const db = supabaseAdmin()
  const common = {
    accountId: args.accountId,
    userId: args.userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
  }
  const first = firstName(args.contactName)
  const oi = first ? `, ${first}` : ''

  try {
    if (args.buttonText === CONFIRMAR) {
      // tag "Confirmado" (find-or-create; secundária — não impede a resposta)
      try {
        const { data: existing } = await db
          .from('tags')
          .select('id')
          .eq('account_id', args.accountId)
          .eq('name', 'Confirmado')
          .maybeSingle()
        let tagId = (existing as { id?: string } | null)?.id
        if (!tagId) {
          const { data: created } = await db
            .from('tags')
            .insert({
              account_id: args.accountId,
              user_id: args.userId,
              name: 'Confirmado',
              color: '#16a34a',
            })
            .select('id')
            .maybeSingle()
          tagId = (created as { id?: string } | null)?.id
        }
        if (tagId) {
          await db.from('contact_tags').insert({ contact_id: args.contactId, tag_id: tagId })
        }
      } catch {
        /* ignore — tag é secundária */
      }
      await engineSendText({
        ...common,
        text: `Perfeito${oi}! ✅ Sua presença está confirmada. Até lá! 🙌`,
      })
      return
    }

    if (args.buttonText === REMARCAR) {
      // 1) para os lembretes: remove a tag "Agendou"
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .eq('tag_id', TAG_AGENDOU)

      // 2) move o card p/ Reagendar + carimba o marcador. O cancelamento
      //    (passo 3) dispara o BOOKING_CANCELLED, que faz o intake mover o
      //    card e o reagendar_watcher tentar mandar o template — o marcador
      //    faz o watcher pular, evitando mensagem duplicada.
      const { data: deal } = await db
        .from('deals')
        .select('id, notes')
        .eq('contact_id', args.contactId)
        .eq('pipeline_id', PIPELINE)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const dealRow = deal as { id?: string; notes?: string | null } | null
      if (dealRow?.id) {
        const notes =
          (dealRow.notes ? dealRow.notes + '\n\n' : '') +
          `↩️ Lead pediu para remarcar (botão da véspera) — link enviado. ${REAGENDAR_MARKER}`
        await db.from('deals').update({ stage_id: STAGE_REAGENDAR, notes }).eq('id', dealRow.id)
      }

      // 3) cancela o booking no Cal.com (libera o slot na hora)
      const uid = await readCalUid(db, args.contactId)
      const apiKey = process.env.CALCOM_API_KEY
      let cancelled = false
      if (uid && apiKey) {
        cancelled = await cancelCalcomBooking(uid, apiKey)
      }

      // 4) escolhe o link: cancelou (ou sem uid) -> novo agendamento;
      //    não cancelou mas tem uid -> reschedule daquele booking.
      const url =
        cancelled || !uid ? CAL_BOOK : `${CAL_BOOKING_BASE}/${uid}?changes=true`
      const body = cancelled
        ? `Tudo certo${oi}! 🙂 Liberei o seu horário. É só escolher um novo aqui embaixo 👇`
        : `Sem problema${oi}! 🙂 É só escolher um novo horário aqui embaixo 👇`

      // 5) manda o botão; se o botão falhar, cai no link em texto (garante a entrega)
      try {
        await engineSendCtaUrl({
          ...common,
          bodyText: body,
          buttonText: 'Escolher horário',
          url,
        })
      } catch {
        await engineSendText({ ...common, text: `${body}\n${url}` })
      }
      return
    }
  } catch (err) {
    console.error('[vespera-button]', err instanceof Error ? err.message : String(err))
  }
}
