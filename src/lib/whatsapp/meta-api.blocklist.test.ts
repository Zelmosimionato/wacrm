import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendReactionMessage,
  sendInteractiveButtons,
  sendInteractiveCtaUrl,
  sendInteractiveList,
} from './meta-api'
import { ContatoBloqueadoError, ContatoNaoResolvidoError } from './blocklist'

// Este arquivo prova a BLOCKLIST. O freio de volume tem os testes dele em
// freio.test.ts; aqui ele so atrapalharia, porque consulta o banco.
vi.mock('./freio', () => ({ conferirFreio: vi.fn(async () => {}) }))

// ============================================================
// A guarda vive na camada mais baixa de proposito: todo envio do CRM passa
// por aqui, entao nenhuma automacao futura consegue contornar sem perceber.
// Este arquivo existe para que "todas as portas estao guardadas" seja um
// teste, e nao uma frase — em 09/08/2026 a auditoria descobriu que
// sendReactionMessage era a excecao que ninguem tinha notado.
// ============================================================

// ⛔ Dados ficticios: quem esta bloqueado de verdade e configuracao.
const BLOQUEADO = '11111111-1111-1111-1111-111111111111'
const LIVRE = '99999999-9999-9999-9999-999999999999'
const BASE = { phoneNumberId: 'p', accessToken: 't', to: '5511999999999' }

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubEnv('WHATSAPP_BLOCKLIST_CONTACT_IDS', BLOQUEADO)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: 'wamid.OK' }] }),
  }))
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** As 7 portas, cada uma com o minimo de argumentos que o tipo exige. */
const PORTAS: [string, (contactId: string) => Promise<unknown>][] = [
  ['sendTextMessage', (contactId) => sendTextMessage({ ...BASE, contactId, text: 'oi' })],
  [
    'sendMediaMessage',
    (contactId) =>
      sendMediaMessage({ ...BASE, contactId, kind: 'image', link: 'https://x/y.jpg' }),
  ],
  [
    'sendTemplateMessage',
    (contactId) => sendTemplateMessage({ ...BASE, contactId, templateName: 'tpl' }),
  ],
  [
    'sendReactionMessage',
    (contactId) =>
      sendReactionMessage({ ...BASE, contactId, targetMessageId: 'wamid.X', emoji: '👍' }),
  ],
  [
    'sendInteractiveButtons',
    (contactId) =>
      sendInteractiveButtons({
        ...BASE,
        contactId,
        bodyText: 'corpo',
        buttons: [{ id: 'a', title: 'Sim' }],
      }),
  ],
  [
    'sendInteractiveCtaUrl',
    (contactId) =>
      sendInteractiveCtaUrl({
        ...BASE,
        contactId,
        bodyText: 'corpo',
        buttonText: 'Abrir',
        url: 'https://exemplo.com',
      }),
  ],
  [
    'sendInteractiveList',
    (contactId) =>
      sendInteractiveList({
        ...BASE,
        contactId,
        bodyText: 'corpo',
        buttonLabel: 'Ver',
        sections: [{ title: 'S', rows: [{ id: 'r1', title: 'Linha' }] }],
      }),
  ],
]

describe('as 7 portas para a Meta', () => {
  it.each(PORTAS)('%s barra contato bloqueado', async (_nome, chamar) => {
    await expect(chamar(BLOQUEADO)).rejects.toThrow(ContatoBloqueadoError)
  })

  it.each(PORTAS)('%s nao chega na rede quando bloqueado', async (_nome, chamar) => {
    await expect(chamar(BLOQUEADO)).rejects.toThrow()
    // ⛔ O ponto: nao basta dar erro depois de mandar. Nada pode sair.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(PORTAS)('%s aborta quando falta o contact_id', async (_nome, chamar) => {
    await expect(chamar('' as string)).rejects.toThrow(ContatoNaoResolvidoError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(PORTAS)('%s deixa passar contato livre', async (_nome, chamar) => {
    await expect(chamar(LIVRE)).resolves.toBeDefined()
    expect(fetchSpy).toHaveBeenCalled()
  })
})
