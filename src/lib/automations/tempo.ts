import { createClient } from '@supabase/supabase-js'
import { runAutomationsForTrigger } from './engine'
import type { Automation, AwaitingReplyTriggerConfig } from '@/types'
import { dentroDoExpediente, passaramHorasUteis } from './horario-comercial'
import { esperandoDesde, type MsgResumo } from './aguardando-resposta'

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
  /**
   * Teto de dias parado — o degrau tem começo E fim.
   *
   * ⛔ Sem isto não existe régua, existe empilhamento: a nutrição tem três
   * degraus na mesma etapa (1–3 dias, 3–6, 6+) e o dedup é POR DIA, não por
   * template. Quem está parado há sete dias casa nos três ao mesmo tempo e
   * recebe as três mensagens no mesmo dia — cada automação achando que
   * mandou uma só.
   */
  dias_parado_max?: number
  /** Teto por execução. Existe para que um erro de público não vire enxurrada. */
  maximo?: number
}

/**
 * Disparo contado a partir de uma DATA do contato — "X horas antes da reunião".
 *
 * ⛔ Sem isto os lembretes não cabem na tela. O público por etapa responde
 * "parado há N dias"; lembrete pergunta outra coisa: quanto falta para uma data
 * que está gravada no contato. São dois eixos diferentes de tempo.
 */
export interface RelativoAData {
  /** id do campo personalizado que guarda a data (ISO). */
  campo: string
  /** Dispara quando faltarem ~estas horas. Negativo = depois da data. */
  horas_antes: number
  /** Tolerância, em horas, para os dois lados. Default: meia hora. */
  janela_horas?: number
}

export interface ConfigTempo {
  /** "HH:mm" no fuso de São Paulo. Ignorado quando há `relativo`. */
  schedule: string
  /** Quando presente, manda a cada ciclo em que a conta bater — não num horário fixo. */
  relativo?: RelativoAData
  timezone?: string
  publico?: PublicoTempo
  /** ⛔ Só manda de verdade com `false` explícito. */
  ensaio?: boolean
  /**
   * Quanto tempo esta automação lembra que já falou com alguém.
   *
   *  - 'dia'      (padrão) uma vez por dia. Serve para aviso recorrente.
   *  - 'sempre'   uma vez na VIDA. É o degrau de régua: "reengajamento" é
   *               dito uma vez, e ponto. ⛔ Sem isto a migração do nurture.js
   *               reenviaria a régua inteira para quem já a recebeu — no
   *               ensaio de 12/08/2026 deu 50 pessoas contra 0 do nurture.
   *  - 'por_data' uma vez por DATA do contato. É o lembrete: a mesma pessoa
   *               tem várias reuniões, e cada uma merece o seu.
   */
  dedup?: 'dia' | 'sempre' | 'por_data'
}

/**
 * O card está DENTRO deste degrau da régua?
 *
 * Piso inclusivo, teto exclusivo: "1 a 3 dias" e "3 a 6" não podem casar os
 * dois no terceiro dia, senão a pessoa leva dois toques no mesmo dia.
 * Sem teto, o degrau é aberto para cima — é o último da régua.
 */
