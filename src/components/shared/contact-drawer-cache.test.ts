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
