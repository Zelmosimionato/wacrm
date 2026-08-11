import type { ChatMessage } from './types'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText, engineSendCtaUrl } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { horariosLivres, type SlotLivre } from '@/lib/appointments/calcom-slots'
import { criarReserva } from '@/lib/appointments/calcom-book'
import { cancelCalcomBooking } from '@/lib/appointments/calcom-cancel'
import { iaAgendaAtiva } from './defaults'

/** Horários livres do escritório (rótulo para a frase + ISO para reservar).
 *  Silencioso por desenho: sem chave, sem tipo de evento ou com a API fora,
 *  devolve [] e a IA simplesmente não fala de horário. */
async function agendaDoEscritorio(): Promise<SlotLivre[]> {
  const chave = process.env.CALCOM_API_KEY
  const evento = process.env.CALCOM_EVENT_TYPE_ID
  if (!chave || !evento) return []
  return horariosLivres(evento, chave)
}

/** Link público do evento — a saída de emergência quando a reserva não sai. */
const AGENDA_LINK = 'https://cal.com/simionato-advogados-n4sm0p/45min'

/**
 * Textos que SUBSTITUEM a resposta da IA quando a reserva não se concretiza.
 * ⛔ Ela já escreveu "confirmado" contando que o sistema marcaria; se não
 * marcou, essa frase não pode sair — o lead apareceria para uma reunião que
 * não existe. Cada texto vai ao ar como mensagem de WhatsApp para cliente
 * real: mudar aqui é mudar a voz do escritório.
 */
const FALTA_EMAIL =
  'Para eu já deixar a sua reunião confirmada, preciso do seu e-mail — é para lá que vai o convite com o link da videochamada.\n\nPode me passar, por gentileza?'
const FALTA_NOME =
  'Para eu já deixar a sua reunião confirmada, me confirma o seu nome completo, por gentileza?'
const EMAIL_NAO_RECEBE =
  'Esse e-mail não está recebendo mensagens — deve ter escapado um errinho de digitação.\n\nPode conferir e me mandar de novo? É para lá que vai o convite da videochamada.'
const HORARIO_TOMADO =
  'Esse horário acabou de ser reservado, me desculpe.\n\nVocê consegue escolher outro por aqui — o que aparecer na tela está livre de verdade: ' +
  AGENDA_LINK
const FALHA_AGENDA =
  'Não consegui concluir a reserva por aqui agora.\n\nPara você não ficar esperando, é só reservar o melhor horário neste link: ' +
  AGENDA_LINK
/**
 * Frases com que ela anuncia reunião feita. Serve à trava abaixo — por isso é
 * deliberadamente estreita: pega afirmação ("agendei", "está confirmado",
 * "convite enviado") e não pega promessa ("assim que você confirmar").
 */
/**
 * A PESSOA afirma que tem reuniao marcada — ou cola o convite.
 *
 * ⛔ Existe porque a ausencia de registro NAO e prova de ausencia de reuniao.
 * Em 10/08/2026 um lead escreveu "desejo confirmar meu agendamento", disse a
 * data e a hora, e a IA respondeu "nao temos esse horario disponivel no nosso
 * sistema" — oferecendo datas 7 e 14 dias depois. A reuniao existia: ele colou
 * o convite do Google Agenda, com link do Meet. So nao estava no CRM, porque
 * a reserva veio por um canal que o CRM nao capta.
 *
 * A IA seguiu a instrucao a risca: quando nao ha reuniao registrada, o contexto
 * afirma que "o sistema acabou de conferir". O sistema conferiu os REGISTROS
 * DELE, que podem estar incompletos.
 *
 * ⭐ Confirmar agendamento nunca foi trabalho da IA: a confirmacao sai por
 * automacao (`confirmacao_agendamento`) quando a reserva chega. Se a pessoa
 * afirma ter reuniao e o sistema nao a conhece, isso e DIVERGENCIA — e
 * divergencia sobre compromisso marcado se resolve com gente, nao com robo.
 */
export const PESSOA_AFIRMA_REUNIAO =
  /\b(confirmar|confirma[çc][ãa]o|confirme)\b[^.?!]{0,40}\b(agendamento|reuni[ãa]o|hor[áa]rio|consulta)\b|\b(minha|meu|nossa|nosso)\s+(reuni[ãa]o|agendamento|hor[áa]rio|consulta)\b|\bj[áa]\s+(estou|est[áa])\s+agendad|\bmeet\.google\.com\b|\blink da videochamada\b|\bfuso hor[áa]rio\b/i

export const AFIRMA_QUE_AGENDOU =
  /\b(agendei|remarquei|reservei|marquei)\b|\b(est[áa]|ficou|fica|segue|continua|permanece)\s+(tudo\s+)?(confirmad|agendad|remarcad|reservad|marcad)|\breuni[ãa]o\b[^.!?\n]{0,30}\b(confirmad|agendad|remarcad|reservad|marcad)|\bconvite\b[^.!?\n]{0,40}\benviad/i

const NAO_CONFIRMADO =
  'Só para eu não errar: me confirma qual horário você prefere que eu já deixo reservado?'
const JA_TEM_REUNIAO =
  'Você já tem uma reunião marcada com a gente — vou cuidar da alteração do horário e te confirmo por aqui, tudo bem?'

/**
 * Efetiva no Cal.com o horário que a IA escolheu, e devolve o texto que deve
 * REALMENTE sair. Regra única: só a resposta da IA sai quando a reunião foi
 * criada; qualquer outro desfecho vira um texto honesto.
 */
async function reservarHorario(args: {
  indice: number
  slots: SlotLivre[]
  nome: string | null
  email: string | null
  telefone: string | null
  hasMeeting: boolean
  textoDaIa: string
}): Promise<{ texto: string; ok: boolean; reagendar: boolean }> {
  const { indice, slots, nome, email, telefone, hasMeeting, textoDaIa } = args

  // Quem já tem reunião não agenda outra: é remarcação, e o sistema tem
  // caminho próprio (card em Reagendar + template com o botão). Quando a
  // reunião foi desfeita nesta mesma resposta, o chamador já passa false.
  if (hasMeeting) return { texto: JA_TEM_REUNIAO, ok: false, reagendar: true }

  const falha = (texto: string) => ({ texto, ok: false, reagendar: false })

  const slot = slots[indice - 1]
  if (!slot) {
    console.error(`[ia-agenda] índice ${indice} fora da agenda (${slots.length} horários)`)
    return falha(FALHA_AGENDA)
  }
  if (!email) return falha(FALTA_EMAIL)
  if (!nome) return falha(FALTA_NOME)
  if (!telefone) return falha(FALHA_AGENDA)

  const chave = process.env.CALCOM_API_KEY
  const evento = process.env.CALCOM_EVENT_TYPE_ID
  if (!chave || !evento) return falha(FALHA_AGENDA)

  const r = await criarReserva({
    eventTypeId: evento,
    apiKey: chave,
    iso: slot.iso,
    nome,
    email,
    telefone: telefone.startsWith('+') ? telefone : `+${telefone.replace(/\D/g, '')}`,
  })
  if (r.ok) {
    // O card, a tag "Agendou", a data e os lembretes vêm do webhook
    // BOOKING_CREATED que o intake já trata — nada a fazer aqui.
    console.log(`[ia-agenda] reservado ${slot.rotulo} (uid ${r.uid}) para ${email}`)
    return { texto: textoDaIa, ok: true, reagendar: false }
  }
  if (r.motivo === 'email_invalido') return falha(EMAIL_NAO_RECEBE)
  return falha(r.motivo === 'indisponivel' ? HORARIO_TOMADO : FALHA_AGENDA)
}

