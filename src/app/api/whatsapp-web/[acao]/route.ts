import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Bridge to the second WhatsApp number — the unofficial WhatsApp Web
 * gateway (`wazap`, pm2) listening on loopback.
 *
 * The gateway has no authentication of its own on purpose: it binds to
 * 127.0.0.1 and is unreachable from outside the machine. This route is
 * the only door, and it is the one that already knows who the caller is.
 *
 * Actions: `status`, `qr` (GET) · `enviar`, `desconectar` (POST).
 */

const GATEWAY = process.env.WAZAP_URL ?? 'http://127.0.0.1:3002'

const GET_ACTIONS = new Set(['status', 'qr'])
const POST_ACTIONS = new Set(['enviar', 'desconectar'])

async function exigirSessao() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user ?? null
}

async function repassar(acao: string, init?: RequestInit) {
  try {
    const res = await fetch(`${GATEWAY}/${acao}`, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    const corpo = await res.json().catch(() => ({}))
    return NextResponse.json(corpo, { status: res.status })
  } catch {
    // The gateway being down is an operational state the screen must be
    // able to show, not a stack trace: say so plainly.
    return NextResponse.json(
      { erro: 'gateway do WhatsApp Web fora do ar' },
      { status: 503 }
    )
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ acao: string }> }
) {
  if (!(await exigirSessao())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { acao } = await params
  if (!GET_ACTIONS.has(acao)) {
    return NextResponse.json({ erro: 'ação desconhecida' }, { status: 404 })
  }
  return repassar(acao)
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ acao: string }> }
) {
  if (!(await exigirSessao())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { acao } = await params
  if (!POST_ACTIONS.has(acao)) {
    return NextResponse.json({ erro: 'ação desconhecida' }, { status: 404 })
  }
  const corpo = await request.text()
  return repassar(acao, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: corpo || '{}',
  })
}
