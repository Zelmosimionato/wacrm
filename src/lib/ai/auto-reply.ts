import type { ChatMessage } from './types'
import { supabaseAdmin } from './admin-client'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText, engineSendCtaUrl } from '@/lib/flows/meta-send'
import { enviarPeloSegundoNumero, registrarEnvioSegundoNumero } from '@/lib/whatsapp/segundo-numero'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { horariosLivres, type SlotLivre } from '@/lib/appointments/calcom-slots'
import { criarReserva } from '@/lib/appointments/calcom-book'
import { cancelCalcomBooking } from '@/lib/appointments/calcom-cancel'
import { iaAgendaAtiva } from './defaults'
import { respostaConfirmaHorario } from './horario-confirmado'
// Guardas puros: processo citado, validador de saída, piso, perdido.
import {
  ACOLHIMENTO_HANDOFF,
  type OrigemDisparo,
  TEXTO_SEGURO_FALLBACK,
  debounceMs,
  detectaProcesso,
  esperaAntesDeGerarMs,
  falhaParaPrompt,
  herdarMarcadoresDeAgenda,
  motivoBloqueioPiso,
  podeMarcarPerdido,
  textoDoLeadNaRajada,
  validarSaida,
} from './sdr-guards'
// Desbloqueio de Conta: faixas de valor bloqueado (regra de 15/10/2026).
import {
  DBC_CORTE_RECUSA,
  PERGUNTA_VALOR_EXATO_DBC,
  VALOR_ABAIXO_DBC,
  blocoPromptDbc,
  deveEncaminharFaixaDbc,
  estadoDbcDaConversa,
  proximaPerguntaFaixaDbc,
  textoIncompativelComFaixaDbc,
} from './dbc-faixas'

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
/** Trava de verdade (01/09/2026): a IA tem a regra de perguntar PF/PJ
 *  escrita e nem sempre cumpre. Sem a tag gravada, `reservarHorario` recusa
 *  marcar e devolve este texto em vez da confirmação — não importa o que a
 *  resposta gerada dizia. */
const FALTA_SEGMENTO =
  'Antes de eu confirmar o horário, só uma última pergunta: essa dívida é sua, pessoal, ou é de uma empresa?'
/**
 * Pisos confidenciais de valor por segmento (mesma fonte da qualificação em
 * `ai_configs.system_prompt`). ⚠️ Tributário PJ tem piso real de R$50k, não
 * R$100k — usar o piso de PJ aqui (mais alto) pra todo mundo é simplificação
 * consciente, mesmo trade-off já aceito na trava de PF/PJ de 01/09: no pior
 * caso pede uma confirmação a mais de quem insistir, nunca perde o lead —
 * a porta sempre fica aberta (ver VALOR_ABAIXO_DO_PISO).
 */
const PISO_PF = 50_000
const PISO_PJ = 100_000
/**
 * Trava de verdade pro PISO DE VALOR (01/09/2026, caso Lead A): a IA tinha a
 * regra escrita ("diga que pode não compensar EM VEZ DE oferecer horário") e,
 * na mesma resposta em que revelou o valor, também ofereceu horário — texto
 * sozinho não bastou, mesma classe de falha do PF/PJ. Troca a resposta
 * INTEIRA antes de sair: o cliente nunca chega a ver a oferta indevida (não é
 * "oferece e depois cancela"). ⛔ Nunca revela o número nem o critério; a
 * porta fica aberta — se a pessoa insistir na resposta seguinte, o próximo
 * turno não carrega o marcador de valor de novo e segue o fluxo normal.
 */
/** Texto original desta trava, antes da unificação de 21/09/2026 (achado:
 *  quem desqualifica pela trava de código PF/PJ ouvia uma despedida
 *  diferente de quem é desqualificado pela própria Márcia nos produtos
 *  DEF/DBC/GPIX/GPASS, cujo texto vem do Agent da plataforma). Mantido como
 *  fallback documentado — não apagar. */
export const VALOR_ABAIXO_DO_PISO_FALLBACK =
  'Vou ser honesta: pela nossa experiência, para valores nessa faixa o custo de uma ação acaba não compensando — prefiro te dizer isso a te levar por um caminho que não vale a pena.\n\nMas você não fica sem nada: no nosso blog e nos materiais gratuitos tem bastante coisa que ajuda. Blog: https://simionatoadvogados.com.br/blog/ · Materiais: https://simionatoadvogados.com.br/materiais-gratuitos/'
/** Mensagem oficial (21/09/2026): o MESMO texto programado no Agent da
 *  plataforma para "DESQUALIFICAÇÃO POR VIABILIDADE ECONÔMICA", com os
 *  mesmos links de blog/materiais gratuitos que a trava de código já
 *  oferecia. Unifica a despedida — não importa se quem desqualificou foi
 *  esta trava (PF/PJ) ou a própria Márcia nos produtos DEF/DBC/GPIX/GPASS. */
