import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { subscribeSpectrum } from "../../app/backdrop/spectrumEvents";
import { createPercussionReaction } from "../../app/backdrop/useSpectrumFeed";
import { useText } from "../../i18n/useText";
import type { EditorDocument } from "../editor/editorModel";
import type { VocalRange } from "../library/songPreferences";
import type { StageLayers } from "./displayModes";
import { defaultPianoRollHeight, usePianoRollLayout, type ResizeEdge } from "./usePianoRollLayout";
import { useSmoothPosition } from "./useSmoothPosition";
import {
  buildLines,
  currentLineIndex,
  letterProgress,
  notesAlignedToWords,
  notesInWindow,
  noteHitReached,
  pitchAccuracy,
  pitchMatchesTarget,
  pitchMidiNearTarget,
  pitchRange,
  upcomingLinePhase,
  type LineDisplayPhase,
  type LyricLine
} from "./karaokeLyrics";
import { PianoKeyboard } from "../../theme/ui";

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
  onNoteScoreChange?: (score: { hitNotes: number; totalNotes: number }) => void;
}

// Every edge (single axis) and corner (both axes) the piano roll can be resized from.
const resizeEdges: readonly ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const windowSeconds = 8;

const PianoRoll = ({
  document,
  position,
  vocalRange,
  shownWordIds,
  keyShift,
  pitchHz,
  onNoteScoreChange
}: {
  document: EditorDocument;
  position: number;
  vocalRange: VocalRange;
  shownWordIds: ReadonlySet<string>;
  keyShift: number;
  pitchHz?: number;
  onNoteScoreChange?: (score: { hitNotes: number; totalNotes: number }) => void;
}) => {
  const t = useText();
  const displayNotes = useMemo(
    () => notesAlignedToWords(document.notes, document.words).map(note => ({ ...note, pitch: note.pitch + keyShift })),
    [document.notes, document.words, keyShift]
  );
  const scoringNotes = useMemo(
    () => document.notes.map(note => ({ ...note, pitch: note.pitch + keyShift })),
    [document.notes, keyShift]
  );
  const range = useMemo(() => pitchRange(displayNotes, vocalRange), [displayNotes, vocalRange]);
  // Scoped to the same current-and-next line the lyrics panel shows: the roll's own 8-second lookahead is
  // otherwise wider than a line typically lasts, so it would preview a further line's melody with no text
  // on screen to read it against -- exactly what reads as "unrelated to the vocal".
  const inLine = useMemo(() => displayNotes.filter(note => shownWordIds.has(note.wordId)), [displayNotes, shownWordIds]);
  const visible = notesInWindow(inLine, position, windowSeconds);
  const span = Math.max(range.max - range.min, 1);
  const keyboardWidth = 76;
  const frameRef = useRef<HTMLDivElement>(null);
  const { layout, active, beginMove, beginResize, handleMove, handleUp } = usePianoRollLayout(frameRef);
  const rollHeight = layout?.height ?? defaultPianoRollHeight;
  const rowHeight = rollHeight / (range.max - range.min + 1);
  const activeNote = scoringNotes.find(note => position >= note.start && position <= note.end);
  const liveMidi = pitchMidiNearTarget(pitchHz, activeNote?.pitch);
  const accuracy = pitchAccuracy(pitchHz, activeNote?.pitch);
  const [hitNoteIds, setHitNoteIds] = useState<ReadonlySet<string>>(() => new Set());
  const hitNoteIdsRef = useRef<ReadonlySet<string>>(new Set());
  const seenNoteIds = useRef<ReadonlySet<string>>(new Set());
  const matchedSeconds = useRef(new Map<string, number>());
  const previousFrame = useRef({ position, noteId: activeNote?.id });
  useEffect(() => {
    matchedSeconds.current.clear();
    hitNoteIdsRef.current = new Set();
    seenNoteIds.current = new Set();
    previousFrame.current = { position, noteId: activeNote?.id };
    setHitNoteIds(new Set());
    onNoteScoreChange?.({ hitNotes: 0, totalNotes: 0 });
  }, [document.revision, keyShift, onNoteScoreChange]);
  useEffect(() => {
    const previous = previousFrame.current;
    const elapsed = position - previous.position;
    if (elapsed < -0.05) {
      matchedSeconds.current.clear();
      hitNoteIdsRef.current = new Set();
      seenNoteIds.current = new Set();
      setHitNoteIds(new Set());
    } else if (activeNote) {
      seenNoteIds.current = new Set(seenNoteIds.current).add(activeNote.id);
    }
    if (
      activeNote && previous.noteId === activeNote.id && elapsed > 0 && elapsed <= 0.2 &&
      pitchMatchesTarget(pitchHz, activeNote.pitch)
    ) {
      const matched = (matchedSeconds.current.get(activeNote.id) ?? 0) + elapsed;
      matchedSeconds.current.set(activeNote.id, matched);
      if (noteHitReached(matched, activeNote.end - activeNote.start) && !hitNoteIdsRef.current.has(activeNote.id)) {
        hitNoteIdsRef.current = new Set(hitNoteIdsRef.current).add(activeNote.id);
        setHitNoteIds(hitNoteIdsRef.current);
      }
    }
    onNoteScoreChange?.({ hitNotes: hitNoteIdsRef.current.size, totalNotes: seenNoteIds.current.size });
    previousFrame.current = { position, noteId: activeNote?.id };
  }, [activeNote, pitchHz, position, onNoteScoreChange]);
  const frameStyle = layout
    ? { left: layout.left, top: layout.top, width: layout.width, height: layout.height, transform: "none" }
    : undefined;

  return (
    <div
      ref={frameRef}
      className={active ? "pianoRoll pianoRollActive" : "pianoRoll"}
      style={frameStyle}
      role="img"
      aria-label={t("pianoRoll")}
      onPointerDown={beginMove}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
    >
      {/* Clips the keyboard/notes/playhead to the panel's own rounded frame; kept separate from .pianoRoll
          itself so that overflow: hidden here never also clips the resize handles, which must stick out
          past this same border to stay grabbable. */}
      <div className="pianoRollContent">
        <div className="pianoRollKeyboard" aria-hidden>
          <PianoKeyboard activeHit={Boolean(activeNote && pitchMatchesTarget(pitchHz, activeNote.pitch))} activeMidi={liveMidi === undefined ? undefined : Math.round(liveMidi)} height={rollHeight} minMidi={range.min} maxMidi={range.max} rowHeight={rowHeight} width={keyboardWidth} />
        </div>
        <div className="pianoRollLane" aria-hidden />
        {visible.map(note => {
          const left = ((note.start - position) / windowSeconds) * 100 + 25;
          const width = Math.max(((note.end - note.start) / windowSeconds) * 100, 0.6);
          const top = 100 - ((note.pitch - range.min) / span) * 100;
          return (
            <span
              key={note.id}
              className={hitNoteIds.has(note.id) ? "pianoNote pianoNoteHit" : "pianoNote"}
              data-note-hit={hitNoteIds.has(note.id) ? "true" : undefined}
              aria-hidden
              style={{ left: `${left}%`, top: `${Math.max(2, Math.min(94, top))}%`, width: `${width}%` }}
            />
          );
        })}
        <span className="pianoPlayhead" aria-hidden style={{ left: "25%" }} />
        {liveMidi !== undefined && (
          <span
            className={activeNote && pitchMatchesTarget(pitchHz, activeNote.pitch)
              ? "livePitchMarker livePitchMarkerHit"
              : "livePitchMarker"}
            data-role="live-pitch-marker"
            aria-hidden
            style={{
              left: "25%",
              top: `${Math.max(2, Math.min(94, 100 - ((liveMidi - range.min) / span) * 100))}%`,
              "--pitch-accuracy": accuracy
            } as CSSProperties}
          />
        )}
      </div>
      {active &&
        resizeEdges.map(edge => (
          <span
            key={edge}
            className={`pianoRollResizeHandle pianoRollResizeHandle-${edge}`}
            aria-hidden
            onPointerDown={beginResize(edge)}
          />
        ))}
    </div>
  );
};

