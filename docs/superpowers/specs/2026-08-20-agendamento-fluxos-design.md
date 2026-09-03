# Reformulação do ciclo de reunião — SDR (IA) + Fluxos nativos

**Data:** 20/08/2026 (revisado no mesmo dia, várias vezes, conforme a fundação do motor + os 3
nós de Cal.com entraram em produção e a conversa foi achando peças que faltavam)
**Autor:** Claude Code, com o titular (Dr. Zelmo Simionato)
**Status:** aprovado — fundação (`wait`) e os 3 nós (`offer_slots`/`book_meeting`/
`cancel_meeting`) já implementados e no ar. Este documento fecha o desenho do GRAFO real (como
as ações se compõem, quem é responsável por cada uma) antes de virar plano de implementação.

## Terminologia — convenção usada daqui pra frente neste documento

Por pedido do titular (20/08): descrever pelas AÇÕES que de fato acontecem, não pelo nome da
etapa do funil (etapa é config, muda — ver "Mudança de etapa visual" mais abaixo). Todo passo
carrega uma marca dizendo QUEM é responsável:

- **[FLUXO]** — nó do motor de Fluxos (`src/lib/flows/*`), dono de um ciclo de vida
  conversacional, com branch vivo por resposta do cliente.
- **[AUTOMAÇÃO]** — régua do motor de Automações (`src/lib/automations/*`), disparada por
  trigger (tag, etapa, tempo), sem branch por resposta do cliente.
- **[EXTERNO]** — código fora do wacrm (o script `intake.js`, rodando via pm2 na VPS,
  separado do repositório do CRM).

## Motivação

No mesmo dia (20/08/2026), múltiplos defeitos de produção e de desenho foram achados com a
MESMA raiz: mais de um sistema mexendo no estado de uma reunião sem se enxergar.

1. **Automação "Superqualificado" disparando pra quem não deveria** — o motor de automações
   tinha um `trigger_type: tag_added` sem filtro real por tag (corrigido nesta sessão).
2. **Lembrete de véspera duplicado, ignorando pedido de reagendamento** — existiam DOIS
   sistemas de lembrete rodando ao mesmo tempo: a Automação "Reunião Agendada — lembrete
   véspera/1h antes" e um relógio de 60s embutido no boot do servidor
   (`lib/reminders/dispatch.ts`, com sua própria trava separada, que já tinha causado 417
   envios duplicados pra 3 clientes em 09/08/2026). O relógio de 60s foi desligado nesta sessão.
3. **`intake.js` (script EXTERNO na VPS) já carrega a cicatriz do mesmo bug**: um comentário no
   próprio arquivo (datado de 12/08/2026) descreve que a confirmação de agendamento chegou a
   ser disparada tanto pelo código do intake quanto pela Automação ao mesmo tempo, mandando a
   confirmação em dobro — corrigido então fazendo SÓ a Automação confirmar. É o padrão se
   repetindo: pedaço de lógica vivendo fora da tela, sem o resto do sistema saber que ele existe.
4. **No-show crescendo** (relatado pelo titular, 20/08, sem número exato — impressão de piora
   recente) — motivo direto do mecanismo de cancelamento-por-falta-de-confirmação e do botão de
   confirmação explícita abaixo: parar de segurar agenda com reunião que não vai acontecer, e
   liberar o horário a tempo de um lead de verdade ocupá-lo.

O padrão que se repete — inclusive em sessões anteriores (a IA dizendo "confirmado" sem ter
confirmado; um sistema de Fluxos construído e nunca ativado enquanto "Automações" crescia em
paralelo) — é **trabalho feito pela metade**: peça nova criada sem desligar a antiga, ou sem
terminar de integrar. Este documento é o desenho de ponta a ponta pedido pelo titular pra não
repetir o padrão desta vez — desta vez cobrindo os DOIS canais de entrada de agendamento, não
só o que passa pela IA.

## Princípio de arquitetura

> Um [FLUXO] é o único dono do estado de um ciclo de vida de reunião. Nenhum outro sistema
> ([AUTOMAÇÃO], script [EXTERNO], ou a IA generativa) toca nesse estado por fora.

