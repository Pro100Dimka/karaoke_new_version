import {
  hasKeyWithPrefix,
  isRecord,
  readText,
  removeKey,
  storageKey,
  writeJson,
  writeText,
} from '../../shared/storage/localStore';
import type {
  EditorDocument,
  EditorNote,
} from '../../application/editor/editorModel';
import { reportOperationFailure } from '../../shared/errors';

interface StoredDraft {
  baseRevision: number;
  document: EditorDocument;
}

interface CompactDraft {
  format: 2;
  baseRevision: number;
  baseDocumentFingerprint: string;
  // Keeping this separate from `document` prevents older readers from treating
  // a compact draft as a complete document without its inherited analysis.
  changes: EditorDocument;
  contours: [number, number, number][];
  inheritVocalActivity?: true;
  inheritRhythm?: true;
}

const draftPrefix = storageKey('editorDraft') + '.';
const keyFor = (songId: string): string => `${draftPrefix}${songId}`;

// Retain only the last validated serialized value, never a mutable parsed
// document. A backup usually reads exactly the draft already checked on open.
let validated:
  | {
      key: string;
      raw: string;
      base: WeakRef<EditorDocument> | null | undefined;
    }
  | undefined;

/** Match the backend save order; note IDs are regenerated when it is reopened. */
const orderedNotes = (document: EditorDocument): EditorNote[][] => {
  const byWord = new Map<string, EditorNote[]>();
  for (const note of document.notes) {
    const notes = byWord.get(note.wordId);
    if (notes) notes.push(note);
    else byWord.set(note.wordId, [note]);
  }
  return document.words.map((word) =>
    (byWord.get(word.id) ?? []).sort((a, b) => a.start - b.start),
  );
};

const compactDraft = (
  draft: StoredDraft,
  base?: EditorDocument,
): StoredDraft | CompactDraft => {
  if (
    !base ||
    base.revision !== draft.baseRevision ||
    !base.documentFingerprint ||
    !/^[0-9a-f]{64}$/.test(base.documentFingerprint)
  )
    return draft;
  const byContour = new Map<
    NonNullable<EditorNote['contour']>,
    { word: number; ordinal: number }
  >();
  orderedNotes(base).forEach((notes, word) =>
    notes.forEach((note, ordinal) => {
      if (note.contour) byContour.set(note.contour, { word, ordinal });
    }),
  );
  const contours: CompactDraft['contours'] = [];
  const notes = draft.document.notes.map((note, index) => {
    const source = note.contour && byContour.get(note.contour);
    if (
      !source ||
      !note.contour?.length ||
      // The backend expands two-element points to confidence=1 on save.
      // Keep those exceptional values inline to preserve their exact shape.
      note.contour.some((point) => point.length !== 3)
    )
      return note;
    contours.push([index, source.word, source.ordinal]);
    const { contour: _contour, ...fields } = note;
    return fields;
  });
  const changes = { ...draft.document, notes };
  const inheritVocalActivity =
    !!base.vocalActivity?.length &&
    changes.vocalActivity === base.vocalActivity;
  const inheritRhythm = !!base.rhythm?.length && changes.rhythm === base.rhythm;
  if (!contours.length && !inheritVocalActivity && !inheritRhythm) return draft;
  if (inheritVocalActivity) delete changes.vocalActivity;
  if (inheritRhythm) delete changes.rhythm;
  return {
    format: 2,
    baseRevision: draft.baseRevision,
    baseDocumentFingerprint: base.documentFingerprint,
    changes,
    contours,
    ...(inheritVocalActivity && { inheritVocalActivity: true }),
    ...(inheritRhythm && { inheritRhythm: true }),
  };
};

export const saveDraft = (
  songId: string,
  draft: StoredDraft,
  base?: EditorDocument,
): void => writeJson(keyFor(songId), compactDraft(draft, base));

const isDocument = (value: unknown): value is EditorDocument =>
  isRecord(value) && Array.isArray(value.words) && Array.isArray(value.notes);

