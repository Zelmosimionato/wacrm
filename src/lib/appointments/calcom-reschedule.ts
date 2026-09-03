// Remarca um agendamento existente no Cal.com (API v2) — MESMA reserva, mesmo uid.
//
// Por que existe: hoje o único jeito de "reagendar" no código era cancelar +
// criar de novo (dois eventos separados, dois e-mails pro lead). O Cal.com
// tem um endpoint que remarca a reserva original sem recriá-la — descoberto
// em 21/08/2026, nunca ligado. Usado pela correção manual de agendamento
// (contact-actions/reschedule): tenta isto primeiro; se o Cal.com recusar
// (ex.: reunião já passou — ele não deixa remarcar o que já aconteceu),
// quem chama cai para só corrigir os campos no CRM.
//
// Nunca lança — devolve um resultado tipado, mesmo padrão de calcom-book.ts
// e calcom-cancel.ts.

const CAL_API = 'https://api.cal.com/v2'

/** Mesma versão do endpoint de cancelamento — cada rota do Cal.com tem a sua. */
const CAL_API_VERSION = '2026-02-25'

export type Remarcacao =
  | { ok: true; inicio: string }
  | { ok: false; motivo: 'indisponivel' | 'recusado' }

const INDISPONIVEL = /no_available_users|already.*booked|slot.*not.*available|booking_time_out_of_bounds|no longer available|minimum.*notice|cannot.*reschedule|past.*booking/i

export async function remarcarReserva(args: {
  uid: string
  apiKey: string
  /** ISO cru do novo horário. */
  novoIso: string
  motivo?: string
}): Promise<Remarcacao> {
  const { uid, apiKey, novoIso, motivo } = args
  try {
    const res = await fetch(
      `${CAL_API}/bookings/${encodeURIComponent(uid)}/reschedule`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cal-api-version': CAL_API_VERSION,
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          start: novoIso,
          ...(motivo ? { reschedulingReason: motivo } : {}),
        }),
      },
    )

    const bruto = await res.text().catch(() => '')
    if (!res.ok) {
      console.error('[calcom-reschedule]', uid, res.status, bruto.slice(0, 300))
      const indisponivel = res.status === 409 || INDISPONIVEL.test(bruto)
      return { ok: false, motivo: indisponivel ? 'indisponivel' : 'recusado' }
    }

    const json = JSON.parse(bruto) as {
      data?: { start?: string; startTime?: string }
    }
    return { ok: true, inicio: json.data?.start ?? json.data?.startTime ?? novoIso }
  } catch (err) {
    console.error('[calcom-reschedule]', uid, err instanceof Error ? err.message : String(err))
    return { ok: false, motivo: 'recusado' }
  }
}
