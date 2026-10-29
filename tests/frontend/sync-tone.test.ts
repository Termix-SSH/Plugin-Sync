import { describe, expect, it } from "vitest";
import { syncTone } from "../../src/frontend/sync/use-sync-status";

describe("sync rail dot", () => {
  it("shows nothing when not linked", () => {
    expect(syncTone(null)).toBeNull();
    expect(syncTone({ linked: false, status: "idle" })).toBeNull();
  });

  it("is green while connected and red when cut off", () => {
    expect(syncTone({ linked: true, status: "idle" })).toBe("ok");
    expect(syncTone({ linked: true, status: "syncing" })).toBe("ok");
    expect(syncTone({ linked: true, status: "offline" })).toBe("error");
    expect(syncTone({ linked: true, status: "signed_out" })).toBe("error");
    expect(syncTone({ linked: true, status: "error" })).toBe("warning");
  });
});
