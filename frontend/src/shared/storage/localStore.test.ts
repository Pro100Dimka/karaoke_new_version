import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasKeyWithPrefix, isRecord, readJson, removeKey, storageKey, writeJson } from "./localStore";

describe("localStore", () => {
  beforeEach(() => window.localStorage.clear());

  it("namespaces and versions keys", () => {
    expect(storageKey("takeNames")).toBe("adVoice.takeNames.v1");
    expect(storageKey("takeNames", 2)).toBe("adVoice.takeNames.v2");
  });

  it("round-trips JSON and removes it", () => {
    writeJson("k", { a: 1 });
    expect(readJson("k")).toEqual({ a: 1 });
    removeKey("k");
    expect(readJson("k")).toBeNull();
  });

  it("treats corrupt JSON as nothing stored", () => {
    window.localStorage.setItem("k", "{broken");
    expect(readJson("k")).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeJson("k", 1)).not.toThrow();
    vi.restoreAllMocks();
  });

  it("finds keys by prefix and recognises plain records", () => {
    writeJson("adVoice.draft.1", {});
    expect(hasKeyWithPrefix("adVoice.draft.")).toBe(true);
    expect(hasKeyWithPrefix("other.")).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord({})).toBe(true);
  });
});
