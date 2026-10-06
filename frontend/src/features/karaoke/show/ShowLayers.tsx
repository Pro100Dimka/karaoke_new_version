import { useEffect, useMemo, useRef } from "react";
import { subscribeSpectrum } from "../../../app/backdrop/spectrumEvents";
import { useDecorationBudget } from "../../../app/DecorationBudgetContext";
import type { LyricLine } from "../karaokeLyrics";
import type { ShowNote, ShowPhrase } from "./performanceTracker";
import { RollFxRenderer, type RollView } from "./rollFxRenderer";
import { ShowEngine, type NoteWord, type ShowSettings } from "./showEngine";
import { StageFxRenderer } from "./stageFxRenderer";
import "./show.css";

/** Each lyric line is one phrase of the show: the notes sung on its words. */
export const phrasesOf = (
  lines: readonly LyricLine[],
  notes: readonly ShowNote[],
): ShowPhrase[] =>
  lines.map((line) => {
    const words = new Set(line.words.map((word) => word.id));
    return {
      start: line.start,
      end: line.end,
      noteIds: notes
        .filter((note) => note.wordId && words.has(note.wordId))
        .map((note) => note.id),
    };
  });

/** Where each note's word sits in its lyric line, so a perfectly sung word can light up on screen. */
export const wordsOfNotes = (
  lines: readonly LyricLine[],
  notes: readonly ShowNote[],
): Map<string, NoteWord> => {
  const places = new Map<string, NoteWord>();
  for (const line of lines) {
    const text = line.words.map((word) => word.text).join("");
    line.words.forEach((word, index) =>
      places.set(word.id, { line: text, index }),
    );
  }
  return new Map(
    notes.flatMap((note) => {
      const place = note.wordId ? places.get(note.wordId) : undefined;
      return place ? [[note.id, place] as const] : [];
    }),
  );
};

/** Development diagnostics only: `__adShow.autopilot = true` in DevTools sings every note exactly, to watch the show build. */
interface ShowDiagnostics {
  engine: ShowEngine;
  autopilot: boolean;
  /** Every effect the director released, newest last. */
  released: { kind: string; at: number; strength: number }[];
}
const diagnostics = (): ShowDiagnostics | undefined =>
  import.meta.env.DEV
    ? (window as unknown as { __adShow?: ShowDiagnostics }).__adShow
    : undefined;

const exposeForDiagnostics = (engine: ShowEngine): (() => void) | undefined => {
  if (!import.meta.env.DEV) return undefined;
  const released: ShowDiagnostics["released"] = [];
  (window as unknown as { __adShow?: ShowDiagnostics }).__adShow = {
    engine,
    autopilot: diagnostics()?.autopilot ?? false,
    released,
  };
  return engine.onCommand(({ kind, at, strength }) => {
    if (kind !== "beatPulse" && kind !== "noteGlow")
      released.push({
        kind,
        at: Math.round(at),
        strength: Math.round(strength * 100) / 100,
      });
  });
};

const devAutopilotPitch = (
  notes: readonly ShowNote[],
  position: number,
): number | undefined => {
  if (!diagnostics()?.autopilot) return undefined;
  const note = notes.find(
    (candidate) => position >= candidate.start && position <= candidate.end,
  );
  return note ? 440 * 2 ** ((note.pitch - 69) / 12) : undefined;
};

interface ShowInput {
  notes: readonly ShowNote[];
  lines: readonly LyricLine[];
  position: number;
  pitchHz: number | undefined;
  playing: boolean;
  settings: ShowSettings;
}

/** The karaoke screen's show: fed with the drawn position, the voice and the backing track; renders nothing itself. */
export const useShowEngine = ({
  notes,
  lines,
  position,
  pitchHz,
  playing,
  settings,
}: ShowInput): ShowEngine => {
  const engine = useMemo(() => new ShowEngine(), []);
  useEffect(
    () =>
      engine.load(notes, phrasesOf(lines, notes), wordsOfNotes(lines, notes)),
    [engine, notes, lines],
  );
  useEffect(() => engine.configure(settings), [engine, settings]);
  useEffect(
    () =>
      subscribeSpectrum((frame) =>
        engine.hear(frame.backingBands, performance.now()),
      ),
    [engine],
  );
  useEffect(
    () =>
      engine.advance(
        performance.now(),
        position,
        devAutopilotPitch(notes, position) ?? pitchHz,
        playing,
      ),
    [engine, notes, position, pitchHz, playing],
  );
  useEffect(() => exposeForDiagnostics(engine), [engine]);
  return engine;
};

/** The stage effects layer: over the clip, under the melody roll, lyrics and console. */
export const StageFx = ({ engine }: { engine: ShowEngine }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const limited = useDecorationBudget();
  useEffect(() => {
    if (limited) return;
    const element = canvas.current;
    const host = element?.closest<HTMLElement>(".karaokePage");
    if (!element || !host) return;
    const renderer = new StageFxRenderer(element, engine, host);
    renderer.start();
    return () => renderer.stop();
  }, [engine, limited]);
  return limited ? null : <canvas ref={canvas} className="showFx" aria-hidden />;
};

/** The light inside the melody roll, laid exactly over its lane. */
export const RollFx = ({
  engine,
  view,
}: {
  engine: ShowEngine;
  view: RollView;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const limited = useDecorationBudget();
  const current = useRef<RollView | undefined>(view);
  current.current = view;
  useEffect(() => {
    if (limited) return;
    const element = canvas.current;
    const frame = element?.parentElement;
    if (!element || !frame) return;
    const renderer = new RollFxRenderer(element, engine, frame, current);
    renderer.start();
    return () => renderer.stop();
  }, [engine, limited]);
  return limited ? null : <canvas ref={canvas} className="showRollFx" aria-hidden />;
};
