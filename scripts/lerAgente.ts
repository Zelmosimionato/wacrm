import { readFileSync, writeFileSync } from 'node:fs'
for (const l of readFileSync('/root/wacrm/.env.local', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const { decrypt } = await import('../src/lib/whatsapp/encryption')
  const { fetchAgentConfig } = await import('../src/lib/ai/agent-config')
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data } = await db.from('ai_configs').select('api_key').eq('is_active', true).limit(1)
  const a = await fetchAgentConfig(decrypt(data![0].api_key))
  if (!a) throw new Error('agente não lido')
  writeFileSync('/root/agent-live-04-11.txt', a.instructions)
  console.log('modelo do agente:', a.model, '| caracteres:', a.instructions.length)
}
main().catch((e) => { console.error('falhou:', e.message); process.exit(1) })