// Fase 3: the AI moves the deal card from the conversation (qualified /
// super / reschedule). The templates are sent by the STAGE automations;
// here we only MOVE the card and fire the stage trigger so they run.
export const AI_VENDAS_PIPELINE = '8e89e154-763c-4cf8-b73b-42f7368c59c3'
export const AI_STAGE_NOVO = 'f6c4e8c1-f13a-442a-9668-414cadb81c01'
export const AI_STAGE_QUALIFICADO = '57bed09e-bc01-4691-8272-dcd8c3c078df'
const AI_STAGE_REAGENDAR = 'f2b7e7f6-c7d6-4d2b-ac6d-ad7842ab7045'
export const AI_STAGE_PERDIDO = '0d0382a5-f15d-4e43-88aa-0c70337d94d4'
const AI_STAGE_FUP = '8bd228cf-fba4-4b28-b704-068bdcfa7c8d'

/**
 * De onde a IA pode AVANÇAR um card para Lead Qualificado.
 *
 * Novo Lead é o começo. FUP — Reativar Lead é lead DORMENTE, não lead
 * avançado: sair de lá é avanço, não é puxar ninguém para trás.
 *
 * ⛔ Sem o FUP aqui, quem respondia "tenho interesse" a um toque de nutrição
 * ficava com o card parado no mesmo lugar e na mesma data — e dois dias depois
 * a régua o encerrava com "como não tivemos retorno, estou finalizando seu
 * atendimento". Medido em 10/08/2026: responder NÃO mexe no card (4 de 6 casos
 * recentes), então o relógio da nutrição corria por cima de quem tinha falado.
 *
 * Follow up No-show entra pelo mesmo motivo: também é dormente. A conduta
 * dela ali é remarcar, não requalificar — e quase sempre a remarcação resolve,
 * porque o webhook do Cal.com move o card sozinho. Mas a pessoa voltar e se
 * requalificar em vez de remarcar é raro e plausível, e nesse caso o código não
 * deve contradizer o julgamento dela: o guarda existe para impedir puxar para
 * TRÁS quem avançou, não para vetar avanço a partir de etapa parada.
 */
const AI_STAGE_NOSHOW = '8c39cc10-4568-432f-b4dd-9a4ba228add6'
export const AI_ETAPAS_QUE_AVANCAM = new Set([AI_STAGE_NOVO, AI_STAGE_FUP, AI_STAGE_NOSHOW])
const AI_TAG_SUPER = 'b9298582-dcc7-46a3-ae34-f54b3c6fece1'

// Campos e tag que descrevem a reunião marcada. São os mesmos que o intake
// grava ao receber o webhook do Cal.com — desfazer é apagar exatamente estes.
const CF_DATA = 'e7935f62-b9f6-414b-9cde-b3c7315c0f11'
const CF_LOCAL = '62721dd7-92f9-4587-b3db-65a8e1a51120'
const CF_DATA_ISO = 'e482845b-8ed4-4f4d-ae0e-0eed9dafbe4e'
const CF_CAL_UID = '9a4af810-d6d3-4201-b39d-9ed46648b5d9'
const TAG_AGENDOU = 'c0278b4c-8f17-416e-a7e4-b66b6e78315a'

/** Assina o cancelamento feito daqui. O intake lê isto no webhook
 *  BOOKING_CANCELLED e fica quieto — senão o lead recebe, logo depois da
 *  conversa em que a IA já ofereceu novos horários, o template com o botão
 *  de reagendar, como se ninguém tivesse falado com ele. */
export const MOTIVO_CANCELAMENTO_IA =
  '[ia-whatsapp] a pessoa avisou por mensagem que nao vem'

/**
 * Desfaz a reunião marcada: cancela no Cal.com, tira a tag "Agendou" e apaga
 * data/local/uid do contato.
 *
 * ⛔ A tag é o que importa mais: `reminders/dispatch.ts` só avisa quem a tem.
 * Sem tirá-la, quem cancelou continua recebendo o lembrete de véspera e o de
 * 1h antes — hoje é o rastro que ninguém vê, porque o CRM sequer sabia dos
 * cancelamentos.
 *
 * Devolve true quando o Cal.com confirmou o cancelamento. O CRM é limpo de
 * qualquer forma: um horário fantasma na agenda é ruim, mas perseguir com
 * lembrete quem avisou que não vem é pior.
 */
/**
 * Tem reunião marcada AGORA? Lê a tag na hora, não no início do turno.
 *
 * ⛔ A tag "Agendou" só aparece quando o webhook do Cal.com volta, segundos
 * depois da reserva. Se a pessoa confirmar duas vezes seguidas ("pode ser" e,
 * logo atrás, "isso"), o segundo turno começaria achando que ela não tem
 * reunião — e marcaria uma SEGUNDA, ocupando dois horários da agenda.
 */
async function temReuniaoAgora(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
): Promise<boolean> {
  const { count } = await db
    .from('contact_tags')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .eq('tag_id', TAG_AGENDOU)
  return (count ?? 0) > 0
}

async function desfazerReuniao(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
): Promise<boolean> {
  const { data: campos } = await db
    .from('contact_custom_values')
    .select('value')
    .eq('contact_id', contactId)
    .eq('custom_field_id', CF_CAL_UID)
    .limit(1)
  const uid = (campos as { value: string | null }[] | null)?.[0]?.value?.trim()

  let cancelado = false
  const chave = process.env.CALCOM_API_KEY
  if (uid && chave) {
    cancelado = await cancelCalcomBooking(uid, chave, MOTIVO_CANCELAMENTO_IA)
  } else {
    console.warn(`[ia-agenda] desmarcar sem uid da reserva (contato ${contactId})`)
  }

  await db
    .from('contact_tags')
    .delete()
    .eq('contact_id', contactId)
    .eq('tag_id', TAG_AGENDOU)
  await db
    .from('contact_custom_values')
    .delete()
    .eq('contact_id', contactId)
    .in('custom_field_id', [CF_DATA, CF_LOCAL, CF_DATA_ISO, CF_CAL_UID])

  console.log(`[ia-agenda] reunião desfeita (contato ${contactId}, cal.com ok=${cancelado})`)
  return cancelado
}

