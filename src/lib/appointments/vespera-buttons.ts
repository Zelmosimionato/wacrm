import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendText } from '@/lib/automations/meta-send'
import { cancelarEReagendar } from './cancelar-e-reagendar'

// Trata os toques nos botões do lembrete de véspera (template
// `lembrete_vespera_confirma`, quick-reply). Chamado pelo webhook quando
// chega uma mensagem type:'button' com um destes títulos:
//   - "Confirmar presença" -> responde confirmando + tag "Confirmado".
//   - "Preciso remarcar"   -> cancelarEReagendar (cancela no Cal.com,
//        libera o slot, tira a tag Agendou, move o card p/ Reagendar, manda
//        link de novo agendamento) — mesma função usada pelo relógio de
//        lembretes quando ninguém confirma nada (reminders/dispatch.ts).
// Nunca lança: o webhook segue mesmo se algo aqui falhar.

const CONFIRMAR = 'Confirmar presença'
const REMARCAR = 'Preciso remarcar'

export function isVesperaButton(text: string | null | undefined): boolean {
  return text === CONFIRMAR || text === REMARCAR
}

function firstName(name: string | null | undefined): string {
  return name ? name.trim().split(/\s+/)[0] : ''
}

interface HandleArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  buttonText: string
  contactName: string | null
}

export async function handleVesperaButton(args: HandleArgs): Promise<void> {
  const db = supabaseAdmin()
  const common = {
    accountId: args.accountId,
    userId: args.userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
  }
  const first = firstName(args.contactName)
  const oi = first ? `, ${first}` : ''

  try {
    if (args.buttonText === CONFIRMAR) {
      // tag "Confirmado" (find-or-create; secundária — não impede a resposta)
      try {
        const { data: existing } = await db
          .from('tags')
          .select('id')
          .eq('account_id', args.accountId)
          .eq('name', 'Confirmado')
          .maybeSingle()
        let tagId = (existing as { id?: string } | null)?.id
        if (!tagId) {
          const { data: created } = await db
            .from('tags')
            .insert({
              account_id: args.accountId,
              user_id: args.userId,
              name: 'Confirmado',
              color: '#16a34a',
            })
            .select('id')
            .maybeSingle()
          tagId = (created as { id?: string } | null)?.id
        }
        if (tagId) {
          await db.from('contact_tags').insert({ contact_id: args.contactId, tag_id: tagId })
        }
      } catch {
        /* ignore — tag é secundária */
      }
      await engineSendText({
        ...common,
        text: `Perfeito${oi}! ✅ Sua presença está confirmada. Até lá! 🙌`,
      })
      return
    }

    if (args.buttonText === REMARCAR) {
      await cancelarEReagendar({
        ...common,
        motivoNota: '↩️ Lead pediu para remarcar (botão da véspera) — link enviado.',
        bodyTextCancelado: `Tudo certo${oi}! 🙂 Liberei o seu horário. É só escolher um novo aqui embaixo 👇`,
        bodyTextSemCancelar: `Sem problema${oi}! 🙂 É só escolher um novo horário aqui embaixo 👇`,
      })
      return
    }
  } catch (err) {
    console.error('[vespera-button]', err instanceof Error ? err.message : String(err))
  }
}
