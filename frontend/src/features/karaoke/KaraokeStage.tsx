import { observer } from 'mobx-react-lite';
import { store } from '../../providers/store';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  KaraokeLyrics,
  MelodyRoll,
  resizeEdges,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { DetachButton, DetachedPanel } from '../../shared/ui/DetachedPanel';
import { useDetachedPanel } from '../../shared/ui/useDetachedPanel';
import type { EditorDocument } from '../../application/editor/editorModel';
import type { VocalRange } from '../../application/library/songPreferences';
import type { StageLayers } from './displayModes';
import { usePianoRollLayout } from './usePianoRollLayout';
import { useSmoothPosition } from './useSmoothPosition';
import { useLyricFill } from './useLyricFill';
import {
  buildLines,
  syllableProgress,
  currentLineIndex,
  lyricSilenceSeconds,
  pitchAccuracy,
  pitchMatchesTarget,
  pitchHzToMidi,
  pitchRange,
  targetPitchAt,
  reliablePitchHz,
  upcomingLinePhase,
  type LineDisplayPhase,
  type LyricLine,
} from './karaokeLyrics';
import type { KaraokeNoteScore, PitchFrame } from '../../contracts/models';
import { RollFx, StageFx, useShowEngine } from './show/ShowLayers';
import type { ShowEngine } from './show/showEngine';

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
const noWords: EditorDocument['words'] = [];
// Where MelodyRoll puts its playhead across the lane (its default), shared with the show's light layer.
const rollLead = 0.25;

// The piano roll's window starts at the size of the roll on the karaoke screen.
const pianoPanelSize = { width: 920, height: 220 };

