/**
 * Desde quando uma conversa está esperando resposta HUMANA.
 *
 * Regra: a espera começa na PRIMEIRA mensagem do cliente depois da nossa
 * última resposta. Não é a última mensagem dele — se ele mandou três seguidas,
 * ele espera desde a primeira, e é esse o tempo que interessa.
 *
 * ⭐ A IA CONTA como resposta, por padrão. O objetivo do sinal é "não deixar
 * ninguém sem atendimento" — e quem foi atendido pela Márcia foi atendido.
 *
 * ⛔ A primeira versão fazia o contrário (só humano encerrava), e o titular
 * mostrou o furo com dois casos reais: o Eduardo, atendido pela IA, ficava
 * marcado como pendente; e a despedida ("obrigado") deixaria marca eterna,
 * porque "eu digo obrigado, ele responde eu que agradeço, e daí". Quem quiser
 * o comportamento antigo desliga `ia_conta_como_resposta` na automação.
 */

export interface MsgResumo {
  sender_type: 'customer' | 'agent' | 'bot' | string
  created_at: string
}

/**
 * Devolve o instante (epoch) em que a espera começou, ou `null` se a conversa
 * não está esperando ninguém — porque já respondemos por último, ou porque não
 * há mensagem de cliente alguma.
 */
export function esperandoDesde(
  mensagens: MsgResumo[],
  iaContaComoResposta = true,
): number | null {
  if (!mensagens?.length) return null

  const ordenadas = [...mensagens]
    .map((m) => ({ tipo: m.sender_type, t: new Date(m.created_at).getTime() }))
    .filter((m) => Number.isFinite(m.t))
    .sort((a, b) => a.t - b.t)

  if (!ordenadas.length) return null

  const respondeu = (tipo: string) =>
    tipo === 'agent' || (iaContaComoResposta && tipo === 'bot')

  // Última vez que NÓS respondemos. -Infinity = nunca respondemos.
  let ultimaResposta = -Infinity
  for (const m of ordenadas) if (respondeu(m.tipo)) ultimaResposta = m.t

  // Primeira do cliente depois disso.
  for (const m of ordenadas) {
    if (m.tipo === 'customer' && m.t > ultimaResposta) return m.t
  }
  return null
}
