import { describe, expect, it } from "vitest";
import type { MusicState } from "./musicPulse";
import { ShowEngine } from "./showEngine";
import type { PerformanceEvent } from "./performanceTracker";
import {
  ambientFor,
  VisualDirector,
  type DirectorContext,
} from "./visualDirector";

const music = (intensity = 1): MusicState => ({
  kick: 0,
  snare: 0,
  air: 0,
  intensity,
  pause: false,
  beatPeriod: 0.5,
});

describe("lyrics rhythm", () => {
  it("ignores weak drum rolls between accents without silencing a quieter passage", () => {
    const engine = new ShowEngine();
    engine.load([], [], new Map(), true, undefined, [
      [1, 1],
      [1.12, 0.3],
      [1.24, 0.35],
      [1.36, 0.25],
      [1.5, 0.9],
      [5, 0.3],
      [5.5, 0.35],
    ]);
    for (const position of [1, 1.5, 5, 5.5]) {
      engine.advance(position * 1000, position, undefined, true);
      expect(engine.state.musicBeat).toBeGreaterThan(0.25);
    }
    for (const position of [1.12, 1.24, 1.36, 1.24]) {
      engine.advance(position * 1000, position, undefined, true);
      expect(engine.state.musicBeat).toBe(0);
    }
  });

  it("keeps the hit crisp instead of swelling through the next tenth of a second", () => {
    const engine = new ShowEngine();
    engine.load([], [], new Map(), true, undefined, [[1, 1]]);
    engine.advance(0, 1, undefined, true);
    expect(engine.state.musicBeat).toBe(1);
    engine.advance(16, 1.016, undefined, true);
    expect(engine.state.musicBeat).toBeGreaterThan(0.45);
    engine.advance(64, 1.064, undefined, true);
    expect(engine.state.musicBeat).toBeLessThan(0.15);
    engine.advance(100, 1.1, undefined, true);
    expect(engine.state.musicBeat).toBe(0);
  });

  it("keeps a strong short hit at a normal animation-frame interval", () => {
    const engine = new ShowEngine();
    engine.load([], [], new Map(), true, undefined, [[1, 1]]);
    engine.advance(0, 0.99, undefined, true);
    engine.advance(16, 1.016, undefined, true);
    expect(engine.state.musicBeat).toBeGreaterThan(0.45);
  });

  it("does not bounce to arbitrary backing sounds without isolated rhythm evidence", () => {
    const engine = new ShowEngine();
    engine.load([], []);
    engine.advance(1000, 0.4, undefined, true);
    engine.hear(Array(18).fill(0.8), 1020);
    engine.advance(1020, 0.42, undefined, true);
    expect(engine.state.musicBeat).toBe(0);
  });

  it("follows bass and drum onsets at the source position, including seek and pause", () => {
    const engine = new ShowEngine();
    engine.load([], [], new Map(), true, undefined, [
      [0.5, 1],
      [1, 0.8],
    ]);
    engine.advance(1000, 0.48, undefined, true);
    engine.advance(1020, 0.5, undefined, true);
    expect(engine.state.musicBeat).toBeGreaterThan(0.7);
    engine.advance(1040, 0.1, undefined, true);
    expect(engine.state.musicBeat).toBe(0);
    engine.advance(1060, 1, undefined, true);
    expect(engine.state.musicBeat).toBeGreaterThan(0.5);
    engine.advance(1080, 1, undefined, false);
    expect(engine.state.musicBeat).toBe(0);
  });
});
const context = (
  energy: number,
  streakSeconds = 0,
  untilBeat?: number,
): DirectorContext => ({ energy, streakSeconds, music: music(), untilBeat });
const note = (score: number, duration = 0.4): PerformanceEvent => ({
  kind: "noteCompleted",
  note: { id: "n", start: 0, end: duration, pitch: 60 },
  score: {
    pitchAccuracy: score,
    voicedCoverage: 1,
    holdStability: 1,
    finalScore: score,
  },
});
const phrase = (
  score: number,
  goodInRow: number,
  perfectInRow: number,
): PerformanceEvent => ({
  kind: "phraseCompleted",
  score,
  goodInRow,
  perfectInRow,
});

