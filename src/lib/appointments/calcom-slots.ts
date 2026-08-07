// Horários livres no Cal.com (API v2), para a IA DIZER horário em vez de inventar.
//
// Por que existe: em 07/08/2026 uma lead com reunião marcada para 11/08 perguntou
// "será que tem horário dia 10/08?". A IA respondeu "por enquanto só temos agenda
// aberta para esta semana" — frase que ela inventou (10/08 é segunda DESTA semana) e
// que fechou a porta de quem queria ANTECIPAR. O prompt já proíbe inventar
// disponibilidade; faltava a alternativa: a agenda de verdade.
//
// Nunca lança — devolve [] — para o gerador seguir sem a lista e o prompt cair na
// regra de não afirmar horário. Melhor responder sem horários do que com horários falsos.

const CAL_API = 'https://api.cal.com/v2'
const CAL_API_VERSION = '2026-02-25'

/** Fuso do escritório. O Cal.com devolve ISO-Z; quem lê a mensagem está em SP. */
const TZ = 'America/Sao_Paulo'

export interface SlotLivre {
  /** ISO cru, como veio do Cal.com — o que se manda de volta ao criar a reserva. */
  iso: string
  /** "segunda-feira, 11/08 às 14:00" — pronto para entrar na frase. */
  rotulo: string
}

function formatar(iso: string): string {
  const d = new Date(iso)
  const dia = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit',
  }).format(d)
  const hora = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit',
  }).format(d)
  return `${dia} às ${hora}`
}

/**
 * Próximos horários livres, do mais cedo ao mais tarde.
 *
 * @param eventTypeId  o tipo de evento do Cal.com (a videochamada de 45min)
 * @param dias         janela a consultar a partir de agora
 * @param limite       quantos devolver — poucos, para a mensagem caber no WhatsApp
 */
export async function horariosLivres(
  eventTypeId: string | number,
  apiKey: string,
  dias = 14,
  limite = 4,
): Promise<SlotLivre[]> {
  try {
    const agora = new Date()
    const fim = new Date(agora.getTime() + dias * 86_400_000)
    const q = new URLSearchParams({
      eventTypeId: String(eventTypeId),
      start: agora.toISOString(),
      end: fim.toISOString(),
      timeZone: TZ,
    })
    const res = await fetch(`${CAL_API}/slots?${q}`, {
      headers: {
        'cal-api-version': CAL_API_VERSION,
        Authorization: `Bearer ${apiKey}`,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error('[calcom-slots]', res.status, body.slice(0, 200))
      return []
    }
    const json = (await res.json()) as {
      data?: Record<string, Array<{ start?: string; time?: string }>>
    }
    // A v2 devolve { data: { "2026-08-11": [{ start: "..." }, ...], ... } }.
    // Achatamos e ordenamos: o lead quer o mais cedo, nao o primeiro do dia listado.
    const todos: string[] = []
    for (const lista of Object.values(json.data ?? {})) {
      for (const s of lista ?? []) {
        const iso = s.start ?? s.time
        if (iso) todos.push(iso)
      }
    }
    todos.sort()
    return todos.slice(0, limite).map((iso) => ({ iso, rotulo: formatar(iso) }))
  } catch (err) {
    console.error('[calcom-slots]', err instanceof Error ? err.message : String(err))
    return []
  }
}
