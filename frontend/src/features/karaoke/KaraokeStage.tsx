import { Mic2 } from "lucide-react";
import { useMemo, useRef } from "react";
import { useText } from "../../i18n/useText";
import type { EditorDocument } from "../editor/editorModel";
import type { VocalRange } from "../library/songPreferences";
import type { StageLayers } from "./displayModes";
import { defaultPianoRollHeight, usePianoRollLayout, type ResizeEdge } from "./usePianoRollLayout";
import { useSmoothPosition } from "./useSmoothPosition";
import {
  activeNoteId,
  buildLines,
  currentLineIndex,
  letterProgress,
  notesAlignedToWords,
  notesInWindow,
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
}

// Every edge (single axis) and corner (both axes) the piano roll can be resized from.
const resizeEdges: readonly ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const windowSeconds = 8;
// Below this, a word completes before a fill can read as gradual motion to the eye at all (see Lyrics).
const shortWordSeconds = 0.22;
// A fresh line is where the eye has to find where to look again; the fill itself is too gradual to read
// as "it started" in this short a window, so a flash marks the moment unmistakably. Matches the flash
// keyframes' own duration (lyricWordFlash, karaoke.css) so the flash class is never dropped mid-animation.
const lineStartFlashSeconds = 0.26;

const PianoRoll = ({
  document,
  position,
  vocalRange,
  shownWordIds,
  keyShift
}: {
  document: EditorDocument;
  position: number;
  vocalRange: VocalRange;
  shownWordIds: ReadonlySet<string>;
  keyShift: number;
}) => {
  const t = useText();
  const notes = useMemo(
    () => notesAlignedToWords(document.notes, document.words).map(note => ({ ...note, pitch: note.pitch + keyShift })),
    [document.notes, document.words, keyShift]
  );
  const range = useMemo(() => pitchRange(notes, vocalRange), [notes, vocalRange]);
  // Scoped to the same current-and-next line the lyrics panel shows: the roll's own 8-second lookahead is
  // otherwise wider than a line typically lasts, so it would preview a further line's melody with no text
  // on screen to read it against -- exactly what reads as "unrelated to the vocal".
  const inLine = useMemo(() => notes.filter(note => shownWordIds.has(note.wordId)), [notes, shownWordIds]);
  const visible = notesInWindow(inLine, position, windowSeconds);
  const span = Math.max(range.max - range.min, 1);
  const keyboardWidth = 76;
  const frameRef = useRef<HTMLDivElement>(null);
  const { layout, active, beginMove, beginResize, handleMove, handleUp } = usePianoRollLayout(frameRef);
  const rollHeight = layout?.height ?? defaultPianoRollHeight;
  const rowHeight = rollHeight / (range.max - range.min + 1);
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
          <PianoKeyboard height={rollHeight} minMidi={range.min} maxMidi={range.max} rowHeight={rowHeight} width={keyboardWidth} />
        </div>
        <div className="pianoRollLane" aria-hidden />
        {visible.map(note => {
          const left = ((note.start - position) / windowSeconds) * 100 + 25;
          const width = Math.max(((note.end - note.start) / windowSeconds) * 100, 0.6);
          const top = 100 - ((note.pitch - range.min) / span) * 100;
          return (
            <span
              key={note.id}
              className="pianoNote"
              aria-hidden
              style={{ left: `${left}%`, top: `${Math.max(2, Math.min(94, top))}%`, width: `${width}%` }}
            />
          );
        })}
        <span className="pianoPlayhead" aria-hidden style={{ left: "25%" }} />
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
  document,
  position,
  shown,
  phase
}: {
  document: EditorDocument;
  position: number;
  shown: readonly (LyricLine | undefined)[];
  phase: LineDisplayPhase;
}) => {
  const t = useText();
  return (
    <div className="lyrics" aria-live="off">
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
          <p key={line.start} className={slot === 0 ? "current" : "next"}>
            {line.words.map((word, wordIndex) => {
              const progress = slot === 0 ? letterProgress(word, position) : 0;
              const singing = slot === 0 && position >= word.start && position <= word.end;
              // Below this, a word's own fill completes faster than a fill can read as gradual motion,
              // period (roughly a fifth of a second) -- true for a large share of short words across
              // songs generally, not a particular one. Trying to animate it smoothly there just looks
              // like a broken snap; a short, deliberate flash timed to the word's start reads as an
              // intentional hit instead.
              const isShortWord = word.end - word.start < shortWordSeconds;
              // A new line is where the fill's own gradual start is least likely to register: there was no
              // previous word to already be watching, so the eye needs an unmistakable cue that singing has
              // begun. Scoped to the line's first word only, and just its opening instant, so it reads as a
              // single cue rather than a flash on every word.
              const isLineStart =
                singing && wordIndex === 0 && position - word.start < lineStartFlashSeconds;
              // The vocal's own measured notes are the closest thing to "the music" already available for
              // every song (no live audio analysis needed); retriggering the pulse on each note onset makes
              // the flicker land on the melody instead of ticking at a fixed, song-independent rate.
              const noteId = singing && !isShortWord ? activeNoteId(document.notes, word.id, position) : null;
              // A held note can fill so slowly it looks frozen; this ambient pulse is the fallback for a
              // singing word with no measured note at this instant (an unpitched syllable, or a song without
              // note data at all), keeping it visibly "live" even when there is nothing to sync a beat to.
              const className = !singing
                ? "lyricWord"
                : isShortWord || isLineStart
                  ? "lyricWord lyricWordFlash"
                  : noteId !== null
                    ? "lyricWord lyricWordNotePulse"
                    : "lyricWord lyricWordSinging";
              return (
                <span
                  key={noteId ?? word.id}
                  className={className}
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

export const KaraokeStage = ({ songTitle, position: polledPosition, playing, rate, keyShift = 0, document, layers, vocalRange, pitchHz }: KaraokeStageProps) => {
  const t = useText();
  const position = useSmoothPosition(polledPosition, playing, rate);
  const showLyrics = layers.showLyrics && document !== null;
  const showPiano = layers.showNotes && document !== null;
  const showLivePitch = layers.showNotes && pitchHz !== undefined;
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
        <PianoRoll document={document} position={position} vocalRange={vocalRange} shownWordIds={shownWordIds} keyShift={keyShift} />
      )}
      <section className="stage" aria-label={songTitle}>
        {showLyrics && <Lyrics document={document} position={position} shown={shown} phase={phase} />}
        {(instrumental || minimal) && (
          <p className="instrumentalMode">{instrumental ? t("instrumentalMode") : songTitle}</p>
        )}
        {showLivePitch && (
          <div className="livePitch">
            <Mic2 aria-hidden size={16} />
            <span>{t("livePitch")}</span>
            <strong>{Math.round(pitchHz)} Hz</strong>
          </div>
        )}
      </section>
    </>
  );
};
