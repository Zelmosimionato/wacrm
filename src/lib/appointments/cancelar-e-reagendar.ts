import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendText, engineSendCtaUrl } from '@/lib/automations/meta-send'
import { cancelCalcomBooking } from './calcom-cancel'

// Cancela o booking no Cal.com, libera o slot, move o card pro estágio
// Reagendar e manda o link de novo horário. Extraído de vespera-buttons.ts
// (botão "Preciso remarcar") pra ser reaproveitado também pelo relógio de
// lembretes, quando ninguém confirma presença e o horário precisa ser
// liberado sozinho — mesma lógica testada, dois gatilhos diferentes.

const PIPELINE = '8e89e154-763c-4cf8-b73b-42f7368c59c3'
const STAGE_REAGENDAR = 'f2b7e7f6-c7d6-4d2b-ac6d-ad7842ab7045'
const TAG_AGENDOU = 'c0278b4c-8f17-416e-a7e4-b66b6e78315a'
const CF_CAL_UID = '9a4af810-d6d3-4201-b39d-9ed46648b5d9'
const REAGENDAR_MARKER = '[reagendar-enviado]'

const CAL_BOOK = 'https://cal.com/simionato-advogados-n4sm0p/45min'
const CAL_BOOKING_BASE = 'https://cal.com/booking'

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

interface CancelarArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  motivoNota: string
  bodyTextCancelado: string
  bodyTextSemCancelar: string
}

export async function cancelarEReagendar(args: CancelarArgs): Promise<{ cancelled: boolean }> {
  const db = supabaseAdmin()
  const common = {
    accountId: args.accountId,
    userId: args.userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
  }

  // 1) para os lembretes: remove a tag Agendou
  await db.from('contact_tags').delete().eq('contact_id', args.contactId).eq('tag_id', TAG_AGENDOU)

  // 2) move o card pra Reagendar + carimba o marcador
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
    const notes = (dealRow.notes ? dealRow.notes + '\n\n' : '') + `${args.motivoNota} ${REAGENDAR_MARKER}`
    await db.from('deals').update({ stage_id: STAGE_REAGENDAR, notes }).eq('id', dealRow.id)
  }

  // 3) cancela no Cal.com
  const uid = await readCalUid(db, args.contactId)
  const apiKey = process.env.CALCOM_API_KEY
  let cancelled = false
  if (uid && apiKey) {
    cancelled = await cancelCalcomBooking(uid, apiKey, args.motivoNota)
  }

  // 4) manda o link certo
  const url = cancelled || !uid ? CAL_BOOK : `${CAL_BOOKING_BASE}/${uid}?changes=true`
  const body = cancelled ? args.bodyTextCancelado : args.bodyTextSemCancelar

  try {
    await engineSendCtaUrl({ ...common, bodyText: body, buttonText: 'Escolher horário', url })
  } catch {
    await engineSendText({ ...common, text: `${body}\n${url}` })
  }

  return { cancelled }
}
