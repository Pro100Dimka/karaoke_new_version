import { useEffect, useMemo, useRef, useState } from "react";
import { KaraokeLyrics, MelodyRoll, resizeEdges } from "@neo-ui-kit/react";
import { DetachButton, DetachedPanel } from "../../shared/ui/DetachedPanel";
import { useDetachedPanel } from "../../shared/ui/useDetachedPanel";
import { useText } from "../../i18n/useText";
import { useApp } from "../../app/AppContext";
import type { EditorDocument } from "../../application/editor/editorModel";
import type { VocalRange } from "../../application/library/songPreferences";
import type { StageLayers } from "./displayModes";
import { usePianoRollLayout } from "./usePianoRollLayout";
import { useSmoothPosition } from "./useSmoothPosition";
import {
  buildLines,
  currentLineIndex,
  letterProgress,
  lyricSilenceSeconds,
  pitchAccuracy,
  pitchMatchesTarget,
  pitchMidiNearTarget,
  pitchRange,
  targetPitchAt,
  reliablePitchHz,
  upcomingLinePhase,
  type LineDisplayPhase,
  type LyricLine,
} from "./karaokeLyrics";
import type { KaraokeNoteScore, PitchFrame } from "../../contracts/models";
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
  pitchFrames?: readonly PitchFrame[];
  onNoteScoreChange?: (score: KaraokeNoteScore) => void;
}

const windowSeconds = 8;
// Where MelodyRoll puts its playhead across the lane (its default), shared with the show's light layer.
const rollLead = 0.25;

// The piano roll's window starts at the size of the roll on the karaoke screen.
const pianoPanelSize = { width: 920, height: 220 };

