import { describe, expect, it } from "vitest";
import { dragLeavesBoundary } from "./fileDrag";

describe("library file drag boundary", () => {
  it("clears the import overlay only when the file leaves the whole page", () => {
    const page = document.createElement("main");
    const card = document.createElement("article");
    page.append(card);

    expect(dragLeavesBoundary(page, card)).toBe(false);
    expect(dragLeavesBoundary(page, null)).toBe(true);
    expect(dragLeavesBoundary(page, document.body)).toBe(true);
  });
});
