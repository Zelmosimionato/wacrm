// Cria a reserva no Cal.com (API v2) — a IA MARCA a reunião, em vez de devolver o link.
//
// Por que existe: a IA já lia a agenda de verdade (calcom-slots.ts) e oferecia horários
// reais, mas terminava mandando o link do Cal.com — o lead quente voltava para um
// formulário. Faltava só a ponta: POST /v2/bookings.
//
// ⚠️ O evento exige NOME, E-MAIL e o campo "Whatsapp" (slug `phone`, obrigatório);
// e-mail sem o qual o Cal.com recusa. O `phone` custom vai em bookingFieldsResponses —
// mandar só `attendee.phoneNumber` deixa o campo obrigatório vazio.
//
// ⚠️ O evento tem antecedência mínima de 24h (minimumBookingNotice=1440). Horário de
// hoje é recusado pela API mesmo que pareça livre — por isso só se reserva o que veio
// da própria lista de slots, que já respeita a regra.
//
// Nunca lança: devolve um resultado tipado para quem chama decidir o texto. Confirmar
// ao lead uma reunião que não foi criada é o vexame que o prompt sempre temeu — quem
// chama TEM de olhar o `ok` antes de mandar a confirmação.

const CAL_API = 'https://api.cal.com/v2'

/** ⚠️ CADA endpoint do Cal.com tem a SUA versão — a de bookings NÃO é a de slots
 *  (2024-09-04) nem a de cancelamento (2026-02-25). Versão errada devolve 404
 *  "Cannot GET", que parece caminho errado e é só cabeçalho. */
const V_BOOKINGS = '2024-08-13'

const TZ = 'America/Sao_Paulo'

export type Reserva =
  | { ok: true; uid: string; inicio: string }
  /** O horário saiu debaixo do pé (outra pessoa reservou entre a leitura e o envio),
   *  ou está fora da janela de 24h. Dá para oferecer outro. */
  | { ok: false; motivo: 'indisponivel' }
  /** O e-mail não recebe correio — quase sempre erro de digitação ("@gnail.con").
   *  Vale um recado próprio: pedir para conferir resolve; "não consegui agendar"
   *  deixa a pessoa sem saber o que fazer. */
  | { ok: false; motivo: 'email_invalido' }
  /** Campo obrigatório vazio, dado recusado ou falha de rede. */
  | { ok: false; motivo: 'recusado' }

/** O Cal.com valida o domínio do e-mail e recusa quem não recebe correio. */
const EMAIL_RUIM = /email_domain_cannot_receive_mail|cannot receive mail|invalid.*email|email.*invalid/i

/** Marcadores de "esse horário não é mais reservável" no corpo de erro da v2. */
const INDISPONIVEL = /no_available_users|already.*booked|slot.*not.*available|booking_time_out_of_bounds|no longer available|minimum.*notice/i

export async function criarReserva(args: {
  eventTypeId: string | number
  apiKey: string
  /** ISO cru, exatamente como veio de `horariosLivres` — não remontar a data. */
  iso: string
  nome: string
  email: string
  /** E.164 com o "+" — é o campo "Whatsapp" obrigatório do formulário. */
  telefone: string
}): Promise<Reserva> {
  const { eventTypeId, apiKey, iso, nome, email, telefone } = args
  try {
    const res = await fetch(`${CAL_API}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cal-api-version': V_BOOKINGS,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        start: iso,
        eventTypeId: Number(eventTypeId),
        attendee: {
          name: nome,
          email,
          timeZone: TZ,
          language: 'pt',
          phoneNumber: telefone,
        },
        // O campo "Whatsapp" (slug `phone`) é obrigatório no formulário do evento.
        // Também é por onde o intake acha o telefone no webhook BOOKING_CREATED.
        bookingFieldsResponses: { phone: telefone },
        metadata: { origem: 'ia-whatsapp' },
      }),
    })

    const bruto = await res.text().catch(() => '')
    if (!res.ok) {
      console.error('[calcom-book]', res.status, bruto.slice(0, 300))
      if (EMAIL_RUIM.test(bruto)) return { ok: false, motivo: 'email_invalido' }
      const indisponivel = res.status === 409 || INDISPONIVEL.test(bruto)
      return { ok: false, motivo: indisponivel ? 'indisponivel' : 'recusado' }
    }

    const json = JSON.parse(bruto) as {
      data?: { uid?: string; start?: string; startTime?: string }
    }
    const uid = json.data?.uid
    if (!uid) {
      // 200 sem uid não é sucesso utilizável: sem uid não se cancela nem se remarca.
      console.error('[calcom-book] resposta sem uid:', bruto.slice(0, 300))
      return { ok: false, motivo: 'recusado' }
    }
    return { ok: true, uid, inicio: json.data?.start ?? json.data?.startTime ?? iso }
  } catch (err) {
    console.error('[calcom-book]', err instanceof Error ? err.message : String(err))
    return { ok: false, motivo: 'recusado' }
  }
}
