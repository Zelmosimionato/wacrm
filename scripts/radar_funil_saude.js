#!/usr/bin/env node
// ============================================================
// RADAR DE SAÚDE DO FUNIL — PROPOSTA, AINDA NÃO AGENDADA
// ============================================================
// Gerado em 10/09/2026 numa auditoria de dívida técnica, a pedido do
// titular. SOMENTE LEITURA — nunca dá UPDATE/INSERT/DELETE em nada,
// só lê o Supabase pela REST API com a service-role key já usada pelo
// wacrm (.env.local) e imprime um relatório no terminal.
//
// COMO RODAR (manual, na VPS):
//   cd /root/wacrm && node scripts/radar_funil_saude.js
//
// O QUE FAZ (cada achado com o MOTIVO, não só a lista crua):
//   1) Cards "parados" — status=open, fora das etapas terminais
//      (Perdido / Cliente - sem automacao), há mais de N dias na
//      MESMA etapa (deals.stage_entered_at, mantido pelo gatilho
//      `deals_registra_etapa` da migração 039). N é por etapa (ver
//      LIMIAR_DIAS_POR_ETAPA) porque "Novo Lead" parado 5 dias é grave
//      (lead esfriando) e "Aguardando Decisão" parado 5 dias é normal
//      (cliente decidindo) — um único N pra tudo gera ruído ou cega
//      demais; o titular pode reajustar os limiares abaixo.
//   2) Cards em "Perdido" cujo CONTATO tem a tag "Agendou" — ou seja,
//      nasceram/foram desqualificados como Perdido mas têm um
//      agendamento REAL do Cal.com associado. Este é o padrão do caso
//      real "Gy Souza" (27/08/2026, ver nota de memória
//      perdido-com-agendamento-real-decisao-caso-a-caso): o handler
//      /calcom em /root/intake/intake.js só tira o card de estágios
//      "menores" que Reunião Agendada, e por posição (11) Perdido é
//      "maior" — a lógica de "não regride" trata isso como avanço
//      legítimo e o card fica escondido em Perdido com reunião
//      marcada. ⛔ O titular decidiu em 27/08 NÃO automatizar o
//      conserto (tratar caso a caso) — este radar SÓ LISTA, não move
//      nenhum card. Decidir se/quando corrigir continua sendo dele.
//   3) Cards em "Perdido" com contact_id NULO — o contato foi apagado
//      (migração 004_contact_delete_set_null.sql troca o FK de
//      contact_id pra SET NULL em vez de apagar o deal junto) e o card
//      ficou órfão, sem nome/telefone rastreável. Não atrapalha nada
//      em produção, mas é lixo de dado que nunca vai ser trabalhado.
//   4) Cards em "Perdido" com status ainda "open" (não "lost") — a
//      maioria são os leads desqualificados por valor que nascem
//      direto em Perdido (/root/intake/intake.js, handleLead ~linha
//      331 e ~linha 785): esse INSERT grava status:"open" sempre,
//      mesmo quando o stageId já é Perdido — só o automation engine
//      (auto-reply.ts linha ~443, nudge-buttons.ts linha ~89) seta
//      status:"lost" quando MOVE um card já existente pra Perdido.
//      ⚠️ NÃO PROPONHO mexer nisso: o dedup de lead recorrente em
//      intake.js (linhas ~413/~652/~785) procura deal existente por
//      "status=eq.open" — se um card nascido em Perdido virasse
//      "lost" automaticamente, um contato que manda mensagem de novo
//      deixaria de encontrar o card antigo e ganharia um duplicado.
//      Ou seja: pode ser um paliativo necessário, não um bug puro —
//      fica registrado como OBSERVAÇÃO pro titular avaliar, não como
//      "achado, corrigir".
//   5) Contatos com mais de 1 deal "open" simultâneo no mesmo pipeline
//      (duplicidade de card) — checado no dry-run de 10/09/2026: ZERO
//      casos. Mantido no radar como rede de segurança pra detectar se
//      isso passar a acontecer.
//
// O QUE ESTE SCRIPT NÃO FAZ:
//   - Não move card, não muda status, não aplica tag, não manda
//     mensagem. Zero escrita no banco.
//   - Não está em nenhum cron/pm2/scheduled-task — decisão de
//     periodicidade é do titular.
// ============================================================

