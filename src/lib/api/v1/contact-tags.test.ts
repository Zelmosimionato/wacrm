import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { addContactTags, setContactTags } from './contacts';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';

// Banco de mentira: só o que as funções de etiqueta tocam.
interface Tag { id: string; name: string }
function fakeDb(tags: Tag[], currentTagIds: string[]) {
  const inserted: string[] = [];
  const removed: string[] = [];
  const created: string[] = [];
  const db = {
    from(table: string) {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.in = (_col: string, ids: string[]) => {
        removed.push(...ids);
        return Promise.resolve({ error: null });
      };
      b.delete = () => b;
      b.insert = (rows: Record<string, string>[]) => {
        if (table === 'contact_tags') {
          inserted.push(...rows.map((r) => r.tag_id));
          return Promise.resolve({ error: null });
        }
        // tags: criação de etiqueta nova
        const made = rows.map((r, i) => ({ id: `novo-${i}`, name: r.name }));
        created.push(...made.map((m) => m.name));
        return { select: () => Promise.resolve({ data: made, error: null }) };
      };
      b.then = (resolve: (v: unknown) => unknown) => {
        const data =
          table === 'tags' ? tags : currentTagIds.map((tag_id) => ({ tag_id }));
        return Promise.resolve({ data, error: null }).then(resolve);
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, inserted, removed, created };
}

const CONTA: Tag[] = [
  { id: 't-bio', name: 'Instagram Bio' },
  { id: 't-super', name: 'Superqualificado' },
  { id: 't-pj', name: 'PJ' },
  { id: 't-cliente', name: 'Cliente' },
  { id: 't-agendou', name: 'Agendou' },
];

describe('etiquetas pedidas por nome (caso de 26/10/2026: o webhook aplicava TODAS as da conta)', () => {
  it('resolveImportTagIds devolve só as etiquetas pedidas, sem diferenciar maiúscula', async () => {
    const { db } = fakeDb(CONTA, []);
    const { tagIdByKey } = await resolveImportTagIds(db, {
      accountId: 'a',
      userId: 'u',
      tagNames: ['instagram bio', 'PJ'],
      canCreateTags: true,
    });
    expect([...tagIdByKey.values()].sort()).toEqual(['t-bio', 't-pj']);
  });

  it('addContactTags grava só as 3 etiquetas do webhook da bio', async () => {
    const { db, inserted } = fakeDb(CONTA, []);
    await addContactTags(db, 'a', 'u', 'c1', ['Instagram Bio', 'Superqualificado', 'PJ']);
    expect(inserted.sort()).toEqual(['t-bio', 't-pj', 't-super']);
  });

  it('addContactTags não repete a etiqueta que o contato já tem', async () => {
    const { db, inserted } = fakeDb(CONTA, ['t-pj']);
    await addContactTags(db, 'a', 'u', 'c1', ['Instagram Bio', 'PJ']);
    expect(inserted).toEqual(['t-bio']);
  });

  it('addContactTags cria a etiqueta que não existe e aplica só ela', async () => {
    const { db, inserted, created } = fakeDb(CONTA, []);
    await addContactTags(db, 'a', 'u', 'c1', ['Etiqueta Nova']);
    expect(created).toEqual(['Etiqueta Nova']);
    expect(inserted).toEqual(['novo-0']);
  });

  it('addContactTags com lista vazia não grava nada', async () => {
    const { db, inserted } = fakeDb(CONTA, []);
    await addContactTags(db, 'a', 'u', 'c1', []);
    expect(inserted).toEqual([]);
  });

  it('setContactTags deixa o contato só com as pedidas (tira as outras, não acrescenta o resto da conta)', async () => {
    const { db, inserted, removed } = fakeDb(CONTA, ['t-cliente', 't-agendou']);
    await setContactTags(db, 'a', 'u', 'c1', ['PJ']);
    expect(inserted).toEqual(['t-pj']);
    expect(removed.sort()).toEqual(['t-agendou', 't-cliente']);
  });
});