export function dentroDoDegrau(
  updatedAt: string,
  publico: Pick<PublicoTempo, 'dias_parado' | 'dias_parado_max'>,
  agora: number = Date.now(),
): boolean {
  if (!publico.dias_parado && !publico.dias_parado_max) return true
  const parado = (agora - Date.parse(updatedAt)) / 86_400_000
  if (publico.dias_parado && parado < publico.dias_parado) return false
  if (publico.dias_parado_max && parado >= publico.dias_parado_max) return false
  return true
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

/**
 * Falta (ou passou) o tempo combinado para esta data?
 *
 * Janela para os dois lados porque o cron bate de 5 em 5 minutos: sem
 * tolerância, o instante exato passa entre duas batidas e o lembrete nunca sai.
 */
export function naHoraRelativa(
  dataISO: string,
  rel: { horas_antes: number; janela_horas?: number },
  agora: number = Date.now(),
): boolean {
  const alvo = Date.parse(dataISO)
  if (!Number.isFinite(alvo)) return false
  const faltamHoras = (alvo - agora) / 3_600_000
  const tol = rel.janela_horas ?? 0.5
  return Math.abs(faltamHoras - rel.horas_antes) <= tol
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
  dedup: 'dia' | 'sempre' | 'por_data' = 'dia',
  chave: string | null = null,
): Promise<boolean> {
  let consulta = db
    .from('automation_logs')
    .select('id')
    .eq('automation_id', automationId)
    .eq('contact_id', contactId)
    // ⛔ Ensaio NÃO conta como "já falei com essa pessoa".
    //
    // O ensaio grava no mesmo lugar que o envio real — é isso que permite
    // comparar um com o outro. Mas com memória 'sempre', deixar o registro de
    // ensaio contar queima a única chance da pessoa: ela apareceria como já
    // atendida sem ter recebido nada. Descobri isso rodando o ensaio duas
    // vezes em 12/08/2026 — na segunda, 100 pessoas já constavam como feitas.
    .not('trigger_event', 'ilike', 'ENSAIO%')
  // 'sempre' e 'por_data' não olham a data do registro: olham se JÁ EXISTE
  // registro (e, no caso da data, se existe PARA AQUELA data).
  if (dedup === 'dia') consulta = consulta.gte('created_at', dia + 'T00:00:00-03:00')
  if (dedup === 'por_data' && chave) consulta = consulta.eq('trigger_event', chave)
  const { data, error } = await consulta.limit(1)
  // Erro de consulta trava o envio de propósito: na dúvida, não manda.
  // Mandar de novo custa mais caro que não mandar.
  if (error) {
    console.error('[tempo] conferência de repetição falhou — pulando', error.message)
    return true
  }
  return Boolean(data?.length)
}

/**
 * Quem tem a data do campo dentro da janela relativa.
 *
 * ⛔ Não filtra por etapa aqui: a data manda. Quem não deve receber (card
 * perdido, por exemplo) é barrado pelos passos da automação, não por este
 * recorte — misturar os dois esconde o motivo de alguém não ter recebido.
 */
async function publicoPorData(
  db: ReturnType<typeof admin>,
  rel: RelativoAData,
  agora: number,
): Promise<string[]> {
  const tol = (rel.janela_horas ?? 0.5) * 3_600_000
  const centro = agora + rel.horas_antes * 3_600_000
  const de = new Date(centro - tol).toISOString()
  const ate = new Date(centro + tol).toISOString()
  const { data, error } = await db
    .from('contact_custom_values')
    .select('contact_id, value')
    .eq('custom_field_id', rel.campo)
    .gte('value', de)
    .lte('value', ate)
  if (error) {
    console.error('[tempo] público por data falhou — nada disparado:', error.message)
    return []
  }
  return (data ?? [])
    .filter((r) => naHoraRelativa(r.value as string, rel, agora))
    .map((r) => r.contact_id as string)
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
    .select('contact_id, updated_at, stage_entered_at')
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
    // ⛔ O relógio do degrau é STAGE_ENTERED_AT, não updated_at.
    //
    // `updated_at` muda a cada edição do card — uma nota, uma etiqueta, uma
    // mensagem gravada. Em 12/08/2026 os 70 cards da etapa FUP apareciam todos
    // como "parados há menos de 3 dias" pelo updated_at, enquanto 62 deles
    // estavam ali havia mais de 6 dias de verdade. A régua nunca saía do
    // primeiro degrau: ninguém chegava ao encerramento e, por isso, ninguém
    // era fechado.
    //
    // `stage_entered_at` (migração 039) só muda quando o card TROCA de etapa,
    // que é exatamente a pergunta "há quanto tempo está parado aqui".
    const entrou = (d.stage_entered_at as string | null) ?? (d.updated_at as string)
    if (!dentroDoDegrau(entrou, publico, agora)) continue
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
    // Dois eixos de tempo, que podem se somar:
    //   - só schedule  -> todo dia às 12h, para o público da etapa
    //   - só relativo  -> 1h antes da reunião, a qualquer hora do dia
    //   - os DOIS      -> às 18h, para quem tem reunião amanhã (a véspera)
    //
    // ⛔ Véspera NÃO é "24h antes": 24h antes de uma reunião das 8h é uma da
    // manhã. Véspera é fim de tarde do dia anterior — por isso ela precisa do
    // horário fixo E da conta, e nenhum dos dois sozinho serve.
    if (cfg.schedule && !estaNaHora(cfg.schedule, minutos)) continue
    if (!cfg.schedule && !cfg.relativo) continue

    const ensaio = cfg.ensaio !== false // ⛔ só manda com `false` explícito
    const contatos = cfg.relativo
      ? await publicoPorData(db, cfg.relativo, Date.now())
      : await resolverPublico(db, a.account_id as string, cfg.publico)

    let alcancados = 0
    let pulados = 0
    const enviados: string[] = []

    // A chave da memória por data: a própria data da reunião daquele contato.
    const datas = new Map<string, string>()
    if (cfg.dedup === 'por_data' && cfg.relativo) {
      const { data: vals } = await db
        .from('contact_custom_values')
        .select('contact_id, value')
        .eq('custom_field_id', cfg.relativo.campo)
        .in('contact_id', contatos)
      for (const v of vals ?? []) datas.set(v.contact_id as string, v.value as string)
    }

    for (const contactId of contatos) {
      const chave =
        cfg.dedup === 'por_data' ? `time_based:${datas.get(contactId) ?? '?'}` : null
      if (await jaDisparouHoje(db, a.id as string, contactId, dia, cfg.dedup, chave)) {
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
          // O prefixo é o que a memória usa para ignorar este registro.
          trigger_event: 'ENSAIO ' + (chave ?? 'time_based'),
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


/**
 * ⛔ Teto por ciclo. Não é otimização: é para que um erro meu na consulta
 * não vire enxurrada de aviso, como as 417 mensagens de 09/08. Quando bate
 * no teto, o log diz — silêncio aqui pareceria "cobri tudo".
 */
const TETO_AVISOS_POR_CICLO = 50

/**
 * Conversas paradas esperando resposta humana.
 *
 * Diferente do `dispararPorTempo`, este NÃO nasce em ensaio: o único passo
 * que ele executa (`notify`) escreve na tabela de notificação e não fala com
 * cliente nenhum. O risco que o ensaio protege — mandar mensagem errada para
 * fora — não existe aqui.
 *
 * ⭐ Só olha esperas que começaram DEPOIS da automação ser criada. Sem esse
 * corte, ligar a automação faria disparar de uma vez toda conversa parada há
 * dias — a enxurrada que o teto acima tenta impedir, chegando pela porta da
 * frente.
 */
export async function dispararAguardandoResposta(): Promise<ResultadoTempo[]> {
  const db = admin()
  const { dia } = agoraSP()
  const agora = Date.now()

  const { data: automacoes, error } = await db
    .from('automations')
    .select('*')
    .eq('is_active', true)
    .eq('trigger_type', 'awaiting_reply')
  if (error || !automacoes?.length) return []

  const saida: ResultadoTempo[] = []

  for (const a of automacoes) {
    const cfg = (a.trigger_config ?? {}) as AwaitingReplyTriggerConfig
    const horas = Number(cfg.horas_uteis ?? 0)
    const soComercial = cfg.somente_horario_comercial !== false
    const corte = new Date(a.created_at as string).getTime()

    // Fora do expediente ninguém é avisado: o aviso esperaria a noite toda
    // e chegaria velho. Volta a valer às 9h do próximo dia útil.
    if (soComercial && !dentroDoExpediente(agora)) {
      saida.push({ automacao: a.name as string, ensaio: false, alcancados: 0, pulados: 0, contatos: [] })
      continue
    }

    const { data: convs, error: errConv } = await db
      .from('conversations')
      .select('id, contact_id, last_message_at')
      .eq('account_id', a.account_id as string)
      .neq('status', 'closed')
      .not('last_message_at', 'is', null)
      .gte('last_message_at', new Date(corte).toISOString())
      .limit(500)
    if (errConv || !convs?.length) {
      if (errConv) console.error('[aguardando] conversas falharam:', errConv.message)
      saida.push({ automacao: a.name as string, ensaio: false, alcancados: 0, pulados: 0, contatos: [] })
      continue
    }

    const ids = convs.map((c) => c.id as string)
    const { data: msgs, error: errMsg } = await db
      .from('messages')
      .select('conversation_id, sender_type, created_at')
      .in('conversation_id', ids)
      .gte('created_at', new Date(corte).toISOString())
      .order('created_at', { ascending: false })
      .limit(5000)
    // Sem as mensagens não dá para saber quem espera — e chutar aqui seria
    // avisar sobre conversa já respondida. Na dúvida, não avisa.
    if (errMsg) {
      console.error('[aguardando] mensagens falharam — nada disparado:', errMsg.message)
      saida.push({ automacao: a.name as string, ensaio: false, alcancados: 0, pulados: 0, contatos: [] })
      continue
    }

    const porConversa = new Map<string, MsgResumo[]>()
    for (const m of msgs ?? []) {
      const k = m.conversation_id as string
      const lista = porConversa.get(k)
      const item = { sender_type: m.sender_type as string, created_at: m.created_at as string }
      if (lista) lista.push(item)
      else porConversa.set(k, [item])
    }

    let alcancados = 0
    let pulados = 0
    const avisados: string[] = []
    let truncou = false

    for (const c of convs) {
      const contactId = c.contact_id as string | null
      if (!contactId) continue

      const desde = esperandoDesde(porConversa.get(c.id as string) ?? [], cfg.ia_conta_como_resposta !== false)
      if (desde === null || desde < corte) continue

      const pronto = soComercial
        ? passaramHorasUteis(desde, horas, agora)
        : agora - desde >= horas * 3_600_000
      if (!pronto) continue

      // Uma vez por episódio de espera: a chave é o instante em que ela
      // começou. Reusa a mesma trava do disparo por tempo.
      const chave = `awaiting_reply:${new Date(desde).toISOString()}`
      if (await jaDisparouHoje(db, a.id as string, contactId, dia, 'por_data', chave)) {
        pulados++
        continue
      }

      if (avisados.length >= TETO_AVISOS_POR_CICLO) {
        truncou = true
        break
      }

      avisados.push(contactId)
      alcancados++
      await runAutomationsForTrigger({
        accountId: a.account_id as string,
        triggerType: 'awaiting_reply',
        contactId,
        context: { conversation_id: c.id as string, esperando_desde: new Date(desde).toISOString() },
      })
    }

    if (truncou) {
      console.warn(
        `[aguardando] "${a.name}" bateu o teto de ${TETO_AVISOS_POR_CICLO} avisos neste ciclo — ` +
          'o resto entra no próximo. Se isso repetir, há algo errado na regra.',
      )
    }

    saida.push({ automacao: a.name as string, ensaio: false, alcancados, pulados, contatos: avisados })
  }

  return saida
}
