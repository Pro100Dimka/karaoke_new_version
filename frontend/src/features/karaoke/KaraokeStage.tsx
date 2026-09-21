import { Mic2 } from "lucide-react";
import { useMemo } from "react";
import { useText } from "../../i18n/useText";
import type { EditorDocument } from "../editor/editorModel";
import type { VocalRange } from "../library/songPreferences";
import type { KaraokeDisplayMode } from "../../shared/preferences/preferences";
import { buildLines, currentLineIndex, notesInWindow, pitchRange, wordProgress } from "./karaokeLyrics";

interface KaraokeStageProps {
  songTitle: string;
  position: number;
  document: EditorDocument | null;
  mode: KaraokeDisplayMode;
  vocalRange: VocalRange;
  pitchHz?: number;
}

const windowSeconds = 8;

const PianoRoll = ({ document, position, vocalRange }: { document: EditorDocument; position: number; vocalRange: VocalRange }) => {
  const t = useText();
  const range = useMemo(() => pitchRange(document.notes, vocalRange), [document.notes, vocalRange]);
  const visible = notesInWindow(document.notes, position, windowSeconds);
  const span = Math.max(range.max - range.min, 1);

  return (
    <div className="pianoRoll" role="img" aria-label={t("pianoRoll")}>
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
  const lines = useMemo(() => buildLines(document.words), [document.words]);
  const index = currentLineIndex(lines, position);
  const shown = [lines[index - 1], lines[index], lines[index + 1]];

  return (
    <div className="lyrics" aria-live="off">
      {shown.map((line, slot) =>
        line ? (
          <p key={line.start} className={slot === 1 ? "current" : slot === 0 ? "previous" : "next"}>
            {line.words.map(word => {
              const progress = slot === 1 ? wordProgress(word, position) : slot === 0 ? 1 : 0;
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
        ) : (
          <p key={`empty-${slot}`} aria-hidden>
            {"\u00a0"}
          </p>
        )
      )}
    </div>
  );
};

export const KaraokeStage = ({ songTitle, position, document, mode, vocalRange, pitchHz }: KaraokeStageProps) => {
  const t = useText();
  const showLyrics = mode !== "minimal" && document !== null && document.words.length > 0;
  const showPiano = mode === "lyricsPiano" && document !== null && document.notes.length > 0;
  const showLivePitch = mode === "lyricsPitch" && pitchHz !== undefined;
  const instrumental = document === null || document.words.length === 0;

  return (
    <section className="stage" aria-label={songTitle}>
      {showPiano && <PianoRoll document={document} position={position} vocalRange={vocalRange} />}
      {showLyrics && <Lyrics document={document} position={position} />}
      {(instrumental || mode === "minimal") && (
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
