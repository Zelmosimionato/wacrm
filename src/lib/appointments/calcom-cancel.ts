// Cancela um agendamento no Cal.com (API v2).
//
// Usado quando o lead toca "Preciso remarcar" no lembrete de véspera:
// cancelar libera o slot na hora e dispara o webhook BOOKING_CANCELLED, que
// o intake já trata (remove a tag "Agendou" e move o card p/ Reagendar). Se
// o lead nunca reagenda, não sobra evento fantasma no calendário.
//
// Nunca lança — devolve true/false — para o handler escolher o texto/link
// (novo agendamento se cancelou; link de reschedule se falhou mas há uid).

const CAL_API = 'https://api.cal.com/v2'
const CAL_API_VERSION = '2026-02-25'

export async function cancelCalcomBooking(
  uid: string,
  apiKey: string,
  reason = 'Lead pediu para remarcar pelo WhatsApp',
): Promise<boolean> {
  try {
    const res = await fetch(
      `${CAL_API}/bookings/${encodeURIComponent(uid)}/cancel`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cal-api-version': CAL_API_VERSION,
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ cancellationReason: reason }),
      },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error('[calcom-cancel]', uid, res.status, body.slice(0, 200))
      return false
    }
    return true
  } catch (err) {
    console.error('[calcom-cancel]', uid, err instanceof Error ? err.message : String(err))
    return false
  }
}
