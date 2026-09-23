export interface EditorNote {
  id: string;
  wordId: string;
  pitch: number;
  start: number;
  end: number;
}

export interface EditorWord {
  id: string;
  text: string;
  start: number;
  end: number;
  /** Where each character starts inside the word, as a fraction (0..1) of its duration; absent when not timed. */
  letters?: readonly number[];
}

export interface EditorDocument {
  revision: number;
  bpm?: number;
  key?: string;
  words: readonly EditorWord[];
  notes: readonly EditorNote[];
  /** The lyrics as written, one line per row; the words come from splitting it, so it tells where lines break. */
  lyrics?: string;
}

export const minNoteSeconds = 0.03;
export const minPitch = 24;
export const maxPitch = 96;
export const snapGridSeconds = 0.05;

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const round = (value: number): number => Math.round(value * 1000) / 1000;

export const snapTime = (seconds: number, enabled: boolean): number =>
  enabled ? round(Math.round(seconds / snapGridSeconds) * snapGridSeconds) : round(seconds);

const wordOf = (document: EditorDocument, note: EditorNote): EditorWord | undefined =>
  document.words.find(word => word.id === note.wordId);

const withNotes = (document: EditorDocument, notes: readonly EditorNote[]): EditorDocument => ({ ...document, notes });

/**
 * Moves every selected note together. The shift is limited so that no note leaves its word,
 * because the note-inside-word invariant is enforced again by the backend on save.
 */
export const moveNotes = (
  document: EditorDocument,
  ids: ReadonlySet<string>,
  deltaPitch: number,
  deltaSeconds: number
): EditorDocument => {
  const selected = document.notes.filter(note => ids.has(note.id));
  if (selected.length === 0) return document;
  let low = -Infinity;
  let high = Infinity;
  for (const note of selected) {
    const word = wordOf(document, note);
    if (!word) continue;
    low = Math.max(low, word.start - note.start);
    high = Math.min(high, word.end - note.end);
  }
  const shift = clamp(deltaSeconds, Number.isFinite(low) ? low : 0, Number.isFinite(high) ? high : 0);
  const pitchLow = Math.max(...selected.map(note => minPitch - note.pitch));
  const pitchHigh = Math.min(...selected.map(note => maxPitch - note.pitch));
  const pitchShift = clamp(deltaPitch, pitchLow, pitchHigh);
  if (shift === 0 && pitchShift === 0) return document;
  return withNotes(
    document,
    document.notes.map(note =>
      ids.has(note.id)
        ? { ...note, pitch: note.pitch + pitchShift, start: round(note.start + shift), end: round(note.end + shift) }
        : note
    )
  );
};

/** Adjusts one boundary; a note never crosses its word, its own opposite edge or a neighbour in the same word. */
export const resizeNote = (
  document: EditorDocument,
  noteId: string,
  edge: "start" | "end",
  seconds: number
): EditorDocument => {
  const note = document.notes.find(item => item.id === noteId);
  const word = note ? wordOf(document, note) : undefined;
  if (!note || !word) return document;
  const siblings = document.notes.filter(item => item.wordId === note.wordId && item.id !== note.id);
  let next = note;
  if (edge === "start") {
    const floor = Math.max(word.start, ...siblings.filter(item => item.end <= note.start).map(item => item.end));
    next = { ...note, start: round(clamp(seconds, floor, note.end - minNoteSeconds)) };
  } else {
    const ceiling = Math.min(word.end, ...siblings.filter(item => item.start >= note.end).map(item => item.start));
    next = { ...note, end: round(clamp(seconds, note.start + minNoteSeconds, ceiling)) };
  }
  return withNotes(document, document.notes.map(item => (item.id === noteId ? next : item)));
};

export const deleteNotes = (document: EditorDocument, ids: ReadonlySet<string>): EditorDocument =>
  ids.size === 0 ? document : withNotes(document, document.notes.filter(note => !ids.has(note.id)));

