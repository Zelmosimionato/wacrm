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

/** ⚠️ CADA endpoint do Cal.com tem a SUA versão de API — não há uma só para o v2.
 *  Mandar a de bookings (2026-02-25) em /slots devolve 404 "Cannot GET", que parece
 *  caminho errado e é só cabeçalho errado. Custou meia hora de tentativa às cegas. */
const V_SLOTS = '2024-09-04'

/** Fuso do escritório. O Cal.com devolve ISO-Z; quem lê a mensagem está em SP. */
const TZ = 'America/Sao_Paulo'

export interface SlotLivre {
  /** ISO cru, como veio do Cal.com — o que se manda de volta ao criar a reserva. */
  iso: string
  /** "segunda-feira, 11/08 às 14:00" — pronto para entrar na frase. */
  rotulo: string
}

/**
 * "dia 13, quarta-feira, às 13:15" — formato pedido pelo titular.
 *
 * O DIA DO MÊS vem primeiro porque é o que a pessoa confere no calendário;
 * "quarta-feira às 13h" sozinho obriga o lead a descobrir que quarta é.
 * O mês só aparece quando o horário cai em outro mês — aí "dia 13" seria
 * ambíguo.
 */
function formatar(iso: string): string {
  const d = new Date(iso)
  const partes = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opts }).format(d)

  const diaDoMes = partes({ day: '2-digit' })
  const mes = partes({ month: '2-digit' })
  const mesAtual = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, month: '2-digit' }).format(
    new Date(),
  )
  const semana = partes({ weekday: 'long' })
  const hora = partes({ hour: '2-digit', minute: '2-digit' })

  const data = mes === mesAtual ? `dia ${diaDoMes}` : `dia ${diaDoMes}/${mes}`
  return `${data}, ${semana}, às ${hora}`
}

/**
 * Próximos horários livres, ESPALHADOS POR DIA.
 *
 * @param eventTypeId  o tipo de evento do Cal.com (a videochamada de 45min)
 * @param dias         janela a consultar a partir de agora. ⚠️ 14 dias era pouco:
 *                     em 09/08/2026 uma lead perguntou "teria em setembro?" e a IA
 *                     respondeu "estou com agenda apenas para as próximas duas
 *                     semanas" — dedução correta da lista curta e falsa no mundo.
 *                     A janela precisa alcançar o mês seguinte.
 * @param limite       quantos devolver — a IA oferece no máximo três de cada vez,
 *                     mas precisa de mais na mão para atender "e na quinta?"
 */
export async function horariosLivres(
  eventTypeId: string | number,
  apiKey: string,
  dias = 45,
  limite = 8,
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
        'cal-api-version': V_SLOTS,
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
    //
    // ⚠️ Pegar os N mais cedo entrega N horários DO MESMO DIA — e aí a IA não
    // tem o que oferecer a quem pede outro dia. Em 08/08/2026 ela recebeu 4
    // horários, todos de quarta, o lead quis remarcar, e ela INVENTOU uma
    // quinta-feira para ter uma segunda opção. Espalhar por dia tira a
    // tentação: opção de verdade no lugar de opção imaginada.
    const porDia = new Map<string, string[]>()
    for (const [dia, lista] of Object.entries(json.data ?? {})) {
      const isos = (lista ?? [])
        .map((s) => s.start ?? s.time)
        .filter((x): x is string => !!x)
        .sort()
      if (isos.length) porDia.set(dia, isos)
    }

    // Rodízio: o 1º horário de cada dia, depois o 2º de cada dia, e assim por
    // diante — dias mais próximos primeiro — até completar o limite.
    const dias_ = [...porDia.keys()].sort()
    const escolhidos: string[] = []
    for (let rodada = 0; escolhidos.length < limite; rodada++) {
      const antes = escolhidos.length
      for (const dia of dias_) {
        if (escolhidos.length >= limite) break
        const iso = porDia.get(dia)?.[rodada]
        if (iso) escolhidos.push(iso)
      }
      if (escolhidos.length === antes) break // acabaram os horários
    }
    escolhidos.sort()
    return escolhidos.map((iso) => ({ iso, rotulo: formatar(iso) }))
  } catch (err) {
    console.error('[calcom-slots]', err instanceof Error ? err.message : String(err))
    return []
  }
}