async function applyAiCardMove(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    accountId: string
    contactId: string
    move: 'qualified' | 'super' | 'reagendar' | 'perdido'
    /** Tem reunião marcada agora? Só quem tem pode ser "reagendado". */
    temReuniao: boolean
  },
): Promise<void> {
  const { accountId, contactId, move, temReuniao } = args
  const { data: deals } = await db
    .from('deals')
    .select('id, stage_id')
    .eq('contact_id', contactId)
    .eq('pipeline_id', AI_VENDAS_PIPELINE)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
  const deal = (deals as { id: string; stage_id: string }[] | null)?.[0]
  if (!deal) return

  if (move === 'super') {
    const { count } = await db
      .from('contact_tags')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', contactId)
      .eq('tag_id', AI_TAG_SUPER)
    if (!count) {
      await db
        .from('contact_tags')
        .insert({ contact_id: contactId, tag_id: AI_TAG_SUPER })
    }
    // Alert the team by email - the CRM has no SMTP, so relay via the
    // intake mailer (shared secret). Fire-and-forget; never blocks.
    const notifySecret = process.env.AUTOMATION_ENGINE_SECRET
    if (notifySecret) {
      const { data: c } = await db
        .from('contacts')
        .select('name, phone')
        .eq('id', contactId)
        .maybeSingle()
      const contact = c as { name: string | null; phone: string | null } | null
      void fetch('http://127.0.0.1:3001/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-engine-secret': notifySecret },
        body: JSON.stringify({
          subject: `Lead SUPERQUALIFICADO (IA): ${contact?.name ?? 'sem nome'}`,
          body: `A IA identificou um lead SUPERQUALIFICADO (divida >= R$ 500 mil) na conversa. Nome: ${contact?.name ?? '-'} | WhatsApp: ${contact?.phone ?? '-'} | Card em Lead Qualificado + tag Superqualificado. Ver: https://crm.simionatoadvogados.com.br`,
        }),
      }).catch(() => {})
    }
  }

  let target: string | null = null
  if (move === 'qualified' || move === 'super') {
    // Avança do começo e do dormente; ⛔ nunca puxa de volta quem já avançou.
    if (AI_ETAPAS_QUE_AVANCAM.has(deal.stage_id)) target = AI_STAGE_QUALIFICADO
  } else if (move === 'reagendar') {
    // ⛔ Só reagenda quem TEM o que reagendar. A etapa "Reagendar reunião"
    // dispara o template "vi que você precisou cancelar o horário" — e em
    // 09/08/2026 ele foi parar numa lead que NUNCA teve reunião: ela disse
    // "não vai dar certo" (recusando um horário), a IA leu como adiamento, e
    // o escritório afirmou a ela um cancelamento que nunca existiu.
    if (!temReuniao) {
      console.warn(
        `[ai auto-reply] reagendar ignorado: contato ${contactId} não tem reunião marcada`,
      )
      return
    }
    if (deal.stage_id !== AI_STAGE_REAGENDAR) target = AI_STAGE_REAGENDAR
  } else if (move === 'perdido') {
    if (deal.stage_id !== AI_STAGE_PERDIDO) target = AI_STAGE_PERDIDO
  }
  if (!target) return

  // Perdido é o único destino que também FECHA o card: a casa marca esses 264
  // cards com status "lost". Card aberto numa etapa de encerramento mentiria
  // no funil e ainda seria pescado pelas automações de reativação — justamente
  // o que não se faz com quem disse que já resolveu.
  const patch: Record<string, unknown> = { stage_id: target }
  if (move === 'perdido') patch.status = 'lost'
  await db.from('deals').update(patch).eq('id', deal.id)
  await runAutomationsForTrigger({
    accountId,
    triggerType: 'deal_stage_changed',
    contactId,
    context: { stage_id: target, pipeline_id: AI_VENDAS_PIPELINE },
  })
}

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

const CLIENT_MODE_BLOCK =
  'ATENCAO - MODO CLIENTE (prioridade maxima, sobrepoe QUALQUER instrucao de qualificacao acima): este contato JA E CLIENTE do escritorio, nao e um lead novo. NUNCA faca qualificacao com ele: nao pergunte o nome, nao pergunte o valor da divida, nao peca dados, nao aplique criterio de valor e nao envie link de agendamento. Trate como atendimento de cliente: acolha com empatia, confirme que recebemos a mensagem e informe que a equipe/o advogado responsavel vai verificar o andamento do caso dele e retornar em breve. Responda em no maximo 2 frases curtas e cordiais. Nao prometa prazos nem resultados, nao invente nada sobre o processo. Mesmo que o cliente esteja aflito ou reclamando, RESPONDA com esse acolhimento - NAO use o protocolo de transferencia ([[HANDOFF]]); o encaminhamento para um humano e feito automaticamente pelo sistema depois da sua resposta.'

/**
 * A contact counts as "returning" if their newest-but-one message in the
 * (reused) conversation is at least this far before the current inbound —
 * i.e. they went quiet and came back, rather than double-texting.
 */
const RETURNING_GAP_MS = 6 * 60 * 60 * 1000

/**
 * Contact tags that represent qualification we already did — echoed back
 * to the model so it doesn't re-ask what the funnel already knows. (Life-
 * cycle tags like "Novo Lead" / "Agendou" / "Cliente" are handled by the
 * state logic, not listed here.)
 */
const QUAL_TAGS = ['Superqualificado', 'Desqualificado', 'Bancário', 'Tributário', 'PF', 'PJ']

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * O e-mail que a pessoa escreveu na conversa.
 *
 * ⛔ Sem isto o agendamento é impossível para quem NÃO veio do formulário: o
 * código só olhava `contacts.email`, e nada grava ali o que a pessoa digita no
 * WhatsApp. Em 08/08/2026 o titular mandou o e-mail cinco vezes e ouviu cinco
 * vezes "preciso do seu e-mail" — a informação estava na tela, e o código
 * procurava no lugar errado.
 *
 * Varre de trás para frente: vale o último que a pessoa escreveu.
 */
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]*[\w]/
export function emailNaConversa(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const achado = m.content.match(RE_EMAIL)
    if (achado) return achado[0].toLowerCase()
  }
  return null
}

/**
 * Espera a rajada terminar antes de responder.
 *
 * Ninguém escreve no WhatsApp em uma mensagem só: manda "Oi tudo bem?" e, sete
 * segundos depois, "Como funciona?". Cada uma dispara uma resposta, e a segunda
 * é gerada antes de a primeira ficar gravada — então ela cumprimenta duas vezes
 * e a pergunta de verdade fica sem resposta. Foi o que aconteceu em 08/08/2026
 * às 14:42.
 *
 * O conserto é o que uma pessoa faz: esperar o outro terminar de digitar.
 */
/** Lido no uso, nao no carregamento do modulo: assim o teste zera a espera
 *  e a operacao ajusta sem rebuild. */
const esperaRajadaMs = () => Number(process.env.AI_ESPERA_RAJADA_MS ?? 6000)

/** Resumos escritos pelas TRAVAS — desligamentos automáticos, não decisão humana. */
const FOI_TRAVA_DO_SISTEMA =
  /limite de \d+ respostas|repetindo a mesma resposta|não conseguiu transcrever/i

/** Quanto tempo parada antes de a IA reassumir uma conversa travada. Um dia
 *  inteiro: curto o bastante para não perder quem volta, longo o bastante
 *  para o escritório ter visto o caso no inbox se quisesse assumir. */
const REABRE_APOS_MS = 24 * 60 * 60_000

/**
 * Id da última mensagem que o contato mandou nesta conversa.
 *
 * ⛔ O valor é `'customer'`. Até 09/08/2026 esta consulta filtrava por
 * `'contact'` — que NÃO EXISTE no banco. A função devolvia `null` sempre, a
 * comparação `null !== null` era sempre falsa, e a guarda de rajada logo abaixo
 * nunca descartava nada: seis segundos de espera em toda resposta, protegendo
 * coisa nenhuma. Não deu erro em lugar nenhum — consulta com valor inexistente
 * apenas volta vazia. Os valores reais são `customer`, `agent` e `bot`.
 */
