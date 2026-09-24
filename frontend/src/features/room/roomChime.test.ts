import { describe, expect, it } from "vitest";
import { roomChimeKinds } from "./roomChime";

describe("room chimes", () => {
  it("selects the matching sound for joins and leaves without conflating them", () => {
    expect(roomChimeKinds({ joined: 1, left: 0 })).toEqual(["join"]);
    expect(roomChimeKinds({ joined: 0, left: 2 })).toEqual(["leave"]);
    expect(roomChimeKinds({ joined: 1, left: 1 })).toEqual(["join", "leave"]);
    expect(roomChimeKinds({ joined: 0, left: 0 })).toEqual([]);
  });
});
