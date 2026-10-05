import { describe, expect, it } from "vitest";
import type { MusicState } from "./musicPulse";
import type { PerformanceEvent } from "./performanceTracker";
import { ambientFor, VisualDirector, type DirectorContext } from "./visualDirector";

const music = (intensity = 1): MusicState => ({ kick: 0, snare: 0, air: 0, intensity, pause: false, beatPeriod: 0.5 });
const context = (energy: number, streakSeconds = 0, untilBeat?: number): DirectorContext => ({ energy, streakSeconds, music: music(), untilBeat });
const note = (score: number, duration = 0.4): PerformanceEvent => ({
  kind: "noteCompleted",
  note: { id: "n", start: 0, end: duration, pitch: 60 },
  score: { pitchAccuracy: score, voicedCoverage: 1, holdStability: 1, finalScore: score },
});
const phrase = (score: number, goodInRow: number, perfectInRow: number): PerformanceEvent =>
  ({ kind: "phraseCompleted", score, goodInRow, perfectInRow });

describe("visual director", () => {
  it("gives nothing for a weak note and escalating light for better ones", () => {
    const director = new VisualDirector();
    expect(director.plan(0, [note(0.4)], [], context(0))).toEqual([]);
    expect(director.plan(1000, [note(0.6)], [], context(0)).map(c => c.kind)).toEqual(["noteGlow"]);
    expect(director.plan(2000, [note(0.95)], [], context(0)).map(c => c.kind)).toEqual(["noteGlow", "noteSparks"]);
    expect(director.plan(3000, [note(0.99)], [], context(0)).map(c => c.kind)).toEqual(["noteGlow", "noteRing"]);
  });

  it("holds a long note's earned release for the next beat within 250 ms", () => {
    const director = new VisualDirector();
    const now = director.plan(0, [note(0.95, 1.5)], [], context(50, 10, 180));
    expect(now.map(c => c.kind)).not.toContain("chargeRelease");
    expect(director.plan(179, [], [], context(50, 10, 1)).map(c => c.kind)).not.toContain("chargeRelease");
    expect(director.plan(180, [], [], context(50, 10, 500)).map(c => c.kind)).toContain("chargeRelease");
  });

  it("keeps big rewards for runs of perfect phrases at high energy, then rests", () => {
    const director = new VisualDirector();
    expect(director.plan(0, [phrase(0.95, 1, 1)], [], context(80, 30)).map(c => c.kind)).not.toContain("laserSweep");
    expect(director.plan(5000, [phrase(0.95, 2, 2)], [], context(80, 30)).map(c => c.kind)).toContain("laserSweep");
    // Within the quiet window after a large event, another perfect run only gets the small phrase reward.
    const next = director.plan(6000, [phrase(0.95, 3, 3)], [], context(80, 30)).map(c => c.kind);
    expect(next).not.toContain("shockwave");
    expect(next).not.toContain("laserSweep");
  });

  it("never shows flash-heavy effects at minimal intensity", () => {
    const director = new VisualDirector();
    director.intensity = "minimal";
    const kinds = director.plan(0, [phrase(0.95, 2, 2)], [], context(85, 35)).map(c => c.kind);
    expect(kinds).not.toContain("laserSweep");
    expect(kinds).not.toContain("shockwave");
    expect(kinds).toContain("phraseBloom");
  });

  it("opens the stage on a section surge only after an earned streak", () => {
    const quiet = new VisualDirector();
    expect(quiet.plan(0, [], [{ kind: "surge", at: 0 }], context(30, 5))).toEqual([]);
    const earned = new VisualDirector();
    const kinds = [
      ...earned.plan(0, [], [{ kind: "surge", at: 0 }], context(60, 25)),
      ...earned.plan(800, [], [], context(60, 25)),
    ].map(c => c.kind);
    expect(kinds).toEqual(["dim", "stageExpansion"]);
  });

  it("builds the ambient stage with the energy: no beams when calm, six at headliner", () => {
    expect(ambientFor(10, music(), "full").beams).toBe(0);
    expect(ambientFor(50, music(), "full").beams).toBeGreaterThan(1.5);
    expect(ambientFor(80, music(), "full").beams).toBeCloseTo(6, 0);
    expect(ambientFor(80, music(), "minimal").particles).toBeLessThan(ambientFor(80, music(), "full").particles);
  });
});
