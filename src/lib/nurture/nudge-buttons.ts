import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendText } from '@/lib/automations/meta-send'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import {
  AI_VENDAS_PIPELINE,
  AI_STAGE_NOVO,
  AI_STAGE_PERDIDO,
  AI_ETAPAS_QUE_AVANCAM,
} from '@/lib/ai/auto-reply'

// ============================================================
// Botões do toque de reativação (template `nudge_prova_social_v2`).
//
// ⭐ Por que botão e não texto livre: a régua de nutrição decide pela IDADE do
// card. Quem respondia por escrito continuava com o card parado na mesma data —
// medido em 10/08/2026: responder NÃO mexe no card em 4 de 6 casos recentes —,
// e dois dias depois recebia "como não tivemos retorno, estou finalizando seu
// atendimento", tendo respondido. Com botão a intenção é inequívoca e a ação é
// determinística: ninguém precisa interpretar nada.
//
// O nudge é o degrau ANTES do encerramento. Pondo a escolha aqui, o
// encerramento passa a alcançar só quem ignorou por completo — que é o certo.
//
// ⛔ A IA não roda sozinha em toque de botão (o webhook seta interactiveReplyId
// e a condição dela é `!interactiveReplyId`). Por isso este módulo devolve
// `chamarIa`: quem apertou "prosseguir" merece conversa de verdade, não uma
// frase pronta.
// ============================================================

const PROSSEGUIR = 'Desejo prosseguir'
const PARAR = 'Parar mensagens'

export function isNudgeButton(text: string | null | undefined): boolean {
  return text === PROSSEGUIR || text === PARAR
}

/**
 * É o pedido de parar?
 *
 * ⛔ Existe porque essa é a ÚNICA mensagem que não pode acordar automação de
 * PRIMEIRO CONTATO. Em 10/08/2026 uma lead importada, que nunca havia escrito,
 * apertou "Parar mensagens": o toque foi lido como a primeira mensagem dela na
 * vida, a automação de auto-criar card disparou, e um card novo nasceu UM
 * SEGUNDO depois de este tratador ter fechado o dela. Ela pediu para parar e
 * voltou para o funil no mesmo instante.
 *
 * ⭐ A regra: só "Desejo prosseguir" retroage. "Parar mensagens" é terminal.
 */
export function ehPararMensagens(text: string | null | undefined): boolean {
  return text === PARAR
}

interface HandleArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  buttonText: string
  contactName: string | null
}

function firstName(name: string | null | undefined): string {
  return name ? name.trim().split(/\s+/)[0] : ''
}

/** Move o card e dispara o gatilho de etapa. Devolve false se não havia card. */
async function moverCard(
  db: ReturnType<typeof supabaseAdmin>,
  args: HandleArgs,
  destino: string,
  fechar: boolean,
): Promise<boolean> {
  const { data: deals } = await db
    .from('deals')
    .select('id, stage_id')
    .eq('contact_id', args.contactId)
    .eq('pipeline_id', AI_VENDAS_PIPELINE)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
  const deal = (deals as { id: string; stage_id: string }[] | null)?.[0]
  if (!deal) return false
  if (deal.stage_id === destino) return true

  const patch: Record<string, unknown> = { stage_id: destino }
  // Perdido é o único destino que também FECHA o card. Card aberto numa etapa
  // de encerramento mentiria no funil e ainda seria pescado pela régua de
  // reativação — que é exatamente o que a pessoa pediu para não acontecer.
  if (fechar) patch.status = 'lost'
  await db.from('deals').update(patch).eq('id', deal.id)
  await runAutomationsForTrigger({
    accountId: args.accountId,
    triggerType: 'deal_stage_changed',
    contactId: args.contactId,
    context: { stage_id: destino, pipeline_id: AI_VENDAS_PIPELINE },
  })
  return true
}

/**
 * Trata o toque. Nunca lança: o webhook segue mesmo se algo aqui falhar.
 * @returns `chamarIa` — se o webhook deve entregar a conversa para a IA.
 */
export async function handleNudgeButton(args: HandleArgs): Promise<{ chamarIa: boolean }> {
  const db = supabaseAdmin()
  const first = firstName(args.contactName)
  const oi = first ? `, ${first}` : ''

  try {
    if (args.buttonText === PARAR) {
      await moverCard(db, args, AI_STAGE_PERDIDO, true)
      // ⛔ Uma frase, sem tentar reverter. Quem pediu para parar não quer ser
      // convencido — insistir aqui é o que gera denúncia e queima o número.
      await engineSendText({
        accountId: args.accountId,
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        text: `Tudo bem${oi}, não mandaremos mais mensagens. 🙏 Se um dia precisar, é só chamar por aqui. Um abraço!`,
      })
      return { chamarIa: false }
    }

    if (args.buttonText === PROSSEGUIR) {
      // Apertar o botão JÁ é declaração de interesse: o card sai da etapa
      // dormente na hora. ⛔ Não depender de a IA concluir o mesmo depois —
      // se ela não concluísse, o relógio da régua continuaria correndo.
      const { data: deals } = await db
        .from('deals')
        .select('stage_id')
        .eq('contact_id', args.contactId)
        .eq('pipeline_id', AI_VENDAS_PIPELINE)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(1)
      const etapa = (deals as { stage_id: string }[] | null)?.[0]?.stage_id
      // ⛔ O destino é NOVO LEAD, não Lead Qualificado. Apertar o botão quer
      // dizer "quero continuar", não "sou qualificada" — e a conduta da IA em
      // Lead Qualificado diz textualmente "sem refazer a qualificação que já foi
      // feita". No primeiro uso real, em 10/08/2026, isso fez ela oferecer
      // horário de reunião direto a uma lead que ninguém sabia se qualificava.
      // Em Novo Lead a conduta é "pode conduzir a qualificação completa:
      // entender o problema, o tipo e o valor" — e o relógio da régua zera igual,
      // porque o que zera é a data do card, não a etapa de destino.
      if (etapa && AI_ETAPAS_QUE_AVANCAM.has(etapa)) {
        await moverCard(db, args, AI_STAGE_NOVO, false)
      }
      // A conversa fica com a IA — ela vê o histórico e retoma de onde parou.
      return { chamarIa: true }
    }
  } catch (err) {
    console.error('[nudge-button]', err)
  }
  return { chamarIa: false }
}
