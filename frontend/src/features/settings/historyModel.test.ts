import { describe, expect, it } from "vitest";
import type { HistoryEventDto } from "../../contracts/models";
import { eventsForTab } from "./historyModel";

const event = (kind: string): HistoryEventDto => ({ id: kind, kind, createdAt: "2026-01-01T00:00:00Z" });

describe("eventsForTab", () => {
  it("splits product events into performances and processing and drops the rest", () => {
    const all = [event("RecordingRegistered"), event("ProcessingFailed"), event("PackageImported")];

    expect(eventsForTab(all, "performances").map(item => item.kind)).toEqual(["RecordingRegistered"]);
    expect(eventsForTab(all, "processing").map(item => item.kind)).toEqual(["ProcessingFailed"]);
  });
});
