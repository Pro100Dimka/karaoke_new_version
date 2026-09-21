const noteNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"] as const;
const maxMidi = 127;
const semitonesPerOctave = 12;
const octaveOffset = 1;

export interface NoteRange {
  low: number;
  high: number;
}

/** Scientific pitch name of a MIDI note, e.g. 60 -> "C4". */
export const noteName = (midi: number): string => {
  const note = Math.max(0, Math.min(maxMidi, Math.round(midi)));
  return `${noteNames[note % semitonesPerOctave]}${Math.floor(note / semitonesPerOctave) - octaveOffset}`;
};

export const rangeOf = (pitches: readonly number[]): NoteRange | null =>
  pitches.length === 0 ? null : { low: Math.min(...pitches), high: Math.max(...pitches) };

/** "C3 – A4" with the current transposition applied; a dash when the song has no notes. */
export const rangeLabel = (range: NoteRange | null, shift: number): string =>
  range === null ? "—" : `${noteName(range.low + shift)} – ${noteName(range.high + shift)}`;
