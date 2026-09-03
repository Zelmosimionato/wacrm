import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  serializeContact,
  findOrCreateContact,
  ContactError,
} from './contacts';

describe('serializeContact', () => {
  it('flattens contact_tags(tags(*)) onto a tags array and nulls missing fields', () => {
    const row = {
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      contact_tags: [
        { tags: { id: 't1', name: 'vip', color: '#fff' } },
        { tags: null }, // orphaned join — dropped
      ],
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      custom_fields: {},
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('tolerates a row with no contact_tags key', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).tags).toEqual([]);
  });

  it('flattens contact_custom_values(value, custom_fields(field_name)) by field name', () => {
    const row = {
      id: 'c3',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
      contact_custom_values: [
        { value: 'Google Ads', custom_fields: { field_name: 'Origem' } },
        { value: 'AD 13', custom_fields: { field_name: 'Anúncio' } },
        { value: null, custom_fields: { field_name: 'Campanha' } }, // null value — dropped
        { value: 'x', custom_fields: null }, // orphaned join — dropped
      ],
    };
    expect(serializeContact(row).custom_fields).toEqual({
      Origem: 'Google Ads',
      Anúncio: 'AD 13',
    });
  });

  it('tolerates a row with no contact_custom_values key', () => {
    const row = {
      id: 'c4',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).custom_fields).toEqual({});
  });
});

describe('findOrCreateContact', () => {
  const noopDb = {} as SupabaseClient;

  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });
});