async function ultimaEntrada(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<string | null> {
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
  return (data as { id: string }[] | null)?.[0]?.id ?? null
}

/**
 * Passa a conversa para um humano e para de responder nela.
 *
 * ⛔ Existe porque o teto de respostas por conversa desligava a IA **em
 * silêncio**: em 08/08/2026 a conversa bateu em 20/20 e o lead simplesmente
 * deixou de ser respondido — ninguém no escritório soube. Ficar sem resposta é
 * o pior desfecho possível para um lead que estava quase marcando.
 */
async function passarParaHumano(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  resumo: string,
  handoffAgentId: string | null,
  jaTemDono: boolean,
): Promise<void> {
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: resumo,
  }
  if (handoffAgentId && !jaTemDono) update.assigned_agent_id = handoffAgentId
  await db.from('conversations').update(update).eq('id', conversationId)
}

/**
 * Pull a usable first name from the stored contact name. The inbound
 * webhook stores the WhatsApp profile name in `contacts.name`, falling
 * back to the phone when the profile has none — so a "name" that is just
 * the phone (or otherwise has no letters) is treated as illegible.
 */
export function legibleFirstName(
  name?: string | null,
  phone?: string | null,
): string | null {
  if (!name) return null
  const n = name.trim()
  if (n.length < 2) return null
  if (!/\p{L}/u.test(n)) return null // no letters → junk / a bare number
  const digitsOnly = (s: string) => s.replace(/\D/g, '')
  if (phone && digitsOnly(n) && digitsOnly(n) === digitsOnly(phone)) return null
  const token = n.split(/\s+/)[0]
  // Normalise an ALL-CAPS or all-lower token to Title case for the
  // greeting ("DANUZE" → "Danuze"); leave mixed-case names untouched.
  if (token === token.toUpperCase() || token === token.toLowerCase()) {
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
  }
  return token
}

/**
 * Etapa em que o card do lead está agora, e o que ela autoriza a IA a fazer.
 *
 * ⛔ Sem isto a Márcia era CEGA de funil: ela escrevia a etapa (ao mover o
 * card) e nunca a lia. Um lead em "Aguardando Decisão" que mandasse "e aí?"
 * era requalificado do zero — perguntavam o valor da dívida a quem já tinha
 * recebido proposta. O card diz de quem é a vez; ela precisa saber o que o
 * card diz.
 */
const ETAPAS: Record<string, { nome: string; conduta: string }> = {
  'f6c4e8c1-f13a-442a-9668-414cadb81c01': {
    nome: 'Novo Lead',
    conduta:
      'É o começo do funil e a conversa é sua. Pode conduzir a qualificação completa: entender o problema, o tipo e o valor.',
  },
  '57bed09e-bc01-4691-8272-dcd8c3c078df': {
    nome: 'Lead Qualificado',
    conduta:
      'Já atingiu o critério. Pode conduzir normalmente e levar ao agendamento — sem refazer a qualificação que já foi feita.',
  },
  'fd70e3b2-52e2-4f2c-b6e8-15450fe6c9d4': {
    nome: 'Reunião Agendada',
    conduta:
      'Você é a SECRETÁRIA desta reunião, não uma vendedora. Confirme dia, hora e link, tire dúvida de logística, ajude a remarcar se precisar. ⛔ Não qualifique, não pergunte valor nem tipo de dívida: isso já passou.',
  },
  'f2b7e7f6-c7d6-4d2b-ac6d-ad7842ab7045': {
    nome: 'Reagendar reunião',
    conduta:
      'Ele tinha reunião e ela caiu. Foque em remarcar: reconheça o retorno em uma frase e ofereça horários. ⛔ Não recomece a qualificação.',
  },
  '8bd228cf-fba4-4b28-b704-068bdcfa7c8d': {
    nome: 'FUP - Reativar Lead',
    conduta:
      'Ele já conversou com o escritório e esfriou. Reconheça o retorno e retome de onde parou — ⛔ sem repetir o roteiro inicial inteiro.',
  },
  '8c39cc10-4568-432f-b4dd-9a4ba228add6': {
    nome: 'Follow up No-show',
    conduta:
      'Ele faltou a uma reunião. Acolha sem cobrança e foque em remarcar. ⛔ Não recomece a qualificação e não fale em falta como se fosse culpa.',
  },
  'ef0adf54-fe31-4492-8bbe-40ef49a249eb': {
    nome: 'Enviar Proposta',
    conduta:
      '⛔ ETAPA SENSÍVEL — ele já está em negociação com o escritório. Você é CONCIERGE: acolha em uma frase, diga que a equipe responsável já está com o caso e vai retornar. ⛔ Não qualifique, não pergunte valor, não ofereça reunião, não fale de proposta nem de honorários.',
  },
  '54960a19-aedb-410a-8092-7c28829c10a7': {
    nome: 'Aguardando Decisão',
    conduta:
      '⛔ ETAPA SENSÍVEL — há uma proposta na mesa e a decisão é dele. Você é CONCIERGE: acolha em uma frase e diga que a equipe responsável já vai falar com ele. ⛔ Não qualifique, não pergunte valor, não cobre resposta, não fale de proposta nem de honorários.',
  },
  'f14359e9-5d16-4a49-91cd-512954ed1f42': {
    nome: 'Preenchimento de Contrato PJ',
    conduta:
      '⛔ ETAPA SENSÍVEL — contrato em elaboração. Acolha em uma frase e encaminhe; ⛔ nada de qualificação, prazo, valor ou detalhe contratual.',
  },
  '4425f561-f62a-4831-9ca1-6b549d513102': {
    nome: 'Preenchimento de Contrato PF',
    conduta:
      '⛔ ETAPA SENSÍVEL — contrato em elaboração. Acolha em uma frase e encaminhe; ⛔ nada de qualificação, prazo, valor ou detalhe contratual.',
  },
  '0d0382a5-f15d-4e43-88aa-0c70337d94d4': {
    nome: 'Perdido',
    conduta:
      'O atendimento foi encerrado antes. Se ele voltou por vontade própria, acolha bem e ouça o que mudou — sem cobrar nada do passado.',
  },
}

/**
 * Marca que o quadro e o alerta sonoro reconhecem.
 *
 * Vai no resumo do handoff (que o alerta lê pelo tempo real) e nas notas do
 * card (que o quadro desenha). ⛔ Mudar este texto quebra o selo e o bip —
 * quem alterar precisa alterar nos três lugares: aqui, no `deal-card` e no
 * `message-alerts`.
 */
export const MARCA_ATENCAO = '[ATENÇÃO]'

/**
 * Carimba o card para ele gritar no quadro.
 *
 * Um lead que escreve estando em negociação ou contrato não pode virar só mais
 * uma conversa no inbox: quem precisa ver é quem está tocando aquele caso, e
 * essa pessoa olha o funil, não a caixa de mensagens.
 */
