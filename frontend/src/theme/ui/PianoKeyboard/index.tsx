import type { CSSProperties, PointerEvent } from "react";
import Primitive from "../_internal/Primitive";

const BLACK_KEYS: ReadonlySet<number> = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export const isBlackPianoKey = (midi: number): boolean => BLACK_KEYS.has(((midi % 12) + 12) % 12);
export const pianoNoteName = (midi: number): string =>
  `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

export interface WhiteKeyGeometry {
  midi: number;
  top: number;
  height: number;
}

export function buildWhitePianoKeyGeometry({ minMidi, maxMidi, rowHeight, height }: {
  minMidi: number; maxMidi: number; rowHeight: number; height: number;
}): WhiteKeyGeometry[] {
  const white = Array.from({ length: maxMidi - minMidi + 1 }, (_, index) => maxMidi - index).filter(midi => !isBlackPianoKey(midi));
  const centers = white.map(midi => (maxMidi - midi + 0.5) * rowHeight);
  return white.map((midi, index) => {
    const center = centers[index] ?? 0;
    const previous = index ? (centers[index - 1] ?? 0) : Math.max(0, center - rowHeight * 2);
    const next = centers[index + 1] ?? Math.min(height, center + rowHeight * 2);
    const top = index ? (previous + center) / 2 : 0;
    const bottom = index === centers.length - 1 ? height : (center + next) / 2;
    return { midi, top, height: Math.max(1, bottom - top) };
  });
}

const keyStyle = (black: boolean, width: number, rowHeight: number): CSSProperties => ({
  position: "absolute",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  paddingInlineStart: `${width * 0.08}px`,
  overflow: "hidden",
  border: black ? "1px solid #020203" : "0 solid #929199",
  borderInlineEndWidth: "1px",
  borderBlockEndWidth: "1px",
  borderRadius: "0 var(--shape-xs) var(--shape-xs) 0",
  color: black ? "#f5f5f7" : "#202027",
  background: black ? "linear-gradient(90deg, #050506, #15151a 70%, #303039)" : "linear-gradient(90deg, #fff, #faf9fb 70%, #dedde2)",
  boxShadow: black ? "1px 2px 4px #0009, inset -1px 0 #ffffff12" : "inset 0 -1px #00000012, inset -3px 0 5px #00000014",
  fontSize: `${rowHeight * 0.5}px`,
  lineHeight: 1,
  whiteSpace: "nowrap",
  cursor: "pointer",
  zIndex: black ? 2 : 1
});

export interface PianoKeyboardProps {
  auditionNote?: (midi: number, durationMs: number) => void;
  height: number;
  maxMidi: number;
  minMidi: number;
  rowHeight: number;
  width: number;
}

export default function PianoKeyboard({ auditionNote, height, maxMidi, minMidi, rowHeight, width }: PianoKeyboardProps) {
  const whiteKeys = buildWhitePianoKeyGeometry({ minMidi, maxMidi, rowHeight, height });
  const blackKeys = Array.from({ length: maxMidi - minMidi + 1 }, (_, index) => maxMidi - index).filter(isBlackPianoKey);
  const audition = (event: PointerEvent, midi: number) => {
    event.stopPropagation();
    auditionNote?.(midi, 220);
  };

  return (
    <Primitive
      data-role="piano-keyboard"
      sx={{ position: "relative", overflow: "hidden", background: "#f1f0f3", boxShadow: "var(--space-2) 0 var(--space-4) #0005" }}
      style={{ width, height }}
    >
      {whiteKeys.map(({ midi, top, height: keyHeight }) => (
        <Primitive key={midi} data-role="piano-key" style={{ ...keyStyle(false, width, rowHeight), top, width, height: keyHeight }} onPointerDown={event => audition(event, midi)}>
          {pianoNoteName(midi)}
        </Primitive>
      ))}
      {blackKeys.map(midi => {
        const keyHeight = rowHeight * 0.68;
        return (
          <Primitive
            key={midi}
            data-role="piano-key"
            data-black
            style={{ ...keyStyle(true, width, rowHeight), top: (maxMidi - midi + 0.5) * rowHeight - keyHeight / 2, width: width * 0.64, height: keyHeight }}
            onPointerDown={event => audition(event, midi)}
          >
            {pianoNoteName(midi)}
          </Primitive>
        );
      })}
    </Primitive>
  );
}