export const VALOR_ABAIXO_DO_PISO =
  'Entendi. Pelas informações que você me passou, infelizmente o seu caso não se enquadra no perfil de atendimento que estamos trabalhando neste momento.\n\nComo trabalhamos com processos judiciais, precisamos considerar os custos envolvidos em relação aos benefícios que podem ser obtidos. No seu caso, esses custos podem não compensar, tornando a medida judicial economicamente inviável.\n\nMas agradecemos muito o seu contato. Estaremos sempre de portas abertas caso futuramente precise nos procurar novamente.\n\nMas você não fica sem nada: no nosso blog e nos materiais gratuitos tem bastante coisa que ajuda. Blog: https://simionatoadvogados.com.br/blog/ · Materiais: https://simionatoadvogados.com.br/materiais-gratuitos/'
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
  db: ReturnType<typeof supabaseAdmin>
  contactId: string
  indice: number
  slots: SlotLivre[]
  nome: string | null
  email: string | null
  telefone: string | null
  hasMeeting: boolean
  textoDaIa: string
}): Promise<{ texto: string; ok: boolean; reagendar: boolean }> {
  const { db, contactId, indice, slots, nome, email, telefone, hasMeeting, textoDaIa } = args

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
    // O card, a data e os lembretes vêm do webhook BOOKING_CREATED que o
    // intake já trata. A tag "Agendou" TAMBÉM — mas achado ao vivo,
    // 22/08/2026: entre a reserva sair aqui e o webhook do Cal.com chegar
    // no /calcom (rede + fila), existe uma janela real onde `temReuniaoAgora`
    // (que só olha essa tag) ainda vê "sem reunião". Lead escolhendo outra
    // data dentro dessa janela reservava DE NOVO — duas reservas ativas pro
    // mesmo contato, a antiga nunca cancelada. Aplicar a tag aqui, na hora,
    // fecha a janela; o webhook aplica de novo depois (idempotente, mesmo
    // UNIQUE(contact_id, tag_id) do schema — onConflict vira no-op).
    const { error: tagErr } = await db
      .from('contact_tags')
      .upsert({ contact_id: contactId, tag_id: TAG_AGENDOU }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
    if (tagErr) {
      console.warn(`[ia-agenda] nao consegui marcar Agendou na hora (webhook cobre depois): ${tagErr.message}`)
    }
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
 * De onde a IA podia avançar um card (hoje a qualificação só grava tag e aviso).
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
const TAG_PF = '9f870fd7-1155-4ede-9da8-8678360c0ae9'
const TAG_PJ = 'ea69a90c-407b-411c-953c-2d9920ef6a5e'
/** Tags de PRODUTO (23/09/2026, caso Lead L): a trava generica de piso so
 *  sabia PF/PJ e foi desligada em 21/09 por nao saber diferenciar produtos
 *  com corte proprio (DBC R$5k, GPIX R$10k) do bancario geral (R$50k). Em
 *  vez de inventar um marcador novo que a IA precisaria lembrar de emitir,
 *  reusamos o motor de automacao que ja existe no CRM: 4 automacoes
 *  keyword_match (1a mensagem) gravam uma destas tags via add_tag, o mesmo
 *  padrao que ja gravava "Bancario"/"Tributario". Fonte da verdade das
 *  palavras-chave fica na tela de Automacoes do CRM, nao aqui. */
const TAG_PRODUTO_RCPCC = '6b2df561-a2fd-497b-91b9-4eaede9ad917'
const TAG_PRODUTO_DBC = '8a749c20-e504-46d0-8e56-92c8abc10de0'
const TAG_PRODUTO_GPIX = 'd2b4ae5e-874d-4553-9fc1-b64fdb6a381d'
const TAG_PRODUTO_GPASS = '2cc91bd9-0903-48dc-a384-f2d82c138bf5'
const TAG_PRODUTO_DEF = '8cbb4baa-f220-425d-9812-46300b7e94c8'
/** Corte de valor por produto (23/09/2026) — mesmos numeros do material de
 *  treinamento comercial (14_Treinamento_IA_Marcia/MARCIA_2_BASE_COMERCIAL).
 *  RCPCC e DEF confirmados com o titular (R$50k cada, mesmo numero por
 *  coincidencia — nao e o generico PISO_PF, e o corte real de cada um). */
const PISO_POR_PRODUTO: Record<string, number> = {
  RCPCC: 50_000,
  DBC: DBC_CORTE_RECUSA, // abaixo disto recusa; de 3 a 5 mil vai ao titular (dbc-faixas.ts)
  GPIX: 10_000,
  GPASS: 100_000,
  DEF: 50_000,
}
/** Trava PERSISTENTE do piso de valor (11/09/2026, caso Lead R2):
 *  o marcador [[VALOR:N]] só é emitido UMA vez por instrução do prompt, e a
 *  rede de regex (valorDeclaradoPeloCliente) exige contexto de moeda
 *  explícito no texto do cliente. Um valor declarado sem "R$"/"mil"/"reais"
 *  (ex.: cliente só digita "9614.69") passa pelas duas fontes só no turno em
 *  que a IA reconhece e recusa — a partir do turno seguinte valorEfetivo
 *  volta a ser null pra sempre, e a trava de piso (abaixo) para de agir,
 *  mesmo a pessoa nunca tendo dado um valor novo. Foi assim que o
 *  Lead R2 (R$9.614,69 PF, piso R$50k) ouviu a recusa certa e,
 *  insistindo no turno seguinte sem repetir o valor, conseguiu agendar de
 *  verdade. Esta tag grava o veredito assim que ele é calculado, pra
 *  continuar valendo em turnos futuros sem depender de a IA repetir nada. */
const TAG_ABAIXO_PISO = '72923bee-2b12-4093-9aa9-cb773aae3928'

/** Lê o segmento PF/PJ já GRAVADO (tag persistida) — não o desta resposta,
 *  porque a confirmação de PF/PJ pode ter vindo num turno anterior ao que
 *  revela o valor (foi exatamente o caso da Lead A, 01/09/2026). PJ ganha
 *  se, por algum motivo, as duas tags existirem — mesmo desempate do
 *  `parseGeneration`. */
async function segmentoPersistido(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
): Promise<'PF' | 'PJ' | null> {
  const { data } = await db
    .from('contact_tags')
    .select('tag_id')
    .eq('contact_id', contactId)
    .in('tag_id', [TAG_PF, TAG_PJ])
  if (!data?.length) return null
  return data.some((t) => t.tag_id === TAG_PJ) ? 'PJ' : 'PF'
}

/** Le a tag de PRODUTO ja gravada (automacao do CRM, ver TAG_PRODUTO_* acima)
 *  pra trava de piso escolher o corte certo em vez do generico PF/PJ.
 *  Se mais de uma tag de produto existir (nao deveria, mas a automacao roda
 *  fora do controle desta funcao), pega a de menor corte — falso positivo de
 *  barrar de mais e mais barato que deixar passar um lead ruim. */
async function produtoPersistido(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
): Promise<keyof typeof PISO_POR_PRODUTO | null> {
  const { data } = await db
    .from('contact_tags')
    .select('tag_id')
    .eq('contact_id', contactId)
    .in('tag_id', [TAG_PRODUTO_RCPCC, TAG_PRODUTO_DBC, TAG_PRODUTO_GPIX, TAG_PRODUTO_GPASS, TAG_PRODUTO_DEF])
  if (!data?.length) return null
  const encontrados = data.map((t) => {
    if (t.tag_id === TAG_PRODUTO_DBC) return 'DBC' as const
    if (t.tag_id === TAG_PRODUTO_GPIX) return 'GPIX' as const
    if (t.tag_id === TAG_PRODUTO_GPASS) return 'GPASS' as const
    if (t.tag_id === TAG_PRODUTO_DEF) return 'DEF' as const
    return 'RCPCC' as const
  })
  return encontrados.sort((a, b) => PISO_POR_PRODUTO[a] - PISO_POR_PRODUTO[b])[0]
}

/** Lê se este contato já foi confirmado abaixo do piso em QUALQUER turno
 *  anterior (tag persistida por `aplicarVeredictoPiso` abaixo). Rede de
 *  último recurso: só entra quando o turno atual não trouxe nenhum valor
 *  novo (nem marcador, nem regex no texto do cliente). */
async function abaixoPisoPersistido(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
): Promise<boolean> {
  const { data } = await db
    .from('contact_tags')
    .select('tag_id')
    .eq('contact_id', contactId)
    .eq('tag_id', TAG_ABAIXO_PISO)
  return !!data?.length
}

/** Grava (ou apaga) a tag "Abaixo do Piso" quando o turno atual traz um
 *  valor FRESCO (marcador ou regex — nunca a própria tag persistida, senão
 *  vira um loop que nunca desliga sozinho). Mantém a porta aberta de
 *  verdade: se a pessoa mais tarde declarar um valor novo igual ou acima do
 *  piso, a tag some e ela deixa de estar travada. */
async function aplicarVeredictoPiso(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
  abaixo: boolean,
): Promise<void> {
  if (abaixo) {
    const { error } = await db
      .from('contact_tags')
      .upsert({ contact_id: contactId, tag_id: TAG_ABAIXO_PISO }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
    if (error) console.warn(`[ia-valor] não consegui gravar a trava persistente (contact ${contactId}): ${error.message}`)
  } else {
    const { error } = await db
      .from('contact_tags')
      .delete()
      .eq('contact_id', contactId)
      .eq('tag_id', TAG_ABAIXO_PISO)
    if (error) console.warn(`[ia-valor] não consegui destravar (contact ${contactId}): ${error.message}`)
  }
}

/** "47.500,00" → 47500 · "450" → 450 · "1.234" → 1234 (ponto = milhar, vírgula
 *  = decimal, padrão BR). */
function normalizaValorBr(bruto: string): number | null {
  const limpo = bruto.replace(/\./g, '').replace(',', '.')
  const n = Number(limpo)
  return Number.isFinite(n) ? Math.round(n) : null
}

/**
 * Rede da trava de piso (01/09/2026, caso Lead R): extrai o ÚLTIMO valor em
 * reais que o PRÓPRIO CLIENTE escreveu — nunca o que a IA escreveu. Existe
 * porque o marcador `[[VALOR:N]]` depende da IA lembrar de emitir, e no caso
 * do Lead R ela reconheceu "R$450,00" na conversa e foi direto pra oferecer
 * horário sem nunca emitir nada. Isto NÃO substitui o marcador — só entra
 * quando `valor` (do turno) veio null, como último recurso.
 * ⚠️ Heurística de texto, não entendimento: uma conversa com vários números
 * (valor original do empréstimo, parcela, valor já pago) pode pegar o número
 * errado. Por isso exige contexto de moeda explícito (`R$`, "mil" ou "reais"
 * — nunca número solto, que seria telefone/data/contagem de parcela) e serve
 * só de REDE: o pior caso de acertar errado é travar uma resposta boa, e a
 * recusa (`VALOR_ABAIXO_DO_PISO`) sempre deixa a porta aberta pra insistir.
 */
export function valorDeclaradoPeloCliente(messages: ChatMessage[]): number | null {
  // 18/09/2026, caso Lead P: "R$ 90 mil" caia inteiro no 1o ramo (R$ + numero)
  // e capturava so "90", perdendo o "mil". Agora o "mil" depois de um valor
  // com R$ e capturado.
  // 13/10/2026, caso Lead C ("Valor aproximado / 52.000,00 / Entrada
  // de 10k + 60 x R$1.458,00"): o 52.000,00 solto nao era lido, o "10k" nao
  // era lido, e a frase era cortada no ponto do milhar ("R$1" / "458,00"), o
  // que deixava a PARCELA de R$ 1.458 passar como valor total e desqualificava
  // um contrato de ~R$ 87 mil. Agora: (1) numero solto em formato BR ("52.000,00")
  // e "52k" tambem contam, desde que haja contexto de total; (2) o ponto de
  // milhar nao quebra a frase; (3) a linha-rotulo anterior ("Valor aproximado")
  // vale de contexto para o numero da linha seguinte; (4) "N x R$ valor" e
  // "entrada de ..." nunca sao total. Na duvida (so parcela, sem total claro)
  // devolve null: a trava nao dispara e a IA pergunta o valor do contrato.
  const PADRAO =
    /R\$\s*([\d.,]+)\s*(mil)?\b|([\d.,]+)\s*mil\b|([\d.,]+)\s*reais\b|(?<![\d.,])(\d{1,3}(?:\.\d{3})+(?:,\d{2})?)(?![\d.,])|(?<![\d.,])(\d{1,3})\s*k\b/gi
  // Não basta encontrar o último número. Em conversas bancárias é comum o
  // cliente informar o contrato e, depois, a parcela ou o saldo restante.
  // O valor da parcela nunca pode substituir o valor total para fins de piso.
  const CONTEXTO_TOTAL = /\b(total|d[ií]vida|contrat[oa]|contratado|liberad[oa]|devo|montante|empr[eé]stimo|financ\w*)\b/i
  const CONTEXTO_NAO_TOTAL = /\b(parcela|presta[cç][aã]o|mensalidade|mensal|saldo\s+(?:restante|devedor|atual)|resta(?:m|va[mn])?|falta(?:m|va[mn])?|j[aá]\s+paguei|paguei|pago)\b/i
  const CONTEXTO_FAIXA = /\b(entre|de\s+\d|chega|chegar|fica|ficam|aproximad[oa]|cerca\s+de)\b/i
  const candidatosTotais: number[] = []
  const estimadosPorParcela: number[] = []
  for (const m of messages) {
    if (m.role !== 'user') continue
    // "60 x R$ 1.458": prazo x parcela. Serve só de ALTA (nunca de piso).
    const NX = /(\d{1,3})\s*[xX]\s*(?:de\s*)?R\$\s*([\d.,]+)/g
    let nx: RegExpExecArray | null
    while ((nx = NX.exec(m.content))) {
      const n = Number(nx[1])
      const p = normalizaValorBr(nx[2])
      if (p !== null && n >= 6 && n <= 120) estimadosPorParcela.push(n * p)
    }
    PADRAO.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PADRAO.exec(m.content))) {
      let bruto: string | undefined
      let ehMil = false
      if (match[1] !== undefined) {
        bruto = match[1]
        ehMil = match[2] !== undefined
      } else if (match[3] !== undefined) {
        bruto = match[3]
        ehMil = true
      } else if (match[4] !== undefined) {
        bruto = match[4]
        ehMil = false
      } else if (match[5] !== undefined) {
        bruto = match[5]
        ehMil = false
      } else if (match[6] !== undefined) {
        bruto = match[6]
        ehMil = true
      }
      if (bruto === undefined) continue
      const numero = normalizaValorBr(bruto)
      if (numero === null) continue
      const valor = ehMil ? numero * 1000 : numero
      // "60 x R$ 1.458" (parcela) e "entrada de 10k" nunca são o valor total.
      const antes = m.content.slice(Math.max(0, match.index - 25), match.index)
      if (/\d+\s*[xX]\s*(?:de\s*)?$/.test(antes)) continue
      if (/entrada(?:\s+(?:de|foi|:))?\s*$/i.test(antes)) continue
      // Delimita a unidade da frase para não contaminar o contrato com uma
      // palavra “parcela” que aparece em outra oração da mesma mensagem.
      // O ponto só encerra a frase se vier espaço/fim depois (não no milhar).
      const partes = m.content.split(/[\n;!?]+|\.(?=\s|$)/)
      const idx = partes.findIndex((parte) => parte.includes(match![0]))
      let contexto = idx >= 0 ? partes[idx] : m.content
      // Número sozinho na linha: a linha-rótulo anterior ("Valor aproximado")
      // é o contexto dele.
      if (idx > 0 && !(CONTEXTO_TOTAL.test(contexto) || CONTEXTO_FAIXA.test(contexto) || CONTEXTO_NAO_TOTAL.test(contexto))) {
        contexto = `${partes[idx - 1]} ${contexto}`
      }
      // Aceita somente um valor associado ao total/dívida/contrato. Valores
      // associados a parcela, mensalidade ou saldo remanescente são ignorados.
      if ((CONTEXTO_TOTAL.test(contexto) || CONTEXTO_FAIXA.test(contexto)) && !CONTEXTO_NAO_TOTAL.test(contexto)) {
        candidatosTotais.push(valor)
      }
    }
  }
  if (candidatosTotais.length === 0) return null
  // Em uma faixa (“entre 20 e 30 mil”), o maior valor é o limite superior.
  // Só haverá desqualificação se até esse limite estiver abaixo do piso. O total
  // estimado por prazo x parcela só pode SUBIR o valor, nunca criar um sozinho.
  return Math.max(...candidatosTotais, ...estimadosPorParcela)
}

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
          body: `A IA identificou um lead SUPERQUALIFICADO (divida >= R$ 500 mil) na conversa. Nome: ${contact?.name ?? '-'} | WhatsApp: ${contact?.phone ?? '-'} | Card na etapa atual do funil + tag Superqualificado. Ver: https://crm.simionatoadvogados.com.br`,
        }),
      }).catch(() => {})
    }
  }

  let target: string | null = null
  if (move === 'qualified' || move === 'super') {
    // A qualificação NÃO move mais o card: a etapa 57bed09e é "Reunião Realizada",
    // marcada à mão pelo titular depois da reunião. Aqui só ficam a tag e o aviso.
    target = null
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
  /** Which webhook is calling ('api' = official Meta Cloud API, 'web' =
   *  segundo número/Evolution). 20/09/2026: this used to be inferred from
   *  `conversations.last_channel`, but that column is only ever written by
   *  the segundo-número send path — a lead who messages the OFFICIAL
   *  number after having used the segundo número earlier still reads
   *  `last_channel: 'web'` (stale), so the reply went out the wrong
   *  number. The caller always knows its own channel with certainty;
   *  passing it explicitly removes the stale-read entirely. */
  channel: 'api' | 'web'
}