async function marcarCardParaAtencao(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
  etapaNome: string,
): Promise<void> {
  const { data } = await db
    .from('deals')
    .select('id, notes')
    .eq('contact_id', contactId)
    .eq('pipeline_id', AI_VENDAS_PIPELINE)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
  const card = (data as { id: string; notes: string | null }[] | null)?.[0]
  if (!card) return
  const quando = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date())
  const linha = `${MARCA_ATENCAO} ${quando} — o lead escreveu no WhatsApp estando em "${etapaNome}". A IA não conduziu: aguarda você.`
  // Uma marca por vez: se já houver uma pendente, o card já está gritando.
  if ((card.notes ?? '').includes(MARCA_ATENCAO)) return
  await db
    .from('deals')
    .update({ notes: card.notes ? `${linha}\n\n${card.notes}` : linha })
    .eq('id', card.id)
}

/** Etapas em que a conversa é de gente, não de máquina. */
const ETAPAS_SENSIVEIS = new Set([
  'ef0adf54-fe31-4492-8bbe-40ef49a249eb',
  '54960a19-aedb-410a-8092-7c28829c10a7',
  'f14359e9-5d16-4a49-91cd-512954ed1f42',
  '4425f561-f62a-4831-9ca1-6b549d513102',
])

async function etapaDoCard(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
): Promise<{ id: string; nome: string; conduta: string } | null> {
  const { data } = await db
    .from('deals')
    .select('stage_id')
    .eq('contact_id', contactId)
    .eq('pipeline_id', AI_VENDAS_PIPELINE)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
  const id = (data as { stage_id: string }[] | null)?.[0]?.stage_id
  if (!id) return null
  const e = ETAPAS[id]
  return e ? { id, ...e } : null
}

/**
 * Dia e hora da reunião marcada, como "12/08/2026, 14:00".
 *
 * Quem preenche o formulário e agenda escreve depois para CONFIRMAR — e a IA
 * sabia apenas que existia uma reunião, nunca quando. Sem a data, o melhor que
 * ela podia fazer era desconversar ("você vai receber a confirmação"), o que
 * soa como quem não tem a informação na mão.
 */
async function dataDaReuniao(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
): Promise<string | null> {
  const { data } = await db
    .from('contact_custom_values')
    .select('value')
    .eq('contact_id', contactId)
    .eq('custom_field_id', CF_DATA)
    .limit(1)
  return (data as { value: string | null }[] | null)?.[0]?.value?.trim() || null
}

/**
 * O que a pessoa já respondeu no formulário do site.
 *
 * Quem chega pelo Typebot já disse valor, segmento e situação — o intake grava
 * isso em `deals.notes`, num bloco "Qualificação". Só que a IA nunca via essas
 * notas: perguntava tudo de novo a quem acabou de preencher, o que soa como
 * escritório que não lê o que recebe. Aqui as respostas voltam para a conversa.
 *
 * Devolve só as linhas do formulário (`• chave: valor`), aparadas — o resto das
 * notas é histórico interno do card (reuniões, reagendamentos) e não ajuda.
 */
async function respostasDoFormulario(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
): Promise<string | null> {
  const { data } = await db
    .from('deals')
    .select('notes')
    .eq('contact_id', contactId)
    .eq('pipeline_id', AI_VENDAS_PIPELINE)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
  const notes = (data as { notes: string | null }[] | null)?.[0]?.notes
  if (!notes) return null
  const linhas = notes
    .split('\n')
    .filter((l) => l.trim().startsWith('•'))
    .map((l) => l.trim())
  if (linhas.length === 0) return null
  return linhas.join('\n').slice(0, 700)
}

/**
 * Build the per-conversation context block appended to the system prompt.
 * Mirrors the CLIENT_MODE_BLOCK pattern: it augments the account's saved
 * SDR prompt with what we already know about THIS contact, without
 * editing it.
 *
 * States (highest first): client (its own block), already-had-a-meeting,
 * known/returning lead (has data but hasn't closed), brand-new. The whole
 * point: never re-ask data the CRM already has, and never treat a known
 * contact as a first-timer.
 */
