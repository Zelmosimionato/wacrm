// Transcreve o áudio que o lead mandou, para a IA poder responder — e para o
// escritório LER em vez de escutar.
//
// Por que existe: em 08/08/2026 a Márcia convidou "pode me mandar em texto ou
// em áudio" (é o que as mensagens prontas do escritório dizem há tempos), o
// titular mandou um áudio e a conversa MORREU. O webhook só chamava a IA para
// mensagem de texto — áudio nem tentava. Como lead ansioso fala em vez de
// escrever, todo áudio que chegou até hoje foi ignorado em silêncio.
//
// Nunca lança: devolve null e quem chama decide (passar para humano é melhor
// que ficar mudo).

import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

/** Mesmo endpoint-base do provider de texto: quem trocar de provedor troca os dois. */
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(
  /\/+$/,
  '',
)

/** ⚠️ Modelo de transcrição, não de conversa — não confundir com `ai_configs.model`. */
const MODELO = process.env.AI_TRANSCRIBE_MODEL || 'whisper-1'

/** Áudio de WhatsApp é curto; acima disto é quase certo que algo travou. */
const TIMEOUT_MS = 60_000

/** Teto de segurança: o WhatsApp já limita, mas mídia inesperada não pode virar conta alta. */
const MAX_BYTES = 25 * 1024 * 1024

export async function transcreverAudioDoWhatsApp(args: {
  mediaId: string
  metaToken: string
  apiKey: string
}): Promise<string | null> {
  const { mediaId, metaToken, apiKey } = args
  try {
    const { url, mimeType } = await getMediaUrl({ mediaId, accessToken: metaToken })
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: url,
      accessToken: metaToken,
    })
    if (buffer.byteLength > MAX_BYTES) {
      console.error(`[transcreve] áudio grande demais (${buffer.byteLength} bytes) — ignorado`)
      return null
    }

    const tipo = contentType || mimeType || 'audio/ogg'
    // O WhatsApp manda ogg/opus; a extensão no nome importa para a API aceitar.
    const ext = tipo.includes('mp4') || tipo.includes('m4a') ? 'm4a' : tipo.includes('mpeg') ? 'mp3' : 'ogg'

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(buffer)], { type: tipo }), `audio.${ext}`)
    form.append('model', MODELO)
    // Sem isto a transcrição às vezes "viaja" para outro idioma em áudio curto
    // ou com ruído — e o nosso lead fala português.
    form.append('language', 'pt')

    const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const corpo = await res.text().catch(() => '')
      console.error('[transcreve]', res.status, corpo.slice(0, 300))
      return null
    }
    const json = (await res.json()) as { text?: string }
    const texto = json.text?.trim()
    if (!texto) return null
    console.log(`[transcreve] ${mediaId}: ${texto.length} chars`)
    return texto
  } catch (err) {
    console.error('[transcreve]', err instanceof Error ? err.message : String(err))
    return null
  }
}