require("dotenv").config({ path: ".env.local", quiet: true });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env.local");
  process.exit(1);
}
const HEADERS = { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY };

// Pipeline comercial (funil de leads GP). O outro pipeline do banco
// (dfa40d35-..., "Solicitação de Agendamento - Acessos" etc.) é operacional
// de processo/acesso, não é o funil comercial — fora do escopo deste radar.
const PIPELINE_COMERCIAL = "8e89e154-763c-4cf8-b73b-42f7368c59c3";
const TAG_AGENDOU = "c0278b4c-8f17-416e-a7e4-b66b6e78315a";

// Limiar de dias parado por NOME de etapa. Etapas terminais (Perdido,
// Cliente - sem automacao) ficam de fora — não fazem sentido nesta
// checagem (Perdido é fim de linha por natureza; Cliente pode ficar
// meses ali sem ser "esquecido"). Ajustar à vontade.
const LIMIAR_DIAS_POR_ETAPA = {
  "Novo Lead - Contato inicial": 3,
  "Lead Qualificado": 5,
  "Reunião Agendada": 2,
  "Reagendar reunião": 5,
  "FUP - Reativar Lead": 10,
  "Enviar Proposta": 7,
  "Follow up No-show": 7,
  "Aguardando Decisão": 14,
  "Preenchimento de Contrato PJ": 7,
  "Preenchimento de Contrato PF": 7,
};
const LIMIAR_PADRAO_DIAS = 7; // qualquer etapa não listada acima

async function get(path) {
  const r = await fetch(SUPABASE_URL + path, { headers: HEADERS });
  if (!r.ok) {
    throw new Error(`${path} -> HTTP ${r.status} ${await r.text()}`);
  }
  return r.json();
}

