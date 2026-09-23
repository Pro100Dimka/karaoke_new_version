import { describe, expect, it } from "vitest";
import { opensWithFullIntroduction } from "./karaokeOpenMode";

describe("karaoke open mode presentation", () => {
  it.each(["AutoStart", "RoomPrepared"] as const)(
    "uses the complete intro and curtain lifecycle for %s",
    mode => expect(opensWithFullIntroduction(mode)).toBe(true)
  );

  it("keeps a direct normal open immediately interactive", () => {
    expect(opensWithFullIntroduction("Normal")).toBe(false);
  });
});
