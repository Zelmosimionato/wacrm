import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendTemplate } from '@/lib/automations/meta-send'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

// ============================================================
// Appointment reminders — the CRM's "relógio".
//
// Runs from the same 60s instrumentation tick as the broadcast
// dispatcher (no external cron). For every contact tagged "Agendou"
// with a future meeting (CF_DATA_ISO), it sends:
//   - lembrete_1h_antes  -> ~1h before the meeting;
//   - the véspera reminder -> afternoon (12h–18h SP) of the day before.
//
// ⛔ REGRA: mandou uma vez, não repete. A marca do que já saiu fica num
// campo do contato, com a DATA DA REUNIÃO na chave — remarcou, data nova,
// pode mandar de novo. Não é janela de tempo: janela é conta, e conta erra
// (ver o comentário em CF_LEMBRETES_ENVIADOS). Brazil dropped DST in 2019,
// so São Paulo is a fixed UTC-3.
// ============================================================

const TAG_AGENDOU = 'c0278b4c-8f17-416e-a7e4-b66b6e78315a'
const CF_DATA = 'e7935f62-b9f6-414b-9cde-b3c7315c0f11' // "Data agendamento" (humano)
const CF_DATA_ISO = 'e482845b-8ed4-4f4d-ae0e-0eed9dafbe4e' // ISO cru
const CF_LOCAL = '62721dd7-92f9-4587-b3db-65a8e1a51120' // link/local do Meet
const SP_OFFSET_MS = 3 * 60 * 60_000 // UTC-3, sem horário de verão

const HOUR = 60 * 60_000
const MIN = 60_000

interface ReminderDef {
  key: string
  enabled: boolean
  template: string
  due: (nowMs: number, meetingMs: number) => boolean
}

/**
 * MANDOU UMA VEZ, NÃO REPETE.
 *
 * O registro do que já saiu fica neste campo do contato, como uma lista de
 * chaves `lembrete-<qual>@<data da reunião>` separadas por ponto e vírgula —
 * mesmo padrão que o nurture usa há tempo. A chave carrega a DATA DA REUNIÃO
 * de propósito: se a pessoa remarcar, a data muda, a chave muda, e o lembrete
 * da nova reunião sai normalmente.
 *
 * ⛔ Campo PRÓPRIO, separado do log do nurture: os dois fazem leitura-escrita
 * no mesmo registro e um apagaria a marca do outro — e marca perdida aqui
 * significa mensagem repetida para cliente.
 *
 * Existe porque em 09/08/2026 a trava era uma janela de tempo, tinha um ponto
 * cego, e o lembrete saiu **417 vezes** para 3 clientes — um deles recebeu 225,
 * um por minuto durante 3h45. Janela de tempo é conta; conta erra. Marca não.
 */
const CF_LEMBRETES_ENVIADOS = '54b97296-7a16-4a15-b0c7-25f61b5b6d7e'

/** `lembrete-vespera@2026-08-10T19:45:00.000Z` */
function chaveDoLembrete(qual: string, reuniaoIso: string): string {
  return `lembrete-${qual}@${reuniaoIso}`
}

/**
 * Contatos que NÃO recebem lembrete nenhum — nem véspera, nem 1h antes.
 *
 * São as três pessoas que levaram a enxurrada de 09/08/2026 (225, 121 e 71
 * mensagens). Já ouviram o suficiente do escritório para uma vida; qualquer
 * lembrete a mais, por mais correto que seja, chega como insistência.
 * Decisão do titular: ficam de fora quando os lembretes voltarem.
 */
const NAO_LEMBRAR = new Set<string>([
  '2089533e-b357-408b-a29d-e6f87867a31e', // O'Grandi Empreendimentos — recebeu 225
  'b4203ce4-2870-4894-92f8-a14abbbc52e9', // Douglas Ceschin de Miranda — recebeu 121
  '62b28142-9fba-4da4-9d5f-f0e276053642', // Thiago Rodrigues — recebeu 71
])

const REMINDERS: ReminderDef[] = [
  {
    key: '1h',
    // ✅ RELIGADO em 09/08/2026, à noite, por decisão do titular, depois da
    // revisão do funil. Agora há duas travas independentes por baixo: a marca
    // por reunião (lógica) e o freio de volume (contagem do que saiu). Se a
    // primeira errar de novo, a segunda barra no segundo envio.
    enabled: true,
    template: 'lembrete_1h_antes',
    due: (now, m) => now >= m - 60 * MIN && now <= m - 30 * MIN,
  },
  {
    key: 'vespera',
    enabled: true, // ✅ idem: religado em 09/08/2026 à noite
    template: 'lembrete_vespera_confirma',
    due: (now, m) => vesperaDue(now, m),
  },
]

// Véspera: 12h–18h (São Paulo) do dia anterior à reunião.
function vesperaDue(nowMs: number, meetingMs: number): boolean {
  if (nowMs >= meetingMs) return false
  const sp = new Date(meetingMs - SP_OFFSET_MS) // lê os campos UTC como hora de SP
  const y = sp.getUTCFullYear()
  const mo = sp.getUTCMonth()
  const d = sp.getUTCDate()
  const start = Date.UTC(y, mo, d - 1, 12) + SP_OFFSET_MS
  const end = Date.UTC(y, mo, d - 1, 18) + SP_OFFSET_MS
  return nowMs >= start && nowMs <= end
}

