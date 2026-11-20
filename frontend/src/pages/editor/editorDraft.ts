import {
  hasKeyWithPrefix,
  isRecord,
  readText,
  removeKey,
  storageKey,
  writeJson,
  writeText,
} from '../../shared/storage/localStore';
import type { EditorDocument } from '../../application/editor/editorModel';
import { reportOperationFailure } from '../../shared/errors';

interface StoredDraft {
  baseRevision: number;
  document: EditorDocument;
}

const draftPrefix = storageKey('editorDraft') + '.';
const keyFor = (songId: string): string => `${draftPrefix}${songId}`;

// Retain only the last validated serialized value, never a mutable parsed
// document. A backup usually reads exactly the draft already checked on open.
let validated: { key: string; raw: string } | undefined;

export const saveDraft = (songId: string, draft: StoredDraft): void =>
  writeJson(keyFor(songId), draft);

const parseDraft = (
  key: string,
  serialized: string | null,
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
  if (
    !isRecord(raw) ||
    typeof raw.baseRevision !== 'number' ||
    !isRecord(raw.document)
  )
    return null;
  const document = raw.document as unknown as EditorDocument;
  if (!Array.isArray(document.words) || !Array.isArray(document.notes))
    return null;
  validated = { key, raw: serialized };
  return { baseRevision: raw.baseRevision, document };
};

export const loadDraft = (songId: string): StoredDraft | null => {
  const key = keyFor(songId);
  return parseDraft(key, readText(key));
};

/** Capture the current valid draft without decoding unchanged contours again. */
export const captureDraft = (songId: string): string | null => {
  const key = keyFor(songId);
  const raw = readText(key);
  if (validated?.key === key && validated.raw === raw) return raw;
  return parseDraft(key, raw) ? raw : null;
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
