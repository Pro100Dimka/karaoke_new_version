import { describe, expect, it } from "vitest";
import { energyLevel, PerformanceTracker, sampleQuality, type PerformanceEvent, type ShowNote } from "./performanceTracker";

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const frame = 1 / 60;

/** Back-to-back notes of `length` seconds on C4, one phrase per four notes. */
const song = (count: number, length = 0.5) => {
  const notes: ShowNote[] = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, start: i * length, end: (i + 1) * length - 0.02, pitch: 60 }));
  const phrases = Array.from({ length: Math.ceil(count / 4) }, (_, p) => {
    const group = notes.slice(p * 4, p * 4 + 4);
    return { start: group[0]?.start ?? 0, end: group.at(-1)?.end ?? 0, noteIds: group.map(note => note.id) };
  });
  return { notes, phrases };
};

/** Plays from `from` to `to` with the voice chosen per moment; returns every event. */
const sing = (tracker: PerformanceTracker, from: number, to: number, voice: (position: number) => number | undefined) => {
  const events: PerformanceEvent[] = [];
  for (let position = from; position <= to; position += frame) events.push(...tracker.update(position, voice(position)));
  return events;
};

describe("performance tracker", () => {
  it("treats vibrato-sized deviations as exact and nothing beyond a semitone", () => {
    expect(sampleQuality(0.15)).toBe(1);
    expect(sampleQuality(-0.6)).toBeCloseTo(0.5, 5);
    expect(sampleQuality(1.2)).toBe(0);
  });

  it("scores an accurately sung note near the top and a silent one as a miss", () => {
    const tracker = new PerformanceTracker();
    const { notes, phrases } = song(2);
    tracker.load(notes, phrases);
    const events = sing(tracker, 0, 1.1, position => (position < 0.5 ? hz(60.1) : undefined));
    const scores = events.flatMap(event => (event.kind === "noteCompleted" ? [event.score.finalScore] : []));
    expect(scores[0]).toBeGreaterThan(0.95);
    expect(scores[1]).toBe(0);
  });

  it("grows the energy with a good streak, reaching On Fire within twenty-odd seconds", () => {
    const tracker = new PerformanceTracker();
    const { notes, phrases } = song(60);
    tracker.load(notes, phrases);
    sing(tracker, 0, 10, () => hz(60));
    const afterTen = tracker.energy;
    sing(tracker, 10 + frame, 25, () => hz(60));
    expect(afterTen).toBeGreaterThan(20);
    expect(tracker.energy).toBeGreaterThan(afterTen);
    expect(energyLevel(tracker.energy)).toMatch(/onFire|headliner/);
  });

  it("forgives a single miss: the energy settles gradually instead of collapsing", () => {
    const tracker = new PerformanceTracker();
    const { notes, phrases } = song(60);
    tracker.load(notes, phrases);
    sing(tracker, 0, 20, () => hz(60));
    const before = tracker.energy;
    sing(tracker, 20 + frame, 21, position => (position < 20.5 ? undefined : hz(60)));
    expect(tracker.energy).toBeGreaterThan(before - 6);
    expect(tracker.streakSeconds).toBeGreaterThan(0);
  });

  it("reports phrases with runs of good and perfect lines", () => {
    const tracker = new PerformanceTracker();
    const { notes, phrases } = song(12);
    tracker.load(notes, phrases);
    const events = sing(tracker, 0, 6.5, () => hz(60));
    const phrasesDone = events.filter(event => event.kind === "phraseCompleted");
    expect(phrasesDone).toHaveLength(3);
    expect(phrasesDone.at(-1)).toMatchObject({ goodInRow: 3, perfectInRow: 3 });
    expect(events.some(event => event.kind === "songCompleted")).toBe(true);
  });

  it("restarts the streak after a seek and never judges the note it lands inside", () => {
    const tracker = new PerformanceTracker();
    const { notes, phrases } = song(40);
    tracker.load(notes, phrases);
    sing(tracker, 0, 8, () => hz(60));
    const events = sing(tracker, 15.25, 15.8, () => undefined);
    expect(tracker.streakSeconds).toBe(0);
    expect(events.filter(event => event.kind === "noteCompleted").map(event => event.kind === "noteCompleted" && event.note.id)).not.toContain("n30");
  });
});
