import assert from "node:assert/strict";
import test from "node:test";
import { phaseAtSecond, toneContinuity, validateNegotiation } from "./multi-electron-room-plan.mjs";

test("the 60-second room scenario exercises both directions, simultaneous singing, and reconnect", () => {
  assert.deepEqual([5, 15, 25, 30, 40, 50, 58].map(phaseAtSecond), [
    "A_TO_B", "B_TO_A", "BOTH", "RECONNECT_B", "A_TO_B", "B_TO_A", "BOTH",
  ]);
});

test("production negotiation rejects the historic 160-to-10ms fallback", () => {
  assert.throws(() => validateNegotiation({
    publishedA: 160, publishedB: 160, selected: 10, appliedA: 10, appliedB: 10,
  }), /unsafe.*10 ms/i);
  assert.doesNotThrow(() => validateNegotiation({
    publishedA: 160, publishedB: 160, selected: 80, appliedA: 80, appliedB: 80,
  }));
});

test("final PCM continuity survives a short phase discontinuity but exposes sustained silence", () => {
  const rate = 48_000, frequency = 697;
  const samples = Float64Array.from({ length: rate }, (_, frame) => {
    const phase = frame >= rate / 2 ? Math.PI : 0;
    return Math.sin(2 * Math.PI * frequency * frame / rate + phase);
  });
  assert.ok(toneContinuity(samples, rate, frequency, 0, 1) > 0.95);

  samples.fill(0, Math.floor(rate * 0.3), Math.floor(rate * 0.7));
  assert.ok(toneContinuity(samples, rate, frequency, 0, 1) < 0.7);
});
