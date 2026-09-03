# Frente A + C — Fundação e Qualificação por conteúdo

**Data:** 20/08/2026
**Status:** Frente A implementada e em produção · Frente C tem plano formal escrito
(`docs/superpowers/plans/2026-08-20-qualificacao-por-conteudo-plan.md`), aguardando execução —
escopo bem menor do que a seção original descrevia, ver correção abaixo
**Parte de:** programa de reestruturação MKT + Comercial — ver
`2026-08-20-agendamento-fluxos-design.md` (Frente D, já speced) e o mapa das 5 frentes
(A Fundação · B Funil de vendas · C Qualificação · D Agendamento · E Retorno de campanha)
acordado na mesma conversa.

## Por que A e C andam juntas, primeiro

Nenhuma das duas depende de mais nada — e as três frentes que faltam (B, D, E) só produzem
dado confiável se A e C já existirem: B precisa saber "quem é PJ/PF/Superqualificado" pra
desenhar etapa de verdade; D precisa do sinal de urgência que só C produz; E precisa de números
que só existem se a API (A) parar de mentir.

---

## Frente A — Fundação: a API do CRM está cega por data

### O defeito (confirmado no código hoje, ainda ativo)

`GET /api/v1/contacts` aceita `created_after`/`created_before` na URL e **os ignora
silenciosamente** — devolve sempre os 100 contatos mais recentes, sem filtrar. Reportado por
escrito em 13/08/2026 (`SGE/comercial/DEFEITO_API_RADAR_CRM.md`) e nunca corrigido. Efeito
medido então: 03/08 aparecia com 2 contatos no radar; paginando de verdade eram 23. Como não
gera erro, ninguém percebe — e o radar já sustentou decisão de verba com esse número errado.

`/api/v1/opportunities`, ao contrário, implementa `created_after`/`updated_after`/
`stage_changed_after` corretamente — o defeito é isolado em `contacts`.

### O conserto

Em `src/app/api/v1/contacts/route.ts`:
1. Ler `created_after`/`created_before` da querystring (mesmo parser ISO 8601 que
   `/opportunities` já usa — `dataIso()`, reaproveitar, não reescrever).
2. Aplicar como filtro real na query Supabase (`created_at >= X` / `created_at < Y`).
3. Parâmetro de data mal formado → **400**, não silêncio (é o que teria evitado meses de
   número errado, conforme o próprio relatório pediu).
4. Documentar no JSDoc do arquivo que `created_at` é devolvido em UTC (já é — só nunca foi
   escrito).

### O que NÃO é defeito, é desalinhamento de documentação

`next_cursor` já vive em `meta.next_cursor` — é o contrato de paginação usado por **todo**
endpoint v1, de propósito. O `SPEC_API_RADAR_CRM.md` (10/08) documentou errado (`next_cursor`
no topo, copiando o exemplo de `/opportunities` de um jeito que não bate com a implementação
real), e o script `radar_crm_dia.py` foi escrito pra esse contrato errado. Ação: **não mexer na
API** — corrigir o SPEC e avisar quem mantém `radar_crm_dia.py` (fora do wacrm, no `SGE/comercial`
local) pra ler de `meta.next_cursor` e paginar até esvaziar a janela.

### Escopo desta implementação

Só `src/app/api/v1/contacts/route.ts` (mais teste). Reaproveita `dataIso()` de
`/opportunities` — sem lib nova, sem endpoint novo. Baixo risco: parâmetro que hoje não existe
passa a existir; quem não manda `created_after` não muda de comportamento.

**✅ Implementado e em produção (20/08/2026).** `dataIso()` virou função compartilhada em
`src/lib/api/v1/pagination.ts` (antes duplicada dentro de `opportunities/route.ts`) —
`/api/v1/contacts` agora aceita `created_after`/`created_before` (`>=`/`<`, ISO 8601, 400 em
data malformada). 3 testes novos (`pagination.test.ts`), suíte completa 797/799 (as 2 falhas
são pré-existentes, de `date-utils.test.ts`, sem relação). Build limpo, deploy feito,
`radar_crm_dia.py` (fora do wacrm) segue precisando do ajuste de leitura de `meta.next_cursor` —
fora do escopo deste repositório.

