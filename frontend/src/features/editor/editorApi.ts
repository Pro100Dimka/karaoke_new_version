import type { AppError, SongDto } from "../../contracts/models";
import type { EditorDocument } from "./editorModel";

interface BackendNote { note: number; start: number; end: number; }
interface BackendWord { text: string; start: number; end: number; notes: BackendNote[]; letters?: number[]; }
interface BackendEditor {
  songId: string;
  revision: number;
  document: { title: string; artist: string; duration: number; bpm: number | null; key: string | null; lyrics: string; words: BackendWord[] };
}

const desktop = (): DesktopApi => {
  if (!window.desktop) throw new Error("Desktop bridge is unavailable");
  return window.desktop;
};

const request = async <T>(request: PythonBridgeRequest): Promise<T> => {
  const response = await desktop().pythonRequest(request);
  if (!response.ok) {
    const raw = response.body && typeof response.body === "object" ? (response.body as Record<string, unknown>) : {};
    const error: AppError = {
      code: typeof raw.code === "string" ? raw.code : `Http${response.status}`,
      message: typeof raw.message === "string" ? raw.message : "Editor backend request failed",
      source: "python",
      correlationId: typeof raw.requestId === "string" ? raw.requestId : undefined
    };
    throw error;
  }
  return response.body as T;
};

/** Letter times are kept relative to the word, so moving or resizing a word in the editor keeps them in step with it. */
const letterFractions = (word: BackendWord): number[] | undefined => {
  const duration = word.end - word.start;
  const letters = word.letters ?? [];
  return letters.length === word.text.length && duration > 0 ? letters.map(moment => Math.min(1, Math.max(0, (moment - word.start) / duration))) : undefined;
};

const toEditorDocument = (value: BackendEditor): EditorDocument => {
  const words = value.document.words.map((word, wordIndex) => ({
    id: `word-${wordIndex}`,
    text: word.text,
    start: word.start,
    end: word.end,
    letters: letterFractions(word)
  }));
  const notes = value.document.words.flatMap((word, wordIndex) =>
    word.notes.map((note, noteIndex) => ({
      id: `word-${wordIndex}-note-${noteIndex}`,
      wordId: `word-${wordIndex}`,
      pitch: note.note,
      start: note.start,
      end: note.end
    }))
  );
  return { revision: value.revision, words, notes, lyrics: value.document.lyrics };
};

const wordCount = (lyrics: string): number => lyrics.split(/\s+/).filter(Boolean).length;

const backendDocument = (song: SongDto, document: EditorDocument) => ({
  title: song.title,
  artist: song.artist,
  duration: song.durationSeconds,
  bpm: null,
  key: null,
  lyrics: document.lyrics && wordCount(document.lyrics) === document.words.length ? document.lyrics : document.words.map(word => word.text).join(" "),
  words: document.words.map(word => ({
    text: word.text,
    start: word.start,
    end: word.end,
    letters: word.letters?.map(fraction => word.start + fraction * (word.end - word.start)),
    notes: document.notes
      .filter(note => note.wordId === word.id)
      .sort((a, b) => a.start - b.start)
      .map(note => ({ note: note.pitch, start: note.start, end: note.end }))
  }))
});

export const editorApi = {
  async load(songId: string): Promise<EditorDocument> {
    return toEditorDocument(await request<BackendEditor>({ method: "GET", path: `/songs/${encodeURIComponent(songId)}/editor` }));
  },

  async save(song: SongDto, document: EditorDocument, expectedRevision: number): Promise<number> {
    const result = await request<{ revision: number }>({
      method: "PUT",
      path: `/songs/${encodeURIComponent(song.id)}/editor`,
      body: { expectedRevision, document: backendDocument(song, document) }
    });
    return result.revision;
  },

  async reset(songId: string, expectedRevision: number): Promise<number> {
    const result = await request<{ revision: number }>({
      method: "POST",
      path: `/songs/${encodeURIComponent(songId)}/editor/reset`,
      body: { expectedRevision }
    });
    return result.revision;
  }
};
