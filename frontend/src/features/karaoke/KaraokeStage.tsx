import { Mic2 } from "lucide-react";
import { useMemo } from "react";
import { useText } from "../../i18n/useText";
import type { EditorDocument } from "../editor/editorModel";
import type { VocalRange } from "../library/songPreferences";
import type { StageLayers } from "./displayModes";
import { useSmoothPosition } from "./useSmoothPosition";
import { activeNoteId, buildLines, currentLineIndex, letterProgress, notesInWindow, pitchRange } from "./karaokeLyrics";
import { PianoKeyboard } from "../../theme/ui";

interface KaraokeStageProps {
  songTitle: string;
  position: number;
  playing: boolean;
  rate: number;
  document: EditorDocument | null;
  layers: StageLayers;
  vocalRange: VocalRange;
  pitchHz?: number;
}

const windowSeconds = 8;
// Below this, a word completes before a fill can read as gradual motion to the eye at all (see Lyrics).
const shortWordSeconds = 0.22;

const PianoRoll = ({ document, position, vocalRange }: { document: EditorDocument; position: number; vocalRange: VocalRange }) => {
  const t = useText();
  const range = useMemo(() => pitchRange(document.notes, vocalRange), [document.notes, vocalRange]);
  const visible = notesInWindow(document.notes, position, windowSeconds);
  const span = Math.max(range.max - range.min, 1);
  const keyboardWidth = 76;
  const rollHeight = 180;
  const rowHeight = rollHeight / (range.max - range.min + 1);

  return (
    <div className="pianoRoll" role="img" aria-label={t("pianoRoll")}>
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
  );
};

const Lyrics = ({ document, position }: { document: EditorDocument; position: number }) => {
  const lines = useMemo(() => buildLines(document.words, document.lyrics), [document.words, document.lyrics]);
  const index = currentLineIndex(lines, position);
  // Only the line being sung and the one coming up -- a line once finished has nothing left to read.
  const shown = [lines[index], lines[index + 1]];

  return (
    <div className="lyrics" aria-live="off">
      {shown.map((line, slot) =>
        line ? (
          <p key={line.start} className={slot === 0 ? "current" : "next"}>
            {line.words.map(word => {
              const progress = slot === 0 ? letterProgress(word, position) : 0;
              const singing = slot === 0 && position >= word.start && position <= word.end;
              // Below this, a word's own fill completes faster than a fill can read as gradual motion,
              // period (roughly a fifth of a second) -- true for a large share of short words across
              // songs generally, not a particular one. Trying to animate it smoothly there just looks
              // like a broken snap; a short, deliberate flash timed to the word's start reads as an
              // intentional hit instead.
              const isShortWord = word.end - word.start < shortWordSeconds;
              // The vocal's own measured notes are the closest thing to "the music" already available for
              // every song (no live audio analysis needed); retriggering the pulse on each note onset makes
              // the flicker land on the melody instead of ticking at a fixed, song-independent rate.
              const noteId = singing && !isShortWord ? activeNoteId(document.notes, word.id, position) : null;
              // A held note can fill so slowly it looks frozen; this ambient pulse is the fallback for a
              // singing word with no measured note at this instant (an unpitched syllable, or a song without
              // note data at all), keeping it visibly "live" even when there is nothing to sync a beat to.
              const className = !singing
                ? "lyricWord"
                : isShortWord
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
        ) : (
          <p key={`empty-${slot}`} aria-hidden>
            {"\u00a0"}
          </p>
        )
      )}
    </div>
  );
};

export const KaraokeStage = ({ songTitle, position: polledPosition, playing, rate, document, layers, vocalRange, pitchHz }: KaraokeStageProps) => {
  const t = useText();
  const position = useSmoothPosition(polledPosition, playing, rate);
  const showLyrics = layers.showLyrics && document !== null;
  const showPiano = layers.showNotes && document !== null;
  const showLivePitch = layers.showNotes && pitchHz !== undefined;
  const instrumental = document === null || document.words.length === 0;
  const minimal = !showLyrics && !showPiano;

  return (
    <section className="stage" aria-label={songTitle}>
      {showPiano && <PianoRoll document={document} position={position} vocalRange={vocalRange} />}
      {showLyrics && <Lyrics document={document} position={position} />}
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
  );
};