---

## Frente C — Qualificação por conteúdo, não por canal

### O problema

Hoje só existe UM lugar que decide "isso é PJ, isso é ≥R$500k, isso é Superqualificado":
`intake.js` → `handleLead()`, e só roda para lead que **chegou por formulário** (Meta nativo).
Lead que chega direto no WhatsApp (Google/LP, "vim do site, quero mais informações") entra pelo
`first_inbound_message` → a IA qualifica em conversa livre, mas **não existe mecanismo
nenhum** que pegue o resultado dessa qualificação e aplique a mesma tag/decisão. Um empresário
com dívida de R$800 mil que mandou "quero mais informações" pelo Google não tem hoje like
caminho pro tratamento de Superqualificado — só por causa da porta que usou.

Consequência prática, achada nesta sessão: quando o lead conta algo como "estou com execução
em andamento" (prazo processual correndo), a IA registra isso só como texto da conversa —
nada convertia isso em prioridade — e o escritório perdeu um cliente que contratou outro
enquanto esperava a reunião padrão.

### ⚠️ CORREÇÃO (após investigação técnica, mesmo dia): o texto abaixo estava errado

O parágrafo original desta seção (preservado nos parênteses ao fim de cada frase, riscado)
partia de uma suposição que não conferia com o código: que a IA "não tem chamada de função
real" e por isso precisaria de infraestrutura nova (`tools` da Anthropic) pra sinalizar
qualificação. Investigação em `generate.ts`/`auto-reply.ts`/`defaults.ts` mostrou que **esse
mecanismo já existe e já roda em produção** — só sob outro nome: marcadores de controle no
fim da resposta (`[[SUPER]]`, `[[QUALIFICADO]]`, `[[REAGENDAR]]`, `[[DESMARCAR]]`,
`[[PERDIDO]]`, `[[PORTA_ABERTA]]`), extraídos por `parseGeneration()` e aplicados por
`auto-reply.ts` (tag, mudança de etapa, disparo de automação) — **em qualquer canal**, porque
roda toda vez que a IA responde, não só quando o lead veio de formulário.

**A causa raiz de verdade, bem menor:** o marcador `[[SUPER]]` já existe e já é aplicado
independente do canal — só que a REGRA que o prompt ensina pra usá-lo está incompleta.
`defaults.ts:124` instruía "use SUPER quando a dívida for ≥ R$500.000" — **sem checar PJ**.
`intake.js` (o caminho do formulário) já aplica a regra certa (`isPJ && highValue`, mesma tag
`b9298582-dcc7-46a3-ae34-f54b3c6fece1`) — o prompt da IA é o único lugar com a regra errada, e
o erro vai no sentido contrário do que se temia: em vez de faltar tratamento pra quem entra
pelo Google, um PF com dívida grande vindo de QUALQUER canal (inclusive o formulário, se a
conversa não bater com o form) podia virar Superqualificado sem ser PJ.

### O conserto de verdade — plano formal em
`docs/superpowers/plans/2026-08-20-qualificacao-por-conteudo-plan.md`

Nenhuma infraestrutura nova. Três tarefas, todas dentro do mecanismo de marcadores já existente:
1. Corrigir a instrução do `[[SUPER]]` no prompt pra exigir PJ, igual ao `intake.js`.
2. Novo marcador `[[URGENTE]]` (mesmo padrão dos existentes) — a IA sinaliza prazo/urgência
   real, em qualquer canal, independente de qualificar ou não.
3. Criar a tag "Urgente" e aplicá-la quando o marcador aparece — consumida depois pela Frente D
   (Fluxo de Agendamento) pra priorizar horário.
`intake.js` **não muda** — já estava certo. Nenhuma chamada de função nova da Anthropic.

### Critério de urgência (parâmetro do prompt, não regra travada em código)

Seguindo o padrão já usado no prompt da Márcia (regra mínima + poucos limites com o porquê):
sinais como "tenho prazo no processo", "já fui citado", "execução em andamento", "protesto
já saiu" — a IA julga pelo conteúdo, não por lista fechada de palavras (lista fechada é frágil
demais pra isso, ao contrário do "remarcar" da Frente D, que É melhor como palavra-chave por
ser uma intenção simples de reconhecer).

