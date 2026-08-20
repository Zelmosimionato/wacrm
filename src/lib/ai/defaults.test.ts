import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './defaults'

describe('buildSystemPrompt — marcador SUPER exige PJ', () => {
  it('instrui a IA a checar PF/PJ antes de usar SUPER, não só o valor', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    // ⛔ 20/08/2026: a regra antiga testava só "valor >= 500k" — um PF com
    // dívida grande virava Superqualificado, quando a regra real (igual ao
    // formulário da Meta, intake.js) é PJ E valor >= 500k.
    expect(prompt).toContain('pessoa jurídica')
    expect(prompt).toMatch(/PJ.*500\.000|500\.000.*PJ/)
  })
})
