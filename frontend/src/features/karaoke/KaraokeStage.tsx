import { useEffect, useMemo, useRef, useState } from "react";
import { KaraokeLyrics, MelodyRoll, resizeEdges } from "@ad-voice/ui";
import { DetachButton, DetachedPanel } from "../../shared/ui/DetachedPanel";
import { useDetachedPanel } from "../../shared/ui/useDetachedPanel";
import { subscribeSpectrum } from "../../app/backdrop/spectrumEvents";
import { createPercussionReaction } from "../../app/backdrop/useSpectrumFeed";
import { useText } from "../../i18n/useText";
import { useApp } from "../../app/AppContext";
import { useDecorationBudget } from "../../app/DecorationBudgetContext";
import type { EditorDocument } from "../editor/editorModel";
import type { VocalRange } from "../library/songPreferences";
import type { StageLayers } from "./displayModes";
import { usePianoRollLayout } from "./usePianoRollLayout";
import { useSmoothPosition } from "./useSmoothPosition";
import {
  buildLines,
  currentLineIndex,
  letterProgress,
  notesAlignedToWords,
  noteHitReached,
  pitchAccuracy,
  pitchMatchesTarget,
  pitchMidiNearTarget,
  pitchRange,
  upcomingLinePhase,
  type LineDisplayPhase,
  type LyricLine,
} from "./karaokeLyrics";
import type { KaraokeNoteScore } from "../../services/recordingCoordinator";
import { RollFx, StageFx, useShowEngine } from "./show/ShowLayers";
import type { ShowEngine } from "./show/showEngine";

interface KaraokeStageProps {
  songTitle: string;
  position: number;
  playing: boolean;
  rate: number;
  keyShift?: number;
  document: EditorDocument | null;
  layers: StageLayers;
  vocalRange: VocalRange;
  pitchHz?: number;
  onNoteScoreChange?: (score: KaraokeNoteScore) => void;
}

const windowSeconds = 8;
// Where MelodyRoll puts its playhead across the lane (its default), shared with the show's light layer.
const rollLead = 0.25;

// The piano roll's window starts at the size of the roll on the karaoke screen.
const pianoPanelSize = { width: 920, height: 220 };

/** The music's kick drum, 0–1, for the roll to breathe with. */
const useBeat = () => {
  const [beat, setBeat] = useState(0);
  const percussion = useMemo(createPercussionReaction, []);
  useEffect(
    () =>
      subscribeSpectrum((frame) =>
        setBeat(percussion.next(frame.backingBands).kick),
      ),
    [percussion],
  );
  return beat;
};