const expandDraft = (
  raw: Record<string, unknown>,
  base?: EditorDocument,
  forBackup = false,
): EditorDocument | null => {
  if (
    typeof raw.baseDocumentFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(raw.baseDocumentFingerprint) ||
    !isDocument(raw.changes) ||
    !Array.isArray(raw.contours) ||
    (raw.inheritVocalActivity !== undefined &&
      raw.inheritVocalActivity !== true) ||
    (raw.inheritRhythm !== undefined && raw.inheritRhythm !== true)
  )
    return null;
  // Deleting and reimporting a song can reuse its ID and revision number.
  // Bind inherited arrays to their content as well, without erasing an old draft.
  const matchingBase =
    base &&
    base.revision === raw.baseRevision &&
    base.documentFingerprint === raw.baseDocumentFingerprint
      ? base
      : undefined;
  if (!matchingBase && !forBackup) return null;
  const document = raw.changes;
  const sources = matchingBase && orderedNotes(matchingBase);
  const seen = new Set<number>();
  for (const reference of raw.contours) {
    if (
      !Array.isArray(reference) ||
      reference.length !== 3 ||
      !reference.every((value) => Number.isSafeInteger(value) && value >= 0)
    )
      return null;
    const [index, word, ordinal] = reference as [number, number, number];
    const note = document.notes[index];
    const contour = sources?.[word]?.[ordinal]?.contour;
    if (
      seen.has(index) ||
      !isRecord(note) ||
      'contour' in note ||
      (sources &&
        (!contour?.length || contour.some((point) => point.length !== 3)))
    )
      return null;
    seen.add(index);
    // The parsed note shell is private to this load. Analysis arrays are
    // immutable throughout the editor, so keep sharing them with the base.
    if (!forBackup) note.contour = contour;
  }
  if (raw.inheritVocalActivity) {
    if (
      'vocalActivity' in document ||
      (matchingBase && !matchingBase.vocalActivity?.length)
    )
      return null;
    if (!forBackup) document.vocalActivity = matchingBase!.vocalActivity;
  }
  if (raw.inheritRhythm) {
    if ('rhythm' in document || (matchingBase && !matchingBase.rhythm?.length))
      return null;
    if (!forBackup) document.rhythm = matchingBase!.rhythm;
  }
  return document;
};

const parseDraft = (
  key: string,
  serialized: string | null,
  base?: EditorDocument,
  forBackup = false,
): StoredDraft | null => {
  validated = undefined;
  if (serialized === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (error) {
    reportOperationFailure('errors.storageRead', error);
    return null;
  }
  if (!isRecord(raw) || typeof raw.baseRevision !== 'number') return null;
  const document =
    raw.format === 2
      ? expandDraft(raw, base, forBackup)
      : raw.format === undefined && isDocument(raw.document)
        ? raw.document
        : null;
  if (!document) return null;
  validated = {
    key,
    raw: serialized,
    base: raw.format === 2 ? (base ? new WeakRef(base) : undefined) : null,
  };
  return { baseRevision: raw.baseRevision, document };
};

export const loadDraft = (
  songId: string,
  base?: EditorDocument,
): StoredDraft | null => {
  const key = keyFor(songId);
  return parseDraft(key, readText(key), base);
};

/** Capture the current valid draft without decoding unchanged contours again. */
export const captureDraft = (
  songId: string,
  base?: EditorDocument,
): string | null => {
  const key = keyFor(songId);
  const raw = readText(key);
  if (
    validated?.key === key &&
    validated.raw === raw &&
    (validated.base === null ||
      (base ? validated.base?.deref() === base : validated.base === undefined))
  )
    return raw;
  // A preview must also preserve a well-formed draft from another revision.
  // Its analysis cannot be reconstructed here, but rollback needs only bytes.
  return parseDraft(key, raw, base, true) ? raw : null;
};

/** Cancelling a preview puts the captured bytes back, without a full serialization. */
export const restoreDraft = (songId: string, serialized: string): void =>
  writeText(keyFor(songId), serialized);

export const clearDraft = (songId: string): void => {
  const key = keyFor(songId);
  if (validated?.key === key) validated = undefined;
  removeKey(key);
};

export const hasEditorDraft = (): boolean => hasKeyWithPrefix(draftPrefix);
