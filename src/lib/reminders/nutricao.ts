import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendText } from '@/lib/automations/meta-send'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

// ============================================================
// Nutrição pré-reunião — exceção deliberada à régua "atendimento é IA,
// pós-atendimento é Fluxo/Automação" (decisão do titular, 24/08/2026):
// isso É pós-agendamento, mas fica com a Márcia porque o objetivo não é
// só lembrar — é manter o lead engajado e dar chance de ele adiantar
// informação antes da reunião, e isso pede julgamento de conversa, não
// só disparo de mensagem fixa.
//
// Dispara UMA mensagem, uma vez só por reunião, no dia seguinte ao
// agendamento — e só se a reunião ainda estiver a 2+ dias de distância
// (reunião mais perto que isso já é coberta pelo lembrete de véspera,
// mandar as duas juntas seria excesso).
//
// Canal: tenta o número oficial (texto livre, sem template) se a janela
// de 24h com o lead ainda estiver aberta; cai pro "segundo número"
// (WhatsApp Web / Evolution, sem trava de 24h) só quando a janela já
// fechou. Prioriza o oficial de propósito — chegar de um número novo,
// que o lead nunca falou, pode soar golpe (o próprio escritório já
// avisou os clientes reais pra só confiarem no WhatsApp oficial).
//
// PF agendada leva, junto, a instrução do relatório SCR do Bacen (pedido
// do titular, 01/09/2026) — sempre pelo segundo número (reduzir volume
// pago na API oficial). Substitui a automação nativa "Bacen SCR — PF
// pós-agendamento" (desativada — a condição dela exigia a tag "PF", que
// não existe pra quem não veio de formulário: o escritório não anuncia pra
// PF no Meta, só tem o form "REV-PJ V2"; e não há hoje mecanismo — IA ou
// código — que aplique "PF" em quem chega direto pelo WhatsApp). Por
// exclusão, decisão do titular: quem agendou e NÃO tem a tag PJ (essa sim
// confiável, vem do formulário) é tratado como PF aqui.
// ============================================================

const TAG_AGENDOU = 'c0278b4c-8f17-416e-a7e4-b66b6e78315a'
const TAG_PJ = 'ea69a90c-407b-411c-953c-2d9920ef6a5e'
const STAGE_PERDIDO = '0d0382a5-f15d-4e43-88aa-0c70337d94d4'
const STAGE_REAGENDAR = 'f2b7e7f6-c7d6-4d2b-ac6d-ad7842ab7045' // "Reagendar reunião"
const CF_DATA_ISO = 'e482845b-8ed4-4f4d-ae0e-0eed9dafbe4e'
const CF_LEMBRETES_ENVIADOS = '54b97296-7a16-4a15-b0c7-25f61b5b6d7e'

// Texto do SCR do Banco Central pra pessoa física — mesmo texto da automação
// nativa "Bacen SCR — PF pós-agendamento" (desativada em 01/09/2026: a
// condição dela nunca batia porque a tag PF quase nunca era aplicada, ver
// fix em intake.js). Movido pra cá por pedido do titular — mandar junto com
// a nutrição, mesmo agendamento, mesmo canal (segundo número).
const TEXTO_BACEN_SCR =
  'Aconselho, se possível, que você entre neste link: ' +
  'https://www.gov.br/pt-br/servicos/obter-relatorio-do-sistema-de-informacoes-de-credito-scr\n' +
  'Aqui você poderá acessar o site do *Banco Central do Brasil* e nas opções emitir relatório, ' +
  'coloque a data de 5 anos para trás, depois clique em emitir relatório, sairá um arquivo em PDF ' +
  'sobre todo seu relacionamento bancário nos últimos 5 anos. Se puder, já separe e traga esse ' +
  'relatório para a nossa reunião — ajuda bastante na análise do seu caso.'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

const JANELA_MENSAGEM_ABERTA_A_PARTIR = DAY // 1 dia após o agendamento
const REUNIAO_TEM_QUE_ESTAR_A_PELO_MENOS = 2 * DAY // senão o lembrete de véspera já cobre

// Três variações do mesmo conteúdo (engajamento + convite a adiantar
// informação + dica de documento) — texto idêntico toda vez, saindo de
// vários contatos, é outro padrão que denuncia automação. Sorteia uma.
const VARIACOES_TEXTO: Array<(nome: string) => string> = [
  (nome) =>
    `${nome}, enquanto isso, se tiver mais algum detalhe do seu caso que queira já adiantar, pode me contar — ajuda o Dr. Zelmo/a Dra. Maria a chegar mais preparado(a) na nossa conversa. E se puder já separar os documentos do seu caso (contrato, extrato), facilita bastante no dia.`,
  (nome) =>
    `${nome}, passando aqui rapidinho: se lembrar de mais algum detalhe do seu caso até lá, pode ir me contando, sem problema. Aproveita também pra já separar contrato e extrato relacionados à dívida — ajuda bastante na hora da conversa.`,
  (nome) =>
    `Oi, ${nome}! Só pra manter contato antes da nossa reunião — qualquer coisa nova sobre o seu caso, pode me mandar por aqui mesmo. E já vai adiantando: se tiver o contrato e o extrato à mão, separa que agiliza bastante no dia.`,
]
function TEXTO(nome: string): string {
  const escolhida = VARIACOES_TEXTO[Math.floor(Math.random() * VARIACOES_TEXTO.length)]
  return escolhida(nome)
}

