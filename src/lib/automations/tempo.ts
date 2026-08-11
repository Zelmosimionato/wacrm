import { createClient } from '@supabase/supabase-js'
import { runAutomationsForTrigger } from './engine'
import type { Automation } from '@/types'

/**
 * Disparo por tempo — a peça que faltava para lembretes e nutrição saírem
 * do código da VPS e virarem automação de tela.
 *
 * A interface já oferecia "time_based" com um campo de horário, mas nada
 * o executava. E o contrato estava incompleto: horário sem PÚBLICO não
 * quer dizer nada — "às 12h" para quem? Aqui o público é parte do gatilho.
 *
 * ⛔ NASCE EM ENSAIO. Este é um disparador de mensagens, a mesma classe de
 * peça que mandou 417 mensagens repetidas em 09/08/2026. Enquanto
 * `ensaio` não for explicitamente `false`, ele calcula o público, grava no
 * log quem receberia e NÃO manda nada. Ligar é uma decisão, não um
 * descuido.
 */

const FUSO = 'America/Sao_Paulo'

/** Quanto tempo depois do horário ainda vale disparar. O cron roda a cada
 *  5 min; a janela cobre atraso de fila sem repetir no ciclo seguinte —
 *  quem já recebeu hoje é barrado pela conferência de repetição. */
const JANELA_MIN = 10

export interface PublicoTempo {
  /** Cards nesta etapa. Sem isso, não há público e nada dispara. */
  stage_id?: string
  pipeline_id?: string
  /** Só cards parados há pelo menos N dias (conta de `updated_at`). */
  dias_parado?: number
  /** Teto por execução. Existe para que um erro de público não vire enxurrada. */
  maximo?: number
}

export interface ConfigTempo {
  /** "HH:mm" no fuso de São Paulo. */
  schedule: string
  timezone?: string
  publico?: PublicoTempo
  /** ⛔ Só manda de verdade com `false` explícito. */
  ensaio?: boolean
}

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

/** "HH:mm" e "AAAA-MM-DD" agora, no fuso do escritório. */
function agoraSP(): { hhmm: string; dia: string; minutos: number } {
  const f = new Intl.DateTimeFormat('sv-SE', {
    timeZone: FUSO,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const s = f.format(new Date()) // "2026-08-10 21:05"
  const [dia, hhmm] = s.split(' ')
  const [h, m] = hhmm.split(':').map(Number)
  return { hhmm, dia, minutos: h * 60 + m }
}

/** O horário marcado está dentro da janela de agora? */
function estaNaHora(schedule: string, minutosAgora: number): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(schedule || '').trim())
  if (!m) return false
  const alvo = Number(m[1]) * 60 + Number(m[2])
  const diff = minutosAgora - alvo
  return diff >= 0 && diff < JANELA_MIN
}

/**
 * Já disparou para este contato hoje?
 *
 * É a trava que faltou em 09/08: a checagem de repetição olhava uma janela
 * de tempo que não cobria o momento do envio, e a mesma mensagem saiu 70
 * vezes. Aqui a pergunta é simples e não depende de janela — houve registro
 * desta automação para este contato no dia de hoje?
 */
async function jaDisparouHoje(
  db: ReturnType<typeof admin>,
  automationId: string,
  contactId: string,
  dia: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('automation_logs')
    .select('id')
    .eq('automation_id', automationId)
    .eq('contact_id', contactId)
    .gte('created_at', dia + 'T00:00:00-03:00')
    .limit(1)
  // Erro de consulta trava o envio de propósito: na dúvida, não manda.
  // Mandar de novo custa mais caro que não mandar.
  if (error) {
    console.error('[tempo] conferência de repetição falhou — pulando', error.message)
    return true
  }
  return Boolean(data?.length)
}

/** Quem entra no disparo desta automação. */
async function resolverPublico(
  db: ReturnType<typeof admin>,
  accountId: string,
  publico: PublicoTempo | undefined,
): Promise<string[]> {
  if (!publico?.stage_id) return [] // sem etapa não há público — silêncio proposital

  let q = db
    .from('deals')
    .select('contact_id, updated_at')
    .eq('account_id', accountId)
    .eq('stage_id', publico.stage_id)
    .eq('status', 'open')
  if (publico.pipeline_id) q = q.eq('pipeline_id', publico.pipeline_id)

  const { data, error } = await q
  if (error) {
    console.error('[tempo] público não resolvido:', error.message)
    return []
  }

  const agora = Date.now()
  const DIA = 86_400_000
  const ids: string[] = []
  for (const d of data ?? []) {
    if (!d.contact_id) continue
    if (publico.dias_parado) {
      const parado = (agora - Date.parse(d.updated_at)) / DIA
      if (parado < publico.dias_parado) continue
    }
    ids.push(d.contact_id as string)
  }

  const teto = publico.maximo ?? 50
  if (ids.length > teto) {
    console.warn(`[tempo] público de ${ids.length} cortado no teto de ${teto}`)
    return ids.slice(0, teto)
  }
  return ids
}

export interface ResultadoTempo {
  automacao: string
  ensaio: boolean
  alcancados: number
  pulados: number
  contatos: string[]
}

/**
 * Roda uma vez. Chamado pelo cron a cada 5 minutos.
 */
export async function dispararPorTempo(): Promise<ResultadoTempo[]> {
  const db = admin()
  const { hhmm, dia, minutos } = agoraSP()

  const { data: automacoes, error } = await db
    .from('automations')
    .select('*')
    .eq('is_active', true)
    .eq('trigger_type', 'time_based')
  if (error || !automacoes?.length) return []

  const saida: ResultadoTempo[] = []

  for (const a of automacoes) {
    const cfg = (a.trigger_config ?? {}) as ConfigTempo
    if (!estaNaHora(cfg.schedule, minutos)) continue

    const ensaio = cfg.ensaio !== false // ⛔ só manda com `false` explícito
    const contatos = await resolverPublico(db, a.account_id as string, cfg.publico)

    let alcancados = 0
    let pulados = 0
    const enviados: string[] = []

    for (const contactId of contatos) {
      if (await jaDisparouHoje(db, a.id as string, contactId, dia)) {
        pulados++
        continue
      }
      enviados.push(contactId)
      if (!ensaio) {
        await runAutomationsForTrigger({
          accountId: a.account_id as string,
          triggerType: 'time_based',
          contactId,
          context: {},
        })
      } else {
        // Em ensaio o registro é gravado do mesmo jeito — é ele que você
        // compara com o que o nurture.js manda de verdade.
        await db.from('automation_logs').insert({
          automation_id: a.id,
          account_id: a.account_id,
          user_id: a.user_id,
          contact_id: contactId,
          trigger_event: 'time_based (ENSAIO)',
          steps_executed: 0,
          status: 'success',
        })
      }
      alcancados++
    }

    console.log(
      `[tempo] ${hhmm} · ${(a as Automation).name} · ${ensaio ? 'ENSAIO' : 'ENVIO REAL'} · ` +
      `alcançados=${alcancados} pulados=${pulados}`,
    )
    saida.push({
      automacao: (a as Automation).name,
      ensaio,
      alcancados,
      pulados,
      contatos: enviados,
    })
  }

  return saida
}