export function buildContactContextBlock(args: {
  firstName: string | null
  email: string | null
  qualTags: string[]
  isClient: boolean
  hasMeeting: boolean
  isReturning: boolean
  /** Respostas do formulário do site, se a pessoa veio por ele. */
  formulario?: string | null
  /** Dia e hora da reunião marcada ("12/08/2026, 14:00"), se houver. */
  dataReuniao?: string | null
  /** Etapa do card e a conduta que ela autoriza. */
  etapa?: { nome: string; conduta: string } | null
}): string | null {
  const {
    firstName,
    email,
    qualTags,
    isClient,
    hasMeeting,
    isReturning,
    formulario,
    dataReuniao,
    etapa,
  } = args

  // Client mode already has CLIENT_MODE_BLOCK — just give it the name.
  if (isClient) {
    if (!firstName) return null
    return (
      'CONTEXTO DO CONTATO (prioridade alta):\n' +
      `- O nome do contato (pelo WhatsApp) é "${firstName}". Trate-o pelo primeiro nome.`
    )
  }

  const knownLead =
    hasMeeting || isReturning || !!email || qualTags.length > 0 || !!formulario

  // Brand-new inbound: only the WhatsApp name is known.
  if (!knownLead) {
    if (!firstName) return null
    return (
      'CONTEXTO DO CONTATO (prioridade alta):\n' +
      `- O nome do contato (identificado pelo WhatsApp) é "${firstName}". Trate-o pelo primeiro nome e NÃO pergunte o nome — você já o conhece (isto SOBREPÕE qualquer instrução acima de pedir o nome).\n` +
      '- É a PRIMEIRA conversa dele com o escritório: na sua primeira mensagem, apresente-se e diga de onde você fala. ⛔ Um "oi, tudo bem?" solto não basta — a pessoa não sabe com quem está falando.'
    )
  }

  // Known lead: list what we already have and forbid re-collecting it.
  // ⛔ Este bloco INFORMA; quem decide a ação é o roteiro. Escrito como ordem
  // ("leve direto ao agendamento"), ele atropela tudo: em 08/08/2026 mandou
  // oferecer horário a quem só disse "bom dia" — e ainda por cima a um lead de
  // R$ 1-5 milhões, que pela regra do escritório nem deveria receber horário.
  const lines: string[] = [
    'DADOS QUE JÁ TEMOS DESTE CONTATO (use isto; NÃO peça de novo o que já está aqui e NÃO recomece a qualificação do zero — continue de onde parou):',
    '- ⛔ Antes de qualquer coisa, responda o que a pessoa acabou de dizer. Estes dados são de antes; ela pode estar voltando por outro motivo. Nada aqui autoriza abrir a conversa falando de horário.',
  ]
  // A etapa manda em tudo: é ela que diz se esta conversa é de qualificação,
  // de secretaria ou de acolhimento antes de passar para um humano.
  if (etapa) {
    lines.push(`- ONDE ELE ESTÁ NO FUNIL: ${etapa.nome}. ${etapa.conduta}`)
  }
  if (firstName) lines.push(`- Nome: ${firstName} — trate pelo nome; não pergunte o nome.`)
  if (email) lines.push(`- E-mail: ${email} — não peça de novo.`)
  if (qualTags.length > 0)
    lines.push(`- Já classificado: ${qualTags.join(', ')} — não repita essa qualificação.`)
  if (formulario) {
    lines.push(
      `- ⛔ ELE JÁ PREENCHEU O FORMULÁRIO DO SITE e respondeu isto:\n${formulario}\n  Ou seja: JÁ ESTÁ QUALIFICADO. ⛔ Não pergunte de novo valor, tipo de dívida, situação nem se é pessoa física ou jurídica — está tudo aí. Refazer essas perguntas a quem acabou de preencher passa a impressão de escritório que não lê o que recebe.\n  O card dele já entrou na etapa certa do funil e as mensagens automáticas já saíram — disso o sistema cuida sozinho. A sua parte é só a conversa.`,
    )
  }

  if (hasMeeting) {
    lines.push(
      dataReuniao
        ? `- Situação: JÁ TEM REUNIÃO MARCADA para ${dataReuniao} (horário de Brasília). Não requalifique. Se ele escrever para confirmar, essa é a data — pode confirmar com segurança. Se quiser mudar de horário, é remarcação. Se for sobre o caso/andamento ou precisar do advogado, acolha e explique que a equipe responsável vai retornar — nunca invente nada sobre o processo.`
        : `- Situação: JÁ agendou/teve uma reunião com o escritório. Não requalifique. Se for dúvida simples/logística (reagendar, horário, documentos), ajude com naturalidade; se for sobre o caso/andamento ou precisar do advogado, acolha e explique que a equipe responsável vai retornar — nunca invente nada sobre o processo.`,
    )
    // ⛔ Quando NÃO há reunião, dizer isso é tão importante quanto dizer a data
    // quando há. Em 09/08/2026 o titular perguntou "como ficou minha reunião?
    // tá agendada?" e ela respondeu "está remarcada para quinta 20/08, às 13h"
    // — lendo do histórico um horário que ele havia ESCOLHIDO mas que nunca
    // chegou a ser reservado. Sem o fato na mão, ela responde de memória.
  } else if (formulario) {
    lines.push(
      '- ⛔ Não há REGISTRO de reunião para ele no sistema. Isso não é o mesmo que "ele não tem reunião": há reservas que chegam por canais que o sistema não vê. Se ele PERGUNTAR se tem algo marcado, diga que não há horário reservado e ofereça marcar agora. ⛔ Mas se ele AFIRMAR que tem reunião, ou disser data e hora, ou colar um convite: NÃO o contradiga, NÃO diga que o horário não existe e NÃO oferece outras datas — quem confere compromisso marcado é uma pessoa. ⛔ E não confirme reunião a partir do que foi falado antes: horário escolhido na conversa NÃO é horário reservado.',
      '- Situação: preencheu o formulário e AINDA NÃO agendou — parou antes de marcar. A qualificação já está feita: retome de onde ele parou, sem recomeçar. O que fazer a partir daí é a sua leitura da conversa e do critério de valor, como sempre.',
    )
  } else {
    lines.push(
      '- ⛔ Não há REGISTRO de reunião para ele no sistema. Isso não é o mesmo que "ele não tem reunião": há reservas que chegam por canais que o sistema não vê. Se ele PERGUNTAR se tem algo marcado, diga que não há horário reservado e ofereça marcar agora. ⛔ Mas se ele AFIRMAR que tem reunião, ou disser data e hora, ou colar um convite: NÃO o contradiga, NÃO diga que o horário não existe e NÃO oferece outras datas — quem confere compromisso marcado é uma pessoa. ⛔ E não confirme reunião a partir do que foi falado antes: horário escolhido na conversa NÃO é horário reservado.',
    )
    lines.push(
      `- Situação: já falou com o escritório antes e ainda não fechou. ⛔ A sua PRIMEIRA mensagem desta conversa TEM de reconhecer o retorno${firstName ? ` (ex.: "Que bom te ver de novo, ${firstName}!")` : ''} — cumprimentar como se fosse a primeira vez faz parecer que ninguém aqui lembra dele. Se já faz horas ou dias desde a última troca, vale se reapresentar em meia frase ("aqui é a Márcia, do Simionato Advogados") — ninguém guarda de cabeça com quem falou ontem. Só não recomece a coleta de dados nem a qualificação. ⛔ Responda PRIMEIRO o que ele acabou de dizer e descubra o que ele quer AGORA — o que ficou registrado aqui é do passado, e ele pode estar voltando por outro motivo. Conduza ao agendamento quando fizer sentido na conversa, ⛔ nunca já na primeira frase.`,
    )
  }

  return lines.join('\n')
}

/**
 * Split an AI reply into separate WhatsApp bubbles on blank lines, so the
 * bot can send e.g. a greeting and then a question as two messages, like a
 * human types. Capped so a long reply cannot fan out into a wall of pings;
 * overflow is merged back into the last bubble rather than dropped.
 */
