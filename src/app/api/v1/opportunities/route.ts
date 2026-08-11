// ============================================================
// GET /api/v1/opportunities — cards do kanban (escopo: opportunities:read)
//
// Filtros: board_id, stage_id, updated_after, created_after,
// stage_changed_after. Paginação por cursor, igual aos demais.
//
// `stage_entered_at` responde "há quanto tempo este card está parado".
// ⛔ Não use `updated_at` para isso: ele muda ao editar o título, o
// valor ou a nota — e a conta de dias parados zerava sem ninguém mexer
// na etapa. Quem mantém a coluna certa é um gatilho no banco, então ela
// vale para card movido no quadro, pela automação, pela IA ou pelos
// scripts da VPS.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, badRequest, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination';

const CAMPOS =
  'id, contact_id, pipeline_id, stage_id, title, value, currency, status, ' +
  'created_at, updated_at, stage_entered_at';

/** Recusa data malformada em vez de ignorar o filtro em silêncio: um
 *  filtro ignorado devolveria a lista inteira, e o radar contaria o
 *  acervo todo como "movimento de hoje". */
function dataIso(bruto: string | null, campo: string): string | null {
  if (!bruto) return null;
  const t = Date.parse(bruto);
  if (Number.isNaN(t)) throw badRequest(`${campo} não é uma data ISO 8601 válida`);
  return new Date(t).toISOString();
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'opportunities:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);

    const boardId = url.searchParams.get('board_id');
    const stageId = url.searchParams.get('stage_id');
    const updatedAfter = dataIso(url.searchParams.get('updated_after'), 'updated_after');
    const createdAfter = dataIso(url.searchParams.get('created_after'), 'created_after');
    const stageChangedAfter = dataIso(
      url.searchParams.get('stage_changed_after'),
      'stage_changed_after',
    );

    let query = ctx.supabase
      .from('deals')
      .select(CAMPOS)
      .eq('account_id', ctx.accountId);

    if (boardId) query = query.eq('pipeline_id', boardId);
    if (stageId) query = query.eq('stage_id', stageId);
    if (updatedAfter) query = query.gte('updated_at', updatedAfter);
    if (createdAfter) query = query.gte('created_at', createdAfter);
    if (stageChangedAfter) query = query.gte('stage_entered_at', stageChangedAfter);

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/opportunities] list error:', error);
      return fail('internal', 'Failed to list opportunities', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit,
    );

    return okList(
      items.map((r) => {
        const d = r as Record<string, unknown>;
        return {
          id: d.id,
          contact_id: d.contact_id,
          board_id: d.pipeline_id,
          stage_id: d.stage_id,
          title: d.title,
          value: d.value ?? 0,
          currency: d.currency ?? null,
          status: d.status,
          created_at: d.created_at,
          updated_at: d.updated_at,
          stage_entered_at: d.stage_entered_at,
        };
      }),
      nextCursor,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