function firstName(name: string | null): string {
  return name ? name.trim().split(/\s+/)[0] : ''
}

export async function dispatchDueReminders(): Promise<void> {
  const active = REMINDERS.filter((r) => r.enabled)
  if (active.length === 0) return

  const db = supabaseAdmin()
  const now = Date.now()
  const nowISO = new Date(now).toISOString()
  const horizonISO = new Date(now + 31 * HOUR).toISOString()

  // Reuniões candidatas: CF_DATA_ISO em [agora, agora+31h]. ISO-Z ordena
  // lexicograficamente, então gte/lte no texto funciona como filtro de tempo.
  const { data: rows } = await db
    .from('contact_custom_values')
    .select('contact_id, value')
    .eq('custom_field_id', CF_DATA_ISO)
    .gte('value', nowISO)
    .lte('value', horizonISO)
  const candidates = (rows ?? []) as { contact_id: string; value: string }[]
  if (candidates.length === 0) return

  let userId: string | null = null

  for (const cand of candidates) {
    if (NAO_LEMBRAR.has(cand.contact_id)) continue
    const meetingMs = new Date(cand.value).getTime()
    if (!Number.isFinite(meetingMs)) continue
    const due = active.find((r) => r.due(now, meetingMs))
    if (!due) continue

    // Ainda é um agendamento ativo? (tag "Agendou" presente; cancelar a remove)
    const { data: tag } = await db
      .from('contact_tags')
      .select('contact_id')
      .eq('contact_id', cand.contact_id)
      .eq('tag_id', TAG_AGENDOU)
      .maybeSingle()
    if (!tag) continue

    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('contact_id', cand.contact_id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    const conversationId = conv?.id as string | undefined
    if (!conversationId) continue

    // JÁ MANDOU? Então não manda de novo. A marca é por reunião e não expira.
    const chave = chaveDoLembrete(due.key, cand.value)
    const { data: logRow, error: logErr } = await db
      .from('contact_custom_values')
      .select('id, value')
      .eq('contact_id', cand.contact_id)
      .eq('custom_field_id', CF_LEMBRETES_ENVIADOS)
      .maybeSingle()
    // ⛔ Falhou a leitura? NÃO manda. Erro de leitura não pode virar permissão
    // para reenviar — era exatamente assim que a repetição ganhava velocidade.
    if (logErr) {
      console.error('[reminders] leitura do log falhou — envio abortado:', logErr)
      continue
    }
    const log = (logRow?.value as string | null) ?? ''
    if (log.split(';').some((k) => k.trim() === chave)) continue

    // ⛔ Marca ANTES de enviar. Se o envio falhar, perde-se um lembrete; se a
    // marca viesse depois, uma falha no meio do caminho repetiria a mensagem a
    // cada 60 segundos. Entre perder um lembrete e inundar um cliente, perde-se
    // o lembrete.
    const novoLog = log ? `${log};${chave}` : chave
    const marcou = logRow?.id
      ? await db
          .from('contact_custom_values')
          .update({ value: novoLog })
          .eq('id', logRow.id as string)
      : await db.from('contact_custom_values').insert({
          contact_id: cand.contact_id,
          custom_field_id: CF_LEMBRETES_ENVIADOS,
          value: novoLog,
        })
    if (marcou.error) {
      console.error('[reminders] não consegui marcar o envio — abortado:', marcou.error)
      continue
    }

    const { data: contact } = await db
      .from('contacts')
      .select('id, name, account_id')
      .eq('id', cand.contact_id)
      .maybeSingle()
    const accountId = contact?.account_id as string | undefined
    if (!accountId) continue

    // Os dois campos que os templates precisam: data (humana) + link.
    const { data: cvs } = await db
      .from('contact_custom_values')
      .select('custom_field_id, value')
      .eq('contact_id', cand.contact_id)
      .in('custom_field_id', [CF_DATA, CF_LOCAL])
    const byField: Record<string, string> = {}
    for (const cv of (cvs ?? []) as { custom_field_id: string; value: string }[]) {
      byField[cv.custom_field_id] = cv.value
    }
    const dataHuman = byField[CF_DATA] ?? cand.value
    const link = byField[CF_LOCAL] ?? ''

    if (!userId) userId = await resolveAuditUserId(db, accountId)

    try {
      await engineSendTemplate({
        accountId,
        userId,
        conversationId,
        contactId: contact!.id as string,
        templateName: due.template,
        language: 'pt_BR',
        params: [firstName((contact!.name as string | null) ?? null), dataHuman, link],
      })
      console.log(`[reminders] ${due.key} -> ${due.template} enviado (contact ${contact!.id})`)
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      console.error(`[reminders] falha ${due.key} contact ${contact!.id}:`, m)
    }
  }
}
