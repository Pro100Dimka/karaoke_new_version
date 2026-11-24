import { observer } from 'mobx-react-lite';
import { store } from '../../providers/store';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  KaraokeLyrics,
  MelodyRoll,
  resizeEdges,
  tr,
  useLocale,
  useReducedMotion,
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
import type { Preferences } from '../../shared/preferences/preferences';
import { RollFx, StageFx, useShowEngine } from './show/ShowLayers';
import type { ShowEngine } from './show/showEngine';
import { RollFxNoteIndex } from './show/rollFxNoteIndex';

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
    notes,
    previewReady,
    position,
    vocalRange,
    pitchHz,
    pitchFrame,
    capturedPitch,
    show,
    hitNoteIds,
    playing,
  }: {
    notes: EditorDocument['notes'];
    previewReady: boolean;
    position: number;
    vocalRange: VocalRange;
    pitchHz?: number;
    pitchFrame?: PitchFrame;
    capturedPitch: boolean;
    show: ShowEngine;
    hitNoteIds: ReadonlySet<string>;
    playing: boolean;
  }) => {
    useLocale();
    const [span, setSpan] = useState(windowSeconds);
    const range = useMemo(
      () => pitchRange(notes, vocalRange),
      [notes, vocalRange],
    );
    const noteIndex = useMemo(() => new RollFxNoteIndex(notes), [notes]);
    const hidden =
      !previewReady ||
      !noteIndex.firstOverlapping(
        position - span * rollLead,
        position + span * (1 - rollLead),
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
    const activeNote = noteIndex.firstOverlapping(voicePosition, voicePosition);
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

/** The same timed lines support a fixed preview, scrolling credits and alternating slots. */
const Lyrics = ({
  position,
  lines,
  lineIndex,
  layout,
  lineCount,
  phase,
  reducedMotion,
  font,
}: {
  position: number;
  lines: readonly LyricLine[];
  lineIndex: number;
  layout: Preferences['karaokeLyricsLayout'];
  lineCount: number;
  phase: LineDisplayPhase;
  reducedMotion: boolean;
  font: string;
}) => {
  useLocale();
  const current = lines[lineIndex];
  const count = layout === 'alternating' ? 2 : lineCount;
  // The credits camera follows musical time, independently of the highlighted row.
  const nextScroll = lines.findIndex((line) => line.start > position);
  const scrollIndex = Math.max(
    0,
    (nextScroll < 0 ? lines.length : nextScroll) - 1,
  );
  const scrollLine = lines[scrollIndex];
  const scrollEnd =
    lines[scrollIndex + 1]?.start ?? scrollLine?.end ?? position;
  const scroll =
    scrollIndex +
    Math.max(
      0,
      Math.min(
        1,
        (position - (scrollLine?.start ?? position)) /
          Math.max(0.001, scrollEnd - (scrollLine?.start ?? position)),
      ),
    );
  const rows = useMemo(() => {
    const before = layout === 'credits' ? Math.floor(count / 2) : 0;
    const firstRow =
      layout === 'credits' ? scrollIndex - before - 1 : lineIndex;
    return Array.from(
      { length: count + (layout === 'credits' ? 2 : 0) },
      (_, slot) => {
        const index = firstRow + slot;
        const line = lines[index];
        if (!line || !current) return [];
        const first = Math.min(index, lineIndex);
        const last = Math.max(index, lineIndex);
        if (
          lines
            .slice(first, last)
            .some(
              (left, offset) =>
                (lines[first + offset + 1]?.start ?? Infinity) - left.end >
                lyricSilenceSeconds,
            )
        )
          return [];
        return [
          {
            line,
            active: index === lineIndex,
            slot:
              layout === 'alternating'
                ? index % 2
                : index -
                  (layout === 'credits' ? scrollIndex - before : lineIndex),
          },
        ];
      },
    ).flat();
  }, [lines, current, lineIndex, layout, count, scrollIndex]);
  const previews = useMemo(
    () => rows.filter((row) => !row.active).flatMap((row) => row.line.words),
    [rows],
  );
  // Preview from "3"; saved word times keep the text unfilled until singing starts.
  const { countdown } = phase;
  const textVisible =
    phase.kind === 'text' || (countdown !== undefined && countdown <= 3);
  const id = useId();
  useLyricFill(
    id,
    textVisible ? (current?.words ?? noWords) : noWords,
    position,
    font,
    syllableProgress,
    textVisible ? previews : noWords,
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
      <div
        className="lyricsPanel"
        hidden={!textVisible}
        style={{
          opacity: phase.kind === 'countdown' ? 1 : (phase.opacity ?? 1),
        }}
      >
        <div
          id={id}
          className="lyricsRows"
          data-layout={layout}
          data-reduced-motion={reducedMotion || undefined}
          style={{
            height:
              layout === 'credits'
                ? `calc(${count} * var(--lyrics-row-height))`
                : undefined,
          }}
        >
          {textVisible &&
            rows.map(({ line, active, slot }) => (
              <KaraokeLyrics
                key={line.start}
                className="lyrics"
                data-lyric-row=""
                data-reduced-motion={reducedMotion || undefined}
                data-slot={slot}
                style={{
                  order: slot,
                  transform:
                    layout === 'credits'
                      ? `translateY(${(slot - (scroll - scrollIndex)) * 100}%)`
                      : undefined,
                }}
                current={active ? line.words : noWords}
                next={active ? noWords : line.words}
                currentKey={`${line.start}-current-${active}`}
                nextKey={`${line.start}-next-${active}`}
              />
            ))}
        </div>
      </div>
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
    const reducedMotion = useReducedMotion();
    const position = useSmoothPosition(polledPosition, playing, rate);
    const { preferences } = store;
    const showLyrics = layers.showLyrics && document !== null;
    const showPiano = layers.showNotes && document !== null;
    const instrumental = document === null || document.words.length === 0;
    const minimal = !showLyrics && !showPiano;
    const lines = useMemo(
      () =>
        document
          ? buildLines(
              document.words,
              document.lyrics,
              document.bpm,
              document.vocalActivity,
            )
          : [],
      [document],
    );
    const lineIndex = currentLineIndex(lines, position);
    const phase = upcomingLinePhase(lines, lineIndex, position);
    const showNotes = useMemo(() => {
      const words = new Set(
        lines.flatMap((line) => line.words.map((word) => word.id)),
      );
      return (document?.notes ?? [])
        .filter((note) => words.has(note.wordId))
        .map((note) => ({
          ...note,
          pitch: note.pitch + keyShift,
        }));
    }, [document, keyShift, lines]);
    const showSettings = useMemo(
      () => ({
        intensity: preferences.reducedMotion
          ? ('balanced' as const)
          : ('full' as const),
        reducedMotion,
      }),
      [preferences.reducedMotion, reducedMotion],
    );
    const show = useShowEngine({
      ignoreSilence: Boolean(store.online.room),
      performanceId: store.online.room?.performanceId,
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
        current === hits ||
        (current.size === hits.size && [...hits].every((id) => current.has(id)))
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
            notes={showNotes}
            previewReady={!showLyrics || phase.kind !== 'empty'}
            position={position}
            vocalRange={vocalRange}
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
              lines={lines}
              lineIndex={lineIndex}
              layout={preferences.karaokeLyricsLayout}
              lineCount={preferences.karaokeLyricsLines}
              phase={phase}
              reducedMotion={reducedMotion}
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
