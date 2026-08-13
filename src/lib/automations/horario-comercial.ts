/**
 * Contagem de MINUTOS ÚTEIS — seg a sex, 09:00–12:00 e 13:00–17:00 (BRT).
 *
 * Existe porque "avisa de novo em 2 horas" não pode significar 2 horas de
 * relógio: conversa que ficou esperando às 16h50 avisaria às 18h50, com o
 * escritório fechado, e o aviso morreria na caixa até o dia seguinte — quando
 * já teria virado ruído. Aqui, 2 horas úteis a partir das 16h50 caem às 10h50
 * do próximo dia útil.
 *
 * ⛔ Não é ajuste de fuso: o Brasil não tem horário de verão desde 2019, então
 * BRT é fixo em UTC−3. O que esta função faz é pular o que está fora do
 * expediente e o intervalo do almoço.
 *
 * O horário vem do Manual do Cliente, que promete resposta em até 1 dia útil:
 * seg–sex, 09h–17h, intervalo 12h–13h.
 */

const MS_MIN = 60_000
const BRT_OFFSET_MIN = -180 // UTC−3, fixo

/** Faixas de expediente, em minutos desde a meia-noite (BRT). */
export const EXPEDIENTE: ReadonlyArray<readonly [number, number]> = [
  [9 * 60, 12 * 60],
  [13 * 60, 17 * 60],
]

/** Minuto do dia (BRT) de um instante. */
function minutoDoDiaBrt(t: number): number {
  const d = new Date(t + BRT_OFFSET_MIN * MS_MIN)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** 0=domingo … 6=sábado, no fuso de Brasília. */
function diaDaSemanaBrt(t: number): number {
  return new Date(t + BRT_OFFSET_MIN * MS_MIN).getUTCDay()
}

/** Meia-noite BRT do dia daquele instante, em epoch UTC. */
function meiaNoiteBrt(t: number): number {
  const d = new Date(t + BRT_OFFSET_MIN * MS_MIN)
  const inicioUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return inicioUtc - BRT_OFFSET_MIN * MS_MIN
}

export function ehDiaUtil(t: number): boolean {
  const dow = diaDaSemanaBrt(t)
  return dow >= 1 && dow <= 5
}

/** O instante cai dentro do expediente? */
export function dentroDoExpediente(t: number): boolean {
  if (!ehDiaUtil(t)) return false
  const m = minutoDoDiaBrt(t)
  return EXPEDIENTE.some(([ini, fim]) => m >= ini && m < fim)
}

/**
 * Quantos minutos úteis existem entre `de` e `ate`.
 * Retorna 0 se `ate` <= `de`. Percorre dia a dia, com teto de 400 dias para
 * nunca virar laço infinito por data maluca vinda do banco.
 */
export function minutosUteis(de: number, ate: number): number {
  if (!Number.isFinite(de) || !Number.isFinite(ate) || ate <= de) return 0

  let total = 0
  let dia = meiaNoiteBrt(de)
  const TETO_DIAS = 400

  for (let i = 0; i < TETO_DIAS && dia <= ate; i++, dia += 24 * 60 * MS_MIN) {
    if (!ehDiaUtil(dia)) continue
    for (const [ini, fim] of EXPEDIENTE) {
      const faixaIni = dia + ini * MS_MIN
      const faixaFim = dia + fim * MS_MIN
      const inicio = Math.max(faixaIni, de)
      const termino = Math.min(faixaFim, ate)
      if (termino > inicio) total += (termino - inicio) / MS_MIN
    }
  }
  return Math.round(total)
}

/** Já se passaram `horas` úteis desde `de`? */
export function passaramHorasUteis(de: number, horas: number, agora: number): boolean {
  if (horas <= 0) return agora >= de
  return minutosUteis(de, agora) >= horas * 60
}
