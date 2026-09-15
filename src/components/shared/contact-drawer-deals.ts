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
