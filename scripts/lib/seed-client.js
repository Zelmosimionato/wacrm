const path = require('node:path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env.local') })
const { createClient } = require('@supabase/supabase-js')

function seedClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('seed-client: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes em .env.local')
  }
  return createClient(url, key)
}

// Casa por (coluna, account_id) — nao so pela coluna sozinha (achado
// #16: risco de casar linha de outra conta num schema que ja e
// multi-tenant em todo o resto).
async function upsertByUniqueColumn(db, table, column, accountId, row) {
  const { data: existing } = await db.from(table).select('*').eq(column, row[column]).eq('account_id', accountId).maybeSingle()
  if (existing) {
    const { data, error } = await db.from(table).update(row).eq('id', existing.id).select('*').single()
    if (error) throw new Error(`upsert ${table}.${row[column]}: ${error.message}`)
    return data
  }
  const { data, error } = await db.from(table).insert(row).select('*').single()
  if (error) throw new Error(`insert ${table}.${row[column]}: ${error.message}`)
  return data
}

// Guarda contra apagar flow_nodes debaixo de um run ativo (achado #14).
async function garantirSemRunAtivo(db, flowId) {
  if (!flowId) return
  const { count, error } = await db
    .from('flow_runs')
    .select('id', { count: 'exact', head: true })
    .eq('flow_id', flowId)
    .eq('status', 'active')
  if (error) throw new Error(`checagem de run ativo falhou: ${error.message}`)
  if (count && count > 0) {
    throw new Error(`ABORTADO: ${count} run(s) ativo(s) no flow ${flowId} — reseed apagaria flow_nodes debaixo deles. Esperar terminarem ou tratar manualmente.`)
  }
}

module.exports = { seedClient, upsertByUniqueColumn, garantirSemRunAtivo }
