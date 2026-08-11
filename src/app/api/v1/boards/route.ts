// ============================================================
// GET /api/v1/boards — kanbans e suas etapas (escopo: opportunities:read)
//
// O radar precisa dos nomes das etapas para dizer "3 cards entraram em
// Reunião Agendada hoje" em vez de despejar identificadores. Lista
// pequena e estável, então vai inteira, sem paginação.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

interface EtapaLinha {
  id: string;
  name: string;
  position: number;
  pipeline_id: string;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'opportunities:read');

    const { data: funis, error: erroFunis } = await ctx.supabase
      .from('pipelines')
      .select('id, name, created_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true });
    if (erroFunis) {
      console.error('[api/v1/boards] pipelines:', erroFunis);
      return fail('internal', 'Failed to list boards', 500);
    }

    const ids = (funis ?? []).map((f) => f.id as string);
    let etapas: EtapaLinha[] = [];
    if (ids.length) {
      const { data, error } = await ctx.supabase
        .from('pipeline_stages')
        .select('id, name, position, pipeline_id')
        .in('pipeline_id', ids)
        .order('position', { ascending: true });
      if (error) {
        console.error('[api/v1/boards] stages:', error);
        return fail('internal', 'Failed to list stages', 500);
      }
      etapas = (data ?? []) as EtapaLinha[];
    }

    // ⛔  já embrulha em { data: ... }. Passar outro  aqui
    // produzia {"data":{"data":[...]}} — só apareceu ao olhar a resposta
    // crua com a chave real.
    return ok(
      (funis ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        stages: etapas
          .filter((e) => e.pipeline_id === f.id)
          .map((e) => ({ id: e.id, name: e.name, position: e.position })),
      })),
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
