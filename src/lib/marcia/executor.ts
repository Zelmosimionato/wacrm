// Márcia v2 — EXECUTOR: transforma a ação do porteiro em efeitos (enviar, reservar, mover card, passar à equipe).
// Só orquestra: todo efeito real passa por `Portas`, injetadas. Assim dá para testar sem tocar em nada de produção,
// e o modo sombra simplesmente usa portas que só registram.
import type { Acao, Decisao, Fatos, Resultado } from './porteiro'

export type TextoFixo = 'recusa_piso' | 'recusa_dbc' | 'pedir_email' | 'horario_tomado'
export type MoveCard = 'qualified' | 'super' | 'reagendar' | 'perdido'

export interface Portas {
  /** Divide em balões e envia pelo canal da conversa (oficial ou segundo número). */
  enviarTexto(texto: string): Promise<void>
  enviarPortaAberta(): Promise<void>
  passarParaHumano(motivo: string, comAcolhimento: boolean): Promise<void>
  gravarAbaixoPiso(abaixo: boolean): Promise<void>
  registrarHorario(n: number): Promise<void>
  reservar(n: number, email: string): Promise<{ ok: boolean; texto: string; reagendar: boolean }>
  desmarcar(): Promise<void>
  moverCard(move: MoveCard): Promise<void>
  /** Texto aprovado, vindo da fonte única de mensagens fixas. */
  textoFixo(chave: TextoFixo): string
  /** Pergunta curta do total (a persona escreve; no DBC é a pergunta fixa do valor exato). */
  perguntarValor(dbc: boolean): Promise<string>
  /** Guarda de saída: corte citado, narração, balão longo etc. */
  saidaValida(texto: string): boolean
}

export interface ResumoExecucao {
  acao: Acao['tipo']
  efeitos: string[]
}

export async function executar(
  res: Resultado,
  d: Decisao,
  f: Fatos,
  p: Portas,
): Promise<ResumoExecucao> {
  const efeitos: string[] = []
  const reg = <T>(nome: string, fn: () => Promise<T>) => {
    efeitos.push(nome)
    return fn()
  }
  const a = res.acao
  const resumo = (): ResumoExecucao => ({ acao: a.tipo, efeitos })

  switch (a.tipo) {
    case 'handoff':
      await reg(`handoff:${a.motivo}${a.silencioso ? ':silencioso' : ''}`, () => p.passarParaHumano(a.motivo, !a.silencioso))
      return resumo()

    case 'silencio':
      return resumo()

    case 'recusa': {
      if (res.gravarAbaixoPiso !== null) await reg(`piso:${res.gravarAbaixoPiso}`, () => p.gravarAbaixoPiso(res.gravarAbaixoPiso!))
      await reg('texto:recusa', () => p.enviarTexto(p.textoFixo(a.motivo === 'dbc_abaixo' ? 'recusa_dbc' : 'recusa_piso')))
      return resumo()
    }

    case 'encaminhar_equipe':
      if (res.gravarAbaixoPiso !== null) await reg(`piso:${res.gravarAbaixoPiso}`, () => p.gravarAbaixoPiso(res.gravarAbaixoPiso!))
      await reg('handoff:dbc_faixa_intermediaria', () => p.passarParaHumano('dbc_faixa_intermediaria', true))
      return resumo()

    case 'perguntar_valor': {
      // A mensagem do modelo é descartada: ela poderia estar oferecendo horário. Pergunta-se só o total.
      const texto = await p.perguntarValor(f.produto === 'DBC')
      await reg('texto:perguntar_valor', () => p.enviarTexto(texto))
      return resumo()
    }

    case 'pedir_email':
      if (res.gravarAbaixoPiso !== null) await reg(`piso:${res.gravarAbaixoPiso}`, () => p.gravarAbaixoPiso(res.gravarAbaixoPiso!))
      await reg('texto:pedir_email', () => p.enviarTexto(p.textoFixo('pedir_email')))
      return resumo()

    case 'horario_indisponivel':
      if (res.gravarAbaixoPiso !== null) await reg(`piso:${res.gravarAbaixoPiso}`, () => p.gravarAbaixoPiso(res.gravarAbaixoPiso!))
      await reg('texto:horario_indisponivel', () => p.enviarTexto(p.textoFixo('horario_tomado')))
      return resumo()

    case 'enviar': {
      if (!p.saidaValida(a.texto)) {
        await reg('handoff:saida_invalida', () => p.passarParaHumano('saida_invalida', true))
        return resumo()
      }
      if (res.gravarAbaixoPiso !== null) await reg(`piso:${res.gravarAbaixoPiso}`, () => p.gravarAbaixoPiso(res.gravarAbaixoPiso!))

      switch (a.efeito) {
        case 'registrar_horario':
          await reg(`horario:${a.horarioN}`, () => p.registrarHorario(a.horarioN!))
          await reg('texto', () => p.enviarTexto(a.texto))
          break
        case 'agendar': {
          const r = await reg(`reservar:${a.horarioN}`, () => p.reservar(a.horarioN!, a.email!))
          // Falha de reserva: nunca afirmar que agendou; vale o texto fixo de falha.
          await reg(r.ok ? 'texto' : 'texto:falha_reserva', () => p.enviarTexto(r.ok ? a.texto : r.texto))
          if (r.reagendar) await reg('card:reagendar', () => p.moverCard('reagendar'))
          break
        }
        case 'desmarcar':
          await reg('desmarcar', () => p.desmarcar())
          await reg('texto', () => p.enviarTexto(a.texto))
          break
        case 'reagendar':
          await reg('texto', () => p.enviarTexto(a.texto))
          await reg('card:reagendar', () => p.moverCard('reagendar'))
          break
        case 'perdido':
          if (f.temReuniao) await reg('desmarcar', () => p.desmarcar())
          await reg('texto', () => p.enviarTexto(a.texto))
          await reg('card:perdido', () => p.moverCard('perdido'))
          break
        case 'porta_aberta':
          await reg('texto', () => p.enviarTexto(a.texto))
          await reg('porta_aberta', () => p.enviarPortaAberta())
          break
        default: // 'nenhum' | 'oferecer_horarios'
          await reg('texto', () => p.enviarTexto(a.texto))
      }
      if (res.handoffDepois) await reg('handoff:etapa_sensivel', () => p.passarParaHumano('etapa_sensivel', false))
      return resumo()
    }
  }
}
