import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { remarcarReserva } from '@/lib/appointments/calcom-reschedule'

// Corrige a reunião marcada de um contato — pra quando o reagendamento
// aconteceu FORA dos caminhos automáticos (Cal.com direto ou o botão
// "Preciso remarcar" do WhatsApp): reunião que já passou (Cal.com recusa
// mexer nela pela própria tela) e foi remarcada por telefone/pessoalmente,
// por exemplo — o caso real que motivou isto (Anderson, 19-24/08/2026):
// reagendado na mão, sem nenhum campo do CRM acompanhar, e o lembrete
// automático saiu com a data velha.
//
// Tenta primeiro a API de reagendar de verdade do Cal.com (mesma reserva,
// mesmo uid — sem isso, hoje só existe cancelar+criar, dois eventos
// separados). Se o Cal.com recusar (ex.: reunião já passada) ou não houver
// uid salvo, cai para corrigir só os campos do CRM — sem isso, o único
// jeito era editar o campo de texto na unha (é como o ISO saiu errado da
// primeira vez).
//
// Sempre reabre o negócio (status -> open) e garante a etapa "Reunião
// Agendada": foi o segundo bloqueio silencioso do caso Anderson — o card
// carregava `status: lost` por baixo mesmo estando na coluna certa.
//
// ⛔ NÃO dispara a automação de confirmação (fireStageAutomation é coisa do
// intake, webhook do Cal.com). Quem usa esta correção já falou com o lead
// pessoalmente — mandar uma confirmação automática por cima seria festejar
// pra ele de novo o que ele já sabe.

const CF_DATA = 'e7935f62-b9f6-414b-9cde-b3c7315c0f11'
const CF_LOCAL = '62721dd7-92f9-4587-b3db-65a8e1a51120'
const CF_DATA_ISO = 'e482845b-8ed4-4f4d-ae0e-0eed9dafbe4e'
const CF_CAL_UID = '9a4af810-d6d3-4201-b39d-9ed46648b5d9'
const TAG_AGENDOU = 'c0278b4c-8f17-416e-a7e4-b66b6e78315a'
const PIPELINE_VENDAS = '8e89e154-763c-4cf8-b73b-42f7368c59c3'
const STAGE_REUNIAO = 'fd70e3b2-52e2-4f2c-b6e8-15450fe6c9d4'

function formatarDataBR(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date(iso))
}

async function upsertCustomValue(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
  fieldId: string,
  value: string,
) {
  const { data: existing } = await db
    .from('contact_custom_values')
    .update({ value })
    .eq('contact_id', contactId)
    .eq('custom_field_id', fieldId)
    .select('id')
  if (existing && existing.length > 0) return
  await db.from('contact_custom_values').insert({
    contact_id: contactId,
    custom_field_id: fieldId,
    value,
  })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id: contactId } = await params
  const body = await request.json().catch(() => null)
  const novoIso = typeof body?.novoIso === 'string' ? body.novoIso : ''
  const novoLocal = typeof body?.novoLocal === 'string' ? body.novoLocal.trim() : ''
  const motivo = typeof body?.motivo === 'string' ? body.motivo.trim() : undefined

  const quando = new Date(novoIso)
  if (!novoIso || Number.isNaN(quando.getTime())) {
    return NextResponse.json({ error: 'novoIso inválido' }, { status: 400 })
  }

  const db = supabaseAdmin()

  const { data: contato } = await db
    .from('contacts')
    .select('id')
    .eq('id', contactId)
    .maybeSingle()
  if (!contato) {
    return NextResponse.json({ error: 'contato não encontrado' }, { status: 404 })
  }

  const { data: uidRow } = await db
    .from('contact_custom_values')
    .select('value')
    .eq('contact_id', contactId)
    .eq('custom_field_id', CF_CAL_UID)
    .maybeSingle()
  const uid = (uidRow?.value as string | null)?.trim() || null

  let calcomSincronizado = false
  let calcomMotivo: string | null = null
  const chave = process.env.CALCOM_API_KEY
  if (uid && chave) {
    const r = await remarcarReserva({ uid, apiKey: chave, novoIso, motivo })
    if (r.ok) {
      calcomSincronizado = true
    } else {
      calcomMotivo = r.motivo
      console.warn(`[corrigir-agendamento] Cal.com recusou remarcar (uid ${uid}): ${r.motivo} — corrigindo só o CRM`)
    }
  } else if (!uid) {
    calcomMotivo = 'sem_uid'
  } else {
    calcomMotivo = 'sem_chave_calcom'
  }

  const dataBR = formatarDataBR(novoIso)
  await upsertCustomValue(db, contactId, CF_DATA, dataBR)
  await upsertCustomValue(db, contactId, CF_DATA_ISO, novoIso)
  if (novoLocal) await upsertCustomValue(db, contactId, CF_LOCAL, novoLocal)

  await db
    .from('contact_tags')
    .upsert(
      { contact_id: contactId, tag_id: TAG_AGENDOU },
      { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
    )

  const { data: deals } = await db
    .from('deals')
    .select('id, status, stage_id')
    .eq('contact_id', contactId)
    .eq('pipeline_id', PIPELINE_VENDAS)
    .order('updated_at', { ascending: false })
    .limit(1)
  const deal = (deals ?? [])[0] as { id: string; status: string; stage_id: string } | undefined
  let dealCorrigido = false
  if (deal && (deal.status !== 'open' || deal.stage_id !== STAGE_REUNIAO)) {
    await db
      .from('deals')
      .update({ status: 'open', stage_id: STAGE_REUNIAO })
      .eq('id', deal.id)
    dealCorrigido = true
  }

  return NextResponse.json({
    ok: true,
    calcomSincronizado,
    calcomMotivo,
    dataBR,
    novoIso,
    dealCorrigido,
    dealEncontrado: !!deal,
  })
}