// Comportamento com cliente e com lead que cita processo em andamento: instruções do Agent da plataforma
// (OpenAI). O código só informa o FATO (buildContactContextBlock) e mantém as travas (detector de processo,
// PESSOA_AFIRMA_REUNIAO).

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
 * Espera residual antes de responder — SEGUNDA linha de defesa, nao a
 * principal (23/09/2026). A principal agora e `scheduleAiReply`: ela
 * debounca ANTES desta funcao ser chamada, entao quando chega aqui ja
 * passaram uns bons segundos de silencio do contato. Esta espera curta so
 * cobre a corrida residual entre duas chamadas praticamente simultaneas
 * (ex.: duas mensagens no mesmissimo instante, texto+audio juntos).
 *
 * Historico (08/08/2026, antes do scheduleAiReply existir): esta era a UNICA
 * defesa, com 6-10s -- funcionava pra rajada rapida mas nao pra mensagens
 * com mais de 10s de intervalo entre si (caso Lead L, 23/09/2026: gaps de
 * 12-15s, cada mensagem "parecia a ultima" na hora da propria checagem, duas
 * respostas quase identicas saiam pro cliente). Ninguém escreve no WhatsApp
 * numa mensagem só: manda "Oi tudo bem?" e, alguns segundos depois, "Como
 * funciona?". `scheduleAiReply` resolve isso na raiz agora; esta espera
 * aqui é só o resto residual.
 */

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
 * Wamid (id do WhatsApp) de uma mensagem, dado o id interno — usado só
 * pra ligar o indicador de "digitando" na mensagem certa. Consulta
 * separada da de `ultimaEntrada` de propósito: não mexe no que a
 * guarda de rajada já usa pra decidir se descarta a resposta.
 */
async function wamidDaMensagem(
  db: ReturnType<typeof supabaseAdmin>,
  messageId: string,
): Promise<string | null> {
  const { data } = await db
    .from('messages')
    .select('message_id')
    .eq('id', messageId)
    .maybeSingle()
  return (data as { message_id: string | null } | null)?.message_id ?? null
}

/**
 * Liga "digitando..." no WhatsApp do contato antes da espera de
 * rajada — sem isso, a espera antes de gerar e o tempo de
 * geração da IA passam em silêncio total, sensação de bot mudo em vez
 * de alguém respondendo. Fire-and-forget de propósito: falha aqui
 * (conta sem WhatsApp configurado, wamid não encontrado, rejeição da
 * Meta) nunca pode impedir a resposta real de sair.
 */
