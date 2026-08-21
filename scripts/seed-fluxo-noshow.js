const { seedClient, upsertByUniqueColumn, garantirSemRunAtivo } = require('./lib/seed-client')

const ACCOUNT_ID = '2569c0e9-5f2e-4d04-957c-e2f158e7a87e'
const USER_ID = 'be874c16-32b2-46c2-b5fa-45097dc62ff1'

const TAG_REMARCADO = process.argv[2]
const TAG_PERDIDO_NOSHOW = process.argv[3]
if (!TAG_REMARCADO || !TAG_PERDIDO_NOSHOW) {
  throw new Error('uso: node scripts/seed-fluxo-noshow.js <tag_remarcado_id> <tag_perdido_noshow_id>\n(ids impressos pela Task 7, Step 3, log "tags:")')
}

const BOTAO_REMARCAR = { reply_id: 'quero_remarcar', title: 'Quero remarcar' }
const BOTAO_NAO = { reply_id: 'nao_obrigado', title: 'Não, obrigado' }

async function main() {
  const db = seedClient()

  const { data: existente } = await db.from('flows').select('id').eq('name', 'Fluxo No-show').eq('account_id', ACCOUNT_ID).maybeSingle()
  await garantirSemRunAtivo(db, existente ? existente.id : null)

  const flow = await upsertByUniqueColumn(db, 'flows', 'name', ACCOUNT_ID, {
    name: 'Fluxo No-show',
    account_id: ACCOUNT_ID,
    user_id: USER_ID,
    description: 'Substitui a automação "Follow up No-show — 3 toques e encerra". Acordado via start_flow quando o card entra em "Follow up No-show".',
    status: 'active',
    trigger_type: 'manual',
    trigger_config: {},
    entry_node_id: null,
    // on_unknown_reply:'ignore', mesmo motivo do achado NEW-9 no Fluxo
    // de Agendamento (Task 8) — sem isso, um "oi" fora de hora enquanto
    // o No-show espera resposta calava a Márcia por até 6 dias (3
    // toques x 2 dias) até esgotar os reprompts.
    fallback_policy: { on_unknown_reply: 'ignore', max_reprompts: 0, on_timeout_hours: 240, on_exhaust: 'end' },
  })

  await db.from('flow_nodes').delete().eq('flow_id', flow.id)

  const nodes = [
    { node_key: 'start', node_type: 'start', config: { next_node_key: 'toque1' } },
    {
      node_key: 'toque1', node_type: 'send_buttons',
      config: {
        text: 'Notei que não conseguimos nos falar na reunião marcada. Quer que eu já veja um novo horário pra você?',
        buttons: [
          { ...BOTAO_REMARCAR, next_node_key: 'limpar_remarcado' },
          { ...BOTAO_NAO, next_node_key: 'limpar_perdido' },
        ],
        timeout: { unit: 'days', amount: 2, next_node_key: 'toque2' },
      },
    },
    {
      node_key: 'toque2', node_type: 'send_buttons',
      config: {
        text: 'Ainda dá tempo de remarcar, se fizer sentido pra você — é só me avisar.',
        buttons: [
          { ...BOTAO_REMARCAR, next_node_key: 'limpar_remarcado' },
          { ...BOTAO_NAO, next_node_key: 'limpar_perdido' },
        ],
        timeout: { unit: 'days', amount: 2, next_node_key: 'toque3' },
      },
    },
    {
      node_key: 'toque3', node_type: 'send_buttons',
      config: {
        text: 'Última tentativa por aqui — se quiser remarcar, é só chamar quando puder.',
        buttons: [
          { ...BOTAO_REMARCAR, next_node_key: 'limpar_remarcado' },
          { ...BOTAO_NAO, next_node_key: 'limpar_perdido' },
        ],
        timeout: { unit: 'days', amount: 2, next_node_key: 'limpar_perdido' },
      },
    },
    // remove-antes-de-add, mesmo motivo da Task 8 (achado real #9).
    { node_key: 'limpar_remarcado', node_type: 'set_tag', config: { mode: 'remove', tag_id: TAG_REMARCADO, next_node_key: 'marcar_remarcado' } },
    { node_key: 'marcar_remarcado', node_type: 'set_tag', config: { mode: 'add', tag_id: TAG_REMARCADO, next_node_key: 'fim_remarcado' } },
    { node_key: 'fim_remarcado', node_type: 'end', config: {} },
    { node_key: 'limpar_perdido', node_type: 'set_tag', config: { mode: 'remove', tag_id: TAG_PERDIDO_NOSHOW, next_node_key: 'marcar_perdido' } },
    { node_key: 'marcar_perdido', node_type: 'set_tag', config: { mode: 'add', tag_id: TAG_PERDIDO_NOSHOW, next_node_key: 'fim_perdido' } },
    { node_key: 'fim_perdido', node_type: 'end', config: {} },
  ]

  const inserted = await db.from('flow_nodes').insert(
    nodes.map((n) => ({ ...n, flow_id: flow.id, position_x: 0, position_y: 0 })),
  ).select('id, node_key')
  if (inserted.error) throw new Error(`insert flow_nodes: ${inserted.error.message}`)
  const startNode = inserted.data.find((n) => n.node_key === 'start')
  await db.from('flows').update({ entry_node_id: startNode.node_key }).eq('id', flow.id)

  console.log('Fluxo No-show id:', flow.id, '| total de nós:', nodes.length)
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
