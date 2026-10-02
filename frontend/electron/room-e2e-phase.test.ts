import { describe, expect, it } from "vitest";
import { classifyLateCutPhase } from "./room-e2e-phase.mjs";

describe("classifyLateCutPhase", () => {
  it("keeps the final drain window separate from active performance", () => {
    expect(classifyLateCutPhase(48_000, 4)).toBe("ACTIVE");
    expect(classifyLateCutPhase(191_999, 4)).toBe("DRAIN");
  });
});
