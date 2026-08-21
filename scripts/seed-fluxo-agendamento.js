const { seedClient, upsertByUniqueColumn, garantirSemRunAtivo } = require('./lib/seed-client')

const ACCOUNT_ID = '2569c0e9-5f2e-4d04-957c-e2f158e7a87e'
const USER_ID = 'be874c16-32b2-46c2-b5fa-45097dc62ff1'
const TAG_URGENTE = '9db3b56e-eecf-4b29-bace-2cc034b38f72'
const TAG_AGENDOU = 'c0278b4c-8f17-416e-a7e4-b66b6e78315a'
const TAG_PERDEU_CONFIRMACAO = '19b12e9b-79c8-4a3d-812b-bcdbeef3e16b'

const PALAVRAS_REAGENDAR = { keywords: ['remarcar', 'reagendar', 'cancelar'], match_type: 'contains' }
const PALAVRAS_URGENCIA = {
  keywords: ['urgente', 'prazo', 'bloqueada', 'bloqueado', 'processo', 'citação', 'citacao', 'sim'],
  match_type: 'contains',
}

async function main() {
  const db = seedClient()

  const { data: existente } = await db.from('flows').select('id').eq('name', 'Fluxo de Agendamento').eq('account_id', ACCOUNT_ID).maybeSingle()
  await garantirSemRunAtivo(db, existente ? existente.id : null)

  const flow = await upsertByUniqueColumn(db, 'flows', 'name', ACCOUNT_ID, {
    name: 'Fluxo de Agendamento',
    account_id: ACCOUNT_ID,
    user_id: USER_ID,
    description: 'Canal A (Márcia): oferece horário, reserva, confirma, pergunta urgência, lembra, cancela por falta de confirmação. Entrada via [[AGENDAR]] em auto-reply.ts, usando startManualFlowRun.',
    status: 'active',
    trigger_type: 'manual',
    trigger_config: {},
    entry_node_id: null,
    // on_timeout_hours = 1200 (50 dias) — cobre o horizonte de 45 dias
    // do Cal.com com margem; 72h (valor original) matava o run de
    // qualquer reunião marcada com mais de 3 dias de antecedência
    // (achado bloqueante #2).
    //
    // on_unknown_reply = 'ignore' (achado NEW-9 da 2ª auditoria, não
    // 'reprompt') — com 'reprompt', QUALQUER mensagem do lead que não
    // bata com um botão/palavra-chave enquanto o Fluxo está ativo
    // (até 45 dias, do agendamento até a reunião) é ENGOLIDA: a Márcia
    // fica muda, e depois de 2 tentativas o run passa pra 'handoff' e
    // TODOS os lembretes restantes morrem junto. Com 'ignore', a
    // mensagem que não bate simplesmente NÃO é consumida pelo Fluxo —
    // cai pra Márcia normalmente, como se o Fluxo não existisse pra
    // aquele texto — enquanto os prazos do próprio Fluxo (agora todo
    // nó suspensivo tem `timeout`, ver Tasks 4 e 5) continuam
    // valendo e disparando sozinhos, sem depender de reprompt algum.
    fallback_policy: { on_unknown_reply: 'ignore', max_reprompts: 0, on_timeout_hours: 1200, on_exhaust: 'handoff' },
  })

  await db.from('flow_nodes').delete().eq('flow_id', flow.id)

  const nodes = [
    { node_key: 'start', node_type: 'start', config: { next_node_key: 'offer_slots' } },
    {
      node_key: 'offer_slots', node_type: 'offer_slots',
      config: {
        prompt_text: 'Encontrei estes horários disponíveis pra sua reunião:',
        button_label: 'Ver horários',
        result_var_key: 'horario_escolhido',
        next_node_key: 'book_meeting',
        no_slots_next_node_key: 'handoff_sem_horario',
      },
    },
    {
      node_key: 'book_meeting', node_type: 'book_meeting',
      config: {
        slot_var_key: 'horario_escolhido',
        email_var_key: 'email_capturado',
        success_next_node_key: 'confirmar',
        failure_next_node_keys: {
          indisponivel: 'offer_slots',
          sem_email: 'pedir_email',
          email_invalido: 'pedir_email_invalido',
          recusado: 'handoff_recusado',
          generico: 'handoff_generico',
        },
      },
    },
    {
      node_key: 'pedir_email', node_type: 'collect_input',
      config: {
        prompt_text: 'Pra eu deixar sua reunião confirmada, preciso do seu e-mail — é pra lá que vai o convite com o link da videochamada. Pode me passar?',
        var_key: 'email_capturado', next_node_key: 'book_meeting',
      },
    },
    {
      node_key: 'pedir_email_invalido', node_type: 'collect_input',
      config: {
        prompt_text: 'Esse e-mail não está recebendo mensagens — deve ter escapado um errinho de digitação.\n\nPode conferir e me mandar de novo? É para lá que vai o convite da videochamada.',
        var_key: 'email_capturado', next_node_key: 'book_meeting',
      },
    },
    { node_key: 'handoff_sem_horario', node_type: 'handoff', config: { note: 'Fluxo de Agendamento: sem horário livre no Cal.com.' } },
    { node_key: 'handoff_recusado', node_type: 'handoff', config: { note: 'Fluxo de Agendamento: Cal.com recusou a reserva.' } },
    { node_key: 'handoff_generico', node_type: 'handoff', config: { note: 'Fluxo de Agendamento: falha genérica ao reservar (Cal.com fora do ar / config ausente).' } },
    {
      // Achado ao vivo, 21/08/2026 (primeiro teste ponta a ponta real):
      // era `send_buttons` perguntando "Confirmar presença" segundos
      // depois de a pessoa ter acabado de ESCOLHER o horário — pedir
      // confirmação de novo, na hora, não fazia sentido nenhum (a escolha
      // do slot JÁ É a confirmação). A confirmação de verdade — a que
      // importa, porque libera o horário pra outro cliente se não vier —
      // já existe mais adiante, 18h antes da reunião (`lembrete_vespera`).
      // Este nó virou só um recibo informativo, sem pergunta nenhuma; o
      // botão "Preciso reagendar" que existia aqui saiu (rota órfã depois
      // dessa mudança — `aviso_reagendar`/`cancelar_para_reagendar` já
      // seguem cobertos pelo ciclo de véspera, via `aviso_reagendar_vespera`).
      node_key: 'confirmar', node_type: 'send_message',
      config: {
        text: 'Prontinho! Sua reunião ficou marcada para {{vars.booking_rotulo}}. Você vai receber um lembrete próximo da data.',
        next_node_key: 'perguntar_urgencia',
      },
    },
    { node_key: 'cancelar_para_reagendar', node_type: 'cancel_meeting', config: { next_node_key: 'offer_slots' } },
    {
      // timeout (achado NEW-5 da 2ª auditoria — Task 5 dá ao
      // collect_input a mesma capacidade de timeout que send_buttons
      // já tem desde a Task 4): sem isto, quem não responde a pergunta
      // opcional de urgência travava o run pra sempre — sem tag
      // Agendou, sem card movido, sem nenhum lembrete de véspera/1h.
      // Ignorar uma pergunta aberta é o caso COMUM, não a exceção.
      // Silêncio aqui é tratado como "sem urgência" — pula direto pro
      // ciclo de agendamento, sem passar por checar_urgencia (não há
      // urgencia_texto nenhum pra checar). sooner_of_hours_or_var pelo
      // mesmo motivo do nó `confirmar` acima (achado R2).
      node_key: 'perguntar_urgencia', node_type: 'collect_input',
      config: {
        // Achado ao vivo, 21/08/2026: não explicitar nome de advogado
        // específico aqui — "a equipe", não "o Dr. Zelmo e a Dra. Maria".
        prompt_text: 'Show, já ficou confirmado! Só mais uma coisa antes de eu deixar você à vontade: existe alguma urgência no seu caso — conta bloqueada, processo já em andamento, prazo correndo?\n\nSe tiver, me conta aqui que já vou avisar a equipe pra chegar preparada. Se não, pode só me dizer "não" que sigo por aqui.',
        var_key: 'urgencia_texto', next_node_key: 'checar_urgencia',
        // margin_minutes: 60 (REAL-BUG-7, 4ª auditoria) — mesmo motivo do nó `confirmar` acima.
        timeout: { until: { mode: 'sooner_of_hours_or_var', hours: 24, var_key: 'booking_inicio_iso', margin_minutes: 60 }, next_node_key: 'limpar_agendou' },
      },
    },
    {
      node_key: 'checar_urgencia', node_type: 'condition',
      config: {
        subject: 'var', subject_key: 'urgencia_texto', operator: 'keyword_match',
        keywords: PALAVRAS_URGENCIA, true_next: 'limpar_urgente', false_next: 'limpar_agendou',
      },
    },
    // Cada tag-ponte ganha um "remove" imediatamente antes do "add" —
    // contact_tags tem UNIQUE(contact_id,tag_id), reaplicar uma tag já
    // presente NÃO gera INSERT, e é o INSERT que acorda a automação
    // via webhook. Sem isto, um lead que passa pelo Fluxo 2 vezes fica
    // em silêncio na 2ª (achado real #9).
    { node_key: 'limpar_urgente', node_type: 'set_tag', config: { mode: 'remove', tag_id: TAG_URGENTE, next_node_key: 'marcar_urgente' } },
    { node_key: 'marcar_urgente', node_type: 'set_tag', config: { mode: 'add', tag_id: TAG_URGENTE, next_node_key: 'avisar_urgencia' } },
    {
      // Achado ao vivo, 21/08/2026: a tag Urgente acende a notificação
      // interna (equipe avisada) mas ninguém dizia nada de volta pro
      // lead — ele ficava sem saber se foi ouvido. Este nó fecha esse
      // vazio antes de seguir pro resto da cadeia de tags.
      node_key: 'avisar_urgencia', node_type: 'send_message',
      config: {
        text: 'Já avisei a equipe sobre a urgência do seu caso — pode aguardar que vamos te chamar em breve.',
        next_node_key: 'limpar_agendou',
      },
    },
    { node_key: 'limpar_agendou', node_type: 'set_tag', config: { mode: 'remove', tag_id: TAG_AGENDOU, next_node_key: 'marcar_agendou' } },
    { node_key: 'marcar_agendou', node_type: 'set_tag', config: { mode: 'add', tag_id: TAG_AGENDOU, next_node_key: 'checar_prazo_curto' } },
    {
      // Achado NEW-4 da 2ª auditoria: uma reunião marcada com poucas
      // horas de antecedência (o Cal.com oferece horário no MESMO
      // dia) não pode passar pelo ciclo de véspera — "sua reunião é
      // amanhã" fica errado, e o timeout de cancelamento de
      // lembrete_vespera (2h antes) pode vencer minutos depois de o
      // lead ter acabado de confirmar em `confirmar`. Reunião a menos
      // de 20h de distância pula direto pro ciclo de 1h antes.
      node_key: 'checar_prazo_curto', node_type: 'condition',
      config: {
        subject: 'var', subject_key: 'booking_inicio_iso', operator: 'hours_until_lt',
        value: '20', true_next: 'esperar_1h', false_next: 'esperar_vespera',
      },
    },
    {
      node_key: 'esperar_vespera', node_type: 'wait',
      config: {
        unit: 'hours', amount: 18, next_node_key: 'lembrete_vespera',
        until: { mode: 'before_var', var_key: 'booking_inicio_iso', hours_before: 18 },
        keyword_branches: [{ trigger: PALAVRAS_REAGENDAR, next_node_key: 'aviso_reagendar_vespera' }],
      },
    },
    {
      node_key: 'aviso_reagendar_vespera', node_type: 'send_message',
      config: { text: 'Sem problema! Vou liberar esse horário e já te mostro outras opções.', next_node_key: 'cancelar_para_reagendar' },
    },
    {
      // Texto ajustado (achado NEW-4) — não afirma mais "é amanhã":
      // esperar_vespera já garante que este nó só é alcançado por
      // reuniões com >=20h de antecedência quando disparado no prazo
      // normal, mas o `until` ainda pode resolver pra "agora" se o
      // sweep atrasar por qualquer motivo operacional — texto que não
      // cita um dia específico nunca fica errado.
      node_key: 'lembrete_vespera', node_type: 'send_buttons',
      config: {
        text: 'Passando pra lembrar da sua reunião, {{vars.booking_rotulo}}.\n\nSe eu não tiver sua confirmação, vou liberar esse horário em breve para outro cliente que está esperando — prefiro muito mais te ver na reunião, mas preciso saber.\n\nPode confirmar por aqui?',
        buttons: [
          { reply_id: 'confirmar_presenca', title: 'Confirmar presença', next_node_key: 'esperar_1h' },
          { reply_id: 'preciso_reagendar', title: 'Preciso reagendar', next_node_key: 'aviso_reagendar_vespera' },
        ],
        // before_var, NÃO end_of_business_day — garante por construção
        // que o cancelamento acontece ANTES da reunião, mesmo quando o
        // lembrete de véspera dispara à noite (ver nota de produto
        // acima do script).
        timeout: { until: { mode: 'before_var', var_key: 'booking_inicio_iso', hours_before: 2 }, next_node_key: 'cancelar_sem_confirmacao' },
      },
    },
    {
      node_key: 'esperar_1h', node_type: 'wait',
      config: {
        unit: 'hours', amount: 1, next_node_key: 'lembrete_1h',
        until: { mode: 'before_var', var_key: 'booking_inicio_iso', hours_before: 1 },
        keyword_branches: [{ trigger: PALAVRAS_REAGENDAR, next_node_key: 'aviso_reagendar_vespera' }],
      },
    },
    {
      node_key: 'lembrete_1h', node_type: 'send_message',
      config: { text: 'Já já é a hora! Sua reunião é daqui a 1 hora, {{vars.booking_rotulo}}.\n\nAté já!', next_node_key: 'esperar_horario' },
    },
    {
      node_key: 'esperar_horario', node_type: 'wait',
      config: {
        unit: 'hours', amount: 1, next_node_key: 'fim_compareceu',
        until: { mode: 'before_var', var_key: 'booking_inicio_iso', hours_before: 0 },
      },
    },
    { node_key: 'fim_compareceu', node_type: 'end', config: {} },
    { node_key: 'cancelar_sem_confirmacao', node_type: 'cancel_meeting', config: { next_node_key: 'remover_tag_agendou' } },
    { node_key: 'remover_tag_agendou', node_type: 'set_tag', config: { mode: 'remove', tag_id: TAG_AGENDOU, next_node_key: 'limpar_perdeu_confirmacao' } },
    { node_key: 'limpar_perdeu_confirmacao', node_type: 'set_tag', config: { mode: 'remove', tag_id: TAG_PERDEU_CONFIRMACAO, next_node_key: 'marcar_perdeu_confirmacao' } },
    { node_key: 'marcar_perdeu_confirmacao', node_type: 'set_tag', config: { mode: 'add', tag_id: TAG_PERDEU_CONFIRMACAO, next_node_key: 'fim_perdeu_confirmacao' } },
    { node_key: 'fim_perdeu_confirmacao', node_type: 'end', config: {} },
  ]

  const inserted = await db.from('flow_nodes').insert(
    nodes.map((n) => ({ ...n, flow_id: flow.id, position_x: 0, position_y: 0 })),
  ).select('id, node_key')
  if (inserted.error) throw new Error(`insert flow_nodes: ${inserted.error.message}`)
  const startNode = inserted.data.find((n) => n.node_key === 'start')
  // entry_node_id GUARDA O node_key (TEXT), NÃO o id (UUID) do node.
  await db.from('flows').update({ entry_node_id: startNode.node_key }).eq('id', flow.id)

  console.log('Fluxo de Agendamento id:', flow.id, '| total de nós:', nodes.length)
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
