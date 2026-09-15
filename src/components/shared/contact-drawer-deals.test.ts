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
