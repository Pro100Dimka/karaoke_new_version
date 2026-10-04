import { expect, it } from "vitest";
import { parseServerSentEvents } from "./BackendEvents";

it("parses complete messages, skips heartbeats and keeps a partial message for the next chunk", () => {
  const job = { type: "job.changed", createdAt: "now", data: { jobId: "j1", state: "Running" } };
  const parsed = parseServerSentEvents(`: heartbeat\n\ndata: ${JSON.stringify(job)}\n\ndata: {"type":"job.ch`);
  expect(parsed.events).toEqual([job]);
  expect(parsed.rest).toBe('data: {"type":"job.ch');
  expect(parseServerSentEvents(`${parsed.rest}anged","data":{"jobId":"j2"}}\r\n\r\n`).events)
    .toEqual([{ type: "job.changed", data: { jobId: "j2" } }]);
});

it("ignores malformed and untyped messages", () => {
  expect(parseServerSentEvents('data: not json\n\ndata: {"no":"type"}\n\n').events).toEqual([]);
});
