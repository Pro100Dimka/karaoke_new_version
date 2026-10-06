import { describe, expect, it } from "vitest";
import type { SocialPerson } from "../../contracts/social";
import { durationText, presenceText, since } from "./socialFormat";

const t = (key: string, params: Record<string, string | number> = {}) =>
  `${key}${Object.entries(params)
    .map(([name, value]) => `:${name}=${value}`)
    .join("")}`;
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
    expect(presenceText(person("InRoom"), t, "en")).toBe("presenceInRoom");
    expect(presenceText(person("Offline"), t, "en")).toBe("presenceOffline");
    expect(
      presenceText(person("Offline", new Date().toISOString()), t, "en"),
    ).toMatch(/^lastSeen:when=/);
  });

  it("gives a room stay in minutes, and in hours with minutes once past an hour", () => {
    expect(durationText(20, t)).toBe("durationMinutes:minutes=1");
    expect(durationText(45 * 60, t)).toBe("durationMinutes:minutes=45");
    expect(durationText(95 * 60, t)).toBe(
      "durationHoursMinutes:hours=1:minutes=35",
    );
  });
});
