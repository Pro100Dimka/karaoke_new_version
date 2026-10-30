import { describe, expect, it } from "vitest";
import type { SocialPerson } from "../../contracts/social";
import { durationText, presenceText, since } from "./socialFormat";

const person = (
  presence: SocialPerson["presence"],
  lastSeenAt: string | null = null,
): SocialPerson => ({
  accountId: "a",
  displayName: "Anna",
  avatarVersion: 0,
  presence,
  roomId: null,
  lastSeenAt,
  relation: "Friend",
});

describe("friends formatting", () => {
  it("says how long ago someone was last seen, in the app's language", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(since("2026-09-30T11:55:00Z", "en", now)).toBe("5 minutes ago");
    expect(since("2026-09-29T12:00:00Z", "en", now)).toBe("yesterday");
  });

  it("shows presence, and the last visit only for someone offline", () => {
    expect(presenceText(person("InRoom"), "en")).toBe("В комнате");
    expect(presenceText(person("Offline"), "en")).toBe("Не в сети");
    expect(
      presenceText(person("Offline", new Date().toISOString()), "en"),
    ).toMatch(/^Был/);
  });

  it("gives a room stay in minutes, and in hours with minutes once past an hour", () => {
    expect(durationText(20)).toBe("1 мин");
    expect(durationText(45 * 60)).toBe("45 мин");
    expect(durationText(95 * 60)).toBe(
      "1 ч 35 мин",
    );
  });
});