const PianoRoll = ({
  document,
  position,
  vocalRange,
  shownWordIds,
  keyShift,
  pitchHz,
  pitchFrame,
  capturedPitch,
  show,
  hidden,
  opacity,
}: {
  document: EditorDocument;
  position: number;
  vocalRange: VocalRange;
  shownWordIds: ReadonlySet<string>;
  keyShift: number;
  pitchHz?: number;
  pitchFrame?: PitchFrame;
  capturedPitch: boolean;
  show: ShowEngine;
  hidden: boolean;
  opacity: number;
}) => {
  const t = useText();
  const [span, setSpan] = useState(windowSeconds);
  const notes = useMemo(
    () =>
      document.notes.map((note) => ({ ...note, pitch: note.pitch + keyShift })),
    [document.notes, keyShift],
  );
  const range = useMemo(
    () => pitchRange(notes, vocalRange),
    [notes, vocalRange],
  );
  // Scoped to the same current-and-next line the lyrics panel shows: the roll's own lookahead is
  // otherwise wider than a line typically lasts, so it would preview a further line's melody with no text
  // on screen to read it against -- exactly what reads as "unrelated to the vocal".
  const inLine = useMemo(
    () => notes.filter((note) => shownWordIds.has(note.wordId)),
    [notes, shownWordIds],
  );
  const frameRef = useRef<HTMLDivElement>(null);
  const panel = useDetachedPanel("pianoRoll", t("pianoRoll"), pianoPanelSize);
  const { layout, active, beginMove, beginResize, handleMove, handleUp } =
    usePianoRollLayout(frameRef, (bounds, pointer) =>
      panel.detach(bounds, pointer),
    );
  const voicePosition = pitchFrame?.positionSeconds ?? position;
  const observedPitch = pitchFrame
    ? reliablePitchHz(pitchFrame.pitchHz, pitchFrame.confidence)
    : pitchHz;
  const activeNote = notes.find(
    (note) => voicePosition >= note.start && voicePosition <= note.end,
  );
  const targetPitch = activeNote
    ? targetPitchAt(activeNote, voicePosition)
    : undefined;
  const liveMidi = pitchMidiNearTarget(observedPitch, targetPitch);
  const accuracy = pitchAccuracy(observedPitch, targetPitch);
  const onTarget = Boolean(
    targetPitch !== undefined && pitchMatchesTarget(observedPitch, targetPitch),
  );
  const hitNoteIds = show.hitNoteIds;
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
        hidden={hidden}
        data-active={(active && !panel.detached) || undefined}
        style={{ ...frameStyle, opacity }}
        // In its own window the roll is placed and sized by that window, not dragged inside the app.
        onPointerDown={panel.detached ? undefined : beginMove}
        onPointerMove={panel.detached ? undefined : handleMove}
        onPointerUp={panel.detached ? undefined : handleUp}
      >
        <MelodyRoll
          className="pianoRollLane"
          style={{ background: "rgba(4, 6, 12, 0.16)" }}
          label={t("pianoRoll")}
          notes={inLine}
          position={position}
          minPitch={range.min}
          maxPitch={range.max}
          window={span}
          onWindowChange={setSpan}
          livePitch={capturedPitch ? undefined : liveMidi}
          accuracy={accuracy}
          hit={onTarget}
          hitIds={hitNoteIds}
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
  reducedMotion,
}: {
  position: number;
  shown: readonly (LyricLine | undefined)[];
  phase: LineDisplayPhase;
  reducedMotion: boolean;
}) => {
  const t = useText();
  const [current, next] = shown;
  // Preview on "1"; saved word times keep the text unfilled until singing starts.
  const { countdown } = phase;
  const textVisible = phase.kind === "text" || countdown === 1;
  const words = (line: LyricLine | undefined, sung: boolean) =>
    line?.words.map((word) => ({
      id: word.id,
      text: word.text,
      progress: sung ? letterProgress(word, position) : 0,
    })) ?? [];
  return (
    <>
      {countdown !== undefined && (
        <p
          className="lyricsCountdown"
          role="timer"
          aria-label={t("introCountdown", { seconds: countdown })}
        >
          <span key={countdown}>{countdown}</span>
        </p>
      )}
      <KaraokeLyrics
        className="lyrics"
        data-reduced-motion={reducedMotion || undefined}
        style={{ opacity: phase.opacity ?? 1 }}
        current={textVisible ? words(current, true) : []}
        next={textVisible ? words(next, false) : []}
        currentKey={current?.start}
        nextKey={next?.start}
      />
    </>
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
  pitchFrames,
  onNoteScoreChange,
}: KaraokeStageProps) => {
  const t = useText();
  const position = useSmoothPosition(polledPosition, playing, rate);
  const { preferences } = useApp("preferences");
  const showLyrics = layers.showLyrics && document !== null;
  const showPiano = layers.showNotes && document !== null;
  const instrumental = document === null || document.words.length === 0;
  const minimal = !showLyrics && !showPiano;
  // Computed once and shared by both panels, so the piano roll can never show a different slice of the
  // song than the lyrics being read alongside it (see PianoRoll's shownWordIds).
  const lines = useMemo(
    () =>
      document ? buildLines(document.words, document.lyrics, document.bpm) : [],
    [document],
  );
  const lineIndex = currentLineIndex(lines, position);
  const current = lines[lineIndex];
  const next = lines[lineIndex + 1];
  const preview =
    current && next && next.start - current.end <= lyricSilenceSeconds
      ? next
      : undefined;
  const shown = [current, preview];
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
      reducedMotion: preferences.reducedMotion,
    }),
    [preferences.reducedMotion],
  );
  const show = useShowEngine({
    vocalActivity: document?.vocalActivity,
    rhythm: document?.rhythm,
    notes: showNotes,
    lines,
    position,
    pitchHz,
    pitchFrames,
    playing,
    settings: showSettings,
  });
  useEffect(() => {
    onNoteScoreChange?.(show.noteScore);
  }, [show, pitchFrames, position, onNoteScoreChange]);
  // The piano roll also keeps the line just finished, one word set wider than the lyrics text shows: a
  // note whose line just ended is often still mid-scroll past the cursor, and the piano roll's own time
  // window already fades it out gracefully -- dropping it here the instant the line changes cut that
  // scroll off abruptly instead of letting it finish sliding behind the keyboard.
  const shownWordIds = useMemo(
    () =>
      new Set(
        [lines[lineIndex - 1], current, preview].flatMap(
          (line) => line?.words.map((word) => word.id) ?? [],
        ),
      ),
    [lines, lineIndex, current, preview],
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
          pitchFrame={pitchFrames?.at(-1)}
          capturedPitch={pitchFrames !== undefined}
          show={show}
          hidden={lines.length > 0 && phase.kind !== "text"}
          opacity={phase.opacity ?? 1}
        />
      )}
      {/* After the roll: stage light passes in front of its glass (softened over it) but stays under the lyrics and console. */}
      <StageFx engine={show} />
      <section className="stage" aria-label={songTitle}>
        {showLyrics && (
          <Lyrics
            position={position}
            shown={shown}
            phase={phase}
            reducedMotion={preferences.reducedMotion}
          />
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
