import assert from "node:assert/strict";
import test from "node:test";
import { createImpairment, createImpairmentSequence, latencyAt } from "./network-impairment.mjs";

test("local two-PC impairment replays exactly one seeded network sequence", () => {
  const profile = { latencyMs: 65, jitterMs: 12, loss: 0.01, duplicate: 0.001 };
  assert.deepEqual(createImpairmentSequence(profile, 12345, 1000),
                   createImpairmentSequence(profile, 12345, 1000));
});

test("local two-PC impairment models a latency jump and recovery", () => {
  const stages = [
    { untilMs: 10_000, latencyMs: 20 },
    { untilMs: 20_000, latencyMs: 100 },
    { untilMs: Number.POSITIVE_INFINITY, latencyMs: 30 }
  ];
  assert.deepEqual(
    [latencyAt(stages, 5_000), latencyAt(stages, 15_000), latencyAt(stages, 25_000)],
    [20, 100, 30]
  );
});

test("local two-PC impairment deterministically models packet reordering", () => {
  const profile = { latencyMs: 20, jitterMs: 0, loss: 0, duplicate: 0, reorder: 1 };
  const [packet] = createImpairmentSequence(profile, 12345, 1);
  assert.equal(packet.reordered, true);
  assert.ok(packet.delayMs > profile.latencyMs);
});

test("a ten-second network outage drops every packet and then recovers", () => {
  const impairment = createImpairment({
    stages: [{ untilMs: Number.POSITIVE_INFINITY, latencyMs: 20 }],
    jitterMs: 0, loss: 0, duplicate: 0,
    outages: [{ fromMs: 1_000, untilMs: 11_000 }]
  }, 12345);
  assert.equal(impairment(999).dropped, false);
  assert.equal(impairment(1_000).dropped, true);
  assert.equal(impairment(10_999).dropped, true);
  assert.equal(impairment(11_000).dropped, false);
});

test("burst loss drops consecutive packets instead of independent random packets", () => {
  const impairment = createImpairment({
    stages: [{ untilMs: Number.POSITIVE_INFINITY, latencyMs: 20 }],
    jitterMs: 0, loss: 0, duplicate: 0,
    burstLoss: { everyPackets: 10, lengthPackets: 4 }
  }, 12345);
  const dropped = Array.from({ length: 20 }, (_, index) => impairment(index * 5).dropped);
  assert.deepEqual(dropped, [
    true, true, true, true, false, false, false, false, false, false,
    true, true, true, true, false, false, false, false, false, false
  ]);
});

test("clock drift, latency jump, jitter and loss coexist in one deterministic profile", () => {
  const profile = {
    stages: [{ untilMs: 1_000, latencyMs: 20 }, { untilMs: 2_000, latencyMs: 100 },
      { untilMs: Number.POSITIVE_INFINITY, latencyMs: 30 }],
    jitterMs: 10, loss: 0.05, duplicate: 0.01, driftPpm: 100
  };
  const first = createImpairment(profile, 777);
  const second = createImpairment(profile, 777);
  const a = [500, 1_500, 2_500].map(time => first(time));
  const b = [500, 1_500, 2_500].map(time => second(time));
  assert.deepEqual(a, b);
  assert.ok(a[1].delayMs > a[0].delayMs && a[2].clockSkewMs > a[0].clockSkewMs);
});

test("opposite directions can use strongly asymmetric routes", () => {
  const outbound = createImpairment({
    stages: [{ untilMs: Number.POSITIVE_INFINITY, latencyMs: 15 }],
    jitterMs: 0, loss: 0, duplicate: 0
  }, 1);
  const inbound = createImpairment({
    stages: [{ untilMs: Number.POSITIVE_INFINITY, latencyMs: 180 }],
    jitterMs: 0, loss: 0, duplicate: 0
  }, 2);
  assert.equal(outbound(0).delayMs, 15);
  assert.equal(inbound(0).delayMs, 180);
});

test("a scheduled CPU stall delays packets by 20 to 500 milliseconds and recovers", () => {
  const impairment = createImpairment({
    stages: [{ untilMs: Number.POSITIVE_INFINITY, latencyMs: 20 }],
    jitterMs: 0, loss: 0, duplicate: 0,
    stalls: [{ fromMs: 1_000, untilMs: 1_500, delayMs: 500 }]
  }, 12345);
  assert.equal(impairment(999).delayMs, 20);
  assert.equal(impairment(1_000).delayMs, 520);
  assert.equal(impairment(1_499).delayMs, 520);
  assert.equal(impairment(1_500).delayMs, 20);
});

test("bandwidth shaping creates a bounded busy-Wi-Fi queue", () => {
  const impairment = createImpairment({
    stages: [{ untilMs: Number.POSITIVE_INFINITY, latencyMs: 20 }],
    jitterMs: 0, loss: 0, duplicate: 0,
    bandwidthKbps: 32, queueLimitMs: 100
  }, 12345);
  const packets = Array.from({ length: 12 }, () => impairment(0, 400));
  assert.ok(packets.some(packet => packet.queueDelayMs > 0));
  assert.ok(packets.some(packet => packet.queueOverflow));
  assert.ok(Math.max(...packets.map(packet => packet.queueDelayMs)) <= 100);
});

test("fault injection marks corrupted, stale and wrong-token packets deterministically", () => {
  const impairment = createImpairment({
    stages: [{ untilMs: Number.POSITIVE_INFINITY, latencyMs: 20 }],
    jitterMs: 0, loss: 0, duplicate: 0,
    corrupt: 1, stale: 1, wrongToken: 1
  }, 12345);
  const packet = impairment(0);
  assert.equal(packet.corrupted, true);
  assert.equal(packet.stale, true);
  assert.equal(packet.wrongToken, true);
});