/** Merges selected notes of one word into a single note spanning them; different words cannot be merged. */
export const canMerge = (document: EditorDocument, ids: ReadonlySet<string>): boolean => {
  const selected = document.notes.filter(note => ids.has(note.id));
  return selected.length >= 2 && new Set(selected.map(note => note.wordId)).size === 1;
};

export const mergeNotes = (document: EditorDocument, ids: ReadonlySet<string>): EditorDocument => {
  if (!canMerge(document, ids)) return document;
  const selected = document.notes.filter(note => ids.has(note.id)).sort((a, b) => a.start - b.start);
  const first = selected[0];
  if (!first) return document;
  const merged: EditorNote = {
    ...first,
    start: Math.min(...selected.map(note => note.start)),
    end: Math.max(...selected.map(note => note.end))
  };
  return withNotes(
    document,
    document.notes.filter(note => !ids.has(note.id) || note.id === first.id).map(note => (note.id === first.id ? merged : note))
  );
};

/** Snaps the start or end of the given notes to a time (playhead), still respecting neighbours and the word. */
export const alignBoundary = (
  document: EditorDocument,
  ids: ReadonlySet<string>,
  edge: "start" | "end",
  seconds: number
): EditorDocument =>
  [...ids].reduce((current, id) => resizeNote(current, id, edge, seconds), document);

export interface EditorIssue {
  noteId: string;
  reason: "outsideWord" | "tooShort" | "overlap";
}

/** Presentation-level check only; canonical validation stays with the backend. */
export const validateDocument = (document: EditorDocument): readonly EditorIssue[] => {
  const issues: EditorIssue[] = [];
  for (const note of document.notes) {
    const word = wordOf(document, note);
    if (!word || note.start < word.start - 1e-6 || note.end > word.end + 1e-6) issues.push({ noteId: note.id, reason: "outsideWord" });
    if (note.end - note.start < minNoteSeconds - 1e-6) issues.push({ noteId: note.id, reason: "tooShort" });
  }
  const byWord = new Map<string, EditorNote[]>();
  for (const note of document.notes) byWord.set(note.wordId, [...(byWord.get(note.wordId) ?? []), note]);
  for (const notes of byWord.values()) {
    const ordered = [...notes].sort((a, b) => a.start - b.start);
    ordered.forEach((note, index) => {
      const previous = ordered[index - 1];
      if (previous && note.start < previous.end - 1e-6) issues.push({ noteId: note.id, reason: "overlap" });
    });
  }
  return issues;
};

export const serializeDocument = (document: EditorDocument): string =>
  JSON.stringify([document.words, document.notes.map(({ id: _id, ...rest }) => rest)]);

/** Content equality, ignoring the local revision counter: a document is dirty only when its content differs. */
export const isEditorDirty = (saved: EditorDocument, current: EditorDocument): boolean =>
  serializeDocument(saved) !== serializeDocument(current);

export const documentEnd = (document: EditorDocument, songSeconds: number): number =>
  Math.max(songSeconds, ...document.words.map(word => word.end), 10);

// ---- undo / redo ----
export interface EditorHistory {
  past: readonly EditorDocument[];
  present: EditorDocument;
  future: readonly EditorDocument[];
}

export const startHistory = (document: EditorDocument): EditorHistory => ({ past: [], present: document, future: [] });

export const pushHistory = (history: EditorHistory, next: EditorDocument): EditorHistory =>
  next === history.present ? history : { past: [...history.past, history.present], present: next, future: [] };

export const undoHistory = (history: EditorHistory): EditorHistory => {
  const previous = history.past.at(-1);
  return previous
    ? { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] }
    : history;
};

export const redoHistory = (history: EditorHistory): EditorHistory => {
  const next = history.future[0];
  return next
    ? { past: [...history.past, history.present], present: next, future: history.future.slice(1) }
    : history;
};