- **A IA (Márcia) é SDR, não agendadora.** Qualifica, responde objeção, tira dúvida, decide
  quando o lead está pronto pra reunião — e entrega o bastão **inteiro** ao [FLUXO] de
  Agendamento nesse momento. Sai do `auto-reply.ts` toda a mecânica de reserva: `criarReserva`,
  `cancelCalcomBooking`, `horariosLivres`, e a pilha de textos defensivos (`FALTA_EMAIL`,
  `FALTA_NOME`, `EMAIL_NAO_RECEBE`, `HORARIO_TOMADO`, `FALHA_AGENDA`) — essas viram conteúdo de
  nó do [FLUXO], não texto gerado por modelo tentando adivinhar se a reserva deu certo.
- **Bastão total, não supervisão.** Enquanto o [FLUXO] de Agendamento está ativo para um
  contato, só ele fala com esse contato. Se o cliente sair do roteiro, o próprio [FLUXO]
  devolve o bastão (`fallback_policy`, já existe no motor).
- **Dois canais de entrada, um só dono depois que a reserva existe.** Uma reunião pode nascer
  de dois jeitos — a Márcia conduz dentro do WhatsApp, ou o lead agenda sozinho numa página
  pública do Cal.com (canal Meta-form → Cal.com direto, hoje mediado pelo script [EXTERNO]
  `intake.js`). A PARTIR do momento que a reserva existe, os dois convergem pro MESMO [FLUXO]
  — ver "Os dois canais convergindo" abaixo. Isso é novo nesta revisão: as versões anteriores
  deste documento só cobriam o canal da Márcia.
- **Toda capacidade nova é código do motor do CRM** (`src/lib/flows/*`, `src/lib/automations/*`),
  nunca um script/rota paralela fora do wacrm. Regra dura, não preferência — foi assim que o
  relógio zumbi e o `intake.js` aconteceram: capacidade que devia estar na tela virou script
  solto. O `intake.js` precisa mudar nesta revisão (ver seção própria) — não pra virar código
  do wacrm (ele continua sendo quem recebe o webhook do Cal.com, isso não muda), mas pra parar
  de tomar decisão de negócio sozinho e só acordar o [FLUXO] que decide.

## O que falta no motor de Fluxos (status ao fechar este documento)

O motor de Fluxos (`lib/flows/engine.ts`) tem hoje: `start`, `send_message`, `send_buttons`,
`send_list`, `send_media`, `collect_input`, `wait`, `offer_slots`, `book_meeting`,
`cancel_meeting`, `condition`, `set_tag`, `handoff`, `end` — todos já em produção. Falta só:

1. **`condition` ganhar o operador `keyword_match`** — hoje só tem `contains` contra UM valor;
   precisa casar contra uma LISTA de palavras-chave (mesmo `matchesKeywordTrigger`/
   `KeywordTriggerConfig` que o `wait` já usa). Pequena extensão, mesmo padrão de hoje.
2. **Uma forma de iniciar um [FLUXO] sem mensagem de entrada real** — hoje `startNewRun` (motor)
   só inicia a partir de uma mensagem inbound real batendo um trigger. Precisa de uma variante
   exportada (`startManualFlowRun` ou nome equivalente) que a Márcia (ao detectar
   `[[AGENDAR]]`) e o endpoint novo que o `intake.js` vai chamar possam usar os DOIS — mesmo
   [FLUXO] de pós-reserva, dois pontos de entrada diferentes.

Nenhum dos dois é infraestrutura nova do zero — são extensões pequenas do motor que já existe.

## Custo de mensagens (Meta) — princípio que atravessa todo o desenho abaixo

Desde nov/2024 a Meta tornou as "conversas de serviço" (dentro da janela de 24h aberta quando o
CONTATO manda mensagem primeiro) **grátis e ilimitadas**. Toda mensagem business-iniciada FORA
dessa janela — como um lembrete mandado dias depois, sem interação nenhuma no meio — volta a
cobrar (template pago, precisa estar pré-aprovado pela Meta).

**Princípio adotado:** toda mensagem do [FLUXO] que puder pedir uma resposta curta (botão, de
preferência — toque de botão conta como interação do contato) deve pedir, mesmo quando o
conteúdo principal é só um aviso. Cada resposta reabre a janela de 24h grátis para a PRÓXIMA
mensagem.