const Lyrics = ({
  position,
  shown,
  phase
}: {
  position: number;
  shown: readonly (LyricLine | undefined)[];
  phase: LineDisplayPhase;
}) => {
  const t = useText();
  const lyricsRef = useRef<HTMLDivElement>(null);
  const percussion = useMemo(createPercussionReaction, []);
  useEffect(() => subscribeSpectrum(frame => {
    const reaction = percussion.next(frame.backingBands);
    lyricsRef.current?.style.setProperty("--lyric-kick", String(reaction.kick));
    lyricsRef.current?.style.setProperty("--lyric-snare", String(reaction.snare));
    lyricsRef.current?.style.setProperty("--lyric-pulse", String(reaction.pulse));
  }), [percussion]);
  return (
    <div ref={lyricsRef} className="lyrics" aria-live="off">
      {shown.map((line, slot) => {
        if (!line) {
          return (
            <p key={`empty-${slot}`} aria-hidden>
              {" "}
            </p>
          );
        }
        // During a long instrumental gap before this line, the screen clears and then counts down to it
        // instead of sitting on its not-yet-sung text for the whole break (see upcomingLinePhase); slot 1's
        // own preview is held back the same way, so nothing floats under an empty or counting-down slot 0.
        // Every branch below keeps the same key (line.start) across phase changes so the existing opacity
        // transition on .lyrics p animates the switch instead of the paragraph being torn down and rebuilt.
        if (slot === 0 && phase.kind === "empty") {
          return (
            <p key={line.start} className="current currentEmpty" aria-hidden>
              {" "}
            </p>
          );
        }
        if (slot === 0 && phase.kind === "countdown") {
          return (
            <p key={line.start} className="current currentCountdown">
              {t("introCountdown", { seconds: phase.secondsRemaining ?? 0 })}
            </p>
          );
        }
        if (slot === 1 && phase.kind !== "text") {
          return (
            <p key={`empty-${slot}`} aria-hidden>
              {" "}
            </p>
          );
        }
        return (
          <p key={line.start} className={slot === 0 ? "current lyricLineReactive" : "next"}>
            {line.words.map(word => {
              const progress = slot === 0 ? letterProgress(word, position) : 0;
              return (
                <span
                  key={word.id}
                  className="lyricWord"
                  style={{ backgroundSize: `${Math.round(progress * 100)}% 100%, 100% 100%` }}
                >
                  {word.text}{" "}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
};

export const KaraokeStage = ({ songTitle, position: polledPosition, playing, rate, keyShift = 0, document, layers, vocalRange, pitchHz, onNoteScoreChange }: KaraokeStageProps) => {
  const t = useText();
  const position = useSmoothPosition(polledPosition, playing, rate);
  const showLyrics = layers.showLyrics && document !== null;
  const showPiano = layers.showNotes && document !== null;
  const instrumental = document === null || document.words.length === 0;
  const minimal = !showLyrics && !showPiano;
  // Computed once and shared by both panels, so the piano roll can never show a different slice of the
  // song than the lyrics being read alongside it (see PianoRoll's shownWordIds).
  const lines = useMemo(() => (document ? buildLines(document.words, document.lyrics) : []), [document]);
  const lineIndex = currentLineIndex(lines, position);
  const shown = [lines[lineIndex], lines[lineIndex + 1]];
  const phase = upcomingLinePhase(lines, lineIndex, position);
  // The piano roll also keeps the line just finished, one word set wider than the lyrics text shows: a
  // note whose line just ended is often still mid-scroll past the cursor, and notesInWindow's own time
  // window already fades it out gracefully -- dropping it here the instant the line changes cut that
  // scroll off abruptly instead of letting it finish sliding behind the keyboard.
  const shownWordIds = useMemo(
    () =>
      new Set(
        [lines[lineIndex - 1], lines[lineIndex], lines[lineIndex + 1]].flatMap(
          line => line?.words.map(word => word.id) ?? []
        )
      ),
    [lines, lineIndex]
  );

  return (
    <>
      {/* Rendered as a sibling of .stage, not inside it: the piano roll is position: fixed and freely
          user-placed (see usePianoRollLayout), including over the console -- it must stay in the karaoke
          page's own top-level stacking order to render behind everything else there, which a descendant
          of .stage's own stacking context could never do regardless of its own z-index. */}
      {showPiano && (
        <PianoRoll document={document} position={position} vocalRange={vocalRange} shownWordIds={shownWordIds} keyShift={keyShift} pitchHz={pitchHz} onNoteScoreChange={onNoteScoreChange} />
      )}
      <section className="stage" aria-label={songTitle}>
        {showLyrics && <Lyrics position={position} shown={shown} phase={phase} />}
        {(instrumental || minimal) && (
          <p className="instrumentalMode">{instrumental ? t("instrumentalMode") : songTitle}</p>
        )}
      </section>
    </>
  );
};
