// ============================================================
// GET /api/v1/opportunities/{id}/history — mudanças de etapa do card
//                                          (escopo: opportunities:read)
//
// É o que responde "quem mudou de etapa HOJE" sem o radar ter de
// comparar fotos do kanban de um dia para o outro.
//
// As linhas vêm de um gatilho no banco, não de código de aplicação:
// card muda de etapa arrastando no quadro, pelo formulário, pela
// automação, pela IA e pelos scripts da VPS — registrar em cada um
// seria esquecer um, e o esquecido só apareceria como número errado
// meses depois.
//
// `changed_by` distingue "user" (veio de sessão autenticada) de
// "automation" (service-role: motor, IA, intake), que é como o radar
// separa movimento humano de movimento de máquina.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'opportunities:read');
    const { id } = await params;

    // Confere o dono antes de devolver histórico: o card tem de ser
    // desta conta. Sem isto, um id adivinhado devolveria a movimentação
    // de outro escritório.
    const { data: card, error: erroCard } = await ctx.supabase
      .from('deals')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (erroCard) {
      console.error('[api/v1/opportunities/history] lookup:', erroCard);
      return fail('internal', 'Failed to read opportunity', 500);
    }
    if (!card) return fail('not_found', 'Opportunity not found', 404);

    const { data, error } = await ctx.supabase
      .from('deal_stage_history')
      .select('from_stage_id, to_stage_id, changed_at, changed_by')
      .eq('deal_id', id)
      .eq('account_id', ctx.accountId)
      .order('changed_at', { ascending: false });
    if (error) {
      console.error('[api/v1/opportunities/history] list:', error);
      return fail('internal', 'Failed to list stage history', 500);
    }

    return ok(data ?? []); // ok() já embrulha em { data: ... }
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
