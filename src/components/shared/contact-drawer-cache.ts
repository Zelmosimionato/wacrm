import type { Contact, ContactNote, Deal, Tag } from "@/types";

export interface ContactDrawerCacheEntry {
  contact?: Contact;
  tags?: (Tag & { contact_tag_id: string })[];
  deals?: Deal[];
  notes?: ContactNote[];
  fetchedAt: number;
}

const cache = new Map<string, ContactDrawerCacheEntry>();

/** How long a cached entry is trusted before the drawer refetches — long
 * enough to skip a refetch if the same contact is opened twice in one
 * session, short enough that data from an earlier visit doesn't linger. */
export const CONTACT_DRAWER_CACHE_TTL_MS = 60_000;

export function getCachedContactDrawerData(
  contactId: string,
  now: number = Date.now(),
): ContactDrawerCacheEntry | undefined {
  const entry = cache.get(contactId);
  if (!entry) return undefined;
  if (now - entry.fetchedAt > CONTACT_DRAWER_CACHE_TTL_MS) {
    cache.delete(contactId);
    return undefined;
  }
  return entry;
}

export function setCachedContactDrawerData(
  contactId: string,
  data: Omit<ContactDrawerCacheEntry, "fetchedAt">,
  now: number = Date.now(),
): void {
  cache.set(contactId, { ...data, fetchedAt: now });
}

export function invalidateContactDrawerCache(contactId: string): void {
  cache.delete(contactId);
}
