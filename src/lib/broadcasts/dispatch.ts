import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  resolveVariables,
  type VariableMapping,
} from '@/lib/broadcasts/resolve-variables';
import { sendTemplateToRecipient } from '@/lib/whatsapp/send-recipient';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value, so the send loop never
 * does an N+1 lookup.
 */
async function fetchCustomValueIndex(
  sb: SupabaseClient,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await sb
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

// Single-flight guard. The scheduler ticks every 60 s, but a large
// paced broadcast can run for much longer than one tick — this keeps a
// second tick from double-sending the same pending rows.
let running = false;

/**
 * Entry point for the in-app scheduler (see src/instrumentation.ts).
 * Picks up every broadcast that is due and drives it to completion,
 * one message at a time, pausing a random interval between sends.
 */
export async function dispatchDueBroadcasts(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const sb = supabaseAdmin();
    const nowIso = new Date().toISOString();

    const ids = new Set<string>();

    // 1) Scheduled broadcasts whose time has arrived.
    const { data: due } = await sb
      .from('broadcasts')
      .select('id')
      .eq('status', 'scheduled')
      .lte('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: true });
    for (const b of due ?? []) ids.add(b.id);

    // 2) Resume anything left mid-flight (e.g. a process restart during
    //    a long paced send) so its pending recipients still go out.
    const { data: resuming } = await sb
      .from('broadcasts')
      .select('id')
      .eq('status', 'sending');
    for (const b of resuming ?? []) ids.add(b.id);

    for (const id of ids) {
      try {
        await processBroadcast(sb, id);
      } catch (err) {
        console.error(`[dispatch] broadcast ${id} failed:`, err);
      }
    }
  } finally {
    running = false;
  }
}

async function processBroadcast(
  sb: SupabaseClient,
  broadcastId: string,
): Promise<void> {
  // Claim: flip scheduled → sending (no-op if already sending).
  await sb
    .from('broadcasts')
    .update({ status: 'sending' })
    .eq('id', broadcastId)
    .eq('status', 'scheduled');

  const { data: b } = await sb
    .from('broadcasts')
    .select('*')
    .eq('id', broadcastId)
    .single();
  if (!b) return;

  const { data: config } = await sb
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', b.account_id)
    .single();
  if (!config) {
    await sb.from('broadcasts').update({ status: 'failed' }).eq('id', b.id);
    return;
  }
  const accessToken = decrypt(config.access_token);

  // Load the template row once so sendTemplateMessage can build
  // header + button components for each recipient.
  const { data: templateRow } = await sb
    .from('message_templates')
    .select('*')
    .eq('account_id', b.account_id)
    .eq('name', b.template_name)
    .eq('language', b.template_language || 'en_US')
    .maybeSingle();

  const { data: recipients } = await sb
    .from('broadcast_recipients')
    .select('*, contact:contacts(*)')
    .eq('broadcast_id', b.id)
    .eq('status', 'pending');

  if (!recipients || recipients.length === 0) {
    await finalize(sb, b.id);
    return;
  }

  const contactIds = recipients
    .map((r) => r.contact?.id)
    .filter((id: unknown): id is string => Boolean(id));
  const customIndex = await fetchCustomValueIndex(sb, contactIds);

  // Random pause between individual sends, in seconds.
  const minS = Number(b.send_interval_min_seconds ?? 0);
  const maxS = Number(b.send_interval_max_seconds ?? 0);
  const lo = Math.max(0, Math.min(minS, maxS));
  const hi = Math.max(lo, Math.max(minS, maxS));

  const variables = (b.template_variables ?? {}) as Record<
    string,
    VariableMapping
  >;

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const phone = r.contact?.phone as string | undefined;
    if (!phone) {
      await sb
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: 'No phone number on contact' })
        .eq('id', r.id);
      continue;
    }

    const params = resolveVariables(
      variables,
      r.contact,
      customIndex.get(r.contact.id),
    );

    const res = await sendTemplateToRecipient({
      phoneNumberId: config.phone_number_id,
      accessToken,
      phone,
      contactId: r.contact.id,
      templateName: b.template_name,
      language: b.template_language || 'en_US',
      templateRow: templateRow ?? undefined,
      params,
    });

    if ('messageId' in res) {
      await sb
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: res.messageId,
          error_message: null,
        })
        .eq('id', r.id);
    } else {
      await sb
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: res.error })
        .eq('id', r.id);
    }

    // Pace: sleep a random lo–hi seconds before the next send.
    if (i < recipients.length - 1 && hi > 0) {
      const wait = lo + Math.random() * (hi - lo);
      await sleep(Math.round(wait * 1000));
    }
  }

  await finalize(sb, b.id);
}

/**
 * Flip a broadcast to its terminal status once no pending recipients
 * remain. Aggregate counts are maintained by the DB trigger (migrations
 * 003 / 005), so we only decide sent vs failed here.
 */
async function finalize(sb: SupabaseClient, broadcastId: string): Promise<void> {
  const { data: b } = await sb
    .from('broadcasts')
    .select('total_recipients, failed_count')
    .eq('id', broadcastId)
    .single();
  const total = Number(b?.total_recipients ?? 0);
  const failed = Number(b?.failed_count ?? 0);
  const finalStatus = total > 0 && failed >= total ? 'failed' : 'sent';
  await sb
    .from('broadcasts')
    .update({ status: finalStatus })
    .eq('id', broadcastId);
}
