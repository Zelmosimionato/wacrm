// ============================================================
// Bloqueio global de envio — a última porta antes da Meta.
//
// ⛔ Quem está na lista NÃO recebe mensagem de máquina nenhuma: nem lembrete,
// nem nutrição, nem reagendamento, nem confirmação, nem template de etapa. A
// verificação vive na camada mais baixa (todo envio do CRM passa por
// `meta-api`) justamente para que nenhuma automação futura consiga contornar
// sem perceber — inclusive uma que ainda não existe.
//
// ⭐ A IDENTIDADE É O `contact_id`, NUNCA O TELEFONE.
// A Meta entrega para um telefone; o CRM decide permissão por contato.
// Telefone serve para ENCONTRAR o contato, jamais para decidir sozinho.
//
// ⛔ NENHUM DADO DE CLIENTE NESTE ARQUIVO. Quem está bloqueado é configuração,
// não código: vem de `WHATSAPP_BLOCKLIST_CONTACT_IDS` no `.env.local`, que está
// fora do git. O código traz o mecanismo; o dado fica no ambiente. Os logs
// registram só o id — quem precisar do nome consulta o CRM.
// ============================================================

/** Ids bloqueados, separados por vírgula, em `WHATSAPP_BLOCKLIST_CONTACT_IDS`. */
function idsBloqueados(): Set<string> {
  const cru = process.env.WHATSAPP_BLOCKLIST_CONTACT_IDS
  if (cru === undefined) {
    // ⛔ Diferente de vazio: vazio é decisão, ausente é esquecimento. Um deploy
    // sem a variável devolveria o silêncio de quem pediu para não ser mais
    // procurado — e ninguém perceberia até a reclamação chegar.
    console.error(
      '[blocklist] ⛔ WHATSAPP_BLOCKLIST_CONTACT_IDS não está definida. ' +
        'Ninguém está bloqueado. Se isso é intencional, defina a variável como ' +
        'string vazia para registrar a intenção.',
    )
    return new Set()
  }
  return new Set(
    cru
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

/**
 * ⏳ TEMPORÁRIO — sufixos de telefone em `WHATSAPP_BLOCKLIST_ALARM_PHONES`,
 * usados **só para alarme**.
 *
 * ⛔ Isto NÃO decide bloqueio. Existe para responder uma única pergunta durante
 * o período de observação: "houve algum caso em que o id não pegou e o telefone
 * teria pegado?" — ou seja, um cadastro duplicado da mesma pessoa. Sem
 * divergência depois de algumas semanas de tráfego real, a variável e este
 * bloco saem.
 */
function sufixosDeAlarme(): Set<string> {
  const cru = process.env.WHATSAPP_BLOCKLIST_ALARM_PHONES
  if (!cru) return new Set()
  return new Set(
    cru
      .split(',')
      .map((s) => s.replace(/\D/g, '').slice(-8))
      .filter(Boolean),
  )
}

/** Este contato está bloqueado? */
export function envioBloqueado(contactId: string | null | undefined): boolean {
  if (!contactId) return false
  return idsBloqueados().has(contactId)
}

/** Erro dedicado, para quem chama distinguir bloqueio de falha de rede. */
export class ContatoBloqueadoError extends Error {
  readonly motivo = 'blocked_by_contact_id'
  constructor(readonly contactId: string) {
    super(`envio bloqueado: contato ${contactId}`)
    this.name = 'ContatoBloqueadoError'
  }
}

/**
 * Envio automático que chegou até a Meta sem saber para QUEM está mandando.
 *
 * ⛔ Isto é defeito, não operação normal. Todo caminho de envio deste sistema
 * tem o contato em mãos: a nutrição manda `contact_id` no corpo, o vigia parte
 * de `deals.contact_id`, o broadcast resolve cada destinatário com
 * `findOrCreateContact` antes de planejar, e a IA parte da conversa.
 *
 * Por isso aborta em vez de liberar: os custos não são simétricos. Uma mensagem
 * legítima a menos custa um alerta para alguém olhar; uma mensagem a mais vai
 * para quem pediu silêncio.
 */
export class ContatoNaoResolvidoError extends Error {
  readonly motivo = 'unresolved_contact_abortado'
  constructor(origem: string) {
    super(`envio sem contact_id (${origem}) — abortado`)
    this.name = 'ContatoNaoResolvidoError'
  }
}

/**
 * Guarda das funções de envio. ⛔ LANÇA em vez de devolver um valor: falhar
 * fechado é o ponto. Se devolvesse um resultado vazio, quem chama gravaria uma
 * mensagem fantasma no inbox — o escritório veria no histórico uma conversa
 * que nunca aconteceu.
 *
 * @param contactId  a identidade. Sem ele não há decisão possível — aborta.
 * @param origem     nome da função de envio, só para o log.
 * @param telefone   opcional, **só para o alarme temporário**. ⛔ Não decide.
 */
export function abortarSeBloqueado(
  contactId: string | null | undefined,
  origem: string,
  telefone?: string | null,
): void {
  if (!contactId) {
    console.error(
      `[blocklist] envio abortado (${origem}) — unresolved_contact_abortado: ` +
        `chegou na porta da Meta sem contact_id. Isto é defeito de quem chamou, ` +
        `não caso normal — o envio foi barrado por precaução.`,
    )
    throw new ContatoNaoResolvidoError(origem)
  }

  if (idsBloqueados().has(contactId)) {
    console.warn(
      `[blocklist] envio abortado (${origem}) — blocked_by_contact_id: ${contactId}`,
    )
    throw new ContatoBloqueadoError(contactId)
  }

  // ⏳ Alarme temporário. Não bloqueia — só grita se o telefone discordar do id.
  if (telefone) {
    const sufixo = telefone.replace(/\D/g, '').slice(-8)
    if (sufixo && sufixosDeAlarme().has(sufixo)) {
      console.error(
        `[blocklist] ⚠️ divergencia_id_x_telefone (${origem}): o contato ${contactId} ` +
          `NÃO está na lista, mas o telefone bate com um que está. O envio SEGUIU. ` +
          `Provável cadastro duplicado — vincule a conversa ao contato certo ou ` +
          `acrescente este id à lista.`,
      )
    }
  }
}
