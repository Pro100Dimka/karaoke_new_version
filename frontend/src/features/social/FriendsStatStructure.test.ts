import { describe, expect, it } from "vitest";
import source from "./FriendsStat.tsx?raw";

describe("FriendsStat", () => {
  it("uses the string icon contract expected by StatCard", () => {
    expect(source).toContain('<StatCard icon="users"');
    expect(source).not.toContain("lucide-react");
  });
});
