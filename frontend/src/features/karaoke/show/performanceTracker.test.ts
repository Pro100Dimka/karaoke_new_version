import { describe, expect, it } from "vitest";
import {
  energyLevel,
  goodNoteScore,
  PerformanceTracker,
  sampleQuality,
  type PerformanceEvent,
  type ShowNote,
} from "./performanceTracker";

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const frame = 1 / 60;

/** Back-to-back notes of `length` seconds on C4, one phrase per four notes. */
const song = (count: number, length = 0.5) => {
  const notes: ShowNote[] = Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    start: i * length,
    end: (i + 1) * length - 0.02,
    pitch: 60,
  }));
  const phrases = Array.from({ length: Math.ceil(count / 4) }, (_, p) => {
    const group = notes.slice(p * 4, p * 4 + 4);
    return {
      start: group[0]?.start ?? 0,
      end: group.at(-1)?.end ?? 0,
      noteIds: group.map((note) => note.id),
    };
  });
  return { notes, phrases };
};

/** Plays from `from` to `to` with the voice chosen per moment; returns every event. */
const sing = (
  tracker: PerformanceTracker,
  from: number,
  to: number,
  voice: (position: number) => number | undefined,
) => {
  const events: PerformanceEvent[] = [];
  for (let position = from; position <= to; position += frame)
    events.push(...tracker.update(position, voice(position)));
  return events;
};