**Correção desta revisão** (achada olhando os diagramas com o titular): isso NÃO garante que
toda mensagem do [FLUXO] seja grátis — a mensagem de "horário liberado" (mandada quando o lead
ficou EM SILÊNCIO até o prazo de confirmação vencer) é, por definição, mandada depois de um
período sem nenhuma interação — a janela provavelmente já fechou. Essa mensagem específica
precisa ser um **template pré-aprovado**, não texto livre. Marcado na seção de mensagens abaixo.

## Os dois canais convergindo

**Canal A — Márcia conduz no WhatsApp:**
1. Márcia qualifica o lead na conversa (IA, já em produção).
2. Márcia detecta o marcador `[[AGENDAR]]` (novo) — só disponível depois que o lead já está
   qualificado (tag "Qualificado" ou "Superqualificado" presente; checagem em código, não só
   confiança no prompt).
3. `[[AGENDAR]]` aciona `startManualFlowRun` — **[FLUXO] de Agendamento** começa a partir do
   nó `offer_slots`.

**Canal B — lead agenda sozinho no Cal.com (Meta-form → página pública):**
1. Lead agenda direto no Cal.com, sem falar com a Márcia antes.
2. O Cal.com dispara um webhook já configurado (confirmado com o titular, 20/08) pra
   `https://crm.simionatoadvogados.com.br/intake/calcom` — eventos "Reserva Criada", "Reserva
   Reagendada", "Reserva cancelada".
3. **[EXTERNO]** `intake.js` recebe o webhook. HOJE: pra "Reserva Criada"/"Reagendada", chama
   `fireStageAutomation(contactId, STAGE_REUNIAO)` — move o card direto pra etapa "Reunião
   Agendada", o que dispara 3 **[AUTOMAÇÃO]** antigas presas nessa etapa (confirmação, lembrete
   véspera, lembrete 1h antes). **Isto muda nesta revisão**: o handler de "Reserva Criada"/
   "Reagendada" passa a chamar um endpoint novo do wacrm (mesmo padrão de secret que já usa pra
   `/api/automations/engine`) que aciona `startManualFlowRun` pro **MESMO** [FLUXO] de
   pós-reserva do Canal A — só que entrando direto no ponto "reserva já existe, falta
   confirmar" (pula `offer_slots`/`book_meeting`, que já aconteceram no Cal.com). O handler de
   "Reserva cancelada" passa a acionar o `cancel_meeting`-equivalente do [FLUXO] (ou, se o
   cancelamento já veio do próprio Cal.com, só encerra o run e ajusta a tag/etapa — detalhe a
   fechar no plano de implementação).

**A partir daqui os dois canais são o MESMO [FLUXO]** — confirma presença, pergunta urgência,
lembra, cancela por falta de confirmação. Ver "Sequência de ações — pós-reserva" abaixo.

## Sequência de ações — Agendamento (Canal A, até a reserva existir)

1. **[FLUXO]** `offer_slots` — busca horário no Cal.com, manda como lista. Ordena por urgência
   se a tag "Urgente" estiver presente (ver "Sinal de urgência" abaixo).
2. **[FLUXO]** `book_meeting` — reserva o horário escolhido.
   - **Sucesso** → segue pra "Sequência de ações — pós-reserva" abaixo.
   - **Falha, motivo "indisponível"** (horário foi tomado enquanto decidia) → volta direto pro
     passo 1 (fresh fetch, sem pedir nada de novo ao lead).
   - **Falha, motivo "sem e-mail"/"e-mail inválido"/outro dado faltando** → manda o texto do
     motivo (reaproveita `FALTA_EMAIL`/`FALTA_NOME`/`EMAIL_NAO_RECEBE` de `auto-reply.ts` quase
     literal) → `collect_input` pra capturar o dado → tenta `book_meeting` de novo com o dado
     capturado. **Correção desta revisão**: antes o desenho dizia genericamente "falha volta a
     oferecer" pra qualquer motivo — errado, só "indisponível" faz sentido voltar a oferecer
     horário; os outros motivos não têm nada a ver com horário, voltar a oferecer não resolve.

## Sequência de ações — pós-reserva (Canal A e Canal B, a partir daqui é o mesmo)

