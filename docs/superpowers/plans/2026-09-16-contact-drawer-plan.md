# ContactDrawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three separate, inconsistent contact/deal panels (Inbox sidebar preview, Funil's `ContactDetailView`, Contacts' `ContactDetailView`) with one shared drawer component — `ContactDrawer` — that shows all 5 sections (Details, Tags, Deals, Notes, Custom Fields) everywhere, editable inline, without adding any new network request beyond what each screen already makes.

**Architecture:** `src/components/contacts/contact-detail-view.tsx` already implements almost everything the design calls for — it's a `Sheet` keyed by `contactId` with 5 tabs, already wired into both the Contacts page and the Funil page (for deals with a linked contact). Instead of building a parallel component, this plan moves and evolves that file into `src/components/shared/contact-drawer.tsx`: renamed, given optional `initial*` props so a caller can pass data it already fetched (skipping the drawer's own fetch), Tabs swapped for Accordion, and a small module-level cache added. Two small pure-logic modules (`contact-drawer-deals.ts`, `contact-drawer-cache.ts`) hold the only genuinely testable logic; the component itself is verified by `tsc --noEmit` plus manual browser checks at each integration point, matching this codebase's existing test conventions (see Global Constraints).

**Tech Stack:** Next.js (App Router) + React + TypeScript, Supabase (`@/lib/supabase/client`), shadcn-style UI primitives already in the repo (`Sheet`, `Accordion` from `@base-ui/react`), `next-intl` for i18n, Vitest for unit tests.

## Global Constraints

