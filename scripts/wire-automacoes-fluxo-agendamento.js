const { seedClient, upsertByUniqueColumn } = require('./lib/seed-client')

const ACCOUNT_ID = '2569c0e9-5f2e-4d04-957c-e2f158e7a87e'
const USER_ID = 'be874c16-32b2-46c2-b5fa-45097dc62ff1'

const TAG_URGENTE = '9db3b56e-eecf-4b29-bace-2cc034b38f72'
const STAGE_FOLLOWUP_NOSHOW = '8c39cc10-4568-432f-b4dd-9a4ba228add6'
const STAGE_PERDIDO = '0d0382a5-f15d-4e43-88aa-0c70337d94d4'
const PIPELINE_VENDAS = '8e89e154-763c-4cf8-b73b-42f7368c59c3'
const AUTOMATION_FOLLOWUP_NOSHOW_ANTIGA = 'b6359cda-4516-4186-8937-d7c86a90c8c8'
const AUTOMATION_PERDEU_CONFIRMACAO = '6809f61f-0a02-4d1a-8a84-87598ac959ee'
const AUTOMATION_AGENDOU = 'f2347d27-201c-48c1-ac90-722a5d1b5ff8'

function argFlag(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : undefined
}

async function main() {
  const db = seedClient()
  const flowAgendamentoId = argFlag('flow-agendamento-id') || null
  const flowNoshowId = argFlag('flow-noshow-id') || null
  const ativarTudo = !!flowAgendamentoId && !!flowNoshowId

  const tagRemarcado = await upsertByUniqueColumn(db, 'tags', 'name', ACCOUNT_ID, {
    name: 'Remarcado via No-show', account_id: ACCOUNT_ID, user_id: USER_ID,
  })
  const tagPerdidoNoshow = await upsertByUniqueColumn(db, 'tags', 'name', ACCOUNT_ID, {
    name: 'Perdido via No-show', account_id: ACCOUNT_ID, user_id: USER_ID,
  })
  console.log('tags:', { tagRemarcado: tagRemarcado.id, tagPerdidoNoshow: tagPerdidoNoshow.id })

  const autoUrgente = await upsertByUniqueColumn(db, 'automations', 'name', ACCOUNT_ID, {
    name: 'Urgente (Fluxo) — notificação', account_id: ACCOUNT_ID, user_id: USER_ID,
    trigger_type: 'tag_added',
    trigger_config: { tag_id: TAG_URGENTE, somente_horario_comercial: false },
    is_active: true,
  })
  await db.from('automation_steps').delete().eq('automation_id', autoUrgente.id)
  await db.from('automation_steps').insert({
    automation_id: autoUrgente.id, position: 0, parent_step_id: null, branch: null,
    step_type: 'notify',
    step_config: {
      destinatario: 'todos',
      titulo: 'Lead sinalizou urgência (Fluxo de Agendamento)',
      corpo: 'Uma reunião em andamento no Fluxo de Agendamento recebeu sinal de urgência — vale olhar a conversa.',
      tipo: 'urgent_lead',
    },
  })

  const autoIniciaNoshow = await upsertByUniqueColumn(db, 'automations', 'name', ACCOUNT_ID, {
    name: 'Fluxo No-show — inicia', account_id: ACCOUNT_ID, user_id: USER_ID,
    trigger_type: 'deal_stage_changed',
    // somente_horario_comercial nao se aplica a deal_stage_changed (o
    // motor so le esse campo pra tag_added) — risco aceito e
    // documentado, achado #13.
    trigger_config: { stage_id: STAGE_FOLLOWUP_NOSHOW, pipeline_id: PIPELINE_VENDAS },
    // ⚠️ F2 (gate Task 0): NUNCA `ativarTudo` — este trigger
    // (deal_stage_changed na MESMA etapa/pipeline) é idêntico ao da
    // automação antiga "Follow up No-show — 3 toques e encerra"
    // (b6359cda-...), que fica ATIVA de propósito até a Task 15 (achado
    // RISK-9). Ativar os dois juntos faz TODO card novo entrando em
    // "Follow up No-show" a partir de hoje disparar os 3 toques antigos
    // E os 3 toques do Fluxo novo ao mesmo tempo — mesmo lead, duas
    // sequências de mensagem. Fica sempre `false` aqui; a ativação real
    // é um passo à parte na Task 15, no MESMO momento em que `b6359cda`
    // é desativada (nunca os dois ativos juntos).
    is_active: false,
  })
  await db.from('automation_steps').delete().eq('automation_id', autoIniciaNoshow.id)
  await db.from('automation_steps').insert({
    automation_id: autoIniciaNoshow.id, position: 0, parent_step_id: null, branch: null,
    step_type: 'start_flow',
    step_config: { flow_id: flowNoshowId || '' },
  })

  const autoRemarcado = await upsertByUniqueColumn(db, 'automations', 'name', ACCOUNT_ID, {
    name: 'Remarcado via No-show (Fluxo) — reinicia Agendamento', account_id: ACCOUNT_ID, user_id: USER_ID,
    trigger_type: 'tag_added',
    // ESTE respeita somente_horario_comercial (tag_added, o unico
    // trigger_type que o motor confere) — true, achado #13.
    trigger_config: { tag_id: tagRemarcado.id, somente_horario_comercial: true },
    is_active: ativarTudo,
  })
  await db.from('automation_steps').delete().eq('automation_id', autoRemarcado.id)
  await db.from('automation_steps').insert({
    automation_id: autoRemarcado.id, position: 0, parent_step_id: null, branch: null,
    step_type: 'start_flow',
    step_config: { flow_id: flowAgendamentoId || '' },
  })

  const autoPerdidoNoshow = await upsertByUniqueColumn(db, 'automations', 'name', ACCOUNT_ID, {
    name: 'Perdido via No-show (Fluxo) — move para Perdido', account_id: ACCOUNT_ID, user_id: USER_ID,
    trigger_type: 'tag_added',
    trigger_config: { tag_id: tagPerdidoNoshow.id, somente_horario_comercial: false },
    is_active: true,
  })
  await db.from('automation_steps').delete().eq('automation_id', autoPerdidoNoshow.id)
  await db.from('automation_steps').insert({
    automation_id: autoPerdidoNoshow.id, position: 0, parent_step_id: null, branch: null,
    step_type: 'move_deal',
    step_config: { stage_id: STAGE_PERDIDO, pipeline_id: PIPELINE_VENDAS, status: 'lost' },
  })

  // "Perdeu Confirmacao": move_deal na posicao 0, send_template na 1 —
  // ORDEM INVERTIDA de proposito (achado bloqueante #3): um throw no
  // send_template (template ainda nao aprovado, ver Task 9) NAO pode
  // impedir o card de mover, porque executeStepsFrom interrompe tudo
  // que vem DEPOIS do passo que lancou o erro.
  await db.from('automation_steps').delete().eq('automation_id', AUTOMATION_PERDEU_CONFIRMACAO)
  await db.from('automation_steps').insert([
    {
      automation_id: AUTOMATION_PERDEU_CONFIRMACAO, position: 0, parent_step_id: null, branch: null,
      step_type: 'move_deal',
      step_config: { stage_id: '8bd228cf-fba4-4b28-b704-068bdcfa7c8d', pipeline_id: PIPELINE_VENDAS },
    },
    {
      automation_id: AUTOMATION_PERDEU_CONFIRMACAO, position: 1, parent_step_id: null, branch: null,
      step_type: 'send_template',
      // variables:{} EXPLICITO (achado bloqueante #4) — sem isso o
      // engine faz auto-fill de {1:'{{nome}}'} e a Meta rejeita
      // (#132000) porque este template nao tem {{1}}.
      step_config: { template_name: 'horario_liberado_sem_confirmacao', variables: {} },
    },
  ])

  console.log('automações:', {
    autoUrgente: autoUrgente.id, autoIniciaNoshow: autoIniciaNoshow.id,
    autoRemarcado: autoRemarcado.id, autoPerdidoNoshow: autoPerdidoNoshow.id,
    perdeuConfirmacao: AUTOMATION_PERDEU_CONFIRMACAO,
  })

  // ⚠️ RISK-9 (4ª auditoria): as duas ações abaixo eram UMA SÓ (`ativarTudo`)
  // numa versão anterior — ligar as automações novas E desligar a "Follow
  // up No-show antiga" no mesmo flip. Isso presumia que a Task 15
  // (migração das 37 reuniões já agendadas, INCLUINDO os 13 leads que
  // estão HOJE nessa etapa) rodaria junto. Como a Task 15 foi adiada
  // (Blocker 3, 4ª auditoria — decisão do titular, ver nota "NÃO EXECUTAR
  // HOJE" na Task 15), desligar essa automação agora tiraria a ÚNICA
  // cobertura real desses 13 leads sem colocar nada no lugar — exatamente
  // o tipo de "automação some, cobertura zero, sem ninguém perceber" que
  // motivou toda esta rodada de correções. Por isso as duas ações são
  // INDEPENDENTES agora: a nova automação liga (novos leads, a partir de
  // hoje, passam pelo Fluxo), a antiga continua ligada até a Task 15
  // rodar de verdade e migrar quem já está nela.
  if (ativarTudo) {
    await db.from('automations').update({ is_active: true }).in('id', [AUTOMATION_AGENDOU, AUTOMATION_PERDEU_CONFIRMACAO])
    console.log('ativação aplicada: Agendou + Perdeu Confirmação ON.')
    console.log('⛔ Follow up No-show antiga (' + AUTOMATION_FOLLOWUP_NOSHOW_ANTIGA + ') NAO foi desativada — ' +
      'continua cobrindo os 13 leads reais que já estão nessa etapa até a Task 15 (migração) rodar. ' +
      'Desativar isso ANTES da migração real deixaria essas 13 pessoas sem cobertura nenhuma.')
  } else {
    console.log('flow_id ainda não informado — automações start_flow criadas com is_active:false.')
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