function diasParado(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

async function main() {
  const stages = await get(
    `/rest/v1/pipeline_stages?select=id,name,position&pipeline_id=eq.${PIPELINE_COMERCIAL}&order=position.asc`
  );
  const stageById = Object.fromEntries(stages.map((s) => [s.id, s]));
  const stagePerdido = stages.find((s) => s.name === "Perdido");
  const stageCliente = stages.find((s) => s.name === "Cliente - sem automacao");
  if (!stagePerdido || !stageCliente) {
    throw new Error("Não achei as etapas 'Perdido' ou 'Cliente - sem automacao' — nome mudou no CRM?");
  }

  const todosOsDeals = await get(
    `/rest/v1/deals?select=id,title,stage_id,status,stage_entered_at,created_at,contact_id&pipeline_id=eq.${PIPELINE_COMERCIAL}`
  );

  // ---- 1) Cards parados ----
  const parados = todosOsDeals.filter((d) => {
    if (d.status !== "open") return false;
    if (d.stage_id === stagePerdido.id || d.stage_id === stageCliente.id) return false;
    const nomeEtapa = stageById[d.stage_id]?.name;
    const limiar = LIMIAR_DIAS_POR_ETAPA[nomeEtapa] ?? LIMIAR_PADRAO_DIAS;
    return diasParado(d.stage_entered_at) >= limiar;
  });

  // ---- 2), 3), 4): tudo que envolve a etapa Perdido ----
  const emPerdido = todosOsDeals.filter((d) => d.stage_id === stagePerdido.id);
  const perdidoOrfaos = emPerdido.filter((d) => !d.contact_id);
  const perdidoStatusAberto = emPerdido.filter((d) => d.status === "open");

  let perdidoComAgendou = [];
  const contactIds = [...new Set(emPerdido.map((d) => d.contact_id).filter(Boolean))];
  const marcados = new Set();
  for (let i = 0; i < contactIds.length; i += 50) {
    const lote = contactIds.slice(i, i + 50);
    const rows = await get(
      `/rest/v1/contact_tags?select=contact_id&tag_id=eq.${TAG_AGENDOU}&contact_id=in.(${lote.join(",")})`
    );
    rows.forEach((r) => marcados.add(r.contact_id));
  }
  perdidoComAgendou = emPerdido.filter((d) => marcados.has(d.contact_id));

  // ---- 5) Duplicidade: contato com >1 deal "open" no mesmo pipeline ----
  const abertos = todosOsDeals.filter((d) => d.status === "open" && d.contact_id);
  const porContato = {};
  abertos.forEach((d) => (porContato[d.contact_id] = porContato[d.contact_id] || []).push(d));
  const duplicados = Object.entries(porContato).filter(([, v]) => v.length > 1);

  // ---- Relatório ----
  const hoje = new Date().toISOString().slice(0, 10);
  console.log(`RADAR DE SAÚDE DO FUNIL — ${hoje}`);
  console.log(`Pipeline comercial: ${todosOsDeals.length} deals totais\n`);

  console.log(`1) CARDS PARADOS além do limiar da etapa — total: ${parados.length}`);
  console.log("   MOTIVO: card vivo (status=open) sem trânsito há mais dias do que o normal pra etapa dele — risco de lead esfriando/esquecido.");
  parados
    .sort((a, b) => diasParado(b.stage_entered_at) - diasParado(a.stage_entered_at))
    .forEach((d) =>
      console.log(
        `   - [${diasParado(d.stage_entered_at)}d] "${d.title}" em "${stageById[d.stage_id]?.name}" (deal ${d.id})`
      )
    );

  console.log(`\n2) "Perdido" com tag "Agendou" (agendamento Cal.com real) — total: ${perdidoComAgendou.length} de ${emPerdido.length}`);
  console.log("   MOTIVO: reunião real marcada, mas o card ficou escondido em Perdido (bug conhecido do handler /calcom, ver cabeçalho). Só listado — nenhuma ação automática.");
  perdidoComAgendou.forEach((d) => console.log(`   - "${d.title}" (deal ${d.id}, contato ${d.contact_id})`));

  console.log(`\n3) "Perdido" com contact_id nulo (contato apagado, card órfão) — total: ${perdidoOrfaos.length}`);
  console.log("   MOTIVO: contato foi apagado depois que o card entrou em Perdido; o card sobrou sem dono rastreável (dado morto, não afeta produção).");
  perdidoOrfaos.forEach((d) => console.log(`   - "${d.title}" (deal ${d.id})`));

  console.log(`\n4) "Perdido" com status ainda "open" — total: ${perdidoStatusAberto.length} de ${emPerdido.length}`);
  console.log("   OBSERVAÇÃO (não é 'achado, corrigir'): provavelmente os leads desqualificados por valor que já nascem em Perdido (intake.js nunca seta status:lost nesse caminho). Mudar isso pode quebrar o dedup de lead recorrente que procura status=open — avaliar com cuidado antes de mexer.");

  console.log(`\n5) Contatos com mais de 1 deal aberto simultâneo — total: ${duplicados.length}`);
  console.log("   MOTIVO: sinal de card duplicado pro mesmo lead. Zero casos no dry-run de 10/09/2026 — mantido como rede de segurança.");
  duplicados.forEach(([cid, v]) => console.log(`   - contato ${cid}: ${v.length} deals abertos (${v.map((x) => x.id).join(", ")})`));

  console.log("\n--- fim do relatório (somente leitura, nada foi alterado) ---");
}

main().catch((e) => {
  console.error("ERRO:", e.message);
  process.exit(1);
});
