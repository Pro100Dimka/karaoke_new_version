import assert from "node:assert/strict";
import test from "node:test";
import { maximumActiveLateCutDelta, phaseAtSecond, roomE2eLiveDelay, toneContinuity, toneLevel, validateNegotiation } from "./multi-electron-room-plan.mjs";

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

test("final PCM tone level measures personal volume attenuation", () => {
  const rate = 48_000, frequency = 941;
  const samples = Float64Array.from({ length: rate * 2 }, (_, frame) => {
    const gain = frame < rate ? 0.8 : 0.2;
    return gain * Math.sin(2 * Math.PI * frequency * frame / rate);
  });
  const loud = toneLevel(samples, rate, frequency, 0, 1);
  const quiet = toneLevel(samples, rate, frequency, 1, 2);
  assert.ok(loud > 0.79 && loud < 0.81);
  assert.ok(quiet > 0.19 && quiet < 0.21);
});

test("the production room test accepts only a safe explicit live deadline", () => {
  assert.equal(roomE2eLiveDelay(["--live-delay=45"]), 45);
  assert.equal(roomE2eLiveDelay([]), 80);
  assert.throws(() => roomE2eLiveDelay(["--live-delay=9"]), /live delay/i);
  assert.throws(() => roomE2eLiveDelay(["--live-delay=81"]), /live delay/i);
});

test("reconnect recovery cuts are reported without hiding cuts during active singing", () => {
  const samples = [
    { phase: "A_TO_B", cuts: 2 },
    { phase: "A_TO_B", cuts: 5 },
    { phase: "RECONNECT_B", cuts: 105 },
    { phase: "RECOVERY", cuts: 205 },
    { phase: "A_TO_B", cuts: 207 },
    { phase: "A_TO_B", cuts: 211 },
  ];
  assert.equal(maximumActiveLateCutDelta(samples, item => item.cuts), 4);
  samples.push({ phase: "BOTH", cuts: 230 });
  assert.equal(maximumActiveLateCutDelta(samples, item => item.cuts), 19);
});
