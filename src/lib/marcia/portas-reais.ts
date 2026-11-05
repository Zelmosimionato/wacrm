// Márcia v2 — PORTAS REAIS: liga o executor aos helpers que já existem (envio, Cal.com, card, handoff).
// Não reimplementa nada: usa as mesmas funções do atendimento atual, que continuam sendo a fonte do comportamento
// de canal, de reserva e de card. Só entra em uso no modo "ligado".
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  aplicarVeredictoPiso,
  applyAiCardMove,
  desfazerReuniao,
  enviarTextoDaIa,
  handoffComAcolhimento,
  passarParaHumano,
  reservarHorario,
  splitBubbles,
  type CanalDeEnvio,
} from '../ai/auto-reply'
import { AGENDA_LINK, MENSAGENS } from './mensagens'
import { validarSaida } from '../ai/sdr-guards'
import { engineSendCtaUrl } from '../flows/meta-send'
import type { SlotLivre } from '../appointments/calcom-slots'
import type { Portas } from './executor'

export interface ContextoReal {
  db: SupabaseClient
  canal: CanalDeEnvio
  handoffAgentId: string | null
  jaTemDono: boolean
  slots: SlotLivre[]
  nome: string | null
  email: string | null
  telefone: string | null
  temReuniao: boolean
  textoDoLead: string
  /** Pede à persona (plataforma) uma pergunta curta do total, sem oferecer horário. */
  perguntarTotalViaModelo: () => Promise<string>
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function portasReais(c: ContextoReal): Portas {
  const { db, canal } = c
  return {
    async enviarTexto(texto) {
      const baloes = splitBubbles(texto)
      for (let i = 0; i < baloes.length; i++) {
        await enviarTextoDaIa(db, canal, baloes[i])
        if (i < baloes.length - 1) await dormir(900)
      }
    },
    async enviarPortaAberta() {
      if (canal.channel === 'web') {
        await enviarTextoDaIa(
          db,
          canal,
          `${MENSAGENS.porta_aberta_texto}\n${AGENDA_LINK}`,
        )
        return
      }
      await engineSendCtaUrl({
        accountId: canal.accountId,
        userId: canal.userId,
        conversationId: canal.conversationId,
        contactId: canal.contactId,
        bodyText: MENSAGENS.porta_aberta_botao,
        buttonText: 'Agendar agora',
        url: AGENDA_LINK,
      })
    },
    async passarParaHumano(motivo, comAcolhimento) {
      const resumo = `[ATENÇÃO] Márcia v2 passou para a equipe: ${motivo}.`
      if (comAcolhimento) {
        await handoffComAcolhimento(db, canal, resumo, c.handoffAgentId, c.jaTemDono)
      } else {
        await passarParaHumano(db, canal.accountId, canal.contactId, canal.conversationId, resumo, c.handoffAgentId, c.jaTemDono)
      }
    },
    gravarAbaixoPiso: (abaixo) => aplicarVeredictoPiso(db, canal.contactId, abaixo),
    async registrarHorario(n) {
      const slot = c.slots[n - 1]
      if (!slot) return
      await db
        .from('conversations')
        .update({ horario_escolhido_iso: slot.iso, horario_escolhido_rotulo: slot.rotulo })
        .eq('id', canal.conversationId)
    },
    reservar: (n, email) =>
      reservarHorario({
        db,
        contactId: canal.contactId,
        indice: n,
        slots: c.slots,
        nome: c.nome,
        email,
        telefone: c.telefone,
        hasMeeting: c.temReuniao,
        textoDaIa: '',
      }),
    async desmarcar() {
      await desfazerReuniao(db, canal.contactId)
    },
    moverCard: (move) => applyAiCardMove(db, { accountId: canal.accountId, contactId: canal.contactId, move, temReuniao: c.temReuniao }),
    textoFixo(chave) {
      return MENSAGENS[chave]
    },
    perguntarValor: (dbc) => (dbc ? Promise.resolve(MENSAGENS.perguntar_valor_dbc) : c.perguntarTotalViaModelo()),
    saidaValida: (texto) => validarSaida(texto, { textoLead: c.textoDoLead }).ok,
  }
}
