import { NextResponse } from 'next/server'
import { dispararPorTempo } from '@/lib/automations/tempo'

/**
 * Porta do disparo por tempo. O cron da máquina bate aqui a cada 5 minutos.
 *
 * Protegida pelo mesmo segredo do motor: sem ele, qualquer um na internet
 * poderia acionar um disparador de mensagens.
 */
export async function POST(request: Request) {
  const segredo = process.env.AUTOMATION_ENGINE_SECRET
  if (!segredo) {
    return NextResponse.json(
      { erro: 'AUTOMATION_ENGINE_SECRET não configurado' },
      { status: 500 },
    )
  }
  const enviado = request.headers.get('x-engine-secret')
  if (enviado !== segredo) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const resultado = await dispararPorTempo()
    return NextResponse.json({ ok: true, resultado })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[tempo] falhou:', msg)
    return NextResponse.json({ erro: msg }, { status: 500 })
  }
}
