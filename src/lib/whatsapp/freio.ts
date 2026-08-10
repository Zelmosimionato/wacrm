import { supabaseAdmin } from '@/lib/ai/admin-client'

// ============================================================
// FREIO DE VOLUME — a trava que não precisa entender o bug.
//
// Toda outra trava do sistema é de LÓGICA: pergunta "já mandei esta mensagem
// para esta pessoa nesta ocasião?" e depende de a resposta estar certa. Em
// 09/08/2026 a resposta esteve errada 417 vezes seguidas e ninguém percebeu:
// a idempotência dos lembretes procurava um envio anterior a partir de
// `reunião − 25h`, mas a véspera dispara entre 12h e 18h do dia anterior — até
// ~31h antes. A consulta olhava para uma janela que começava DEPOIS do próprio
// envio. A mensagem estava gravada; a trava só não a enxergava. Como a grade
// de reuniões começa às 13h, isso valia para praticamente toda a agenda.
//
// ⭐ Este freio não sabe o que é lembrete, nem reunião, nem janela. Ele CONTA.
// O sistema foi programado para mandar cada template uma vez por ocasião —
// então mais que isso é defeito, seja qual for o raciocínio que produziu.
//
// ⛔ Conta só TEMPLATE (mensagem de máquina). Resposta livre da Márcia não
// entra: ela quebra a resposta em até 4 balões, e uma conversa animada
// tropeçaria num teto pensado para automação.
// ============================================================

/**
 * Mesmo template para o mesmo contato.
 *
 * ⭐ O programado é UMA vez por ocasião — então o teto por hora é 1. Duas
 * mensagens idênticas para a mesma pessoa dentro de uma hora não são fluxo
 * desenhado nenhum; são defeito.
 *
 * No DIA são 2, porque aí existe ocasião nova de verdade: a pessoa cancela de
 * manhã e remarca à tarde, e as duas confirmações são corretas.
 *
 * ⛔ Apertado de propósito. Errar apertado é barato e barulhento: o envio não
 * sai e o log diz por quê — afrouxa-se numa linha do .env.local, sem deploy.
 * Errar folgado é silencioso e caro, e foi o que aconteceu em 09/08/2026.
 */
const LIMITE_MESMO_TEMPLATE_HORA = () =>
  Number(process.env.FREIO_MESMO_TEMPLATE_HORA ?? 1)
const LIMITE_MESMO_TEMPLATE_DIA = () =>
  Number(process.env.FREIO_MESMO_TEMPLATE_DIA ?? 2)

/** Segunda rede: uma fuga que cicle ENTRE templates diferentes não seria
 *  pega pelo teto acima. Nenhum contato legítimo recebe 3 templates numa
 *  hora — o pico real medido fora do incidente foi 2. */
const LIMITE_CONTATO_HORA = () => Number(process.env.FREIO_CONTATO_HORA ?? 3)

const HORA = 60 * 60_000
const DIA = 24 * HORA

export class FreioError extends Error {
  readonly motivo = 'freio_de_volume'
  constructor(
    readonly detalhe: string,
    readonly contactId: string,
  ) {
    super(`freio de volume: ${detalhe}`)
    this.name = 'FreioError'
  }
}

/** Conta templates já enviados a este contato, opcionalmente de um só nome. */
async function jaEnviados(
  contactId: string,
  desdeMs: number,
  templateName?: string,
): Promise<number> {
  const db = supabaseAdmin()
  let q = db
    .from('messages')
    .select('id, conversations!inner(contact_id)', { count: 'exact', head: true })
    .eq('conversations.contact_id', contactId)
    .not('template_name', 'is', null)
    .gte('created_at', new Date(desdeMs).toISOString())
  if (templateName) q = q.eq('template_name', templateName)
  const { count, error } = await q
  if (error) {
    // ⛔ Falha FECHADA. Se não dá para contar, não dá para garantir que o
    // próximo envio está dentro do programado — e foi exatamente "seguir sem
    // conseguir verificar" que produziu as 417.
    throw new FreioError(
      `não consegui contar os envios recentes (${error.message}) — envio barrado por precaução`,
      contactId,
    )
  }
  return count ?? 0
}

/**
 * Barra o envio que passa do que o sistema foi programado a mandar.
 *
 * ⛔ Só para TEMPLATE. Quem chama passa `templateName`; envio de texto livre
 * não chega aqui.
 */
export async function conferirFreio(
  contactId: string,
  templateName: string,
  origem: string,
): Promise<void> {
  const agora = Date.now()

  const mesmoHora = await jaEnviados(contactId, agora - HORA, templateName)
  if (mesmoHora >= LIMITE_MESMO_TEMPLATE_HORA()) {
    const d = `${mesmoHora}x "${templateName}" para o contato ${contactId} na última hora (limite ${LIMITE_MESMO_TEMPLATE_HORA()})`
    console.error(`[freio] envio abortado (${origem}) — ${d}`)
    throw new FreioError(d, contactId)
  }

  const mesmoDia = await jaEnviados(contactId, agora - DIA, templateName)
  if (mesmoDia >= LIMITE_MESMO_TEMPLATE_DIA()) {
    const d = `${mesmoDia}x "${templateName}" para o contato ${contactId} nas últimas 24h (limite ${LIMITE_MESMO_TEMPLATE_DIA()})`
    console.error(`[freio] envio abortado (${origem}) — ${d}`)
    throw new FreioError(d, contactId)
  }

  const qualquerHora = await jaEnviados(contactId, agora - HORA)
  if (qualquerHora >= LIMITE_CONTATO_HORA()) {
    const d = `${qualquerHora} templates para o contato ${contactId} na última hora (limite ${LIMITE_CONTATO_HORA()})`
    console.error(`[freio] envio abortado (${origem}) — ${d}`)
    throw new FreioError(d, contactId)
  }
}
