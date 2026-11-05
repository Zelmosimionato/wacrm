// Márcia v2/3.0 — FONTE ÚNICA das mensagens fixas ao lead (textos aprovados pelo titular, copiados do código atual).
// Editar texto = editar SÓ este arquivo. Nenhum outro lugar do módulo escreve texto ao lead.
// (Tudo o que a Márcia conversa livremente mora nas instruções da plataforma; aqui só entra o que precisa ser exato.)
export const AGENDA_LINK = 'https://cal.com/simionato-advogados-n4sm0p/45min'
const BLOG = 'https://simionatoadvogados.com.br/blog/'
const MATERIAIS = 'https://simionatoadvogados.com.br/materiais-gratuitos/'

export const MENSAGENS = {
  /** Total abaixo do corte (RCPCC, GPIX, GPASS, DEF e sem produto). */
  recusa_piso:
    'Entendi. Pelas informações que você me passou, infelizmente o seu caso não se enquadra no perfil de atendimento que estamos trabalhando neste momento.\n\nComo trabalhamos com processos judiciais, precisamos considerar os custos envolvidos em relação aos benefícios que podem ser obtidos. No seu caso, esses custos podem não compensar, tornando a medida judicial economicamente inviável.\n\nMas agradecemos muito o seu contato. Estaremos sempre de portas abertas caso futuramente precise nos procurar novamente.\n\nMas você não fica sem nada: no nosso blog e nos materiais gratuitos tem bastante coisa que ajuda. Blog: ' +
    BLOG +
    ' · Materiais: ' +
    MATERIAIS,
  /** Desbloqueio de Conta abaixo de R$ 3 mil (recusa suave). */
  recusa_dbc:
    'Entendi, e sinto muito pelo transtorno de ter a conta bloqueada.\n\n' +
    'Como trabalhamos com processos judiciais, precisamos olhar os custos em relação ao benefício. No seu caso, um processo judicial ficaria mais caro do que o ganho que você teria, então não compensaria para você.\n\n' +
    'A porta continua aberta: se surgir qualquer novidade sobre o bloqueio, é só me chamar por aqui.\n\n' +
    'Enquanto isso, deixo conteúdos que podem ajudar você a entender seus direitos. Blog: ' +
    BLOG +
    ' · Materiais: ' +
    MATERIAIS,
  /** Passagem à equipe com acolhimento. */
  acolhimento_equipe: 'Entendi. Vou chamar alguém da nossa equipe para continuar o atendimento por aqui, só um instante.',
  /** Valor ainda não informado (RCPCC, GPIX, GPASS, DEF): pergunta aberta, sem citar corte. */
  perguntar_total: 'Para eu te orientar certinho, qual o valor total aproximado das suas dívidas?',
  /** Desbloqueio de Conta: valor ausente ou vago. */
  perguntar_valor_dbc: 'Para eu entender direitinho o seu caso, qual foi o valor exato que o banco bloqueou?',
  pedir_email:
    'Para eu já deixar a sua reunião confirmada, preciso do seu e-mail — é para lá que vai o convite com o link da videochamada.\n\nPode me passar, por gentileza?',
  pedir_nome: 'Para eu já deixar a sua reunião confirmada, me confirma o seu nome completo, por gentileza?',
  email_invalido:
    'Esse e-mail não está recebendo mensagens — deve ter escapado um errinho de digitação.\n\nPode conferir e me mandar de novo? É para lá que vai o convite da videochamada.',
  horario_tomado:
    'Esse horário acabou de ser reservado, me desculpe.\n\nVocê consegue escolher outro por aqui — o que aparecer na tela está livre de verdade: ' +
    AGENDA_LINK,
  falha_reserva:
    'Não consegui concluir a reserva por aqui agora.\n\nPara você não ficar esperando, é só reservar o melhor horário neste link: ' +
    AGENDA_LINK,
  ja_tem_reuniao: 'Você já tem uma reunião marcada com a gente — vou cuidar da alteração do horário e te confirmo por aqui, tudo bem?',
  confirmar_horario: 'Só para eu não errar: me confirma qual horário você prefere que eu já deixo reservado?',
  /** Último recurso quando a saída do modelo é inutilizável. */
  texto_seguro: 'Só para eu te ajudar do jeito certo: pode me contar, com suas palavras, o que está acontecendo?',
  porta_aberta_texto: 'Se mudar de ideia, é só acessar o link abaixo e escolher o melhor horário. Fico à disposição! 😊',
  porta_aberta_botao: 'Se mudar de ideia, é só tocar no botão abaixo e escolher o melhor horário. Fico à disposição! 😊',
} as const

export type ChaveMensagem = keyof typeof MENSAGENS