const PianoRoll = observer(
  ({
    document,
    position,
    vocalRange,
    keyShift,
    pitchHz,
    pitchFrame,
    capturedPitch,
    show,
    hitNoteIds,
    playing,
  }: {
    document: EditorDocument;
    position: number;
    vocalRange: VocalRange;
    keyShift: number;
    pitchHz?: number;
    pitchFrame?: PitchFrame;
    capturedPitch: boolean;
    show: ShowEngine;
    hitNoteIds: ReadonlySet<string>;
    playing: boolean;
  }) => {
    useLocale();
    const [span, setSpan] = useState(windowSeconds);
    const notes = useMemo(
      () =>
        document.notes.map((note) => ({
          ...note,
          pitch: note.pitch + keyShift,
        })),
      [document.notes, keyShift],
    );
    const range = useMemo(
      () => pitchRange(notes, vocalRange),
      [notes, vocalRange],
    );
    const hidden = !notes.some(
      (note) =>
        note.end >= position - span * rollLead &&
        note.start <= position + span * (1 - rollLead),
    );
    const frameRef = useRef<HTMLDivElement>(null);
    const panel = useDetachedPanel(
      'pianoRoll',
      tr('pianoRoll'),
      pianoPanelSize,
    );
    const { layout, active, beginMove, beginResize, handleMove, handleUp } =
      usePianoRollLayout(frameRef, (bounds, pointer) =>
        panel.detach(bounds, pointer),
      );
    const voicePosition = pitchFrame?.positionSeconds ?? position;
    const observedPitch = pitchFrame ? pitchFrame.pitchHz : pitchHz;
    const measuredPitch = reliablePitchHz(
      observedPitch,
      pitchFrame?.confidence,
    );
    const activeNote = notes.find(
      (note) => voicePosition >= note.start && voicePosition <= note.end,
    );
    const targetPitch = activeNote
      ? targetPitchAt(activeNote, voicePosition)
      : undefined;
    const liveMidi = pitchHzToMidi(observedPitch);
    const accuracy = pitchAccuracy(measuredPitch, targetPitch);
    const onTarget = Boolean(
      targetPitch !== undefined &&
      pitchMatchesTarget(measuredPitch, targetPitch),
    );
    const livePitch = capturedPitch ? undefined : liveMidi;
    const label = tr('pianoRoll');
    const melody = useMemo(
      () => (
        <MelodyRoll
          className="pianoRollLane"
          label={label}
          notes={notes}
          position={position}
          minPitch={range.min}
          maxPitch={range.max}
          window={span}
          onWindowChange={setSpan}
          livePitch={livePitch}
          accuracy={accuracy}
          hit={onTarget}
          hitIds={hitNoteIds}
        />
      ),
      [
        label,
        notes,
        position,
        range,
        span,
        livePitch,
        accuracy,
        onTarget,
        hitNoteIds,
      ],
    );
    const frameStyle =
      layout && !panel.detached
        ? {
            left: layout.left,
            top: layout.top,
            width: layout.width,
            height: layout.height,
            transform: 'none',
          }
        : undefined;

    return (
      <DetachedPanel panel={panel}>
        <div
          ref={frameRef}
          className="pianoRoll"
          hidden={hidden}
          inert={hidden}
          data-ad-paused={hidden ? '' : undefined}
          data-active={(active && !panel.detached) || undefined}
          style={frameStyle}
          // In its own window the roll is placed and sized by that window, not dragged inside the app.
          onPointerDown={panel.detached ? undefined : beginMove}
          onPointerMove={panel.detached ? undefined : handleMove}
          onPointerUp={panel.detached ? undefined : handleUp}
        >
          {melody}
          <RollFx
            playing={playing && !hidden}
            engine={show}
            view={{
              notes,
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
  },
);

/** The two lines on screen: the one being sung fills word by word and breathes with the drums; the next waits below. */
const Lyrics = ({
  position,
  shown,
  phase,
  reducedMotion,
  font,
}: {
  position: number;
  shown: readonly (LyricLine | undefined)[];
  phase: LineDisplayPhase;
  reducedMotion: boolean;
  font: string;
}) => {
  useLocale();
  const [current, next] = shown;
  // Preview on "1"; saved word times keep the text unfilled until singing starts.
  const { countdown } = phase;
  const textVisible = phase.kind === 'text' || countdown === 1;
  const id = useId();
  useLyricFill(
    id,
    textVisible ? (current?.words ?? noWords) : noWords,
    position,
    font,
    syllableProgress,
  );
  return (
    <>
      {countdown !== undefined && (
        <p
          className="lyricsCountdown"
          role="timer"
          aria-label={tr('introCountdown', { seconds: countdown })}
        >
          <span key={countdown}>{countdown}</span>
        </p>
      )}
      <KaraokeLyrics
        id={id}
        className="lyrics"
        data-reduced-motion={reducedMotion || undefined}
        style={{ opacity: phase.opacity ?? 1 }}
        current={textVisible ? (current?.words ?? noWords) : noWords}
        next={textVisible ? (next?.words ?? noWords) : noWords}
        currentKey={current?.start}
        nextKey={next?.start}
      />
    </>
  );
};

export const KaraokeStage = observer(
  ({
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
    useLocale();
    const position = useSmoothPosition(polledPosition, playing, rate);
    const { preferences } = store;
    const showLyrics = layers.showLyrics && document !== null;
    const showPiano = layers.showNotes && document !== null;
    const instrumental = document === null || document.words.length === 0;
    const minimal = !showLyrics && !showPiano;
    const lines = useMemo(
      () =>
        document
          ? buildLines(document.words, document.lyrics, document.bpm)
          : [],
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
        intensity: 'full' as const,
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
    const [hitNoteIds, setHitNoteIds] = useState(show.hitNoteIds);
    // Publish new hits after the engine consumes this frame, including the final paused frame.
    useEffect(() => {
      onNoteScoreChange?.(show.noteScore);
      const hits = show.hitNoteIds;
      setHitNoteIds((current) =>
        current.size === hits.size && [...hits].every((id) => current.has(id))
          ? current
          : hits,
      );
    });
    return (
      <>
        {/* Rendered as a sibling of .stage, not inside it: the piano roll is position: fixed and freely
          user-placed (see usePianoRollLayout), including over the console -- it must stay in the karaoke
          page's own top-level stacking order to render behind everything else there, which a descendant
          of .stage's own stacking context could never do regardless of its own z-index. */}
        {showPiano && (
          <PianoRoll
            playing={playing}
            document={document}
            position={position}
            vocalRange={vocalRange}
            keyShift={keyShift}
            pitchHz={pitchHz}
            pitchFrame={pitchFrames?.at(-1)}
            capturedPitch={pitchFrames !== undefined}
            show={show}
            hitNoteIds={hitNoteIds}
          />
        )}
        {/* After the roll: stage light passes in front of its glass (softened over it) but stays under the lyrics and console. */}
        <StageFx engine={show} playing={playing} />
        <section className="stage" aria-label={songTitle}>
          {showLyrics && (
            <Lyrics
              position={position}
              shown={shown}
              phase={phase}
              reducedMotion={preferences.reducedMotion}
              font={preferences.headingFont}
            />
          )}
          {(instrumental || minimal) && (
            <p className="instrumentalMode">
              {instrumental ? tr('instrumentalMode') : songTitle}
            </p>
          )}
        </section>
      </>
    );
  },
);