const PianoRoll = ({
  document,
  position,
  vocalRange,
  shownWordIds,
  keyShift,
  pitchHz,
  onNoteScoreChange,
  show,
}: {
  document: EditorDocument;
  position: number;
  vocalRange: VocalRange;
  shownWordIds: ReadonlySet<string>;
  keyShift: number;
  pitchHz?: number;
  onNoteScoreChange?: (score: KaraokeNoteScore) => void;
  show: ShowEngine;
}) => {
  const t = useText();
  const beat = useBeat();
  const [span, setSpan] = useState(windowSeconds);
  const displayNotes = useMemo(
    () =>
      notesAlignedToWords(document.notes, document.words).map((note) => ({
        ...note,
        pitch: note.pitch + keyShift,
      })),
    [document.notes, document.words, keyShift],
  );
  const scoringNotes = useMemo(
    () =>
      document.notes.map((note) => ({ ...note, pitch: note.pitch + keyShift })),
    [document.notes, keyShift],
  );
  const range = useMemo(
    () => pitchRange(displayNotes, vocalRange),
    [displayNotes, vocalRange],
  );
  // Scoped to the same current-and-next line the lyrics panel shows: the roll's own lookahead is
  // otherwise wider than a line typically lasts, so it would preview a further line's melody with no text
  // on screen to read it against -- exactly what reads as "unrelated to the vocal".
  const inLine = useMemo(
    () => displayNotes.filter((note) => shownWordIds.has(note.wordId)),
    [displayNotes, shownWordIds],
  );
  const frameRef = useRef<HTMLDivElement>(null);
  const panel = useDetachedPanel("pianoRoll", t("pianoRoll"), pianoPanelSize);
  const { layout, active, beginMove, beginResize, handleMove, handleUp } =
    usePianoRollLayout(frameRef, (bounds, pointer) =>
      panel.detach(bounds, pointer),
    );
  const activeNote = scoringNotes.find(
    (note) => position >= note.start && position <= note.end,
  );
  const liveMidi = pitchMidiNearTarget(pitchHz, activeNote?.pitch);
  const accuracy = pitchAccuracy(pitchHz, activeNote?.pitch);
  const onTarget = Boolean(
    activeNote && pitchMatchesTarget(pitchHz, activeNote.pitch),
  );
  const [hitNoteIds, setHitNoteIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const hitNoteIdsRef = useRef<ReadonlySet<string>>(new Set());
  const seenNoteIds = useRef<ReadonlySet<string>>(new Set());
  const matchedSeconds = useRef(new Map<string, number>());
  const voicedSeconds = useRef(new Map<string, number>());
  const pitchStatistics = useRef(
    new Map<string, { count: number; sum: number; squared: number }>(),
  );
  const previousFrame = useRef({ position, noteId: activeNote?.id });
  const resetScoring = () => {
    matchedSeconds.current.clear();
    voicedSeconds.current.clear();
    pitchStatistics.current.clear();
    hitNoteIdsRef.current = new Set();
    seenNoteIds.current = new Set();
    setHitNoteIds(new Set());
  };
  useEffect(() => {
    resetScoring();
    previousFrame.current = { position, noteId: activeNote?.id };
    onNoteScoreChange?.({
      hitNotes: 0,
      totalNotes: 0,
      rhythmAccuracyPercent: 0,
      noteStabilityPercent: 0,
    });
  }, [document.revision, keyShift, onNoteScoreChange]);
  useEffect(() => {
    const previous = previousFrame.current;
    const elapsed = position - previous.position;
    if (elapsed < -0.05) {
      resetScoring();
    } else if (activeNote) {
      seenNoteIds.current = new Set(seenNoteIds.current).add(activeNote.id);
    }
    if (
      activeNote &&
      previous.noteId === activeNote.id &&
      elapsed > 0 &&
      elapsed <= 0.2 &&
      pitchMatchesTarget(pitchHz, activeNote.pitch)
    ) {
      const matched =
        (matchedSeconds.current.get(activeNote.id) ?? 0) + elapsed;
      matchedSeconds.current.set(activeNote.id, matched);
      if (
        noteHitReached(matched, activeNote.end - activeNote.start) &&
        !hitNoteIdsRef.current.has(activeNote.id)
      ) {
        hitNoteIdsRef.current = new Set(hitNoteIdsRef.current).add(
          activeNote.id,
        );
        setHitNoteIds(hitNoteIdsRef.current);
      }
    }
    if (
      activeNote &&
      previous.noteId === activeNote.id &&
      elapsed > 0 &&
      elapsed <= 0.2 &&
      liveMidi !== undefined
    ) {
      voicedSeconds.current.set(
        activeNote.id,
        (voicedSeconds.current.get(activeNote.id) ?? 0) + elapsed,
      );
      const deviation = liveMidi - activeNote.pitch;
      const stats = pitchStatistics.current.get(activeNote.id) ?? {
        count: 0,
        sum: 0,
        squared: 0,
      };
      pitchStatistics.current.set(activeNote.id, {
        count: stats.count + 1,
        sum: stats.sum + deviation,
        squared: stats.squared + deviation * deviation,
      });
    }
    const seen = scoringNotes.filter((note) =>
      seenNoteIds.current.has(note.id),
    );
    const rhythmAccuracyPercent =
      seen.length === 0
        ? 0
        : (100 *
            seen.reduce(
              (sum, note) =>
                sum +
                Math.min(
                  1,
                  (voicedSeconds.current.get(note.id) ?? 0) /
                    Math.max(0.001, note.end - note.start),
                ),
              0,
            )) /
          seen.length;
    const noteStabilityPercent =
      seen.length === 0
        ? 0
        : (100 *
            seen.reduce((sum, note) => {
              const stats = pitchStatistics.current.get(note.id);
              if (!stats) return sum;
              const mean = stats.sum / stats.count;
              const spread = Math.sqrt(
                Math.max(0, stats.squared / stats.count - mean * mean),
              );
              return sum + Math.max(0, 1 - spread);
            }, 0)) /
          seen.length;
    onNoteScoreChange?.({
      hitNotes: hitNoteIdsRef.current.size,
      totalNotes: seenNoteIds.current.size,
      rhythmAccuracyPercent,
      noteStabilityPercent,
    });
    previousFrame.current = { position, noteId: activeNote?.id };
  }, [
    activeNote,
    liveMidi,
    pitchHz,
    position,
    onNoteScoreChange,
    scoringNotes,
  ]);
  const frameStyle =
    layout && !panel.detached
      ? {
          left: layout.left,
          top: layout.top,
          width: layout.width,
          height: layout.height,
          transform: "none",
        }
      : undefined;

  return (
    <DetachedPanel panel={panel}>
      <div
        ref={frameRef}
        className="pianoRoll"
        data-active={(active && !panel.detached) || undefined}
        style={frameStyle}
        // In its own window the roll is placed and sized by that window, not dragged inside the app.
        onPointerDown={panel.detached ? undefined : beginMove}
        onPointerMove={panel.detached ? undefined : handleMove}
        onPointerUp={panel.detached ? undefined : handleUp}
      >
        <MelodyRoll
          className="pianoRollLane"
          label={t("pianoRoll")}
          notes={inLine}
          position={position}
          minPitch={range.min}
          maxPitch={range.max}
          window={span}
          onWindowChange={setSpan}
          livePitch={liveMidi}
          accuracy={accuracy}
          hit={onTarget}
          hitIds={hitNoteIds}
          beat={beat}
        />
        <RollFx
          engine={show}
          view={{
            notes: inLine,
            position,
            span,
            lead: rollLead,
            low: range.min,
            high: range.max,
          }}
        />
        <span
          className="pianoRollDetach"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <DetachButton panel={panel} size="xs" />
        </span>
        {active &&
          !panel.detached &&
          resizeEdges.map((edge) => (
            <span
              key={edge}
              className="ad-floating-panel-handle"
              data-edge={edge}
              aria-hidden
              onPointerDown={beginResize(edge)}
            />
          ))}
      </div>
    </DetachedPanel>
  );
};

/** The two lines on screen: the one being sung fills word by word and breathes with the drums; the next waits below. */
const Lyrics = ({
  position,
  shown,
  phase,
}: {
  position: number;
  shown: readonly (LyricLine | undefined)[];
  phase: LineDisplayPhase;
}) => {
  const t = useText();
  const [drums, setDrums] = useState({ kick: 0, snare: 0, pulse: 0 });
  const percussion = useMemo(createPercussionReaction, []);
  useEffect(
    () =>
      subscribeSpectrum((frame) =>
        setDrums(percussion.next(frame.backingBands)),
      ),
    [percussion],
  );
  const [current, next] = shown;
  // During a long instrumental gap before a line the screen clears, then counts down to it instead of
  // sitting on its not-yet-sung text for the whole break (see upcomingLinePhase).
  const message =
    phase.kind === "countdown"
      ? t("introCountdown", { seconds: phase.secondsRemaining ?? 0 })
      : undefined;
  const words = (line: LyricLine | undefined, sung: boolean) =>
    line?.words.map((word) => ({
      id: word.id,
      text: word.text,
      progress: sung ? letterProgress(word, position) : 0,
    })) ?? [];

  return (
    <KaraokeLyrics
      className="lyrics"
      message={message}
      current={phase.kind === "text" ? words(current, true) : []}
      next={phase.kind === "text" ? words(next, false) : []}
      currentKey={current?.start}
      nextKey={next?.start}
      kick={drums.kick}
      snare={drums.snare}
      pulse={drums.pulse}
    />
  );
};

export const KaraokeStage = ({
  songTitle,
  position: polledPosition,
  playing,
  rate,
  keyShift = 0,
  document,
  layers,
  vocalRange,
  pitchHz,
  onNoteScoreChange,
}: KaraokeStageProps) => {
  const t = useText();
  const position = useSmoothPosition(polledPosition, playing, rate);
  const { preferences } = useApp("preferences");
  const decorationLimited = useDecorationBudget();
  const showLyrics = layers.showLyrics && document !== null;
  const showPiano = layers.showNotes && document !== null;
  const instrumental = document === null || document.words.length === 0;
  const minimal = !showLyrics && !showPiano;
  // Computed once and shared by both panels, so the piano roll can never show a different slice of the
  // song than the lyrics being read alongside it (see PianoRoll's shownWordIds).
  const lines = useMemo(
    () => (document ? buildLines(document.words, document.lyrics) : []),
    [document],
  );
  const lineIndex = currentLineIndex(lines, position);
  const shown = [lines[lineIndex], lines[lineIndex + 1]];
  const phase = upcomingLinePhase(lines, lineIndex, position);
  const showNotes = useMemo(
    () =>
      (document?.notes ?? []).map((note) => ({
        ...note,
        pitch: note.pitch + keyShift,
      })),
    [document, keyShift],
  );
  const showSettings = useMemo(
    () => ({
      intensity: "full" as const,
      reducedMotion: preferences.reducedMotion || decorationLimited,
    }),
    [preferences.reducedMotion, decorationLimited],
  );
  const show = useShowEngine({
    notes: showNotes,
    lines,
    position,
    pitchHz,
    playing,
    settings: showSettings,
  });
  // The piano roll also keeps the line just finished, one word set wider than the lyrics text shows: a
  // note whose line just ended is often still mid-scroll past the cursor, and the piano roll's own time
  // window already fades it out gracefully -- dropping it here the instant the line changes cut that
  // scroll off abruptly instead of letting it finish sliding behind the keyboard.
  const shownWordIds = useMemo(
    () =>
      new Set(
        [lines[lineIndex - 1], lines[lineIndex], lines[lineIndex + 1]].flatMap(
          (line) => line?.words.map((word) => word.id) ?? [],
        ),
      ),
    [lines, lineIndex],
  );

  return (
    <>
      {/* Rendered as a sibling of .stage, not inside it: the piano roll is position: fixed and freely
          user-placed (see usePianoRollLayout), including over the console -- it must stay in the karaoke
          page's own top-level stacking order to render behind everything else there, which a descendant
          of .stage's own stacking context could never do regardless of its own z-index. */}
      {showPiano && (
        <PianoRoll
          document={document}
          position={position}
          vocalRange={vocalRange}
          shownWordIds={shownWordIds}
          keyShift={keyShift}
          pitchHz={pitchHz}
          onNoteScoreChange={onNoteScoreChange}
          show={show}
        />
      )}
      {/* After the roll: stage light passes in front of its glass (softened over it) but stays under the lyrics and console. */}
      <StageFx engine={show} />
      <section className="stage" aria-label={songTitle}>
        {showLyrics && (
          <Lyrics position={position} shown={shown} phase={phase} />
        )}
        {(instrumental || minimal) && (
          <p className="instrumentalMode">
            {instrumental ? t("instrumentalMode") : songTitle}
          </p>
        )}
      </section>
    </>
  );
};