### O que NÃO muda nesta frente

- O formulário continua existindo e continua sendo um atalho (evita perguntar de novo o que já
  veio preenchido) — só deixa de ser o ÚNICO portão pra Superqualificado.
- Nenhuma automação/fluxo consumidor (Superqualificado, Fluxo de Agendamento) muda de
  comportamento — eles continuam reagindo à tag como hoje; só passam a recebê-la de mais de
  um lugar.

### Risco e por que isto NÃO entra no mesmo lote de deploy que a Frente A

Frente A é um filtro de leitura, sem efeito colateral em produção. Frente C muda o
COMPORTAMENTO da IA em toda conversa nova — precisa de plano com etapas testáveis
(ex.: ligar `tools` sem ainda desligar o farejamento de texto, rodar em paralelo, comparar,
só então desligar o farejamento) antes de qualquer deploy. Vai para `writing-plans` como passo
seguinte, não implementação direta.

---

## Nota — funil de vendas (Frente B, adiantado nesta sessão)

Revisão do funil real (`pipeline_stages`, hoje):
```
0 Novo Lead · 1 Lead Qualificado · 2 Reunião Agendada · 3 Reagendar reunião ·
4 FUP-Reativar Lead · 5 Enviar Proposta · 6 Follow up No-show · 7 Aguardando Decisão ·
8 Preench. Contrato PJ · 9 Preench. Contrato PF · 10 Perdido · 11 Cliente-sem-automação
```
Achados a resolver quando a Frente B começar:
1. A ordem das posições não é uma sequência real — "Follow up No-show" (6) vem depois de
   "Enviar Proposta" (5), o que é impossível na prática; "FUP-Reativar" (4) está encaixado no
   meio do caminho principal quando é uma régua de resgate acessível de qualquer etapa parada.
2. Não existe "Lead Ganho"/"Cliente Ativo" — o mais próximo é "Cliente - sem automação", nome
   que descreve propriedade técnica, não estado de negócio. Precisa virar o evento "Won" da
   Frente E com nome que bate com o que significa.
3. PJ/PF só se separam nas etapas 8/9 — bem depois de a qualificação (Frente C) já saber a
   resposta desde a entrada. Decisão consciente pendente: manter unificado até o contrato, ou
   refletir a separação mais cedo no funil.

Também confirmado nesta sessão: existe automação de geração de contrato pronta e testada
(pasta Drive "Modelos de Contrato (automação)" — Procuração M/F, Contrato Revisional PJ
sócio/sócia, PF Masculino/Feminino; contrato real já gerado para cliente Rafaelle Louise Dos
Santos Martins) que **não está ligada** a nenhuma etapa do funil hoje. É o conteúdo natural do
que "Preenchimento de Contrato PJ/PF" deveria disparar.

### "Lead Ganho", definido pelo titular (não é uma etapa isolada)

"Ganho" não é o card entrar em "Preenchimento de Contrato" — é o **onboarding fechar**:
contrato assinado + checklist de documentos + forma de pagamento definida. Só depois desse
conjunto completo é que o card (agora cliente) **atravessa de pipeline**: sai do Funil de
Vendas e entra no **Funil Operacional**, cuja primeira etapa é justamente
"Solicitação de Agendamento - Acessos" (já mapeada nesta sessão — é a automação com o risco de
janela-24h achado hoje). Ou seja: o evento "Won" da Frente E não é uma mudança de ETAPA, é a
**mudança de FUNIL** — o gatilho mais forte e mais inequívoco que existe no sistema, porque só
acontece uma vez por cliente.

### Automação pode e deve mover o card pra trás — não existe funil só de ida

Não há regra de que automação só empurra o lead pra frente. Agendar, reagendar, cair em
perdido e o lead retomar contato depois — tudo isso é o funil normal, é dinâmico por natureza.
Nenhum desenho de fluxo (Frente D incluída) deve assumir que uma automação "não pode" mover um
card pra uma etapa anterior — se o conteúdo da conversa pede isso, o card volta, sem
exceção especial pra justificar.
