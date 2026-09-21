import { hasKeyWithPrefix, isRecord, readJson, removeKey, storageKey, writeJson } from "../../shared/storage/localStore";
import type { EditorDocument } from "./editorModel";

interface StoredDraft {
  baseRevision: number;
  document: EditorDocument;
}

const draftPrefix = storageKey("editorDraft") + ".";
const keyFor = (songId: string): string => `${draftPrefix}${songId}`;

export const saveDraft = (songId: string, draft: StoredDraft): void => writeJson(keyFor(songId), draft);

export const loadDraft = (songId: string): StoredDraft | null => {
  const raw = readJson(keyFor(songId));
  if (!isRecord(raw) || typeof raw.baseRevision !== "number" || !isRecord(raw.document)) return null;
  const document = raw.document as unknown as EditorDocument;
  if (!Array.isArray(document.words) || !Array.isArray(document.notes)) return null;
  return { baseRevision: raw.baseRevision, document };
};

export const clearDraft = (songId: string): void => removeKey(keyFor(songId));

export const hasEditorDraft = (): boolean => hasKeyWithPrefix(draftPrefix);
