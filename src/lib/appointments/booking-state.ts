export type BookingOwner = 'flow' | 'legacy' | 'human'
export type BookingStatus = 'active' | 'confirmed' | 'cancelled' | 'rescheduled' | 'completed'

type Db = { from: (table: string) => any }

export async function upsertBookingState(
  db: Db,
  input: {
    accountId: string
    contactId: string
    dealId?: string | null
    bookingUid: string
    scheduledAt?: string | null
    owner: BookingOwner
    status?: BookingStatus
    eventId?: string | null
  },
) {
  const now = new Date().toISOString()
  const { error } = await db.from('booking_states').upsert(
    {
      account_id: input.accountId,
      contact_id: input.contactId,
      deal_id: input.dealId ?? null,
      booking_uid: input.bookingUid,
      scheduled_at: input.scheduledAt ?? null,
      owner: input.owner,
      status: input.status ?? 'active',
      last_event_id: input.eventId ?? null,
      updated_at: now,
    },
    { onConflict: 'account_id,booking_uid' },
  )
  if (error) console.error('[booking-state] upsert failed:', error.message)
  return { ok: !error, error: error?.message ?? null }
}

export async function markBookingConfirmed(
  db: Db,
  accountId: string,
  contactId: string,
  bookingUid?: string | null,
) {
  let q = db
    .from('booking_states')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .in('status', ['active', 'confirmed'])
  if (bookingUid) q = q.eq('booking_uid', bookingUid)
  const { error } = await q
  return { ok: !error, error: error?.message ?? null }
}

export async function markBookingCancelled(
  db: Db,
  accountId: string,
  contactId: string,
  bookingUid: string | null | undefined,
  reason: string,
) {
  let q = db
    .from('booking_states')
    .update({ status: 'cancelled', cancellation_reason: reason, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .in('status', ['active', 'confirmed'])
  if (bookingUid) q = q.eq('booking_uid', bookingUid)
  const { error } = await q
  return { ok: !error, error: error?.message ?? null }
}

export async function markBookingRescheduled(
  db: Db,
  accountId: string,
  contactId: string,
  bookingUid: string | null | undefined,
) {
  let q = db
    .from('booking_states')
    .update({ status: 'rescheduled', cancellation_reason: 'calcom_rescheduled', updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .in('status', ['active', 'confirmed'])
  if (bookingUid) q = q.eq('booking_uid', bookingUid)
  const { error } = await q
  return { ok: !error, error: error?.message ?? null }
}