async function ligarDigitando(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  gatilhoMessageId: string | null,
): Promise<void> {
  if (!gatilhoMessageId) return
  try {
    const wamid = await wamidDaMensagem(db, gatilhoMessageId)
    if (!wamid) return
    const { data: config } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!config?.phone_number_id || !config.access_token) return
    await sendTypingIndicator({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      messageId: wamid,
    })
  } catch (err) {
    console.warn(
      `[ai auto-reply] indicador de digitando falhou (seguindo sem ele): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Passa a conversa para um humano e para de responder nela.
 *
 * ⛔ Existe porque o teto de respostas por conversa desligava a IA **em
 * silêncio**: em 08/08/2026 a conversa bateu em 20/20 e o lead simplesmente
 * deixou de ser respondido — ninguém no escritório soube. Ficar sem resposta é
 * o pior desfecho possível para um lead que estava quase marcando.
 */
export async function passarParaHumano(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  contactId: string,
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
  await avisarHandoff(db, accountId, contactId, conversationId, resumo, handoffAgentId)
}

/**
 * Só o aviso (notificação no CRM + WhatsApp) de um handoff — separado de
 * `passarParaHumano` pra caminhos que já desligam a IA com sua própria
 * lógica de atribuição (ex: áudio sem transcrição nos webhooks) e só
 * precisam do aviso, sem herdar/alterar o comportamento de assignment.
 *
 * Achado 25/08/2026: desligar `ai_autoreply_disabled` sem chamar isto
 * deixa o handoff mudo — foi o caso do handoff decidido pela própria IA
 * (o caminho mais comum) e do "cliente existente", nenhum dos dois
 * passava por aqui. Consertado nesses dois pontos e nos dois webhooks de
 * áudio sem transcrição.
 */
export async function avisarHandoff(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  contactId: string,
  conversationId: string,
  resumo: string,
  handoffAgentId: string | null,
): Promise<void> {
  // Achado ao vivo, 22/08/2026: desligar a IA sem avisar ninguém deixa a
  // conversa muda até alguém tropeçar nela por acaso — foi quase 1h sem
  // resposta pra um lead real, e "ninguém do escritório olha isso em fim
  // de semana" (o painel de notifications não basta). Dois avisos agora:
  // grava em `notifications` (fica no CRM, rastreável, sempre) e manda
  // WhatsApp de verdade pro titular só quando o lead é Superqualificado
  // (>= R$500 mil, tag AI_TAG_SUPER) — 21/09/2026: todo handoff mandava
  // WhatsApp pro titular, virou ruído; ele pediu pra restringir ao que
  // realmente merece interromper o celular dele fora do horário comercial.
  const destinatarios = handoffAgentId
    ? [handoffAgentId]
    : (
        (await db.from('profiles').select('user_id').eq('account_id', accountId)).data ?? []
      ).map((p) => (p as { user_id: string }).user_id)
  if (destinatarios.length > 0) {
    const { error: notifyErr } = await db.from('notifications').insert(
      destinatarios.map((uid) => ({
        account_id: accountId,
        user_id: uid,
        type: 'awaiting_reply',
        conversation_id: conversationId,
        contact_id: contactId,
        title: 'IA parou e passou pra você',
        body: resumo,
      })),
    )
    if (notifyErr) {
      console.error(
        `[ai auto-reply] notificação de handoff falhou (conversa ${conversationId}): ${notifyErr.message}`,
      )
    }
  }
  const { count: superCount } = await db
    .from('contact_tags')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .eq('tag_id', AI_TAG_SUPER)
  if ((superCount ?? 0) > 0) {
    await alertarPorWhatsapp(db, accountId, resumo)
  }
}

/**
 * Manda o resumo do handoff pro WhatsApp do titular — texto livre, então
 * só chega se a janela de 24h com ele estiver aberta (ele conversa com o
 * número do escritório com frequência, então normalmente está). Sem
 * template aprovado ainda pra garantir entrega fora da janela — falha
 * aqui não pode derrubar o handoff, por isso é best-effort e nunca lança.
 */
export async function alertarPorWhatsapp(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  resumo: string,
): Promise<void> {
  const telefone = process.env.AI_ALERTA_HANDOFF_TELEFONE
  const contactId = process.env.AI_ALERTA_HANDOFF_CONTACT_ID
  if (!telefone || !contactId) return
  try {
    const { data: config } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!config?.phone_number_id || !config.access_token) return
    await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      to: telefone,
      contactId,
      text: `⛔ IA travou e passou pra humano.\n\n${resumo}`,
    })
  } catch (err) {
    console.error(
      `[ai auto-reply] alerta de handoff por WhatsApp falhou: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers de I/O dos guardas (lógica pura em ./sdr-guards)
// ---------------------------------------------------------------------------

/** Marca como gerada pela IA a linha gravada pelo envio via segundo número. Nunca lança. */
async function marcarComoIa(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  texto: string,
): Promise<void> {
  try {
    const { data } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'agent')
      .eq('ai_generated', false)
      .eq('content_text', texto)
      .order('created_at', { ascending: false })
      .limit(1)
    const id = (data as { id: string }[] | null)?.[0]?.id
    if (id) await db.from('messages').update({ ai_generated: true }).eq('id', id)
  } catch (err) {
    console.warn(`[sdr] marcarComoIa falhou: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Um humano (sender_type agent, não gerado pela IA) escreveu na conversa nos últimos 10 min? Erro de consulta conta como não. */
async function humanoEscreveuRecente(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<boolean> {
  try {
    const pausaMs = Number(process.env.AI_PAUSA_HUMANO_MS ?? 0)
    if (!(pausaMs > 0)) return false
    const desde = new Date(Date.now() - pausaMs).toISOString()
    const { data } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'agent')
      .eq('ai_generated', false)
      .gte('created_at', desde)
      .limit(1)
    return !!(data && (data as unknown[]).length > 0)
  } catch (err) {
    console.warn(`[sdr] checagem de humano recente falhou (seguindo): ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/** O contato tem a tag Cliente? */
async function contatoEhCliente(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
): Promise<boolean> {
  const { data: tagRows } = await db
    .from('contact_tags')
    .select('tags!inner(name)')
    .eq('contact_id', contactId)
  for (const r of tagRows ?? []) {
    const t = (r as { tags?: { name?: string } | { name?: string }[] }).tags
    if (Array.isArray(t) ? t.some((x) => x?.name === 'Cliente') : t?.name === 'Cliente') return true
  }
  return false
}

interface CanalDeEnvio {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  channel: 'api' | 'web'
}

/** Envia um texto fixo ao lead pelo canal da conversa, marcado como da IA. Nunca lança. */
async function enviarTextoDaIa(
  db: ReturnType<typeof supabaseAdmin>,
  c: CanalDeEnvio,
  texto: string,
): Promise<void> {
  try {
    if (c.channel === 'web') {
      const { data } = await db.from('contacts').select('phone').eq('id', c.contactId).maybeSingle()
      const telefone = (data as { phone: string | null } | null)?.phone ?? null
      const ok = telefone ? await enviarPeloSegundoNumero(telefone, texto) : false
      if (ok) {
        await registrarEnvioSegundoNumero(db, c.conversationId, texto)
        await marcarComoIa(db, c.conversationId, texto)
      } else {
        console.error(`[sdr] acolhimento não saiu pelo segundo número (conversa ${c.conversationId})`)
      }
    } else {
      await engineSendText({
        accountId: c.accountId,
        userId: c.userId,
        conversationId: c.conversationId,
        contactId: c.contactId,
        text: texto,
        aiGenerated: true,
      })
    }
  } catch (err) {
    console.error(`[sdr] envio de texto fixo falhou (conversa ${c.conversationId}): ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Grava o handoff (desliga a IA, notifica; o resumo leva `[ATENÇÃO]`) e depois
 * envia o acolhimento fixo ao lead.
 */
async function handoffComAcolhimento(
  db: ReturnType<typeof supabaseAdmin>,
  c: CanalDeEnvio,
  resumo: string,
  handoffAgentId: string | null,
  jaTemDono: boolean,
): Promise<void> {
  const marcado = resumo.includes(MARCA_ATENCAO) ? resumo : `${MARCA_ATENCAO} ${resumo}`
  await passarParaHumano(db, c.accountId, c.contactId, c.conversationId, marcado, handoffAgentId, jaTemDono)
  await enviarTextoDaIa(db, c, ACOLHIMENTO_HANDOFF)
}

/**
 * Pull a usable first name from the stored contact name. The inbound
 * webhook stores the WhatsApp profile name in `contacts.name`, falling
 * back to the phone when the profile has none — so a "name" that is just
 * the phone (or otherwise has no letters) is treated as illegible.
 */
// Achado 25/08/2026: o perfil do WhatsApp é texto livre — muita gente usa
// frase/motivação/religiosa em vez do próprio nome ("Bênção de Deus", "eu
// amo animais"). Isso tinha letra, passava no filtro antigo, e a Márcia
// cumprimentava o lead com a frase inteira e NUNCA perguntava o nome de
// verdade (a instrução que injeta o nome no prompt é propositalmente
// absoluta — "SOBREPÕE qualquer instrução de pedir o nome" — então o
// conserto tem que ser aqui no filtro, não ali). Bloqueia pela primeira
// palavra ser um pronome/verbo/palavra religiosa comum que nunca é
// primeiro nome sozinho, e por emoji — os dois padrões mais comuns desse
// tipo de "nome" no WhatsApp.
const PRIMEIRA_PALAVRA_NAO_E_NOME = new Set([
  'eu', 'tu', 'ele', 'ela', 'nos', 'nós', 'voce', 'você', 'vc',
  'amo', 'amor', 'sou', 'minha', 'meu', 'feliz', 'obrigado', 'obrigada',
  'bencao', 'benção', 'bênção', 'bencaos', 'benções', 'bênçãos', 'deus', 'jesus', 'senhor',
  'gracas', 'graças', 'fe', 'fé', 'paz', 'abencoado', 'abençoado',
  'abencoada', 'abençoada', 'anonimo', 'anônimo', 'particular', 'usuario',
  'usuário', 'contato', 'whatsapp', 'familia', 'família', 'vida', 'luz',
])

export function legibleFirstName(
  name?: string | null,
  phone?: string | null,
): string | null {
  if (!name) return null
  const n = name.trim()
  if (n.length < 2) return null
  if (!/\p{L}/u.test(n)) return null // no letters → junk / a bare number
  if (/\p{Extended_Pictographic}/u.test(n)) return null // emoji no "nome"
  const digitsOnly = (s: string) => s.replace(/\D/g, '')
  if (phone && digitsOnly(n) && digitsOnly(n) === digitsOnly(phone)) return null
  const token = n.split(/\s+/)[0]
  if (PRIMEIRA_PALAVRA_NAO_E_NOME.has(token.toLowerCase())) return null
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
    nome: 'Reunião Realizada',
    conduta:
      'A reunião com o advogado já aconteceu. Você acolhe e passa ao humano se o lead escrever. ⛔ Não requalifique nem marque nova reunião sem ele.',
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
 * It augments the account's saved
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

  // FATOS apenas (16/10/2026). O que fazer com cada fato é do Agent da plataforma (OpenAI); aqui só entra
  // o que o sistema sabe deste contato nesta resposta.
  const CAB = 'FATOS DESTE CONTATO (informação do sistema, não instruções):'
  const fatos: string[] = []
  if (firstName) fatos.push(`- Nome (WhatsApp): ${firstName}`)

  if (isClient) {
    fatos.push('- Este contato JÁ É CLIENTE do escritório.')
    return [CAB, ...fatos].join('\n')
  }

  const knownLead =
    hasMeeting || isReturning || !!email || qualTags.length > 0 || !!formulario

  // Contato novo: só o nome do WhatsApp é conhecido.
  if (!knownLead) {
    if (!firstName) return null
    fatos.push('- Conversa: PRIMEIRA conversa dele com o escritório.')
    return [CAB, ...fatos].join('\n')
  }

  if (etapa) fatos.push(`- Etapa do funil: ${etapa.nome}. ${etapa.conduta}`)
  if (email) fatos.push(`- E-mail registrado: ${email}`)
  if (qualTags.length > 0) fatos.push(`- Já classificado: ${qualTags.join(', ')}`)
  if (formulario) fatos.push(`- Formulário do site, preenchido por ele:\n${formulario}`)

  // Tags de ORIGEM (o intake as aplica ao criar o contato a partir do site) não são prova de conversa
  // anterior (caso Lead G, 05/10/2026: lead novo ouviu "Que bom te ver de novo"). Retorno só com sinal real:
  // disparo anterior / intervalo entre sessões (isReturning), tag de qualificação de conversa anterior
  // (Superqualificado/Desqualificado) ou card fora de Novo Lead.
  const TAGS_DE_ORIGEM = new Set(['Bancário', 'Tributário', 'PF', 'PJ'])
  const primeiraConversa =
    !isReturning &&
    qualTags.every((t) => TAGS_DE_ORIGEM.has(t)) &&
    (!etapa || etapa.nome === 'Novo Lead')

  if (hasMeeting) {
    fatos.push(
      dataReuniao
        ? `- Reunião: marcada para ${dataReuniao} (horário de Brasília).`
        : '- Reunião: ele já agendou ou já teve reunião com o escritório.',
    )
  } else {
    // Dizer que NÃO há registro importa tanto quanto dizer a data (caso 09/08/2026: ela leu do histórico um
    // horário escolhido que nunca foi reservado).
    fatos.push(
      '- Reunião: nenhum registro no sistema. Reservas podem chegar por canais que o sistema não vê, e horário escolhido na conversa NÃO é horário reservado.',
    )
    if (formulario) fatos.push('- Estado: preencheu o formulário e ainda não agendou.')
    fatos.push(
      primeiraConversa
        ? '- Conversa: PRIMEIRA conversa dele com o escritório (as tags vêm da origem do lead no site, não de contato anterior).'
        : '- Conversa: RETORNO — ele já falou com o escritório antes e ainda não fechou.',
    )
  }

  return [CAB, ...fatos].join('\n')
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
  origem: OrigemDisparo = 'debounce',
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId, channel } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return
    const canal: CanalDeEnvio = {
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      channel,
    }

    // ⛔ NAO volte a perguntar aqui se EXISTE automacao de mensagem ativa.
    // Essa pergunta esteve neste ponto e calava a IA para TODA mensagem da
    // conta assim que qualquer automacao `keyword_match` fosse ligada — sem
    // erro, sem log, sem card em humano. Em 10/08/2026 a "Confirmacao de
    // agendamento" foi ligada as 20:44 e a Marcia ficou muda por 16 horas;
    // o unico sintoma era silencio, e silencio ninguem ve.
    //
    // Quem decide isso e o webhook, ANTES de chamar aqui, com
    // `automacaoVaiResponder`: ela cala a IA so quando a automacao de fato
    // CASA com esta mensagem e tem passo que FALA.

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select(
        'assigned_agent_id, ai_autoreply_disabled, ai_reply_count, ai_handoff_summary, updated_at, last_channel, horario_escolhido_iso, horario_escolhido_rotulo',
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
        .update({ ai_autoreply_disabled: false, ai_reply_count: 0, ai_handoff_summary: null })
        .eq('id', conversationId)
    }
    // Teto de respostas desta conversa. ⛔ Antes isto era um `return` mudo — o
    // lead falava e ninguém respondia mais, sem nenhum sinal para o escritório.
    // Bateu no teto, a conversa é de humano.
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      console.warn(
        `[ai auto-reply] conversa ${conversationId} bateu o teto de ${config.autoReplyMaxPerConversation} respostas — passando para humano.`,
      )
      await handoffComAcolhimento(
        db,
        canal,
        `A IA atingiu o limite de ${config.autoReplyMaxPerConversation} respostas automáticas nesta conversa e parou. O lead segue esperando resposta — assuma daqui.`,
        config.handoffAgentId,
        !!conv.assigned_agent_id,
      )
      return
    }

    // Humano escreveu há pouco: a IA não responde.
    if (await humanoEscreveuRecente(db, conversationId)) {
      console.log(`[sdr] conversa ${conversationId}: humano escreveu nos últimos 10 min — IA em pausa`)
      return
    }

    // Espera a rajada terminar: se outra mensagem do contato chegar nestes
    // segundos, esta resposta é descartada e quem responde é o disparo da
    // última — com a conversa inteira em contexto.
    const gatilho = await ultimaEntrada(db, conversationId)
    void ligarDigitando(db, accountId, gatilho)
    await sleep(esperaAntesDeGerarMs(origem, process.env))
    if ((await ultimaEntrada(db, conversationId)) !== gatilho) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Lead que cita processo/penhora/etc. (e não é Cliente): a IA não gera
    // resposta; acolhe com texto fixo e passa para o humano.
    const textoLeadRajada = textoDoLeadNaRajada(messages)
    const deteccao = detectaProcesso(textoLeadRajada)
    // ⛔ Desbloqueio de Conta (DBC) não passa por aqui (20/10/2026, caso Lead A,
    // bloqueio de R$ 168): quem vem da campanha/LP de DBC cita bloqueio
    // judicial, penhora e Sisbajud em TODA conversa — é o assunto. A trava de
    // processo, anterior à campanha, mandava todos ao humano antes de olhar o
    // valor. Em DBC a qualificação é só pelo valor (faixas de `dbc-faixas.ts`:
    // abaixo de 3 mil recusa suave, 3–5 mil titular, 5 mil+ agenda).
    const ehDbc = deteccao.gatilho && (await produtoPersistido(db, contactId)) === 'DBC'
    if (ehDbc) {
      console.log(
        `[sdr] conversa ${conversationId}: DBC citou processo (${deteccao.termos.join(', ')}) — qualifica pelo valor, sem handoff por processo`,
      )
    }
    if (deteccao.gatilho && !ehDbc && !(await contatoEhCliente(db, contactId))) {
      console.warn(
        `[sdr] conversa ${conversationId}: lead citou processo (${deteccao.termos.join(', ')}) — handoff com acolhimento`,
      )
      await handoffComAcolhimento(
        db,
        canal,
        `Lead citou processo judicial (${deteccao.termos.join(', ')}${deteccao.cnj ? `, CNJ ${deteccao.cnj}` : ''}). A IA parou sem qualificar e enviou acolhimento — assuma daqui. ${buildHandoffSummary({ messages, replyCount: conv.ai_reply_count ?? 0 })}`,
        config.handoffAgentId,
        !!conv.assigned_agent_id,
      )
      return
    }

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
      userPrompt: config.provider === 'openai' ? null : config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      horarios: slots.map((s) => s.rotulo),
    })
    // O que o funil já sabe desta pessoa: o formulário que ela preencheu e,
    // se agendou, o dia da reunião. Sem isso a IA repergunta o que o site já
    // perguntou e desconversa sobre a própria agenda do escritório.
    const [formulario, dataReuniao, etapa] = await Promise.all([
      isClient ? Promise.resolve(null) : respostasDoFormulario(db, contactId),
      hasMeeting ? dataDaReuniao(db, contactId) : Promise.resolve(null),
      isClient ? Promise.resolve(null) : etapaDoCard(db, contactId),
    ])
    const etapaSensivelAgora = !!(etapa && ETAPAS_SENSIVEIS.has(etapa.id))

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

    // ⭐ DESBLOQUEIO DE CONTA (15/10/2026, caso Lead M, "Mais de 3000"):
    // faixas de valor bloqueado — abaixo de 3 mil recusa suave; de 3 a 5 mil a IA
    // NÃO dispensa, coleta processo/natureza e passa ao titular; acima de 5 mil
    // qualifica e agenda; valor vago => pergunta o valor exato antes de classificar.
    // O estado é recalculado a cada turno a partir do que o PRÓPRIO lead escreveu.
    const produtoLead = isClient ? null : await produtoPersistido(db, contactId)
    const estadoDbc = produtoLead === 'DBC' ? estadoDbcDaConversa(messages) : null
    if (estadoDbc) {
      systemPrompt += '\n\n' + blocoPromptDbc(estadoDbc)
      // Faixa intermediária: assim que o valor exato está na faixa, passa ao titular (sem perguntas, sem chamar o modelo).
      if (!hasMeeting && !etapaSensivelAgora && deveEncaminharFaixaDbc(estadoDbc)) {
        console.warn(
          `[dbc] conversa ${conversationId}: faixa intermediária (R$${estadoDbc.valor}) com ${estadoDbc.respostasAposFaixa} respostas — handoff com acolhimento`,
        )
        // a recusa gravada de um valor anterior (ex.: R$ 2.000 corrigido para R$ 3.500) deixa de valer
        await aplicarVeredictoPiso(db, contactId, false)
        await handoffComAcolhimento(
          db,
          canal,
          `Lead de Desbloqueio de Conta na faixa intermediária de valor (declarou R$ ${estadoDbc.valor}). Passado ao titular assim que o valor ficou conhecido, sem perguntas, sem recusar e sem agendar — assuma daqui. ${buildHandoffSummary({ messages, replyCount: conv.ai_reply_count ?? 0 })}`,
          config.handoffAgentId,
          !!conv.assigned_agent_id,
        )
        return
      }
    }

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
        accountId,
        contactId,
        conversationId,
        `${MARCA_ATENCAO} Ele afirma ter reuniao marcada e o sistema NAO tem registro dela. ⛔ Isso nao prova que nao existe: ha reservas que chegam por canais que o CRM nao capta. Confira na agenda antes de responder — a IA foi impedida de contradize-lo.`,
        config.handoffAgentId,
        !!conv.assigned_agent_id,
      )
      return
    }

    const registrarUso = (u: Awaited<ReturnType<typeof generateReply>>['usage']) =>
      void logAiUsage(db, {
        accountId,
        conversationId,
        mode: 'auto_reply',
        provider: config.provider,
        model: config.model,
        usage: u,
      })

    let gerado = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Validador de saída: reprova valor de corte, marcador sobrando e excesso
    // de perguntas. Regenera uma vez com a falha anexada; se reprovar de novo,
    // falha grave vira handoff e falha leve vira texto seguro.
    if (gerado.text && !gerado.handoff) {
      const v1 = validarSaida(gerado.text, { textoLead: textoLeadRajada })
      if (!v1.ok) {
        console.warn(`[sdr] conversa ${conversationId}: resposta reprovada (${v1.falhas.map((f) => f.detalhe).join('; ')}) — regenerando`)
        registrarUso(gerado.usage)
        const primeiraResposta = gerado
        gerado = await generateReply({
          config,
          systemPrompt: systemPrompt + '\n\n' + falhaParaPrompt(v1),
          messages,
        })
        // O modelo não vê a resposta reprovada: se a 1ª trazia o horário escolhido/a reserva,
        // a regeneração os perde (caso Lead J, 19/10) e a reunião nunca é marcada.
        gerado = herdarMarcadoresDeAgenda(primeiraResposta, gerado)
        const v2 = gerado.text && !gerado.handoff ? validarSaida(gerado.text, { textoLead: textoLeadRajada }) : null
        if (v2 && !v2.ok) {
          console.error(`[sdr] conversa ${conversationId}: reprovada de novo (${v2.falhas.map((f) => f.detalhe).join('; ')})`)
          if (v2.gravidade === 'grave') {
            registrarUso(gerado.usage)
            await handoffComAcolhimento(
              db,
              canal,
              `A resposta da IA foi reprovada duas vezes pelo validador de saída (${v2.falhas.map((f) => f.detalhe).join('; ')}). Assuma daqui.`,
              config.handoffAgentId,
              !!conv.assigned_agent_id,
            )
            return
          }
          gerado = {
            ...gerado,
            text: TEXTO_SEGURO_FALLBACK,
            move: null,
            agendar: null,
            horarioEscolhido: null,
            desmarcar: false,
            portaAberta: false,
          }
        }
      }
    }

    // Chegou mensagem nova do lead (ou um humano escreveu) durante a geração:
    // esta resposta é descartada; responde o disparo da última mensagem.
    if (
      (await ultimaEntrada(db, conversationId)) !== gatilho ||
      (await humanoEscreveuRecente(db, conversationId))
    ) {
      console.log(`[sdr] conversa ${conversationId}: resposta descartada (mensagem nova ou humano ativo)`)
      registrarUso(gerado.usage)
      return
    }

    const { text, handoff, move, agendar, horarioEscolhido, segmento, valor, desmarcar, portaAberta, usage } = gerado

    // Grava a tag PF/PJ na hora que o marcador aparece — não espera o resto
    // do turno. É o que a trava de agendamento (abaixo) vai ler depois,
    // inclusive em turnos futuros: a pergunta pode ter sido respondida numa
    // resposta anterior à que está marcando a reunião.
    if (segmento) {
      const tagId = segmento === 'PJ' ? TAG_PJ : TAG_PF
      const { error: segErr } = await db
        .from('contact_tags')
        .upsert({ contact_id: contactId, tag_id: tagId }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
      if (segErr) {
        console.warn(`[ia-segmento] não consegui gravar tag ${segmento} (contact ${contactId}): ${segErr.message}`)
      }
    }

    // ⭐ Trava de HORÁRIO ESCOLHIDO (20/09/2026, caso Lead D): grava
    // o horário resolvido no INSTANTE em que o lead escolhe — mesmo padrão
    // do segmento acima. `slots` é a MESMA lista que a IA acabou de ler
    // nesta resposta, então o índice bate. Sobrescreve qualquer escolha
    // anterior de propósito: se ele mudou de ideia, o mais recente vale.
    if (horarioEscolhido) {
      const slotEscolhido = slots[horarioEscolhido - 1]
      if (slotEscolhido) {
        const { error: horarioErr } = await db
          .from('conversations')
          .update({
            horario_escolhido_iso: slotEscolhido.iso,
            horario_escolhido_rotulo: slotEscolhido.rotulo,
          })
          .eq('id', conversationId)
        if (horarioErr) {
          console.warn(
            `[ia-agenda] não consegui gravar horário escolhido (conversa ${conversationId}): ${horarioErr.message}`,
          )
        }
      } else {
        console.warn(
          `[ia-agenda] índice ${horarioEscolhido} fora da agenda (${slots.length} horários) — não gravei escolha`,
        )
      }
    }

    // ⛔⛔ TRAVA DE VERDADE — PISO DE VALOR, não só o prompt (01/09/2026, caso
    // Lead A: revelou ~R$9.000 de dívida PF e ofereceu 2 horários na MESMA
    // resposta, mesmo com a instrução escrita dizendo o contrário). Calcula
    // ANTES de `textoFinal`/`moveFinal` nascerem, pra travar a resposta
    // inteira — não só a reserva final, como faz a trava de PF/PJ (mais
    // abaixo): aqui o problema é a OFERTA em si, que acontece bem antes de
    // qualquer marcador de agendamento existir.
    //
    // Reforçada no mesmo dia (caso Lead R, R$450 de cheque especial): ela
    // reconheceu o valor na conversa mas nunca "concluiu" nada — foi direto
    // pra oferecer horário sem NUNCA emitir [[VALOR:N]]. Marcador que depende
    // da IA lembrar de emitir tem esse limite; por isso a trava agora usa
    // DUAS fontes independentes.
    //
    // ✅ RELIGADA em 23/09/2026 (caso Lead L): a trava generica foi
    // desativada em 21/09 porque nao sabia diferenciar produto (barrava DBC/
    // GPIX com o corte errado de R$50k). Agora ela primeiro consulta a tag de
    // PRODUTO (produtoPersistido, gravada por automacao do CRM) e so cai no
    // generico PF/PJ quando nenhuma tag de produto foi gravada ainda — ver
    // PISO_POR_PRODUTO acima. O caso Lead L (RCPCC, ~R$20-34k, a IA
    // "concluiu" acima do criterio sem checagem nenhuma) e a prova de que
    // deixar so a IA decidir nao segura sozinho.
    // A extração textual agora só aceita valor contextualizado como total,
    // dívida, contrato ou faixa; parcela e saldo remanescente são ignorados.
    // O marcador da IA não é fonte suficiente para desqualificação: ele pode
    // ter sido calculado a partir da parcela. Assim, o caso “contrato de
    // R$540 mil / parcela de R$2 mil” permanece protegido.
    const PISO_GENERICO_ATIVO = true
    let valorOverride: string | null = null
    // Fonte única para desqualificação: valor total contextualizado que o
    // próprio cliente escreveu. O marcador “valor” continua disponível para
    // a conversa, mas não pode sozinho derrubar um lead.
    const valorFresco = valorDeclaradoPeloCliente(messages)
    // Fonte 3 (trava persistente, 11/09/2026): sem valor novo neste turno,
    // usa o veredito já gravado de um turno anterior — ver TAG_ABAIXO_PISO
    // acima. Sentinela bem abaixo de qualquer piso real, só pra comparar.
    const veioPersistido = valorFresco === null && (await abaixoPisoPersistido(db, contactId))
    const valorEfetivo = valorFresco ?? (veioPersistido ? -1 : null)
    // A trava não vale para Cliente, etapa sensível, reunião marcada ou horário já escolhido.
    const bloqueioPiso = motivoBloqueioPiso({
      isClient,
      etapaSensivel: etapaSensivelAgora,
      hasMeeting,
      horarioEscolhido: !!(conv.horario_escolhido_iso || conv.horario_escolhido_rotulo || horarioEscolhido),
    })
    if (bloqueioPiso && valorEfetivo !== null) {
      console.log(`[ia-valor] trava de piso não aplicada: ${bloqueioPiso} (contact ${contactId})`)
    }
    // DBC tem faixas próprias (dbc-faixas.ts); a trava genérica de piso não vale aqui.
    let faixaDbcIntermediaria = false
    let faixaDbcIndefinida = false
    if (estadoDbc) {
      if (bloqueioPiso) {
        console.log(`[dbc] trava de faixa não aplicada: ${bloqueioPiso} (contact ${contactId})`)
      } else if (estadoDbc.faixa === 'abaixo') {
        console.warn(
          `[dbc] recusa suave — valor bloqueado R${estadoDbc.valor} abaixo da faixa atendida (contact ${contactId})`,
        )
        valorOverride = VALOR_ABAIXO_DBC
        await aplicarVeredictoPiso(db, contactId, true)
      } else if (estadoDbc.faixa === 'indefinida') {
        // Valor ausente ou vago: a IA pergunta o valor exato. Só mantém a recusa de um
        // turno anterior quando NENHUM número apareceu na conversa desde então.
        if (
          estadoDbc.valor === null &&
          !estadoDbc.vago &&
          (await abaixoPisoPersistido(db, contactId))
        ) {
          valorOverride = VALOR_ABAIXO_DBC
        } else {
          faixaDbcIndefinida = true
        }
      } else {
        // faixa intermediária ou qualificado: destrava qualquer recusa gravada antes.
        await aplicarVeredictoPiso(db, contactId, false)
        faixaDbcIntermediaria = estadoDbc.faixa === 'faixa_intermediaria'
      }
    } else if (PISO_GENERICO_ATIVO && valorEfetivo !== null && !bloqueioPiso) {
      // Fonte 1 (preferida, 23/09/2026): tag de PRODUTO gravada por
      // automacao do CRM — corte especifico e correto por produto.
      const produto = produtoLead
      const seg = segmento ?? (await segmentoPersistido(db, contactId))
      // Segmento ainda não confirmado → usa o piso mais BAIXO (PF) como
      // padrão de segurança (18/09/2026, caso Lead B: PF com R$70k foi
      // recusada porque o default antigo usava o piso PJ de R$100k, mais alto
      // que o dela). Falso positivo de recusar um PF bom é pior que falso
      // negativo de qualificar um PJ pequeno — o segundo um humano barra na
      // reunião; o primeiro já perdeu o lead antes de alguém ver. Substitui o
      // default de 01/09 (Lead R), que priorizava o risco oposto.
      // Sem tag de produto (lead antigo, ou automação ainda não pegou):
      // cai no genérico PF/PJ de sempre, como rede de segurança.
      const piso = produto ? PISO_POR_PRODUTO[produto] : seg === 'PJ' ? PISO_PJ : PISO_PF
      const abaixo = valorEfetivo < piso
      if (abaixo) {
        console.warn(
          `[ia-valor] resposta travada — valor R${valorEfetivo} (${veioPersistido ? 'trava persistente de turno anterior' : 'valor total contextualizado no texto do cliente'}) abaixo do piso ${produto ?? seg ?? 'PF (padrão)'} (contact ${contactId})`,
        )
        valorOverride = VALOR_ABAIXO_DO_PISO
      }
      // Só regrava a trava quando o turno trouxe sinal FRESCO — nunca a
      // partir do próprio valor persistido, senão vira um loop que nunca
      // destrava sozinho.
      if (!veioPersistido) {
        await aplicarVeredictoPiso(db, contactId, abaixo)
      }
    }

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
      // O modelo não pode (ou não deve) responder — passa pra humano.
      // Achado 25/08/2026: este era o caminho MAIS COMUM de handoff (a
      // própria Márcia decidindo via [[HANDOFF]]) e o único que nunca
      // passava por `passarParaHumano` — não gravava notificação nem
      // mandava o alerta de WhatsApp. "Assigning fires on_conversation_
      // assigned" só é verdade quando há handoffAgentId configurado E a
      // conversa ainda não tem dono; fora isso, o handoff ficava mudo dos
      // dois lados — foi o caso de hoje (Lead X, Lead Y). Reusa
      // `passarParaHumano` em vez de duplicar a lógica.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      await handoffComAcolhimento(
        db,
        canal,
        summary,
        config.handoffAgentId,
        !!conv.assigned_agent_id,
      )
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
    // Piso de valor travado: a resposta gerada nem chega a ser considerada —
    // nem pra sair como texto, nem pra mover o card. Ver bloco `valorOverride`
    // acima.
    let textoFinal = valorOverride ?? text
    let moveFinal = valorOverride ? null : move
    if (faixaDbcIntermediaria || faixaDbcIndefinida) {
      // DBC sem classificação firme (faixa de 3 a 5 mil, ou valor ausente/vago): nada de
      // recusar, agendar nem qualificar. Intermediária => o caso vai ao titular; indefinida
      // => pergunta o valor exato antes de classificar.
      if (moveFinal === 'perdido' || moveFinal === 'qualified' || moveFinal === 'super') moveFinal = null
      if (textoIncompativelComFaixaDbc(textoFinal)) {
        console.warn(`[dbc] texto da IA dispensava/agendava lead sem classificação firme — trocado por pergunta fixa (contact ${contactId})`)
        textoFinal = faixaDbcIndefinida ? PERGUNTA_VALOR_EXATO_DBC : proximaPerguntaFaixaDbc(messages)
      }
    }
    // PERDIDO não é aplicado em etapa sensível.
    if (moveFinal === 'perdido' && !podeMarcarPerdido({ etapaSensivel: etapaSensivelAgora })) {
      console.warn(`[sdr] conversa ${conversationId}: PERDIDO ignorado em etapa sensível`)
      moveFinal = null
    }
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
      //
      // ⛔⛔ TRAVA DE VERDADE — PF/PJ, não só o prompt. Achado 01/09/2026: a
      // regra de perguntar pessoa física/jurídica já estava escrita no prompt,
      // forte, e mesmo assim não era sempre cumprida (mesma classe do caso da
      // Sylvia, 31/08 — dívida sem valor exato). Texto sozinho não bastou, e
      // texto sozinho não vai bastar de novo. Aqui é o único lugar que
      // realmente marca a reunião no Cal.com — se a tag PF/PJ não está
      // gravada, RECUSA marcar, não importa o que a resposta da IA já dizia.
      // (`valorOverride` já teria zerado o texto acima; aqui é defesa a mais
      // pro raro caso de a IA emitir AGENDAR na mesma resposta que revela um
      // valor abaixo do piso.)
      let agendarTravado = valorOverride || faixaDbcIntermediaria || faixaDbcIndefinida ? null : agendar
      if (agendarTravado !== null) {
        const { data: temSegmento } = await db
          .from('contact_tags')
          .select('tag_id')
          .eq('contact_id', contactId)
          .in('tag_id', [TAG_PF, TAG_PJ])
          .limit(1)
        if (!temSegmento?.length) {
          console.warn(`[ia-agenda] agendamento recusado — sem tag PF/PJ (contact ${contactId})`)
          textoFinal = FALTA_SEGMENTO
          agendarTravado = null
        }
      }
      if (agendarTravado !== null) {
        const nomeCompleto = legibleFirstName(contactRow?.name, contactRow?.phone)
          ? (contactRow?.name?.trim() ?? null)
          : null
        const r = await reservarHorario({
          db,
          contactId,
          indice: agendarTravado,
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
        // Reservou: o horário escolhido cumpriu seu papel. Sem limpar, ele fica
        // gravado na conversa e um horário velho pode ser reservado de novo
        // quando o lead voltar a escrever.
        if (r.ok) {
          await db
            .from('conversations')
            .update({ horario_escolhido_iso: null, horario_escolhido_rotulo: null })
            .eq('id', conversationId)
        }
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
      //
      // ⭐ 20/10/2026 (caso Lead H): "então sigo com o dia 26 às 13:15" não tem
      // nenhuma palavra que a regex conheça, e nada reservou. Além das frases
      // conhecidas, vale o FATO: a resposta cita só o horário que o lead
      // escolheu, sem perguntar nada (`respostaConfirmaHorario`). A escolha
      // pode ter sido gravada neste mesmo turno (`slots[horarioEscolhido-1]`)
      // ou num turno anterior (`conv.horario_escolhido_*`).
      const slotDestaVez = horarioEscolhido ? slots[horarioEscolhido - 1] : undefined
      const isoEscolhido = slotDestaVez?.iso ?? conv.horario_escolhido_iso
      const rotuloEscolhido = slotDestaVez?.rotulo ?? conv.horario_escolhido_rotulo
      const confirmaSemMarcador = respostaConfirmaHorario(textoFinal, rotuloEscolhido)
      if (!reservaFeita && !hasMeeting && (AFIRMA_QUE_AGENDOU.test(textoFinal) || confirmaSemMarcador)) {
        console.error(
          `[ia-agenda] ⛔ resposta afirmava reunião marcada sem reserva nenhuma — substituída${confirmaSemMarcador ? ' (confirmou o horário escolhido sem marcador)' : ''}. Original: ${textoFinal.slice(0, 200)}`,
        )
        // ⭐ 20/09/2026 (caso Lead D): antes de cair no "confirme de
        // novo qual horário", tenta completar sozinho com o horário que o
        // lead já ESCOLHEU num turno anterior (gravado pelo marcador
        // HORARIO_ESCOLHIDO, acima). Resolve o sintoma real: a IA tinha
        // tudo que precisava (horário + e-mail), só não reemitiu o
        // AGENDAR — o sistema não pode depender dela lembrar sozinha.
        const horarioPersistidoIso = isoEscolhido
        const horarioPersistidoRotulo = rotuloEscolhido
        // Mesma trava de verdade do caminho do AGENDAR: sem a tag PF/PJ gravada
        // não se marca reunião, nem por aqui.
        let faltaSegmento = false
        if (email && horarioPersistidoIso) {
          const { data: temSegmento } = await db
            .from('contact_tags')
            .select('tag_id')
            .eq('contact_id', contactId)
            .in('tag_id', [TAG_PF, TAG_PJ])
            .limit(1)
          faltaSegmento = !temSegmento?.length
          if (faltaSegmento) {
            console.warn(`[ia-agenda] completar sozinha recusado — sem tag PF/PJ (contact ${contactId})`)
          }
        }
        if (email && horarioPersistidoIso && !faltaSegmento) {
          const nomeCompleto = legibleFirstName(contactRow?.name, contactRow?.phone)
            ? (contactRow?.name?.trim() ?? null)
            : null
          const r = await reservarHorario({
            db,
            contactId,
            indice: 1,
            slots: [{ iso: horarioPersistidoIso, rotulo: horarioPersistidoRotulo ?? '' }],
            nome: nomeCompleto,
            email,
            telefone: contactRow?.phone ?? null,
            hasMeeting: desmarcar ? false : await temReuniaoAgora(db, contactId),
            textoDaIa: `Prontinho! Já deixei reservado: ${horarioPersistidoRotulo ?? 'o horário combinado'}. Você vai receber os detalhes por e-mail e por aqui também.`,
          })
          if (r.ok) {
            console.log(`[ia-agenda] completou sozinha com o horário escolhido num turno anterior (contact ${contactId})`)
          }
          textoFinal = r.texto
          reservaFeita = r.ok
          if (r.reagendar) moveFinal = 'reagendar'
          // Limpa a trava depois de tentar, sucesso ou falha — nunca fica
          // tentando pra sempre o mesmo horário, que pode ter saído do ar.
          await db
            .from('conversations')
            .update({ horario_escolhido_iso: null, horario_escolhido_rotulo: null })
            .eq('id', conversationId)
        }
        if (!reservaFeita) {
          textoFinal = faltaSegmento ? FALTA_SEGMENTO : email ? NAO_CONFIRMADO : FALTA_EMAIL
        }
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
        accountId,
        contactId,
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
    // 20/09/2026: conversa que chegou pelo SEGUNDO número (WhatsApp Web/
    // Evolution, `channel: 'web'`) tem que ser respondida pelo MESMO canal —
    // o `engineSendText` só sabe falar com o número oficial da Meta, e a
    // Meta rejeita o envio pra um contato que nunca abriu janela com ELA
    // (achado real: Márcia gerava a resposta certa, ficava só no CRM,
    // `status: 'failed'`, [131047] "mais de 24h" — o contato tinha, sim,
    // acabado de escrever, só que pro número errado).
    const bubbles = splitBubbles(textoFinal)
    const viaSegundoNumero = channel === 'web'
    for (let i = 0; i < bubbles.length; i++) {
      if (viaSegundoNumero) {
        const telefone = contactRow?.phone ?? null
        const ok = telefone ? await enviarPeloSegundoNumero(telefone, bubbles[i]) : false
        if (ok) {
          await registrarEnvioSegundoNumero(db, conversationId, bubbles[i])
          await marcarComoIa(db, conversationId, bubbles[i])
        } else {
          console.error(
            `[ai auto-reply] falha ao enviar pelo segundo número (conversa ${conversationId}, telefone ${telefone ?? 'ausente'}) — resposta ficou só no CRM`,
          )
        }
      } else {
        await engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text: bubbles[i],
          aiGenerated: true,
        })
      }
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
        // Segundo número é texto puro (sem botão interativo) — manda o
        // link direto na mensagem em vez do CTA button que só a Meta sabe
        // renderizar.
        if (viaSegundoNumero) {
          const telefone = contactRow?.phone ?? null
          const textoLink = `Se mudar de ideia, é só acessar o link abaixo e escolher o melhor horário. Fico à disposição! 😊\n${AGENDA_LINK}`
          const ok = telefone ? await enviarPeloSegundoNumero(telefone, textoLink) : false
          if (ok) {
            await registrarEnvioSegundoNumero(db, conversationId, textoLink)
            await marcarComoIa(db, conversationId, textoLink)
          }
          else console.error(`[ia-agenda] link de porta aberta falhou pelo segundo número (conversa ${conversationId})`)
        } else {
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
        }
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
        accountId,
        contactId,
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
      // Mesmo achado do handoff decidido pelo modelo (25/08/2026): este
      // caminho também nunca chamava `passarParaHumano` — sem notificação,
      // sem WhatsApp.
      await passarParaHumano(
        db,
        accountId,
        contactId,
        conversationId,
        'Cliente existente - atendimento sobre o caso. A IA acolheu e encaminhou para um humano (nao qualifica cliente).',
        config.handoffAgentId,
        !!conv.assigned_agent_id,
      )
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

/** Fila de debounce por conversa (23/09/2026, caso Lead L): mensagens em
 *  rajada chegam em webhooks SEPARADOS (a Meta manda 1 POST por mensagem
 *  quando elas nao sao simultaneas de verdade) e cada requisicao do Next.js
 *  roda concorrente as outras -- sem fila, duas geracoes da IA rodavam em
 *  paralelo, cada uma cega da mensagem que a outra tinha acabado de
 *  processar, e as duas respostas (quase identicas, so reformuladas) saiam
 *  para o cliente. `dispatchInboundToAiReply` sempre le o historico fresco
 *  do banco, entao nao precisa bufferizar mensagem nenhuma aqui -- so atrasar
 *  a CHAMADA ate o silencio do cliente. Processo unico do PM2 (fork, 1
 *  instancia) -- Map em memoria e seguro; um deploy raro perde os timers
 *  pendentes, pior caso e 1 resposta saindo na hora em vez de esperar. */
// Silêncio exigido após a última mensagem do lead nos toques seguintes (AI_DEBOUNCE_MS).
const debounceDaFilaMs = () => debounceMs(process.env)
const filaDebounceIa = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Agenda a resposta da IA por conversa. 1o toque: dispara na hora e o disparo
 * espera AI_ESPERA_PRIMEIRO_TOQUE_MS antes de gerar. Demais toques: espera
 * AI_DEBOUNCE_MS de silencio (reiniciado a cada mensagem nova) e o disparo
 * espera so o residual AI_ESPERA_RAJADA_MS antes de gerar.
 */
export function scheduleAiReply(args: DispatchArgs, isFirstTouch: boolean): void {
  const { conversationId } = args
  const timerAnterior = filaDebounceIa.get(conversationId)
  if (timerAnterior) clearTimeout(timerAnterior)

  const disparar = () => {
    filaDebounceIa.delete(conversationId)
    void dispatchInboundToAiReply(args, isFirstTouch ? 'primeiro_toque' : 'debounce')
  }

  if (isFirstTouch) {
    disparar()
    return
  }

  filaDebounceIa.set(conversationId, setTimeout(disparar, debounceDaFilaMs()))
}