describe("visual director", () => {
  it.each([0, 20, 80])(
    "keeps the musical beat expressive at performance energy %s",
    (energy) => {
      const commands = new VisualDirector().plan(
        1000,
        [],
        [{ kind: "beat", at: 1000, strength: 1 }],
        context(energy),
      );
      expect(commands).toContainEqual(
        expect.objectContaining({ kind: "beatPulse", strength: 1 }),
      );
    },
  );
  it("keeps visible stage lights for an early earned reward", () => {
    expect(ambientFor(20, music(), "full").beams).toBeGreaterThanOrEqual(1.5);
    const commands = new VisualDirector().plan(
      0,
      [{ kind: "levelReached", level: "awakening" }],
      [],
      context(20),
    );
    expect(
      commands.some(
        (command) => command.kind === "lightWave" && command.strength >= 0.45,
      ),
    ).toBe(true);
  });
  it("gives nothing for a weak note and escalating light for better ones", () => {
    const director = new VisualDirector();
    expect(director.plan(0, [note(0.4)], [], context(0))).toEqual([]);
    expect(
      director.plan(1000, [note(0.6)], [], context(0)).map((c) => c.kind),
    ).toEqual(["noteGlow"]);
    expect(
      director.plan(2000, [note(0.95)], [], context(0)).map((c) => c.kind),
    ).toEqual(["noteGlow", "noteSparks"]);
    expect(
      director.plan(3000, [note(0.99)], [], context(0)).map((c) => c.kind),
    ).toEqual(["noteGlow", "noteRing"]);
  });

  it("holds a long note's earned release for the next beat within 250 ms", () => {
    const director = new VisualDirector();
    const now = director.plan(0, [note(0.95, 1.5)], [], context(50, 10, 180));
    expect(now.map((c) => c.kind)).not.toContain("chargeRelease");
    expect(
      director.plan(179, [], [], context(50, 10, 1)).map((c) => c.kind),
    ).not.toContain("chargeRelease");
    expect(
      director.plan(180, [], [], context(50, 10, 500)).map((c) => c.kind),
    ).toContain("chargeRelease");
  });

  it("keeps big rewards for runs of perfect phrases at high energy, then rests", () => {
    const director = new VisualDirector();
    expect(
      director
        .plan(0, [phrase(0.95, 1, 1)], [], context(80, 30))
        .map((c) => c.kind),
    ).not.toContain("laserSweep");
    expect(
      director
        .plan(5000, [phrase(0.95, 2, 2)], [], context(80, 30))
        .map((c) => c.kind),
    ).toContain("laserSweep");
    // Within the quiet window after a large event, another perfect run only gets the small phrase reward.
    const next = director
      .plan(6000, [phrase(0.95, 3, 3)], [], context(80, 30))
      .map((c) => c.kind);
    expect(next).not.toContain("shockwave");
    expect(next).not.toContain("laserSweep");
  });

  it("never shows flash-heavy effects at minimal intensity", () => {
    const director = new VisualDirector();
    director.intensity = "minimal";
    const kinds = director
      .plan(0, [phrase(0.95, 2, 2)], [], context(85, 35))
      .map((c) => c.kind);
    expect(kinds).not.toContain("laserSweep");
    expect(kinds).not.toContain("shockwave");
    expect(kinds).toContain("phraseBloom");
  });

  it("opens the stage on a section surge only after an earned streak", () => {
    const quiet = new VisualDirector();
    expect(
      quiet.plan(0, [], [{ kind: "surge", at: 0 }], context(30, 5)),
    ).toEqual([]);
    const earned = new VisualDirector();
    const kinds = [
      ...earned.plan(0, [], [{ kind: "surge", at: 0 }], context(60, 25)),
      ...earned.plan(800, [], [], context(60, 25)),
    ].map((c) => c.kind);
    expect(kinds).toEqual(["dim", "stageExpansion"]);
  });

  it("builds the ambient stage with the energy: no beams when calm, six at headliner", () => {
    expect(ambientFor(10, music(), "full").beams).toBe(0);
    expect(ambientFor(50, music(), "full").beams).toBeGreaterThan(1.5);
    expect(ambientFor(80, music(), "full").beams).toBeCloseTo(6, 0);
    expect(ambientFor(80, music(), "minimal").particles).toBeLessThan(
      ambientFor(80, music(), "full").particles,
    );
  });
});
