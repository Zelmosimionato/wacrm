// Márcia v2 — ENTRADA: uma mensagem do lead entra, passa por fatos → modelo → porteiro → executor.
// modo 'sombra': decide e REGISTRA (arquivo de log), não envia nem grava nada no CRM.
// modo 'ligado': executa de verdade. Falha nunca é silenciosa: erro do modelo → 1 nova tentativa → equipe + alerta.
// ⛔ Ainda NÃO está ligado a nenhum webhook; só é chamado por scripts até o titular aprovar a troca.
import { appendFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { agendaDoEscritorio } from '../ai/auto-reply'
import { loadAiConfig } from '../ai/config'
import { buildConversationContext } from '../ai/context'
import { executar, type ResumoExecucao } from './executor'
import { fatosParaTexto, lerFatos } from './fatos'
import { carregarInstrucoes } from './instrucoes'
import { decidirComModelo, lerValorFocado } from './modelo'
import { portasReais } from './portas-reais'
import { MENSAGENS } from './mensagens'
import { validarSaida } from '../ai/sdr-guards'
import { decidir, type Decisao, type Resultado } from './porteiro'

export type Modo = 'sombra' | 'ligado'
const LOG_SOMBRA = process.env.MARCIA_V2_LOG ?? '/root/marcia-v2-sombra.log'

export interface EntradaArgs {
  db: SupabaseClient
  accountId: string
  userId: string
  contactId: string
  conversationId: string
  canal: 'api' | 'web'
  modo: Modo
}

export interface SaidaProcessar {
  decisao: Decisao | null
  resultado: Resultado | null
  execucao: ResumoExecucao | null
  erro: string | null
}

async function comUmaRepeticao<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    await new Promise((r) => setTimeout(r, 1500))
    return fn()
  }
}

export async function processarMensagem(a: EntradaArgs): Promise<SaidaProcessar> {
  const { db } = a
  const config = await loadAiConfig(db, a.accountId)
  if (!config) return { decisao: null, resultado: null, execucao: null, erro: 'sem configuração de IA ativa' }

  const slots = await agendaDoEscritorio()
  const horarios = slots.map((s) => s.rotulo)
  const lidos = await lerFatos(db, { contactId: a.contactId, conversationId: a.conversationId, horariosLivres: slots.map((_, i) => i + 1) })
  const conversa = await buildConversationContext(db, a.conversationId)
  const textoDoCliente = conversa.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
  const fatos = { ...lidos.fatos, textoDoCliente }

  const { texto: instrucoes } = await carregarInstrucoes(config.apiKey, config.systemPrompt ?? null)
  const { data: contato } = await db.from('contacts').select('name, phone, email').eq('id', a.contactId).maybeSingle()
  const c = contato as { name: string | null; phone: string | null; email: string | null } | null
  const { data: conv } = await db.from('conversations').select('assigned_agent_id').eq('id', a.conversationId).maybeSingle()
  const jaTemDono = !!(conv as { assigned_agent_id: string | null } | null)?.assigned_agent_id

  const portas = portasReais({
    db,
    canal: { accountId: a.accountId, userId: a.userId, conversationId: a.conversationId, contactId: a.contactId, channel: a.canal },
    handoffAgentId: config.handoffAgentId,
    jaTemDono,
    slots,
    nome: c?.name ?? null,
    email: c?.email ?? null,
    telefone: c?.phone ?? null,
    temReuniao: fatos.temReuniao,
    textoDoLead: textoDoCliente,
    perguntarTotalViaModelo: async () => {
      try {
      const r = await decidirComModelo({
        apiKey: config.apiKey, model: config.model, instrucoes,
        fatosTexto: `${fatosParaTexto(lidos, horarios)}\nInstrução do sistema para esta resposta: pergunte apenas, em uma mensagem curta e acolhedora, o valor total aproximado. Não ofereça horário.`,
        conversa, produto: fatos.produto,
      })
      return r.decisao.mensagem.trim() || MENSAGENS.perguntar_total
      } catch {
        return MENSAGENS.perguntar_total
      }
    },
  })

  try {
    const r = await comUmaRepeticao(() =>
      decidirComModelo({ apiKey: config.apiKey, model: config.model, instrucoes, fatosTexto: fatosParaTexto(lidos, horarios), conversa, produto: fatos.produto }),
    )
    const foc = await comUmaRepeticao(() => lerValorFocado({ apiKey: config.apiKey, model: config.model, produto: fatos.produto, conversa }))
    let decisao: Decisao = { ...r.decisao, valorTotal: foc.valorTotal, valorRelacao: foc.valorRelacao, valorTipo: foc.valorTipo, valorTrecho: foc.valorTrecho }
    let resultado = decidir(decisao, fatos)

    // 05/11/2026 (1o teste ao vivo): mensagem barrada pelo filtro de saida (ex.: 2 perguntas) ia direto para a equipe.
    // Como no fluxo antigo, reescreve antes de desistir: ate 2 regeneracoes com a falha anexada; so entao o executor passa a equipe.
    for (let i = 0; i < 2 && resultado.acao.tipo === 'enviar'; i++) {
      const v = validarSaida(resultado.acao.texto, { textoLead: textoDoCliente })
      if (v.ok) break
      const aviso = `Instrução do sistema: sua resposta anterior foi reprovada (${v.falhas.map((f) => f.detalhe).join('; ')}). Reescreva a mensagem ao lead corrigindo isso: no máximo UMA pergunta, sem marcadores [[ ]], sem narrar processo interno e sem citar valores de corte.`
      const r2 = await comUmaRepeticao(() =>
        decidirComModelo({ apiKey: config.apiKey, model: config.model, instrucoes, fatosTexto: `${fatosParaTexto(lidos, horarios)}
${aviso}`, conversa, produto: fatos.produto }),
      )
      decisao = { ...r2.decisao, valorTotal: foc.valorTotal, valorRelacao: foc.valorRelacao, valorTipo: foc.valorTipo, valorTrecho: foc.valorTrecho }
      resultado = decidir(decisao, fatos)
    }

    if (a.modo === 'sombra') {
      appendFileSync(
        LOG_SOMBRA,
        JSON.stringify({ quando: new Date().toISOString(), conversa: a.conversationId, produto: fatos.produto, intencao: decisao.intencao, valor: decisao.valorTotal, tipo: decisao.valorTipo, acao: resultado.acao.tipo, ms: r.ms + foc.ms }) + '\n',
      )
      return { decisao, resultado, execucao: null, erro: null }
    }
    const execucao = await executar(resultado, decisao, fatos, portas)
    return { decisao, resultado, execucao, erro: null }
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e)
    console.error(`[marcia-v2] falha (conversa ${a.conversationId}): ${erro}`)
    if (a.modo === 'ligado') await portas.passarParaHumano('falha_modelo', true) // nunca em silêncio
    else appendFileSync(LOG_SOMBRA, JSON.stringify({ quando: new Date().toISOString(), conversa: a.conversationId, erro }) + '\n')
    return { decisao: null, resultado: null, execucao: null, erro }
  }
}
