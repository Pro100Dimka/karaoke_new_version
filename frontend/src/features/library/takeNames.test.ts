import { describe, expect, it } from "vitest";
import type { RecordingDto } from "../../contracts/models";
import { text } from "../../i18n/messages";
import { defaultTakeName, numberTakes } from "./takeNames";

const take = (id: string, createdAt: string): RecordingDto => ({
  id,
  filePath: "",
  songId: "s",
  displayName: "",
  createdAt,
  durationSeconds: 1,
  sizeBytes: 0,
  analyzed: false,
});

describe("take names", () => {
  it("numbers takes in recording order regardless of list order", () => {
    const numbers = numberTakes([
      take("b", "2026-02-01T10:00:00Z"),
      take("a", "2026-01-01T10:00:00Z"),
    ]);
    expect(numbers.get("a")).toBe(1);
    expect(numbers.get("b")).toBe(2);
  });

  it("formats the default name as Take N · date time in the interface language", () => {
    const createdAt = new Date(2026, 0, 5, 9, 7).toISOString();
    expect(defaultTakeName((key, params) => text("ru", key, params), 3, createdAt)).toBe(
      "Дубль 3 · 2026-01-05 09:07",
    );
    expect(defaultTakeName((key, params) => text("en", key, params), 3, createdAt)).toBe(
      "Take 3 · 2026-01-05 09:07",
    );
  });
});
