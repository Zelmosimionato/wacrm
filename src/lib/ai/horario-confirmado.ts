/**
 * A resposta da IA confirma, sem perguntar, o horário que o lead escolheu?
 *
 * Caso Lead H (19/10/2026): ela escolheu "26 às 13:15" e deu o e-mail; a IA
 * respondeu "Então sigo com o dia 26 às 13:15." — sem marcador AGENDAR e sem
 * nenhuma das palavras que a trava `AFIRMA_QUE_AGENDOU` conhece ("agendei",
 * "marquei"...). Nada reservou, o lead achou que estava marcado e ninguém viu.
 *
 * Em vez de caçar mais uma frase, olhamos o fato: a resposta cita UM horário,
 * é o que o lead escolheu, e não pergunta nada. Uma lista de opções ("tenho
 * 13:15, 14:00 ou 14:45") cita vários horários e uma pergunta ("qual fica
 * melhor?") tem "?" — nenhuma das duas conta.
 *
 * Função pura, sem I/O.
 */

/** Horas citadas no texto, normalizadas para HH:MM ("13h15", "13:15" e "13h" viram 13:15 / 13:00). */
export function horasCitadas(texto: string): string[] {
  const achadas = new Set<string>()
  const re = /\b([01]?\d|2[0-3])\s*(?::|h)\s*([0-5]\d)?\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(texto))) {
    // "13h" sem minutos só vale se vier colado ao "h" (evita "2 h" solto de outra coisa).
    const hh = m[1].padStart(2, '0')
    const mm = (m[2] ?? '00').padStart(2, '0')
    achadas.add(`${hh}:${mm}`)
  }
  return [...achadas]
}

/** Hora do rótulo do horário escolhido, ex.: "dia 26, segunda-feira, às 13:15" -> "13:15". */
export function horaDoRotulo(rotulo: string | null | undefined): string | null {
  if (!rotulo) return null
  const h = horasCitadas(rotulo)
  return h.length === 1 ? h[0] : null
}

export function respostaConfirmaHorario(
  texto: string,
  rotuloEscolhido: string | null | undefined,
): boolean {
  const hora = horaDoRotulo(rotuloEscolhido)
  if (!hora) return false
  if (texto.includes('?')) return false
  const citadas = horasCitadas(texto)
  return citadas.length === 1 && citadas[0] === hora
}