1. **[FLUXO]** manda a confirmação com 2 botões: `Confirmar presença` / `Preciso reagendar`.
   - **`Preciso reagendar`** (ou palavra-chave remarcar/reagendar/cancelar) → **[FLUXO]**
     `cancel_meeting` PRIMEIRO (cancela a reserva que já existe) → volta pro `offer_slots`.
     **Correção desta revisão**: o desenho anterior pulava direto pra `offer_slots` sem
     cancelar — o lead escolheria um horário novo e ficaria com DUAS reservas na agenda, a
     antiga nunca liberada. Achado olhando o diagrama com o titular.
   - **`Confirmar presença`** → segue pro passo 2.
2. **[FLUXO]** pergunta sobre urgência (`collect_input`, texto livre — não é botão, ver "Sinal
   de urgência" abaixo pro motivo).
   - Resposta bate palavra-chave de urgência (`condition` com `keyword_match`) → **[FLUXO]**
     `set_tag` "Urgente" → dispara handoff (ver "Sinal de urgência").
   - Não bate → segue direto.
3. **[FLUXO]** `set_tag` "Agendou" → isso dispara uma **[AUTOMAÇÃO]** nova (`tag_added` →
   `move_deal`), que só existe pra mover o card visualmente — ver "Mudança de etapa visual"
   abaixo pro nome exato da etapa e por que é uma Automação separada, não o próprio [FLUXO]
   fazendo isso.
4. **[FLUXO]** aguarda até a véspera (horário comercial).
   - Palavra-chave de remarcar a qualquer momento → mesmo tratamento do passo 1 (`cancel_meeting`
     primeiro, depois `offer_slots`).
   - Sem resposta → **[FLUXO]** manda o lembrete de véspera, 2 botões (`Confirmar presença` /
     `Preciso reagendar`), com o aviso explícito de que o horário será liberado sem confirmação
     até o fim do expediente do dia.
     - `Preciso reagendar`/palavra-chave → `cancel_meeting` primeiro, depois `offer_slots`
       (mesmo tratamento).
     - `Confirmar presença` → **[FLUXO]** aguarda até 1h antes → manda o lembrete de 1h (só
       aviso, sem botão — a confirmação já aconteceu, não precisa forçar mais resposta aqui) →
       aguarda até o horário da reunião → `end` (compareceu — segue pro funil normal; humano
       move manualmente pro fluxo de No-show se o lead faltou de verdade).
     - Sem resposta até o prazo (fim do expediente da véspera) → segue pra "Cancelamento por
       falta de confirmação" abaixo.

## Cancelamento por falta de confirmação

1. **[FLUXO]** `cancel_meeting` — cancela a reserva de verdade no Cal.com.
2. **[FLUXO]** manda a mensagem avisando que o horário foi liberado. **Correção desta
   revisão**: essa mensagem é mandada justamente porque o lead ficou em silêncio — a janela de
   24h grátis provavelmente já fechou. Precisa ser **template pré-aprovado**, não texto livre
   (o desenho anterior dizia "grátis, dentro da janela" — errado).
3. **[FLUXO]** `set_tag` remove "Agendou", `set_tag` adiciona uma tag nova (nome a definir no
   plano — ex. "Perdeu Confirmação") — isso dispara uma **[AUTOMAÇÃO]** nova (`tag_added` →
   `move_deal`) que move o card direto pra etapa onde a régua de reativação já existente assume
   (ver "Mudança de etapa visual").

## Fluxo "No-show"

Substitui a automação "Follow up No-show — 3 toques e encerra". Acordado quando o titular/Dra.
Maria move o card manualmente pro estado de No-show (confirmado: **não** existe hoje detecção
automática de comparecimento — o gatilho continua sendo ação humana).

**Correção desta revisão**: são **3 toques**, não 2 — confundido com o padrão de 2 toques da
régua de reativação genérica. O nome da automação que está sendo substituída já dizia "3
toques" desde o início.

1. **[FLUXO]** (assim que o humano marca) manda o 1º toque: "quer remarcar?", 2 botões
   (`Quero remarcar` / `Não, obrigado`).
   - `Quero remarcar`/palavra-chave → volta pro `offer_slots` do [FLUXO] de Agendamento.
   - `Não, obrigado` → move pra Perdido, `end`.
   - Sem resposta, 2 dias → 2º toque (mesmos botões, mesmos ramos).
   - Sem resposta ao 2º toque, 2 dias → **3º toque** (mesmos botões, mesmos ramos).
   - Sem resposta ao 3º toque → move pra Perdido, `end`.

## Sinal de urgência

Caso concreto do titular: lead mencionou ter "execução em andamento" (prazo processual
correndo); a IA marcou a reunião no próximo horário padrão; o titular só soube da urgência
depois que o lead **cancelou e contratou outro escritório**, porque a reunião estava longe
demais.

**Desenho:**

1. **Pergunta proativa, não só detecção passiva.** Confiar só em o lead mencionar urgência por
   conta própria é raso — nem todo mundo fala. Dois pontos de pergunta explícita:
   - **Márcia (conversa livre, antes de agendar)**: checklist de qualificação ganha a pergunta
     de urgência (conta bloqueada, processo em andamento, prazo correndo, citação recebida)
     como item explícito.
   - **[FLUXO] de pós-reserva (passo 2 da sequência acima)**: mesma pergunta, texto livre —
     não botão, porque preserva o efeito do lead descrever a própria urgência com as próprias
     palavras, e ainda serve ao princípio de "sempre pedir resposta".
2. **Resposta positiva → `set_tag` "Urgente"** (mesmo mecanismo já em produção desde a Frente
   C) **→ dispara handoff IMEDIATO**, sem checar prazo de agenda — notificação interna pro
   titular/Dra. Maria (reaproveita a tabela `notifications`, já usada pelo passo `notify` das
   Automações — novo `type`; ver Migração abaixo), levando o resumo/motivo da urgência junto.
   **Alerta humano, não remanejo automático** de reunião alheia — decisão de agir continua
   sempre humana.
3. **[FLUXO]** `offer_slots` continua lendo a tag "Urgente": se presente, ordena e oferece só
   os horários mais próximos (em vez da distribuição normal).

## Mudança de etapa visual

O card precisa se mover visualmente no funil conforme a reunião avança — mas quem move é
sempre uma **[AUTOMAÇÃO]** reagindo a uma tag que o [FLUXO] marcou, nunca o [FLUXO]
diretamente (o motor de Fluxos não tem capacidade de mover etapa hoje, e não precisa ganhar —
`move_deal` já existe como passo de Automação, reaproveitar é mais barato que construir).

**Achado importante nesta revisão**: a etapa "Reunião Agendada" (que já existe) tem 3
Automações antigas grudadas nela (`tag_added`/`deal_stage_changed` → confirmação, lembrete
véspera, lembrete 1h antes) — se o [FLUXO] novo mover card pra essa MESMA etapa, essas 3
disparam por cima das mensagens do [FLUXO], reintroduzindo o problema que motivou o dia
inteiro.

**Resolução (decidida com o titular, 20/08)**: etapa nova, **"Reunião Agendada 2"**, exclusiva
do [FLUXO] — os dois canais (A e B) passam a mover card pra ela, nunca mais pra "Reunião
Agendada" antiga. As 3 Automações antigas ficam INTOCADAS, continuam servindo só as reuniões
já marcadas pelo caminho antigo (confirmado: a maior parte termina na semana seguinte a
20/08/2026, sobra pouca coisa até o fim do mês — corte rápido). Quando a Frente B (redesenho
do funil, sessão própria, ainda não feita) acontecer, "Reunião Agendada 2" se funde de volta
numa "Reunião Agendada" única, como parte natural daquele redesenho — não é retrabalho.

- **Sucesso** (passo 3 da sequência pós-reserva) → tag "Agendou" → **[AUTOMAÇÃO]** nova
  (`tag_added` "Agendou" → `move_deal` "Reunião Agendada 2").
- **Cancelamento por falta de confirmação** → tag nova (nome a definir) → **[AUTOMAÇÃO]** nova
  (`tag_added` → `move_deal` "FUP - Reativar Lead", etapa que JÁ existe, com régua de
  reativação já pronta e ativa — 2 toques, 3 dias, mesma automação "FUP - Reativar Lead — 2
  toques e encerra" de hoje, sem mudança nenhuma nela). A mensagem de "horário liberado" que o
  [FLUXO] manda antes de mover (ver "Cancelamento por falta de confirmação" acima) já cumpre o
  papel do "primeiro toque diferenciado" — a régua da FUP assume dali com os templates dela já
  aprovados, sem precisar criar template novo.

## Textos das mensagens (conteúdo dos nós `send_message`/`send_buttons`/`collect_input`)

Voz: mesma da Márcia hoje em produção (`FALTA_EMAIL`/`FALTA_NOME`/etc. em `auto-reply.ts`) —
primeira pessoa, direta, sem gíria, sem emoji. `{{...}}` marca interpolação de var do Fluxo.

**`offer_slots` — `prompt_text`:**
> Encontrei estes horários disponíveis pra sua reunião:

`button_label`: `Ver horários`

**Confirmação (`send_buttons`, texto livre):**
> Prontinho! Sua reunião ficou marcada para {{booking_rotulo}}.
>
> Preciso que você confirme sua presença — é só tocar no botão abaixo.

Botões: `Confirmar presença` (18 caract.) / `Preciso reagendar` (17 caract.) — dentro do
limite de 20 da Meta.

**Depois de "Confirmar presença" — pergunta de urgência (`collect_input`, texto livre):**
> Show, já ficou confirmado! Só mais uma coisa antes de eu deixar você à vontade: existe
> alguma urgência no seu caso — conta bloqueada, processo já em andamento, prazo correndo?
>
> Se tiver, me conta aqui que já vou avisar o Dr. Zelmo e a Dra. Maria pra chegarem
> preparados. Se não, pode só me dizer "não" que sigo por aqui.

**Depois de "Preciso reagendar" (confirmação OU lembrete de véspera) — antes de cancelar:**
> Sem problema! Vou liberar esse horário e já te mostro outras opções.

(mensagem curta, antecede o `cancel_meeting` + novo `offer_slots` — texto novo desta revisão,
cobrindo a correção do item "reagendar precisa cancelar primeiro")

**Lembrete de véspera (`send_buttons`, com o aviso de prazo):**
> Passando pra lembrar: sua reunião é amanhã, {{booking_rotulo}}.
>
> Se eu não tiver sua confirmação até o fim do expediente de hoje, vou liberar esse horário
> para outro cliente que está esperando — prefiro muito mais te ver na reunião, mas preciso
> saber.
>
> Pode confirmar por aqui?

Botões: `Confirmar presença` / `Preciso reagendar` (mesmos de antes).

**Cancelamento por falta de confirmação — horário liberado (⚠️ TEMPLATE pré-aprovado, não
texto livre — ver "Custo de mensagens" acima):**
> Como não tive sua confirmação, precisei liberar esse horário — mas fica tranquilo, é só me
> chamar quando fizer sentido pra você que eu já vejo outro horário livre.

(precisa passar pela submissão/aprovação de template da Meta antes de ir ao ar — mesmo
processo que os templates existentes da FUP já passaram)

**Lembrete de 1h antes (só aviso, sem botão — a confirmação já aconteceu):**
> Já já é a hora! Sua reunião é daqui a 1 hora, {{booking_rotulo}}.
>
> O link de acesso: {{link_reuniao}}
>
> Até já!

**`book_meeting` falha "sem e-mail"/"sem nome"/"e-mail inválido"** — reaproveita quase literal
de `auto-reply.ts` (`FALTA_EMAIL`/`FALTA_NOME`/`EMAIL_NAO_RECEBE`), adaptado pra fechar em
`collect_input` (pedir o dado) em vez de fechar a resposta:
> Pra eu deixar sua reunião confirmada, preciso do seu e-mail — é pra lá que vai o convite com
> o link da videochamada. Pode me passar?

(nome/e-mail-não-recebe seguem o mesmo padrão — mesmo texto-base de `auto-reply.ts`, só como
conteúdo de nó em vez de constante TS). Motivo "indisponível" **não** manda mensagem própria —
volta direto a `offer_slots`, que já reabre com "Encontrei estes horários...".

**Fluxo No-show — 1º toque (2 botões):**
> Oi, {{nome}}! Notei que não conseguimos nos falar na reunião marcada. Quer que eu já veja um
> novo horário pra você?

Botões: `Quero remarcar` / `Não, obrigado`

**Fluxo No-show — 2º e 3º toque (mesmos botões, textos levemente diferentes pra não soar
repetitivo):**
> 2º toque: Ainda dá tempo de remarcar, se fizer sentido pra você — é só me avisar.
> 3º toque: Última tentativa por aqui — se quiser remarcar, é só chamar quando puder.

## `intake.js` — mudança necessária [EXTERNO]

Arquivo: `/root/intake/intake.js`, rodando via pm2 na VPS (processo `intake`), SEPARADO do
repositório do wacrm. Recebe o webhook do Cal.com já configurado
(`https://crm.simionatoadvogados.com.br/intake/calcom`, eventos Reserva Criada/Reagendada/
Cancelada, confirmado ativo em 20/08/2026).

**Hoje**: handler de `BOOKING_CREATED`/`BOOKING_RESCHEDULED` chama
`fireStageAutomation(contactId, STAGE_REUNIAO)` — move o card direto pra "Reunião Agendada"
(`STAGE_REUNIAO = 'fd70e3b2-...'`), delegando toda a confirmação/lembrete às 3 Automações
antigas presas nessa etapa.

**Depois desta revisão**: o mesmo handler passa a chamar um endpoint NOVO do wacrm (mesmo
padrão de autenticação por secret compartilhado que `ENGINE_URL` já usa hoje pra
`/api/automations/engine`) que aciona `startManualFlowRun` pro [FLUXO] de pós-reserva — entrando
direto no passo 1 da sequência ("manda a confirmação com 2 botões"), pulando `offer_slots`/
`book_meeting` (que já aconteceram no Cal.com). O handler de `BOOKING_CANCELLED`/evento de
cancelamento precisa de tratamento equivalente — detalhe exato (encerrar o run existente vs.
nunca ter chegado a criar um) fica pro plano de implementação resolver olhando o código real do
handler.

⚠️ Isto é uma mudança em código FORA do repositório do wacrm, com seu próprio processo de
deploy (editar o arquivo na VPS + `pm2 restart intake`, não o build/test/deploy do Next.js) —
maior risco de superfície de teste, já que não tem a mesma suíte automatizada do wacrm ao redor.
Recomendado: implementar e validar o [FLUXO] pro Canal A (Márcia) primeiro, confirmar que o
endpoint novo funciona de ponta a ponta chamado manualmente, e só DEPOIS tocar no `intake.js` —
reduz o raio de dano se algo sair errado (Canal A continua funcionando mesmo se a mudança do
`intake.js` precisar de mais uma rodada).

## Migração de banco necessária

1. `notifications.type` — `CHECK` constraint (migração 027 + estendida em 040 pra
   `awaiting_reply`) precisa de um terceiro valor pro handoff de urgência (ex.: `urgent_lead`),
   mesmo padrão de migração que `042` já fez pra `flow_nodes.node_type` hoje. O insert
   reaproveita o mesmo shape do passo `notify` das Automações (`src/lib/automations/engine.ts`,
   case `'notify'`) — `account_id`, `user_id` (destinatário — aqui sempre "todos da conta"),
   `type`, `conversation_id`, `contact_id`, `title`, `body` (motivo/resumo da urgência).
2. `pipeline_stages` — nova linha "Reunião Agendada 2" (mesmo `pipeline_id` de "Reunião
   Agendada"/"FUP - Reativar Lead", posição a definir no plano). Não precisa de migração de
   schema — é INSERT de dado, a tabela não tem `CHECK` de nome fixo.
3. Duas Automações novas (dado, não schema): `tag_added` "Agendou" → `move_deal` "Reunião
   Agendada 2"; `tag_added` [tag nova de cancelamento] → `move_deal` "FUP - Reativar Lead".

## O que continua Automação sem mudança nenhuma

- **Superqualificado — primeiro toque** (corrigido hoje: filtro de tag + horário comercial).
- **FUP - Reativar Lead — 2 toques e encerra** (a régua que a nova tag de cancelamento vai
  acionar — nada nela muda).
- **Aguardando Decisão — ao entrar na etapa**.
- **Solicitação de Agendamento - Acessos** (ainda precisa do fallback de janela-24h no passo
  `send_message`, achado em sessão anterior, fora do escopo deste redesign).
- **Esperando resposta (na hora/2h/4h)** — aviso interno, não fala com cliente.
- **As 3 Automações da etapa "Reunião Agendada" antiga** (confirmação, lembrete véspera,
  lembrete 1h antes) — INTOCADAS, seguem servindo só reuniões já marcadas pelo caminho antigo
  até esvaziarem sozinhas (ver "Mudança de etapa visual").
- **Reagendar reunião — convite com botão** — mecanismo do NO-SHOW antigo (template
  `noshow_reagendar_botao`), sendo substituído pelo Fluxo No-show novo desta revisão.

## Rollout faseado (decidido nesta conversa, 20/08)

Cogitado e descartado: manter o `[[AGENDAR:N]]` da Márcia rodando em paralelo pro segmento PJ,
com o [FLUXO] novo só pro segmento PF. **Rejeitado** — não é "dois sistemas pra dois públicos",
é o MESMO risco do dia inteiro (dois mecanismos capazes de agir sobre o mesmo Cal.com/mesma
conversa), só reparticionado por segmento em vez de por camada. Além disso, todo ganho desta
revisão (cancelamento por falta de confirmação, pergunta de urgência proativa, handoff
imediato) ficaria de fora pra PJ — e o no-show crescente não é problema só de PF.

**Decisão**: [FLUXO] único pros dois segmentos, mas **rollout faseado** — primeiro só pra PF
(público menor, mais fácil de acompanhar de perto em produção), valida por um tempo, só
depois estende pra PJ. Isso é *sequência de lançamento*, não arquitetura permanente — quando
PJ entrar, é o MESMO [FLUXO], sem segunda implementação. O corte PF/PJ nesta fase inicial pode
ser feito pela checagem de qualificação que já entra no marcador `[[AGENDAR]]` (Tarefa da
Márcia) — restringir por enquanto a PF ali, e remover a restrição quando for hora de estender.

## Riscos e limites deliberados

- **Sem detecção automática de no-show** — depende de ação humana, decisão do titular (não
  construir isso agora).
- **Sinal de urgência não desloca reunião de terceiros** — só prioriza entre horários livres e
  dispara alerta humano; remanejo de reunião já marcada de outro cliente é decisão humana,
  sempre.
- **Prazo de cancelamento por falta de confirmação é parâmetro, não regra fechada** — o titular
  não tem certeza se deve ser a véspera; entra como *default* configurável.
- **Palavra-chave, não IA generativa, dentro do Fluxo** — mais barato e mais previsível, mas
  cobre menos variação de fala que uma IA cobriria. Lista de gatilho exata (ex.: `["urgente",
  "prazo", "bloqueada", "processo", "citação", "sim"]`) é config do nó `condition`, ajustável
  sem deploy. Risco de falso-negativo registrado, mitigado por incluir termos amplos como "sim".
- **Custo de mensagens é estimativa, não medido** — princípio de "sempre pedir resposta"
  adotado por lógica (conversa de serviço é grátis, business-iniciada fora da janela cobra),
  não por teste A/B de custo real. Vale medir depois de algum volume — `flow_run_events` já
  loga o suficiente pra isso.
- **No-show "crescendo de uns tempos pra cá"** é impressão do titular, sem número exato — o
  Fluxo novo loga em `flow_run_events`, então depois de volume dá pra ter o dado real.
- **`/api/appointments/confirm`** (endpoint hoje existente, `src/app/api/appointments/confirm/
  route.ts`) NÃO está no caminho de chamada atual do `intake.js` pra `BOOKING_CREATED` (que usa
  `fireStageAutomation`, não este endpoint) — provável candidato a código órfão já hoje, ou
  usado por outro caminho ainda não identificado. Confirmar quem mais chama antes de decidir
  se limpa ou deixa — fora do escopo deste desenho, registrado aqui pra não esquecer.
- **`intake.js` é mudança de maior risco** (código fora do wacrm, deploy separado) — sequenciar
  por último no plano de implementação, depois do Canal A (Márcia) estar validado.
