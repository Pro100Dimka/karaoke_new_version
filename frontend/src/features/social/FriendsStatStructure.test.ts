import { describe, expect, it } from "vitest";
import source from "./FriendsStat.tsx?raw";

describe("FriendsStat", () => {
  it("is the library's stat tile with the friends icon", () => {
    expect(source).toMatch(/<StatTile\s+icon="users"/);
    expect(source).not.toContain("lucide-react");
  });
});