describe("performance tracker", () => {
  it("keeps weak pitch measurements out of both the final grade and green-note evidence", () => {
    const tracker = new PerformanceTracker();
    tracker.load([{ id: "held", start: 0, end: 1, pitch: 60 }], []);
    for (let i = 0; i < 20; i++) {
      tracker.update((i + 0.5) * 0.05, hz(i < 10 ? 60 : 64), 0.05, true, i < 10 ? 1 : 0.4);
    }
    expect(tracker.noteScore.pitchAccuracyPercent).toBeCloseTo(100);
    expect(tracker.noteScore.noteStabilityPercent).toBeCloseTo(100);
    expect(tracker.hitNoteIds.has("held")).toBe(true);
    expect(tracker.noteScore).toMatchObject({ expectedPitchSeconds: 1, assessedPitchSeconds: 0.5 });
  });

  it("still counts reliable wrong notes and actual silence as mistakes", () => {
    for (const voice of [hz(64), undefined]) {
      const tracker = new PerformanceTracker();
      tracker.load([{ id: "held", start: 0, end: 1, pitch: 60 }], []);
      for (let i = 0; i < 20; i++) tracker.update((i + 0.5) * 0.05, voice, 0.05, voice !== undefined, 1);
      expect(tracker.noteScore.pitchAccuracyPercent).toBe(0);
      expect(tracker.hitNoteIds.has("held")).toBe(false);
      expect(tracker.noteScore.assessedPitchSeconds).toBeCloseTo(1);
    }
  });

  it("measures stability as steady sung time without letting one outlier spoil a held phrase", () => {
    const tracker = new PerformanceTracker();
    tracker.load([{ id: "held", start: 0, end: 1, pitch: 60 }], []);
    for (let i = 0; i < 20; i++) tracker.update((i + 0.5) * 0.05, hz(i === 10 ? 63 : 60), 0.05);
    expect(tracker.noteScore.noteStabilityPercent).toBeCloseTo(95);
  });
  it.each([false, true])("grades consonant activity independently of pitch (missing onset: %s)", (missingOnset) => {
    const tracker = new PerformanceTracker();
    tracker.load([{ id: "held", start: 0.2, end: 0.8, pitch: 60 }], [], true, [[0, missingOnset ? 1 : 0.6]]);
    for (let i = 0; i < 20; i++) {
      const time = (i + 0.5) * 0.05;
      const pitched = time >= 0.2 && time < 0.8;
      tracker.update(time, pitched ? hz(60) : undefined, 0.05, missingOnset ? pitched : true);
    }
    expect(tracker.noteScore.rhythmAccuracyPercent).toBeCloseTo(60);
  });
  it("does not let brief transition notes erase long correctly sung phrases from stage energy", () => {
    const tracker = new PerformanceTracker();
    const notes = Array.from({ length: 20 }, (_, second) => [
      { id: `held-${second}`, start: second, end: second + 0.8, pitch: 60 },
      ...Array.from({ length: 10 }, (_, index) => ({ id: `brief-${second}-${index}`,
        start: second + 0.8 + index * 0.02, end: second + 0.82 + index * 0.02, pitch: 60 })),
    ]).flat();
    tracker.load(notes, []);
    for (let i = 0; i < 2000; i++) {
      const time = (i + 0.5) / 100;
      tracker.update(time, hz(time % 1 < 0.8 ? 60 : 63), 0.01);
    }
    expect(tracker.energy).toBeGreaterThanOrEqual(45);
  });
  it("weights final pitch by sung time rather than treating a tiny note like a held phrase", () => {
    const tracker = new PerformanceTracker();
    tracker.load([{ id: "short", start: 0, end: 0.05, pitch: 60 },
      { id: "held", start: 0.05, end: 1, pitch: 60 }], []);
    for (let i = 0; i < 20; i++) tracker.update((i + 0.5) * 0.05, i === 0 ? undefined : hz(60), 0.05);
    expect(tracker.noteScore.pitchAccuracyPercent).toBeCloseTo(95);
    expect(tracker.noteScore.noteStabilityPercent).toBeCloseTo(100);
  });
  it("counts singing through rests as a rhythm error", () => {
    const tracker = new PerformanceTracker();
    tracker.load([{ id: "first", start: 0, end: 0.5, pitch: 60 },
      { id: "second", start: 1, end: 1.5, pitch: 60 }], []);
    for (let i = 0; i < 40; i++) tracker.update((i + 0.5) * 0.05, hz(60), 0.05);
    expect(tracker.noteScore.rhythmAccuracyPercent).toBeCloseTo(50);
  });
  it("does not judge the unplayed remainder of a note as a rhythm error", () => {
    const tracker = new PerformanceTracker();
    tracker.load([{ id: "held", start: 0, end: 1, pitch: 60 }], []);
    for (let i = 0; i < 10; i++) tracker.update((i + 0.5) * 0.05, hz(60), 0.05);
    expect(tracker.noteScore.rhythmAccuracyPercent).toBeCloseTo(100);
  });
  it("awakens the stage on a genuinely hit note even after an imperfect phrase", () => {
    const tracker = new PerformanceTracker();
    const { notes, phrases } = song(12);
    tracker.load(notes, phrases);
    sing(tracker, 0, 4, () => undefined);
    sing(tracker, 4 + frame, 4.6, () => hz(60));
    expect(tracker.hitNoteIds.size).toBeGreaterThan(0);
    expect(tracker.energy).toBeGreaterThanOrEqual(20);
    sing(tracker, 4.6 + frame, 5, () => hz(60));
    expect(tracker.energy).toBeGreaterThanOrEqual(20);
  });
  it("retains the complete take's measurements across seeks and starts a new total on load", () => {
    const tracker = new PerformanceTracker();
    const { notes, phrases } = song(20);
    tracker.load(notes, phrases);
    sing(tracker, 0, 1, () => hz(60));
    const first = tracker.noteScore.totalNotes;
    sing(tracker, 5, 6, () => undefined);
    expect(tracker.noteScore.totalNotes).toBeGreaterThan(first);
    expect(tracker.noteScore.hitNotes).toBe(2);
    tracker.load(notes, phrases);
    expect(tracker.noteScore.totalNotes).toBe(0);
  });
  it("provides the final modal metrics directly from captured samples, including silent notes", () => {
    const tracker = new PerformanceTracker();
    tracker.load([{ id: "sung", start: 0, end: 1, pitch: 60 },
      { id: "silent", start: 1, end: 2, pitch: 60 }], []);
    for (let i = 0; i < 40; i++) tracker.update((i + 0.5) * 0.05, i < 20 ? hz(60.2) : undefined, 0.05);
    expect(tracker.noteScore).toMatchObject({ version: 3, hitNotes: 1, totalNotes: 2,
    });
    expect(tracker.noteScore.pitchAccuracyPercent).toBeCloseTo(50);
    expect(tracker.noteScore.rhythmAccuracyPercent).toBeCloseTo(50);
    expect(tracker.noteScore.meanSemitoneDeviation).toBeCloseTo(0.2);
  });
  it("lights the stage within the first sung phrase and holds it across an instrumental break", () => {
    const tracker = new PerformanceTracker();
    const notes = song(20);
    tracker.load(notes.notes, notes.phrases);
    sing(tracker, 0, 5, () => hz(60.6));
    expect(tracker.energy).toBeGreaterThanOrEqual(35);
    sing(tracker, 5 + frame, 10, () => hz(60.6));
    const earned = tracker.energy;
    sing(tracker, 10 + frame, 18, () => undefined);
    expect(tracker.energy).toBeGreaterThanOrEqual(earned - 3);
  });
  it("scores a short note covered by capture windows even when neither centre lands inside it", () => {
    const tracker = new PerformanceTracker();
    tracker.load([{ id: "short", start: 0.04, end: 0.06, pitch: 60 }], []);
    tracker.update(0.025, hz(60), 0.05);
    tracker.update(0.075, hz(60), 0.05);
    expect(tracker.hitNoteIds.has("short")).toBe(true);
  });
  it("rewards a note accepted by the green-note tolerance", () => {
    const tracker = new PerformanceTracker();
    const { notes, phrases } = song(1);
    tracker.load(notes, phrases);
    const event = sing(tracker, 0, 0.6, () => hz(60.8)).find((item) => item.kind === "noteCompleted");
    expect(event?.kind === "noteCompleted" && event.score.finalScore).toBeGreaterThanOrEqual(goodNoteScore);
  });
  it("treats vibrato-sized deviations as exact and nothing beyond a semitone", () => {
    expect(sampleQuality(0.15)).toBe(1);
    expect(sampleQuality(-0.6)).toBeCloseTo(0.5, 5);
    expect(sampleQuality(1.2)).toBe(0);
  });

  it("scores an accurately sung note near the top and a silent one as a miss", () => {
    const tracker = new PerformanceTracker();
    const { notes, phrases } = song(2);
    tracker.load(notes, phrases);
    const events = sing(tracker, 0, 1.1, (position) =>
      position < 0.5 ? hz(60.1) : undefined,
    );
    const scores = events.flatMap((event) =>
      event.kind === "noteCompleted" ? [event.score.finalScore] : [],
    );
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
    sing(tracker, 20 + frame, 21, (position) =>
      position < 20.5 ? undefined : hz(60),
    );
    expect(tracker.energy).toBeGreaterThan(before - 6);
    expect(tracker.streakSeconds).toBeGreaterThan(0);
  });

  it("reports phrases with runs of good and perfect lines", () => {
    const tracker = new PerformanceTracker();
    const { notes, phrases } = song(12);
    tracker.load(notes, phrases);
    const events = sing(tracker, 0, 6.5, () => hz(60));
    const phrasesDone = events.filter(
      (event) => event.kind === "phraseCompleted",
    );
    expect(phrasesDone).toHaveLength(3);
    expect(phrasesDone.at(-1)).toMatchObject({ goodInRow: 3, perfectInRow: 3 });
    expect(events.some((event) => event.kind === "songCompleted")).toBe(true);
  });

  it("restarts the streak after a seek and never judges the note it lands inside", () => {
    const tracker = new PerformanceTracker();
    const { notes, phrases } = song(40);
    tracker.load(notes, phrases);
    sing(tracker, 0, 8, () => hz(60));
    const events = sing(tracker, 15.25, 15.8, () => undefined);
    expect(tracker.streakSeconds).toBe(0);
    expect(
      events
        .filter((event) => event.kind === "noteCompleted")
        .map((event) => event.kind === "noteCompleted" && event.note.id),
    ).not.toContain("n30");
  });
});