function chaveNutricao(reuniaoIso: string): string {
  return `nutricao@${reuniaoIso}`
}

// Espaça os disparos entre leads diferentes — uma rajada de mensagens saindo
// no mesmo segundo, mesmo em baixo volume, é o padrão que mais chama atenção
// de detecção de automação. 4-10s aleatório entre um envio e o próximo.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
function pausaAleatoria(): Promise<void> {
  return sleep(4_000 + Math.floor(Math.random() * 6_000))
}

const GATEWAY_SEGUNDO_NUMERO = process.env.WAZAP_URL ?? 'http://127.0.0.1:3002'

async function enviarPeloSegundoNumero(telefone: string, texto: string): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY_SEGUNDO_NUMERO}/enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefone, texto }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      console.error('[nutricao] segundo número recusou o envio:', res.status)
      return false
    }
    return true
  } catch (err) {
    console.error('[nutricao] gateway do segundo número fora do ar:', err instanceof Error ? err.message : String(err))
    return false
  }
}

// Registra no CRM uma mensagem que já saiu pelo segundo número — mesmo
// padrão usado pro envio principal da nutrição, reaproveitado pro SCR.
async function registrarEnvioSegundoNumero(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  texto: string,
): Promise<void> {
  await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'agent',
    content_type: 'text',
    content_text: texto,
    status: 'sent',
    channel: 'web',
  })
  await db
    .from('conversations')
    .update({ last_message_text: texto, last_message_at: new Date().toISOString(), last_channel: 'web' })
    .eq('id', conversationId)
}