function splitBubbles(text: string): string[] {
  const parts = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length <= 1) return [text.trim()]
  const MAX = 4
  if (parts.length <= MAX) return parts
  return [...parts.slice(0, MAX - 1), parts.slice(MAX - 1).join('\n\n')]
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select(
        'assigned_agent_id, ai_autoreply_disabled, ai_reply_count, ai_handoff_summary, updated_at',
      )
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) {
      // ⛔ Desligamento por TRAVA do sistema (teto de respostas, frase repetida,
      // áudio sem transcrição) não pode durar para sempre: sem dono humano, a
      // pessoa que voltasse semanas depois falaria com o vazio. Passado um dia
      // inteiro e chegando mensagem nova, a IA reassume — a conversa de agora
      // é outra, e o motivo do desligamento morreu com a anterior.
      const porTrava = FOI_TRAVA_DO_SISTEMA.test(conv.ai_handoff_summary ?? '')
      const paradaHa = Date.now() - new Date(conv.updated_at as string).getTime()
      if (!porTrava || paradaHa < REABRE_APOS_MS) return
      console.log(
        `[ai auto-reply] conversa ${conversationId} reaberta: trava do sistema há ${Math.round(paradaHa / 3_600_000)}h e ninguém assumiu`,
      )
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: false, ai_reply_count: 0 })
        .eq('id', conversationId)
    }
    // Teto de respostas desta conversa. ⛔ Antes isto era um `return` mudo — o
    // lead falava e ninguém respondia mais, sem nenhum sinal para o escritório.
    // Bateu no teto, a conversa é de humano.
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      console.warn(
        `[ai auto-reply] conversa ${conversationId} bateu o teto de ${config.autoReplyMaxPerConversation} respostas — passando para humano.`,
      )
      await passarParaHumano(
        db,
        conversationId,
        `A IA atingiu o limite de ${config.autoReplyMaxPerConversation} respostas automáticas nesta conversa e parou. O lead segue esperando resposta — assuma daqui.`,
        config.handoffAgentId,
        !!conv.assigned_agent_id,
      )
      return
    }

    // Espera a rajada terminar: se outra mensagem do contato chegar nestes
    // segundos, esta resposta é descartada e quem responde é o disparo da
    // última — com a conversa inteira em contexto.
    const gatilho = await ultimaEntrada(db, conversationId)
    await sleep(esperaRajadaMs())
    if ((await ultimaEntrada(db, conversationId)) !== gatilho) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    // One read of this contact's tags drives three things: existing
    // clients (tag "Cliente") never get lead qualification; contacts who
    // already booked/attended a meeting (tag "Agendou") must not be
    // re-qualified; and any qualification tags are echoed back so the
    // model doesn't re-ask what we already know.
    let isClient = false
    let hasMeeting = false
    let qualTags: string[] = []
    {
      const { data: tagRows } = await db
        .from('contact_tags')
        .select('tags!inner(name)')
        .eq('contact_id', contactId)
      const names = new Set<string>()
      for (const r of tagRows ?? []) {
        const t = (r as { tags?: { name?: string } | { name?: string }[] }).tags
        if (Array.isArray(t)) t.forEach((x) => x?.name && names.add(x.name))
        else if (t?.name) names.add(t.name)
      }
      isClient = names.has('Cliente')
      hasMeeting = names.has('Agendou')
      qualTags = QUAL_TAGS.filter((t) => names.has(t))
    }

    // Contact's WhatsApp name + e-mail (used to greet by name and skip the
    // data-collection steps we already have) and whether they're returning.
    const { data: contactRow } = await db
      .from('contacts')
      .select('name, phone, email')
      .eq('id', contactId)
      .maybeSingle()
    const firstName = legibleFirstName(contactRow?.name, contactRow?.phone)
    const emailDoCadastro = contactRow?.email?.trim() || null

    // O e-mail escrito na conversa GANHA do cadastro: quem digita de novo está
    // corrigindo. ⛔ Na ordem inversa, um e-mail errado gravado uma vez envenena
    // para sempre — em 08/08/2026 o titular digitou "@gnail.con", o valor foi
    // parar no contato, e a correção seguinte foi ignorada turno após turno
    // porque o cadastro tinha precedência. Grava a cada mudança.
    const email = emailNaConversa(messages) ?? emailDoCadastro
    if (email && email !== emailDoCadastro) {
      await db.from('contacts').update({ email }).eq('id', contactId)
      console.log(`[ai auto-reply] e-mail atualizado pela conversa: ${email}`)
    }

    let isReturning = false
    if (!isClient && !hasMeeting) {
      // (a) we reached them in a past broadcast (e.g. a re-engagement
      //     disparo) and now they're replying.
      const { data: bc } = await db
        .from('broadcast_recipients')
        .select('id')
        .eq('contact_id', contactId)
        .in('status', ['sent', 'delivered', 'read', 'replied'])
        .limit(1)
      if (bc && bc.length > 0) isReturning = true

      // (b) or there's an earlier message session in this reused
      //     conversation (a real gap before the current inbound).
      if (!isReturning) {
        const { data: msgs } = await db
          .from('messages')
          .select('created_at')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: false })
          .limit(50)
        if (msgs && msgs.length > 1) {
          const newest = new Date(msgs[0].created_at).getTime()
          isReturning = msgs
            .slice(1)
            .some(
              (m) => newest - new Date(m.created_at).getTime() > RETURNING_GAP_MS,
            )
        }
      }
    }

    // AGENDA REAL — lida antes de responder, para a IA DIZER horário em vez de inventar.
    // ⛔ Falha na consulta devolve lista vazia, e o prompt então a proíbe de falar de
    // horário: melhor responder sem horário nenhum do que com horário que não existe.
    const slots = await agendaDoEscritorio()

    let systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      horarios: slots.map((s) => s.rotulo),
    })
    if (isClient) systemPrompt += '\n\n' + CLIENT_MODE_BLOCK
    // O que o funil já sabe desta pessoa: o formulário que ela preencheu e,
    // se agendou, o dia da reunião. Sem isso a IA repergunta o que o site já
    // perguntou e desconversa sobre a própria agenda do escritório.
    const [formulario, dataReuniao, etapa] = await Promise.all([
      isClient ? Promise.resolve(null) : respostasDoFormulario(db, contactId),
      hasMeeting ? dataDaReuniao(db, contactId) : Promise.resolve(null),
      isClient ? Promise.resolve(null) : etapaDoCard(db, contactId),
    ])

    const contextBlock = buildContactContextBlock({
      firstName,
      email,
      qualTags,
      isClient,
      hasMeeting,
      isReturning,
      formulario,
      dataReuniao,
      etapa,
    })
    if (contextBlock) systemPrompt += '\n\n' + contextBlock

    // ⛔ A PESSOA AFIRMA TER REUNIAO E O SISTEMA NAO TEM REGISTRO.
    //
    // Ausencia de registro nao e prova de ausencia. Em 10/08/2026 um lead
    // escreveu "desejo confirmar meu agendamento", deu data e hora, e a IA
    // respondeu que o horario nao existia no sistema — oferecendo datas 7 e 14
    // dias depois. A reuniao era real; so nao estava no CRM.
    //
    // Confirmar agendamento nunca foi trabalho dela: a confirmacao sai por
    // automacao quando a reserva chega. Divergencia sobre compromisso marcado
    // se resolve com gente olhando a agenda.
    const ultimaDoLead =
      [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    if (!hasMeeting && PESSOA_AFIRMA_REUNIAO.test(String(ultimaDoLead))) {
      console.warn(
        `[ai auto-reply] ⛔ lead afirma ter reuniao e o sistema nao tem registro - passando para humano (contato ${contactId})`,
      )
      await passarParaHumano(
        db,
        conversationId,
        `${MARCA_ATENCAO} Ele afirma ter reuniao marcada e o sistema NAO tem registro dela. ⛔ Isso nao prova que nao existe: ha reservas que chegam por canais que o CRM nao capta. Confira na agenda antes de responder — a IA foi impedida de contradize-lo.`,
        config.handoffAgentId,
        !!conv.assigned_agent_id,
      )
      return
    }

    const { text, handoff, move, agendar, desmarcar, portaAberta, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    // AGENDAMENTO — marca ANTES de falar. ⛔ A ordem é o coração disto: se a
    // reserva falhasse DEPOIS da confirmação sair, o lead apareceria para uma
    // reunião que não existe — exatamente o vexame que o roteiro sempre temeu.
    // Reservar só depois de ganhar o slot de resposta garante o par
    // "marcou ⇔ avisou": nunca uma reunião criada sem ninguém contar.
    let textoFinal = text
    let moveFinal = move
    let reservaFeita = false
    if (!isClient && iaAgendaAtiva()) {
      // 1) DESFAZER primeiro. O que a pessoa avisou por mensagem — "não vou
      //    poder" — só vira verdade quando a reserva morre: é isso que libera
      //    o horário para outro lead e cala os lembretes. Vale mesmo que a
      //    remarcação não venha em seguida.
      // Desistir TAMBÉM desfaz a reunião. ⛔ Sem isto, quem tem horário
      // marcado e diz "não preciso mais" tem o card fechado como Perdido e a
      // reserva CONTINUA de pé: o horário fica preso, e os lembretes de
      // véspera e de 1h ainda batem na porta de quem já se despediu.
      if ((desmarcar || moveFinal === 'perdido') && hasMeeting) {
        await desfazerReuniao(db, contactId)
      }

      // 2) REMARCAR (ou marcar pela primeira vez).
      if (agendar !== null) {
        const nomeCompleto = legibleFirstName(contactRow?.name, contactRow?.phone)
          ? (contactRow?.name?.trim() ?? null)
          : null
        const r = await reservarHorario({
          indice: agendar,
          slots,
          nome: nomeCompleto,
          email,
          telefone: contactRow?.phone ?? null,
          // Releitura na hora: pega a reserva que acabou de entrar pelo webhook
          // e evita marcar duas. Desfeita agora, a antiga não bloqueia a nova.
          hasMeeting: desmarcar ? false : await temReuniaoAgora(db, contactId),
          textoDaIa: text,
        })
        textoFinal = r.texto
        reservaFeita = r.ok
        if (r.reagendar) moveFinal = 'reagendar'
        // Desmarcou e a remarcação não saiu: o card não pode ficar parado em
        // "Reunião Agendada" sem reunião nenhuma. Vai para Reagendar, e o
        // fluxo de nutrição volta a puxar essa pessoa.
        if (desmarcar && !r.ok && !moveFinal) moveFinal = 'reagendar'
      }
      // ⛔ Desmarcar NÃO move o card sozinho. Mover para "Reagendar reunião"
      // acorda a automação de etapa, que dispara o template "vi que você
      // precisou cancelar o horário" — e ele chegou, em 08/08/2026, um segundo
      // depois de a IA já ter oferecido horários novos na conversa. Dois
      // atendimentos falando com a mesma pessoa ao mesmo tempo.
      // O card só se move quando a PESSOA adia ([[REAGENDAR]], que o modelo
      // marca) ou quando a remarcação falhou (tratado acima).

      // ⛔ TRAVA: ela não anuncia o que não fez.
      //
      // 08/08/2026, primeira conversa real: sem ter o e-mail, ela corretamente
      // NÃO usou o marcador (é o que a instrução manda) — e mesmo assim
      // escreveu "prontinho, agendei para quarta às 16:15". Nenhuma reserva
      // existia. Pior: na mensagem seguinte ela leu o próprio "agendei" no
      // histórico, concluiu que estava feito e respondeu "o convite já foi
      // enviado". A mentira se propagou sozinha.
      //
      // Proibir no prompt não basta: o modelo escorrega, e escorregou. Aqui a
      // frase simplesmente não sai.
      if (!reservaFeita && !hasMeeting && AFIRMA_QUE_AGENDOU.test(textoFinal)) {
        console.error(
          `[ia-agenda] ⛔ resposta afirmava reunião marcada sem reserva nenhuma — substituída. Original: ${textoFinal.slice(0, 200)}`,
        )
        textoFinal = email ? NAO_CONFIRMADO : FALTA_EMAIL
      }
    }

    // ⛔ TRAVA ANTI-LAÇO: nunca mandar de novo a MESMA frase que acabou de sair.
    //
    // 08/08/2026: o titular mandou o e-mail cinco vezes e ouviu cinco vezes a
    // mesma frase pedindo o e-mail. Um texto idêntico repetido não é conversa,
    // é sistema preso — e quem está do outro lado vê um robô quebrado. Nenhuma
    // instrução conserta isso, porque a frase repetida vinha do meu código.
    // Repetiu, a conversa é de humano.
    const ultimaDaIa = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant')
      ?.content.trim()
    if (ultimaDaIa && splitBubbles(textoFinal).some((b) => b.trim() === ultimaDaIa)) {
      console.error(
        `[ai auto-reply] ⛔ repetiria a mesma frase na conversa ${conversationId} — passando para humano. Frase: ${ultimaDaIa.slice(0, 120)}`,
      )
      await passarParaHumano(
        db,
        conversationId,
        'A IA ficou repetindo a mesma resposta e foi interrompida. Veja a conversa: provavelmente ela pediu um dado que a pessoa JÁ mandou. Assuma daqui.',
        config.handoffAgentId,
        !!conv.assigned_agent_id,
      )
      return
    }

    // Send as one or more WhatsApp bubbles. The model separates bubbles
    // with a blank line (e.g. greeting, then the question). This is still
    // ONE logical reply — the per-conversation slot was claimed once
    // above, so extra bubbles do NOT each consume a slot. A short gap
    // between sends preserves order and feels human.
    const bubbles = splitBubbles(textoFinal)
    for (let i = 0; i < bubbles.length; i++) {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: bubbles[i],
        aiGenerated: true,
      })
      if (i < bubbles.length - 1) await sleep(900)
    }

    // PORTA ABERTA: a pessoa recusou marcar agora. Em vez de encerrar de mãos
    // vazias, a despedida vai seguida de um botão que abre a agenda.
    //
    // ⚠️ O botão leva DIRETO ao Cal.com, de propósito (decisão do titular): a
    // pessoa costuma voltar dias depois, e aí ela marca de fato em vez de
    // reabrir uma conversa que estaria fria dos dois lados.
    // ⛔ Não manda o botão se o card vai para "Reagendar reunião": aquela etapa
    // já dispara um template que TAMBÉM tem botão de agendamento. Os dois
    // juntos chegam em sequência, dizendo a mesma coisa duas vezes.
    if (portaAberta && !isClient && moveFinal !== 'reagendar') {
      try {
        await engineSendCtaUrl({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          bodyText:
            'Se mudar de ideia, é só tocar no botão abaixo e escolher o melhor horário. Fico à disposição! 😊',
          buttonText: 'Agendar agora',
          url: AGENDA_LINK,
        })
      } catch (err) {
        console.error('[ia-agenda] botão de porta aberta falhou:', err)
      }
    }

    // Fase 3: act on the AI's card-move marker (after the reply is sent).
    if (moveFinal && !isClient) {
      try {
        // `hasMeeting` é do INÍCIO do turno — de propósito. Quem acabou de
        // desmarcar continua sendo alguém que tinha reunião, e para essa
        // pessoa "reagendar" é exatamente o certo. Quem nunca teve, não.
        await applyAiCardMove(db, {
          accountId,
          contactId,
          move: moveFinal,
          temReuniao: hasMeeting,
        })
      } catch (err) {
        console.error('[ai auto-reply] card move failed:', err)
      }
    }

    // ETAPA SENSÍVEL: ela acolheu em uma frase e para por aqui. A conversa vai
    // para uma pessoa — e o handoff É o alerta interno, porque aparece no
    // inbox de quem trabalha, e não num painel que ninguém abre. Proposta,
    // decisão e contrato são conversas com consequência: cada palavra ali é
    // compromisso do escritório, não papo de qualificação.
    if (etapa && ETAPAS_SENSIVEIS.has(etapa.id) && !isClient) {
      console.log(
        `[ai auto-reply] etapa sensível (${etapa.nome}) — acolhido e passado para humano`,
      )
      await passarParaHumano(
        db,
        conversationId,
        `${MARCA_ATENCAO} Lead escreveu estando em "${etapa.nome}". A IA apenas acolheu e parou — etapa de negociação/contrato é conversa de gente. Assuma daqui.`,
        config.handoffAgentId,
        !!conv.assigned_agent_id,
      )
      await marcarCardParaAtencao(db, contactId, etapa.nome)
    }

    // Existing client: the AI acknowledged in client mode; now hand the
    // thread to a human - the bot must not field questions about the case.
    if (isClient) {
      const clientUpdate: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary:
          'Cliente existente - atendimento sobre o caso. A IA acolheu e encaminhou para um humano (nao qualifica cliente).',
      }
      if (config.handoffAgentId) clientUpdate.assigned_agent_id = config.handoffAgentId
      await db.from('conversations').update(clientUpdate).eq('id', conversationId)
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