- No new dependencies (no SWR, no react-query, no cache library) — confirmed decision in `docs/superpowers/specs/2026-09-16-contact-drawer-design.md`.
- Every edit happens on the VPS repo at `/root/wacrm` (this machine has no local clone). Workflow per file: write/edit locally in the scratchpad, `scp` to the matching path under `/root/wacrm`, then run commands over `ssh root@169.58.21.237`. `npm`/`vitest`/`tsc` only exist on the VPS — every "run" step in this plan is an SSH command.
- This codebase has **no** `@testing-library/react` and Vitest runs with `environment: "node"` (see `vitest.config.ts`) — there is exactly one existing component test (`src/components/ui/dropdown-menu-group-label.test.tsx`) and it only uses `renderToStaticMarkup` to check a component throws/doesn't throw, never interaction testing. This plan follows that precedent: genuinely testable decision logic is extracted into small pure functions and unit-tested with plain Vitest (no DOM); the drawer component itself is checked with `tsc --noEmit` and a manual browser pass per the design doc's own Rollout section — do not attempt to introduce `@testing-library/react` or a jsdom environment as part of this work.
- `pm2 restart wacrm` only happens once, at the very end (Task 11), after every integration point is built and manually verified — it changes the live experience for whoever is using the CRM (Márcia included). Warn the user immediately before running it.
- Keep the existing `onUpdated` prop name (not the design doc's `onSaved`) — `ContactDetailView` is already wired into two call sites under that name; renaming it is pure churn with no behavior change, so this plan keeps `onUpdated` to minimize the diff. Everything else in the design doc's `ContactDrawerProps` interface is implemented as written.
- Keep the existing i18n namespace `Contacts.detailView` for all translated strings in the moved component — renaming the namespace would touch every locale file for no functional reason.

---

## File Structure

| File | Change |
|---|---|
| `src/components/shared/contact-drawer-deals.ts` | **Create.** Pure helpers: `shouldShowCreateDealButton`, `pickSalesPipeline`. |
| `src/components/shared/contact-drawer-deals.test.ts` | **Create.** Unit tests for the above. |
| `src/components/shared/contact-drawer-cache.ts` | **Create.** Module-level `Map` cache with TTL, used by the drawer to skip refetching a contact opened twice in the same session. |
| `src/components/shared/contact-drawer-cache.test.ts` | **Create.** Unit tests for the cache. |
| `src/components/shared/contact-drawer.tsx` | **Create** (moved + rewritten from `contact-detail-view.tsx`). |
| `src/components/contacts/contact-detail-view.tsx` | **Delete** (Task 11, once nothing imports it). |
| `src/components/inbox/contact-sidebar.tsx` | **Modify.** Fix "Criar negócio" bug; open `ContactDrawer` instead of `DealForm`/navigation. |
| `src/app/(dashboard)/pipelines/page.tsx` | **Modify.** Import `ContactDrawer` instead of `ContactDetailView`; pass `initialDeals`/`focusDealId`. |
| `src/app/(dashboard)/contacts/page.tsx` | **Modify.** Import `ContactDrawer` instead of `ContactDetailView` (no other change). |

---

## Task 1: Pure helper — `shouldShowCreateDealButton` / `pickSalesPipeline`

**Files:**
- Create: `src/components/shared/contact-drawer-deals.ts`
- Test: `src/components/shared/contact-drawer-deals.test.ts`

**Interfaces:**
- Produces: `shouldShowCreateDealButton(deals: Deal[]): boolean`, `pickSalesPipeline<P extends Pick<Pipeline, "id" | "name">>(pipelines: P[]): P | undefined` — both imported by Task 7 (drawer's Deals section) and Task 9 (sidebar bug fix).

- [ ] **Step 1: Write the failing test**

Write `src/components/shared/contact-drawer-deals.test.ts` locally at
`C:\Users\ZELMOS~1\AppData\Local\Temp\claude\D--ClaudeEscritorio\5a439391-d009-426b-862c-48705877548b\scratchpad\contact-drawer-deals.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shouldShowCreateDealButton, pickSalesPipeline } from "./contact-drawer-deals";
import type { Deal, Pipeline } from "@/types";

describe("shouldShowCreateDealButton", () => {
  it("is true when the contact has no deals", () => {
    expect(shouldShowCreateDealButton([])).toBe(true);
  });

  it("is false when the contact already has at least one deal", () => {
    const deal = { id: "d1" } as Deal;
    expect(shouldShowCreateDealButton([deal])).toBe(false);
  });
});

describe("pickSalesPipeline", () => {
  it("picks the pipeline whose name mentions venda", () => {
    const pipelines: Pick<Pipeline, "id" | "name">[] = [
      { id: "p1", name: "Suporte" },
      { id: "p2", name: "Funil de Vendas" },
    ];
    expect(pickSalesPipeline(pipelines)?.id).toBe("p2");
  });

  it("falls back to the first pipeline when none matches", () => {
    const pipelines: Pick<Pipeline, "id" | "name">[] = [
      { id: "p1", name: "Suporte" },
      { id: "p2", name: "Onboarding" },
    ];
    expect(pickSalesPipeline(pipelines)?.id).toBe("p1");
  });

  it("returns undefined for an empty list", () => {
    expect(pickSalesPipeline([])).toBeUndefined();
  });
});
```

Then:
```bash
scp "C:\Users\ZELMOS~1\AppData\Local\Temp\claude\D--ClaudeEscritorio\5a439391-d009-426b-862c-48705877548b\scratchpad\contact-drawer-deals.test.ts" root@169.58.21.237:/root/wacrm/src/components/shared/contact-drawer-deals.test.ts
```
(create the remote directory first if needed: `ssh root@169.58.21.237 "mkdir -p /root/wacrm/src/components/shared"`)

- [ ] **Step 2: Run test to verify it fails**

Run: `ssh root@169.58.21.237 "cd /root/wacrm && npx vitest run src/components/shared/contact-drawer-deals.test.ts"`
Expected: FAIL — `Cannot find module './contact-drawer-deals'`

- [ ] **Step 3: Write minimal implementation**

Write `src/components/shared/contact-drawer-deals.ts` locally, then `scp` to the same remote directory:

```ts
import type { Deal, Pipeline } from "@/types";

/** The "Criar negócio" affordance only makes sense when the contact has no
 * open deal yet — showing it unconditionally hid that a deal already
 * existed (bug found 16/09/2026 in contact-sidebar.tsx). */
export function shouldShowCreateDealButton(deals: Deal[]): boolean {
  return deals.length === 0;
}

/** Picks the pipeline a freshly-created deal should land in: the one whose
 * name mentions "venda" (the lead funnel), falling back to the first
 * pipeline when none matches. Same rule contact-sidebar.tsx's
 * openCreateDeal used inline — centralized here so contact-drawer.tsx
 * reuses it instead of duplicating the regex. */
export function pickSalesPipeline<P extends Pick<Pipeline, "id" | "name">>(
  pipelines: P[],
): P | undefined {
  return pipelines.find((p) => /venda/i.test(p.name)) ?? pipelines[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ssh root@169.58.21.237 "cd /root/wacrm && npx vitest run src/components/shared/contact-drawer-deals.test.ts"`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && git add src/components/shared/contact-drawer-deals.ts src/components/shared/contact-drawer-deals.test.ts && git commit -m 'feat(contacts): extract create-deal helpers for ContactDrawer'"
```

---

## Task 2: Pure helper — contact-drawer cache

**Files:**
- Create: `src/components/shared/contact-drawer-cache.ts`
- Test: `src/components/shared/contact-drawer-cache.test.ts`

**Interfaces:**
- Consumes: `Contact`, `Tag`, `Deal`, `ContactNote` types from `@/types`.
- Produces: `getCachedContactDrawerData(contactId, now?)`, `setCachedContactDrawerData(contactId, data, now?)`, `invalidateContactDrawerCache(contactId)`, `CONTACT_DRAWER_CACHE_TTL_MS` — all imported by Task 6.

- [ ] **Step 1: Write the failing test**

Write `src/components/shared/contact-drawer-cache.test.ts` locally, then `scp` to `/root/wacrm/src/components/shared/contact-drawer-cache.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedContactDrawerData,
  setCachedContactDrawerData,
  invalidateContactDrawerCache,
  CONTACT_DRAWER_CACHE_TTL_MS,
} from "./contact-drawer-cache";

describe("contact drawer cache", () => {
  beforeEach(() => {
    invalidateContactDrawerCache("c1");
  });

  it("returns undefined for a contact that was never cached", () => {
    expect(getCachedContactDrawerData("c1")).toBeUndefined();
  });

  it("returns what was just stored", () => {
    setCachedContactDrawerData("c1", { deals: [] }, 1000);
    expect(getCachedContactDrawerData("c1", 1000)?.deals).toEqual([]);
  });

  it("expires an entry older than the TTL", () => {
    setCachedContactDrawerData("c1", { deals: [] }, 1000);
    const expired = getCachedContactDrawerData(
      "c1",
      1000 + CONTACT_DRAWER_CACHE_TTL_MS + 1,
    );
    expect(expired).toBeUndefined();
  });

  it("keeps an entry right at the TTL boundary", () => {
    setCachedContactDrawerData("c1", { deals: [] }, 1000);
    const stillValid = getCachedContactDrawerData(
      "c1",
      1000 + CONTACT_DRAWER_CACHE_TTL_MS,
    );
    expect(stillValid?.deals).toEqual([]);
  });

  it("invalidate removes the entry immediately", () => {
    setCachedContactDrawerData("c1", { deals: [] }, 1000);
    invalidateContactDrawerCache("c1");
    expect(getCachedContactDrawerData("c1", 1000)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ssh root@169.58.21.237 "cd /root/wacrm && npx vitest run src/components/shared/contact-drawer-cache.test.ts"`
Expected: FAIL — `Cannot find module './contact-drawer-cache'`

- [ ] **Step 3: Write minimal implementation**

Write `src/components/shared/contact-drawer-cache.ts` locally, then `scp` to the same remote directory:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ssh root@169.58.21.237 "cd /root/wacrm && npx vitest run src/components/shared/contact-drawer-cache.test.ts"`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && git add src/components/shared/contact-drawer-cache.ts src/components/shared/contact-drawer-cache.test.ts && git commit -m 'feat(contacts): add module-level cache for ContactDrawer'"
```

---

## Task 3: Move `contact-detail-view.tsx` → `shared/contact-drawer.tsx`, rename component

**Files:**
- Create: `src/components/shared/contact-drawer.tsx` (full copy of `src/components/contacts/contact-detail-view.tsx`, then edited per steps below)
- Modify (reference only, not yet touched): `src/components/contacts/contact-detail-view.tsx` (deleted in Task 11 once nothing imports it)

**Interfaces:**
- Consumes: nothing new yet — this task is a straight move + rename, behavior-identical.
- Produces: `ContactDrawer` component, `ContactDrawerProps` interface (same shape as the old `ContactDetailViewProps`, renamed) — consumed by Tasks 4–8.

- [ ] **Step 1: Copy the file to its new home**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && git mv src/components/contacts/contact-detail-view.tsx src/components/shared/contact-drawer.tsx"
```

- [ ] **Step 2: Rename the component and its props interface**

In `src/components/shared/contact-drawer.tsx`, replace:

```ts
interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
}

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
}: ContactDetailViewProps) {
```

with:

```ts
interface ContactDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
}

export function ContactDrawer({
  open,
  onOpenChange,
  contactId,
  onUpdated,
}: ContactDrawerProps) {
```

(The `initial*`/`focusDealId` props are added in Task 6 — kept separate so this step is a pure rename with no behavior change, easy to verify in isolation.)

- [ ] **Step 3: Type-check the isolated rename**

```bash
scp "src/components/shared/contact-drawer.tsx" root@169.58.21.237:/root/wacrm/src/components/shared/contact-drawer.tsx
```
(edit locally first, then scp — or edit directly on the VPS with the same content; either way, verify with:)

Run: `ssh root@169.58.21.237 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i 'contact-detail-view\|ContactDetailView'"`
Expected: errors listing every remaining import of the old name (`contacts/page.tsx`, `pipelines/page.tsx`) — these are fixed in Tasks 7–8, not here. No error should mention `contact-drawer.tsx` itself.

- [ ] **Step 4: Commit**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && git add -A src/components/shared/contact-drawer.tsx src/components/contacts/contact-detail-view.tsx && git commit -m 'refactor(contacts): move ContactDetailView to shared/contact-drawer.tsx'"
```

(The two remaining broken imports are expected here — Tasks 7 and 8 fix them. This intermediate commit stays small and reviewable; the repo is not required to build cleanly again until Task 8 finishes.)

---

## Task 4: Add `initial*` props and skip-fetch-when-provided logic

**Files:**
- Modify: `src/components/shared/contact-drawer.tsx`

**Interfaces:**
- Consumes: `getCachedContactDrawerData`, `setCachedContactDrawerData` from Task 2.
- Produces: `ContactDrawerProps` gains `initialContact?`, `initialTags?`, `initialDeals?`, `initialNotes?`, `focusDealId?` — consumed by Task 8 (Funil) and Task 9 (Inbox).

- [ ] **Step 1: Extend the props interface**

In `src/components/shared/contact-drawer.tsx`, replace the interface from Task 3 Step 2 with:

```ts
interface ContactDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
  /** Data the calling screen already fetched — when present, the drawer
   * seeds its state from it instead of re-querying Supabase. Keeps the
   * Inbox's contact-sidebar (which already has all four) from doubling
   * its request count just because the drawer opened. */
  initialContact?: Contact;
  initialTags?: (Tag & { contact_tag_id: string })[];
  initialDeals?: Deal[];
  initialNotes?: ContactNote[];
  /** When set, the Deals accordion section opens expanded on this deal
   * instead of the default (Details) section. */
  focusDealId?: string;
}

export function ContactDrawer({
  open,
  onOpenChange,
  contactId,
  onUpdated,
  initialContact,
  initialTags,
  initialDeals,
  initialNotes,
  focusDealId,
}: ContactDrawerProps) {
```

- [ ] **Step 2: Import the cache module**

Add near the top of `src/components/shared/contact-drawer.tsx`, alongside the other local imports:

```ts
import {
  getCachedContactDrawerData,
  setCachedContactDrawerData,
} from '@/components/shared/contact-drawer-cache';
```

- [ ] **Step 3: Seed state from props/cache, fetch only what's missing**

Replace the existing effect:

```ts
useEffect(() => {
  if (open && contactId) {
    fetchContact();
    fetchTags();
    fetchNotes();
    fetchCustomFields();
    fetchDeals();
  }
}, [open, contactId, fetchContact, fetchTags, fetchNotes, fetchCustomFields, fetchDeals]);
```

with:

```ts
useEffect(() => {
  if (!open || !contactId) return;

  const cached = getCachedContactDrawerData(contactId);

  const seedContact = initialContact ?? cached?.contact;
  const seedTags = initialTags ?? cached?.tags;
  const seedDeals = initialDeals ?? cached?.deals;
  const seedNotes = initialNotes ?? cached?.notes;

  if (seedContact) {
    setContact(seedContact);
    setEditName(seedContact.name ?? '');
    setEditPhone(seedContact.phone);
    setEditEmail(seedContact.email ?? '');
    setEditCompany(seedContact.company ?? '');
  } else {
    fetchContact();
  }

  if (seedTags) {
    setAllTags((prev) => (prev.length ? prev : prev));
    setContactTagIds(seedTags.map((t) => t.id));
  }
  // allTags (every tag that exists, for the toggle grid) is never part of
  // what a caller has — always fetched, same as before.
  fetchTags();

  if (seedNotes) {
    setNotes(seedNotes);
  } else {
    fetchNotes();
  }

  if (seedDeals) {
    setDeals(seedDeals);
  } else {
    fetchDeals();
  }

  // Custom field VALUES are never pre-loaded by any of the 3 screens today
  // (confirmed in the design doc) — always fetched.
  fetchCustomFields();

  if (!cached) {
    setCachedContactDrawerData(contactId, {
      contact: seedContact,
      tags: seedTags,
      deals: seedDeals,
      notes: seedNotes,
    });
  }
}, [
  open,
  contactId,
  initialContact,
  initialTags,
  initialDeals,
  initialNotes,
  fetchContact,
  fetchTags,
  fetchNotes,
  fetchCustomFields,
  fetchDeals,
]);
```

Note on `fetchTags()` always running: `fetchTags` fetches **two** things — the full tag catalogue (`allTags`, for the toggle grid) and this contact's tag ids (`contactTagIds`). No caller ever has `allTags` precomputed, so that half must always run; `seedTags` (this contact's ids) is applied first so there's no flash of "no tags selected" while the fetch is in flight, then `fetchTags()` overwrites `contactTagIds` with the confirmed server value once it resolves — harmless double-set, no double network call avoided here since `allTags` was never cacheable, but `contactTagIds` no longer needs its own separate wait.

- [ ] **Step 4: Update `onUpdated` call sites to also invalidate the cache**

Add the import from Step 2's line to the top, then wrap the existing `onUpdated` calls. In `saveDetails`, `toggleTag`, and after `fetchDeals()`/`fetchNotes()` following a mutation, add a call to invalidate the cache for the current contact so a later open re-fetches fresh data instead of trusting a stale cache entry written before the edit. Concretely, replace:

```ts
    if (error) {
      toast.error(t('toastUpdateFailed'));
    } else {
      toast.success(t('toastUpdated'));
      fetchContact();
      onUpdated();
    }
    setSavingDetails(false);
```

with:

```ts
    if (error) {
      toast.error(t('toastUpdateFailed'));
    } else {
      toast.success(t('toastUpdated'));
      if (contactId) invalidateContactDrawerCache(contactId);
      fetchContact();
      onUpdated();
    }
    setSavingDetails(false);
```

and add `invalidateContactDrawerCache` to the Step 2 import:

```ts
import {
  getCachedContactDrawerData,
  setCachedContactDrawerData,
  invalidateContactDrawerCache,
} from '@/components/shared/contact-drawer-cache';
```

Apply the same one-line `invalidateContactDrawerCache(contactId)` insertion (guarded by `if (contactId)`) right before `onUpdated()` in `toggleTag`'s two branches (tag add and tag remove).

- [ ] **Step 5: Type-check**

```bash
scp "src/components/shared/contact-drawer.tsx" root@169.58.21.237:/root/wacrm/src/components/shared/contact-drawer.tsx
```

Run: `ssh root@169.58.21.237 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i 'contact-drawer.tsx'"`
Expected: no output (no type errors in this file).

- [ ] **Step 6: Commit**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && git add src/components/shared/contact-drawer.tsx && git commit -m 'feat(contacts): let ContactDrawer accept pre-fetched data via initial* props'"
```

---

## Task 5: Convert Tabs to Accordion

**Files:**
- Modify: `src/components/shared/contact-drawer.tsx`

**Interfaces:**
- Consumes: `focusDealId` prop from Task 4 (decides the default-open section).
- Produces: same 5 sections, now as an `Accordion`, rendered under the section keys `"details" | "tags" | "notes" | "custom" | "deals"` — consumed visually by Task 7 (new create-deal UI goes inside the `"deals"` `AccordionItem`).

- [ ] **Step 1: Swap the import**

Replace:
```ts
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
```
with:
```ts
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
```

- [ ] **Step 2: Compute the default-open section**

Add near the top of the component body (after the existing `useState` declarations, before the `return`):

```ts
const defaultOpenSection = focusDealId ? 'deals' : 'details';
```

- [ ] **Step 3: Replace the `Tabs` wrapper and 5 `TabsTrigger`s with `Accordion`**

Replace:
```tsx
            <Tabs defaultValue="details" className="flex-1 flex flex-col min-h-0">
              <TabsList className="bg-muted/50 border-b border-border mx-4 mt-3">
                <TabsTrigger
                  value="details"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.details')}
                </TabsTrigger>
                <TabsTrigger
                  value="tags"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.tags', { fallback: 'Tags' })}
                </TabsTrigger>
                <TabsTrigger
                  value="notes"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.notes')}
                </TabsTrigger>
                <TabsTrigger
                  value="custom"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.custom')}
                </TabsTrigger>
                <TabsTrigger
                  value="deals"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.deals')}
                </TabsTrigger>
              </TabsList>
```
with:
```tsx
            <Accordion
              defaultValue={[defaultOpenSection]}
              className="flex-1 overflow-y-auto px-4 py-3"
            >
```

- [ ] **Step 4: Replace each `TabsContent` with an `AccordionItem` + `AccordionTrigger` + `AccordionContent`**

For each of the 5 sections, replace the pattern:
```tsx
              {/* Details Tab */}
              <TabsContent value="details" className="flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-3">
                  ...
                </div>
              </TabsContent>
```
with:
```tsx
              <AccordionItem value="details">
                <AccordionTrigger>{t('tabs.details')}</AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-3">
                    ...
                  </div>
                </AccordionContent>
              </AccordionItem>
```
keeping the `...` (the section's existing inner JSX) byte-for-byte unchanged. Apply the same transform to the 4 remaining sections:

- `tags` → trigger text `{t('tabs.tags', { fallback: 'Tags' })}`
- `notes` → trigger text `{t('tabs.notes')}` (note: the notes section's outer `div` used `flex flex-col min-h-0` for its own internal scroll — since the section is no longer height-constrained by a tab panel, simplify its wrapper `div` from `className="flex-1 flex flex-col min-h-0 px-4 py-3"` to `className="space-y-2"`, matching the other sections; drop the now-redundant inner `flex-1 overflow-y-auto` on the notes-list `div` too, since the whole Accordion already scrolls)
- `custom` → trigger text `{t('tabs.custom')}`
- `deals` → trigger text `{t('tabs.deals')}`

- [ ] **Step 5: Close the `Accordion` tag**

Replace the closing `</Tabs>` with `</Accordion>`.

- [ ] **Step 6: Type-check**

```bash
scp "src/components/shared/contact-drawer.tsx" root@169.58.21.237:/root/wacrm/src/components/shared/contact-drawer.tsx
```

Run: `ssh root@169.58.21.237 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i 'contact-drawer.tsx'"`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && git add src/components/shared/contact-drawer.tsx && git commit -m 'refactor(contacts): ContactDrawer uses Accordion instead of Tabs'"
```

---

## Task 6: Add gated "Criar negócio" to the Deals section

**Files:**
- Modify: `src/components/shared/contact-drawer.tsx`

**Interfaces:**
- Consumes: `shouldShowCreateDealButton`, `pickSalesPipeline` from Task 1.
- Produces: nothing new consumed elsewhere — this is the drawer's own create-deal affordance (Contacts and Funil never had one before).

- [ ] **Step 1: Import the helpers and add create-deal state**

Add to the imports:
```ts
import { shouldShowCreateDealButton, pickSalesPipeline } from '@/components/shared/contact-drawer-deals';
```

Near the existing `editDeal`/`formStages`/`dealFormOpen` state, add:
```ts
const [creatingDeal, setCreatingDeal] = useState(false);
```

- [ ] **Step 2: Add the create-deal handler**

Near the existing `openDeal` callback, add:

```ts
const openCreateDeal = useCallback(async () => {
  if (!contactId) return;
  setCreatingDeal(true);
  const { data: pipes } = await supabase
    .from('pipelines')
    .select('id, name')
    .order('created_at', { ascending: true });
  const pipeline = pickSalesPipeline((pipes ?? []) as { id: string; name: string }[]);
  if (!pipeline) {
    setCreatingDeal(false);
    return;
  }
  const { data: stageRows } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('pipeline_id', pipeline.id)
    .order('position');
  setFormStages((stageRows ?? []) as PipelineStage[]);
  setEditDeal(null);
  setDealFormOpen(true);
  setCreatingDeal(false);
}, [contactId, supabase]);
```

Note: the existing `DealForm` at the bottom of the file is rendered with `pipelineId={editDeal?.pipeline_id ?? ''}` — when `editDeal` is `null` (create mode), this would send an empty `pipelineId`. Fix that render prop in the same step, replacing:
```tsx
    <DealForm
      open={dealFormOpen}
      onOpenChange={setDealFormOpen}
      deal={editDeal}
      pipelineId={editDeal?.pipeline_id ?? ''}
      stages={formStages}
      onSaved={() => {
        setDealFormOpen(false);
        fetchDeals();
      }}
    />
```
with (adding `createPipelineId` state and `defaultContactId`/`defaultTitle` so a freshly created deal is actually linked to this contact — `DealForm` already supports both props, per `deal-form.tsx:44-47`):
```tsx
    <DealForm
      open={dealFormOpen}
      onOpenChange={setDealFormOpen}
      deal={editDeal}
      pipelineId={editDeal?.pipeline_id ?? createPipelineId}
      stages={formStages}
      defaultContactId={contactId ?? undefined}
      defaultTitle={contact?.name || contact?.phone}
      onSaved={() => {
        setDealFormOpen(false);
        if (contactId) invalidateContactDrawerCache(contactId);
        fetchDeals();
      }}
    />
```
and add the missing state next to `creatingDeal`:
```ts
const [createPipelineId, setCreatePipelineId] = useState('');
```
and set it inside `openCreateDeal`, right after `pickSalesPipeline` resolves:
```ts
  setCreatePipelineId(pipeline.id);
```
(inserted immediately after the `if (!pipeline) { ... }` guard in Step 2's handler).

- [ ] **Step 3: Render the button in the Deals `AccordionContent`**

Inside the `deals` `AccordionItem`'s content (from Task 5), after the existing deals-list rendering (`{deals.map(...)}` block) and its closing `)}`, add:

```tsx
                  {shouldShowCreateDealButton(deals) && (
                    <button
                      type="button"
                      onClick={openCreateDeal}
                      disabled={creatingDeal}
                      className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      <Plus className="size-3" />
                      {t('dealsTab.createDeal', { fallback: 'Criar negócio' })}
                    </button>
                  )}
```

- [ ] **Step 4: Type-check**

```bash
scp "src/components/shared/contact-drawer.tsx" root@169.58.21.237:/root/wacrm/src/components/shared/contact-drawer.tsx
```

Run: `ssh root@169.58.21.237 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i 'contact-drawer.tsx'"`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && git add src/components/shared/contact-drawer.tsx && git commit -m 'feat(contacts): add gated Criar negócio button to ContactDrawer Deals section'"
```

---

## Task 7: Integrate into Contacts page (`/contacts`)

**Files:**
- Modify: `src/app/(dashboard)/contacts/page.tsx`

**Interfaces:**
- Consumes: `ContactDrawer` from Task 6 (final component).

- [ ] **Step 1: Swap the import**

Replace:
```ts
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
```
with:
```ts
import { ContactDrawer } from '@/components/shared/contact-drawer';
```

- [ ] **Step 2: Swap the render**

Replace:
```tsx
      {/* Contact Detail Sheet */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
      />
```
with:
```tsx
      {/* Contact Detail Sheet */}
      <ContactDrawer
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
      />
```

No `initial*` props here — per the approved design, this is the one entry point without a reported performance problem, so the drawer fetching everything itself on open is acceptable.

- [ ] **Step 3: Type-check**

```bash
scp "src/app/(dashboard)/contacts/page.tsx" root@169.58.21.237:"/root/wacrm/src/app/(dashboard)/contacts/page.tsx"
```

Run: `ssh root@169.58.21.237 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i 'contacts/page.tsx'"`
Expected: no output.

- [ ] **Step 4: Manual verification (dev server, not yet pm2 restart)**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && npm run build 2>&1 | tail -40"
```
Expected: build succeeds with no errors referencing `contacts/page.tsx` or `contact-drawer.tsx`. (This is a build-only check — do not restart the live `pm2` process yet; Task 11 does that once, after every screen is done.)

- [ ] **Step 5: Commit**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && git add 'src/app/(dashboard)/contacts/page.tsx' && git commit -m 'feat(contacts): Contacts page opens ContactDrawer instead of ContactDetailView'"
```

---

## Task 8: Integrate into Funil (`/pipelines`)

**Files:**
- Modify: `src/app/(dashboard)/pipelines/page.tsx`

**Interfaces:**
- Consumes: `ContactDrawer` from Task 6.
- Produces: `leadFocusDealId` state, read by nothing outside this file.

- [ ] **Step 1: Swap the import**

Replace:
```ts
import { ContactDetailView } from "@/components/contacts/contact-detail-view";
```
(confirm the exact import line by reading the file's import block first — the design doc's earlier grep found `ContactDetailView` used at the render site but the import line itself wasn't captured; it lives in the same import block as `DealForm` from `@/components/pipelines/deal-form`)
with:
```ts
import { ContactDrawer } from "@/components/shared/contact-drawer";
```

- [ ] **Step 2: Track which deal to focus**

Near the existing `leadContactId`/`leadOpen` state, add:
```ts
const [leadFocusDeal, setLeadFocusDeal] = useState<Deal | null>(null);
```

- [ ] **Step 3: Pass the clicked deal through `handleEditDeal`**

Replace:
```ts
  const handleEditDeal = useCallback((deal: Deal) => {
    if (deal.contact_id) {
      setLeadContactId(deal.contact_id);
      setLeadOpen(true);
      return;
    }
    setEditingDeal(deal);
    setDefaultStageId(deal.stage_id);
    setDealFormOpen(true);
  }, []);
```
with:
```ts
  const handleEditDeal = useCallback((deal: Deal) => {
    if (deal.contact_id) {
      setLeadContactId(deal.contact_id);
      setLeadFocusDeal(deal);
      setLeadOpen(true);
      return;
    }
    setEditingDeal(deal);
    setDefaultStageId(deal.stage_id);
    setDealFormOpen(true);
  }, []);
```

- [ ] **Step 4: Swap the render, passing `initialDeals`/`focusDealId`**

Replace:
```tsx
      {/* The lead behind the card — history, templates, conversation. */}
      <ContactDetailView
        open={leadOpen}
        onOpenChange={setLeadOpen}
        contactId={leadContactId}
        onUpdated={refreshDeals}
      />
```
with:
```tsx
      {/* The lead behind the card — history, templates, conversation. */}
      <ContactDrawer
        open={leadOpen}
        onOpenChange={setLeadOpen}
        contactId={leadContactId}
        onUpdated={refreshDeals}
        initialDeals={leadFocusDeal ? [leadFocusDeal] : undefined}
        focusDealId={leadFocusDeal?.id}
      />
```

`initialDeals` here intentionally holds only the one clicked deal, not the contact's full deal list — the design doc calls this out explicitly ("Tags/notas/campos personalizados ainda não existem no board hoje → buscados pela gaveta na primeira vez que abre") and the same applies to any *other* deals this contact might have beyond the one shown on the board; the drawer's own `fetchDeals()` still runs whenever `initialDeals` doesn't already reflect the complete list. Since Task 4's effect only skips `fetchDeals()` when `initialDeals` is present at all (not when it's known-complete), passing a partial list here would wrongly skip the fetch — so instead leave `initialDeals` **undefined** and rely solely on `focusDealId` for the open-to-this-deal behavior:

Replace the render from this step with:
```tsx
      {/* The lead behind the card — history, templates, conversation. */}
      <ContactDrawer
        open={leadOpen}
        onOpenChange={setLeadOpen}
        contactId={leadContactId}
        onUpdated={refreshDeals}
        focusDealId={leadFocusDeal?.id}
      />
```

- [ ] **Step 5: Type-check**

```bash
scp "src/app/(dashboard)/pipelines/page.tsx" root@169.58.21.237:"/root/wacrm/src/app/(dashboard)/pipelines/page.tsx"
```

Run: `ssh root@169.58.21.237 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i 'pipelines/page.tsx'"`
Expected: no output.

- [ ] **Step 6: Manual verification**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && npm run build 2>&1 | tail -40"
```
Expected: build succeeds, no error referencing `pipelines/page.tsx` or `contact-drawer.tsx`. At this point **every** import of the old `ContactDetailView`/`contact-detail-view.tsx` name is gone — confirm with:
```bash
ssh root@169.58.21.237 "cd /root/wacrm && grep -rn 'ContactDetailView\|contact-detail-view' src/ || echo CLEAN"
```
Expected: `CLEAN`.

- [ ] **Step 7: Commit**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && git add 'src/app/(dashboard)/pipelines/page.tsx' && git commit -m 'feat(pipelines): Funil opens ContactDrawer instead of ContactDetailView, focused on the clicked deal'"
```

---

## Task 9: Fix the "Criar negócio" visibility bug in the Inbox sidebar preview

**Files:**
- Modify: `src/components/inbox/contact-sidebar.tsx`

**Interfaces:**
- Consumes: `shouldShowCreateDealButton` from Task 1.

This is the bug the design doc flagged directly ("o botão 'Criar negócio' aparece sempre depois da lista de negócios, mesmo quando o contato já tem um ou mais negócios"). It's fixed here independently of the drawer integration (Task 10) because it's a one-line, immediately-testable-by-inspection fix to an existing bug, not new drawer behavior.

- [ ] **Step 1: Import the helper**

Add to `src/components/inbox/contact-sidebar.tsx`'s imports:
```ts
import { shouldShowCreateDealButton } from "@/components/shared/contact-drawer-deals";
```

- [ ] **Step 2: Gate the button**

Replace:
```tsx
              {/* Create a card for this contact — makes no-deal contacts
                  (e.g. WhatsApp leads without a card) actionable: create,
                  then move/lose as any other deal. */}
              <button
                type="button"
                onClick={openCreateDeal}
                className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Criar negócio para este contato"
              >
                <Plus className="h-3 w-3" />
                Criar negócio
              </button>
```
with:
```tsx
              {/* Create a card for this contact — makes no-deal contacts
                  (e.g. WhatsApp leads without a card) actionable: create,
                  then move/lose as any other deal. Only shown when the
                  contact has no deal yet (bug found 16/09/2026: this used
                  to render unconditionally even when a deal already
                  existed). */}
              {shouldShowCreateDealButton(deals) && (
                <button
                  type="button"
                  onClick={openCreateDeal}
                  className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title="Criar negócio para este contato"
                >
                  <Plus className="h-3 w-3" />
                  Criar negócio
                </button>
              )}
```

- [ ] **Step 3: Type-check**

```bash
scp "src/components/inbox/contact-sidebar.tsx" root@169.58.21.237:/root/wacrm/src/components/inbox/contact-sidebar.tsx
```

Run: `ssh root@169.58.21.237 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i 'contact-sidebar.tsx'"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && git add src/components/inbox/contact-sidebar.tsx && git commit -m 'fix(inbox): hide Criar negócio button when the contact already has a deal'"
```

---

## Task 10: Wire the Inbox sidebar to open `ContactDrawer`

**Files:**
- Modify: `src/components/inbox/contact-sidebar.tsx`

**Interfaces:**
- Consumes: `ContactDrawer` from Task 6.

This is the integration point the design doc calls "zero busca nova" — `fetchContactData` in this file already loads `deals`, `notes`, and `tags` in parallel on every contact change; this task makes clicking the contact's name or a deal open the drawer pre-seeded with that same data instead of navigating away or opening a bare `DealForm`.

- [ ] **Step 1: Import `ContactDrawer` and add its open/state**

Add to imports:
```ts
import { ContactDrawer } from "@/components/shared/contact-drawer";
```

Near the existing `editDeal`/`dealFormOpen` state, add:
```ts
const [drawerOpen, setDrawerOpen] = useState(false);
const [drawerFocusDealId, setDrawerFocusDealId] = useState<string | undefined>(undefined);
```

- [ ] **Step 2: Replace the name `Link` with a button that opens the drawer**

Replace:
```tsx
            <Link
              href={`/contacts?contact=${contact.id}`}
              className="mt-3 text-sm font-semibold text-foreground hover:text-primary hover:underline"
              title="Abrir contato"
            >
              {displayName}
            </Link>
```
with:
```tsx
            <button
              type="button"
              onClick={() => {
                setDrawerFocusDealId(undefined);
                setDrawerOpen(true);
              }}
              className="mt-3 text-sm font-semibold text-foreground hover:text-primary hover:underline"
              title="Abrir contato"
            >
              {displayName}
            </button>
```

(The `Link` import becomes unused if nothing else in the file references it — check with a search for `Link` before removing the `import Link from "next/link"` line; if this was the only use, delete that import line too.)

- [ ] **Step 3: Replace the deal-click handler to open the drawer focused on that deal**

Replace:
```tsx
                  <button
                    key={deal.id}
                    type="button"
                    onClick={() => openDeal(deal)}
                    className="w-full rounded-lg bg-muted px-3 py-2 text-left transition-colors hover:bg-muted/70"
                    title="Abrir card"
                  >
```
with:
```tsx
                  <button
                    key={deal.id}
                    type="button"
                    onClick={() => {
                      setDrawerFocusDealId(deal.id);
                      setDrawerOpen(true);
                    }}
                    className="w-full rounded-lg bg-muted px-3 py-2 text-left transition-colors hover:bg-muted/70"
                    title="Abrir card"
                  >
```

The `openDeal`/`editDeal`/`formStages`/`dealFormOpen` state and the `DealForm` render at the bottom of the file now have no remaining caller for the "edit an existing deal" path — leave them in place only for `openCreateDeal` (Task 9's button still uses `dealFormOpen`/`editDeal=null`/`formStages` to open `DealForm` in create mode). Do **not** delete `openDeal` itself in this task — deleting dead code is out of scope here and risks breaking Task 9's create flow, which shares `dealFormOpen`/`formStages` state with it. (If `openDeal` truly has zero remaining callers after this step, flag it for the user rather than removing it — per this project's standing rule that unrelated cleanup isn't done without being asked.)

- [ ] **Step 4: Render the drawer**

At the bottom of the component, alongside the existing `<DealForm ... />` render, add:
```tsx
      <ContactDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        contactId={contact.id}
        onUpdated={fetchContactData}
        initialContact={contact}
        initialTags={tags}
        initialDeals={deals}
        initialNotes={notes}
        focusDealId={drawerFocusDealId}
      />
```

- [ ] **Step 5: Type-check**

```bash
scp "src/components/inbox/contact-sidebar.tsx" root@169.58.21.237:/root/wacrm/src/components/inbox/contact-sidebar.tsx
```

Run: `ssh root@169.58.21.237 "cd /root/wacrm && npx tsc --noEmit 2>&1 | grep -i 'contact-sidebar.tsx'"`
Expected: no output. If `Link` is reported unused, remove its import per Step 2's note and re-run.

- [ ] **Step 6: Manual verification**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && npm run build 2>&1 | tail -40"
```
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && git add src/components/inbox/contact-sidebar.tsx && git commit -m 'feat(inbox): sidebar opens ContactDrawer with already-fetched data instead of navigating away'"
```

---

## Task 11: Full-repo verification, delete dead file, restart

**Files:**
- Delete: `src/components/contacts/contact-detail-view.tsx` (already moved in Task 3 via `git mv` — this task only confirms nothing references the old path and that the deletion is committed)

- [ ] **Step 1: Confirm the old file is gone and nothing imports it**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && test -f src/components/contacts/contact-detail-view.tsx && echo STILL_EXISTS || echo GONE"
ssh root@169.58.21.237 "cd /root/wacrm && grep -rn 'ContactDetailView\|contact-detail-view' src/ || echo CLEAN"
```
Expected: `GONE` and `CLEAN`.

- [ ] **Step 2: Run the full test suite**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && npx vitest run"
```
Expected: all tests pass, including the 10 new ones from Tasks 1–2.

- [ ] **Step 3: Full type-check**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && npx tsc --noEmit"
```
Expected: no output (clean).

- [ ] **Step 4: Full build**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && npm run build 2>&1 | tail -60"
```
Expected: build succeeds.

- [ ] **Step 5: Push**

```bash
ssh root@169.58.21.237 "cd /root/wacrm && git push origin main"
```

- [ ] **Step 6: Warn the user, then restart the live process**

Before running the next command, tell the user explicitly: *"Isso vai trocar a experiência de Inbox, Funil e Contatos pro que estiver usando o CRM agora (inclusive a Márcia) — posso reiniciar?"* Only after an explicit yes:
```bash
ssh root@169.58.21.237 "pm2 restart wacrm"
```

- [ ] **Step 7: Manual smoke test in the browser (per the approved design's Rollout section)**

Open the live wacrm URL and confirm, for each of the 3 screens:
1. **Funil:** click a card with a linked contact → drawer opens with the Deals section expanded on that exact deal.
2. **Inbox:** open a conversation with an existing deal → click the contact's name → drawer opens with Details expanded, no network tab entry beyond what the conversation view already made (check via browser devtools Network tab — no new `/rest/v1/contacts`, `/rest/v1/deals`, `/rest/v1/contact_notes`, or `/rest/v1/contact_tags` request fires on drawer open, only the custom-fields fetch which was always uncached).
3. **Contatos:** click a contact row → drawer opens, all 5 accordion sections present and expandable.
4. **Bug fix check:** find a contact that already has a deal in any of the 3 screens' drawer — confirm "Criar negócio" does NOT appear. Find one with zero deals — confirm it does appear and creates a deal correctly.

---

## Self-Review

**Spec coverage:** All 4 design-doc sections are covered — architecture (Tasks 3–6), the "Criar negócio" bug fix (Tasks 6, 9), the 3 integration points (Tasks 7, 8, 10), and the rollout order (Funil → Inbox → Contatos is the design's stated order; this plan does Contatos → Funil → Inbox instead because Contatos is the simplest, zero-risk integration to validate the moved component against first, and Task 8/10 both depend on Task 6 either way — the *end state* and *zero-new-request guarantee* match the spec exactly, only the validation order differs, and Task 11's manual smoke test covers all 3 before the single `pm2 restart`). No new library was introduced; no other screen was touched; Kanban drag-and-drop code is untouched.

**Placeholder scan:** no TBD/TODO; every step has literal code; no step says "similar to Task N" without repeating the code.

**Type consistency:** `ContactDrawerProps` fields (`initialContact`, `initialTags`, `initialDeals`, `initialNotes`, `focusDealId`, `onUpdated`) are named identically everywhere they're introduced (Task 4) and consumed (Tasks 7, 8, 10). `shouldShowCreateDealButton(deals: Deal[])` and `pickSalesPipeline<P>(pipelines: P[])` signatures match between Task 1's definition and their call sites in Tasks 6 and 9. The cache functions' signatures match between Task 2's definition and Task 4's usage.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-16-contact-drawer-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