export async function dispatchNutricaoPreReuniao(): Promise<void> {
  const db = supabaseAdmin()
  const now = Date.now()
  const nowISO = new Date(now).toISOString()
  // Candidatas: reunião marcada, ainda no mínimo 2 dias no futuro.
  const horizonISO = new Date(now + 60 * DAY).toISOString()
  const dataMinima = new Date(now + REUNIAO_TEM_QUE_ESTAR_A_PELO_MENOS).toISOString()

  const { data: rows } = await db
    .from('contact_custom_values')
    .select('contact_id, value')
    .eq('custom_field_id', CF_DATA_ISO)
    .gte('value', dataMinima)
    .lte('value', horizonISO)
  const candidates = (rows ?? []) as { contact_id: string; value: string }[]
  if (candidates.length === 0) return

  let userId: string | null = null
  let primeiroEnvio = true

  for (const cand of candidates) {
    const meetingMs = new Date(cand.value).getTime()
    if (!Number.isFinite(meetingMs)) continue

    // Ainda é um agendamento ativo?
    const { data: tag } = await db
      .from('contact_tags')
      .select('created_at')
      .eq('contact_id', cand.contact_id)
      .eq('tag_id', TAG_AGENDOU)
      .maybeSingle()
    if (!tag) continue

    const agendadoEm = new Date(tag.created_at as string).getTime()
    if (!Number.isFinite(agendadoEm)) continue
    // Só dispara a partir de 1 dia depois de agendar.
    if (now < agendadoEm + JANELA_MENSAGEM_ABERTA_A_PARTIR) continue

    // PERDIDO é silêncio — mesma regra dos lembretes de véspera/1h.
    const { data: cards } = await db
      .from('deals')
      .select('status, stage_id')
      .eq('contact_id', cand.contact_id)
      .order('updated_at', { ascending: false })
      .limit(1)
    const card = (cards ?? [])[0] as { status?: string; stage_id?: string } | undefined
    if (card && (card.status === 'lost' || card.stage_id === STAGE_PERDIDO)) continue
    // Mesmo achado 24/08/2026 do dispatch.ts: card movido pra "Reagendar
    // reunião" é o titular dizendo manualmente que aquele horário não vale
    // mais — nutrir sobre uma reunião que ele mesmo já desmarcou é o mesmo
    // erro do lembrete de 1h, só que sobre "adianta detalhes" em vez de
    // "sua reunião é daqui a pouco".
    if (card && card.stage_id === STAGE_REAGENDAR) continue

    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('contact_id', cand.contact_id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    const conversationId = conv?.id as string | undefined
    if (!conversationId) continue

    // JÁ MANDOU? Não manda de novo — mesma trava anti-repetição dos lembretes.
    const chave = chaveNutricao(cand.value)
    const { data: logRow, error: logErr } = await db
      .from('contact_custom_values')
      .select('id, value')
      .eq('contact_id', cand.contact_id)
      .eq('custom_field_id', CF_LEMBRETES_ENVIADOS)
      .maybeSingle()
    if (logErr) {
      console.error('[nutricao] leitura do log falhou — envio abortado:', logErr)
      continue
    }
    const log = (logRow?.value as string | null) ?? ''
    if (log.split(';').some((k) => k.trim() === chave)) continue

    const { data: contact } = await db
      .from('contacts')
      .select('id, name, phone, phone_normalized, account_id')
      .eq('id', cand.contact_id)
      .maybeSingle()
    const accountId = contact?.account_id as string | undefined
    if (!accountId) continue
    const telefone = ((contact?.phone_normalized || contact?.phone || '') as string).replace(/\D/g, '')
    if (!telefone) continue

    const nome = ((contact?.name as string | null) ?? '').trim().split(/\s+/)[0] || ''
    const texto = TEXTO(nome)

    // PF agendada leva também a instrução do relatório SCR do Bacen, pra
    // trazer pronto no dia da reunião — pedido do titular, 01/09/2026.
    //
    // ⛔ Não dá pra exigir a tag "PF" propriamente: não existe formulário do
    // Meta pra PF (só o "REV-PJ V2", que marca PJ certinho) e não existe hoje
    // nenhum mecanismo -- nem a IA, nem código -- que aplique "PF" pra quem
    // chega direto pelo WhatsApp. Exigir a tag deixaria isto praticamente
    // morto. Por exclusão (decisão do titular, 01/09/2026): quem já agendou
    // e NÃO tem a tag PJ (essa sim confiável, vem do formulário) é tratado
    // como PF. Risco aceito: um PJ que fala direto no WhatsApp sem passar
    // pelo anúncio recebe o link do SCR por engano — raro, dado que a fonte
    // de lead PJ do escritório é o anúncio.
    const { data: tagPJ } = await db
      .from('contact_tags')
      .select('contact_id')
      .eq('contact_id', cand.contact_id)
      .eq('tag_id', TAG_PJ)
      .maybeSingle()
    const ehPF = !tagPJ

    // Janela de 24h aberta? Olha a última mensagem DO LEAD nesta conversa.
    const { data: ultimaDoLead } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const janelaAberta =
      !!ultimaDoLead && now - new Date(ultimaDoLead.created_at as string).getTime() < 24 * HOUR

    // Marca ANTES de enviar — mesmo motivo dos lembretes: falha no envio
    // perde 1 mensagem; marca depois de falhar repetiria a cada tick.
    const novoLog = log ? `${log};${chave}` : chave
    const marcou = logRow?.id
      ? await db.from('contact_custom_values').update({ value: novoLog }).eq('id', logRow.id as string)
      : await db.from('contact_custom_values').insert({
          contact_id: cand.contact_id,
          custom_field_id: CF_LEMBRETES_ENVIADOS,
          value: novoLog,
        })
    if (marcou.error) {
      console.error('[nutricao] não consegui marcar o envio — abortado:', marcou.error)
      continue
    }

    if (!primeiroEnvio) await pausaAleatoria()
    primeiroEnvio = false

    if (janelaAberta) {
      if (!userId) userId = await resolveAuditUserId(db, accountId)
      try {
        await engineSendText({
          accountId,
          userId,
          conversationId,
          contactId: contact!.id as string,
          text: texto,
        })
        console.log(`[nutricao] enviado pelo canal oficial (contact ${contact!.id})`)
      } catch (err) {
        console.error(`[nutricao] falha no canal oficial (contact ${contact!.id}):`, err instanceof Error ? err.message : String(err))
      }
    } else {
      const ok = await enviarPeloSegundoNumero(telefone, texto)
      if (ok) {
        await registrarEnvioSegundoNumero(db, conversationId, texto)
        console.log(`[nutricao] enviado pelo segundo número (contact ${contact!.id})`)
      } else {
        console.error(`[nutricao] falha no segundo número (contact ${contact!.id})`)
      }
    }

    // SCR do Bacen (PF) — sempre pelo segundo número, por pedido do titular
    // (reduzir volume pago na API oficial). Mesma pausa anti-rajada da
    // nutrição antes de mandar, pra não sair colada.
    if (ehPF) {
      await pausaAleatoria()
      const okBacen = await enviarPeloSegundoNumero(telefone, TEXTO_BACEN_SCR)
      if (okBacen) {
        await registrarEnvioSegundoNumero(db, conversationId, TEXTO_BACEN_SCR)
        console.log(`[nutricao] SCR Bacen (PF) enviado pelo segundo número (contact ${contact!.id})`)
      } else {
        console.error(`[nutricao] falha no envio do SCR Bacen (contact ${contact!.id})`)
      }
    }
  }
}
