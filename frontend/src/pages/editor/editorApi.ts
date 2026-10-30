import { bridgedHttp } from "../../services/desktopBridge";
import { libraryChanged } from "../../services/backendEvents";
import type { SongDto } from "../../contracts/models";
import type { EditorDocument, EditorNote } from "../../application/editor/editorModel";

interface BackendNote {
  note: number;
  start: number;
  end: number;
  contour?: readonly (readonly [number, number, number?])[];
}
interface BackendWord {
  text: string;
  start: number;
  end: number;
  notes: BackendNote[];
  letters?: number[];
}
interface BackendEditor {
  songId: string;
  revision: number;
  document: {
    title: string;
    artist: string;
    duration: number;
    bpm: number | null;
    key: string | null;
    lyrics: string;
    vocalActivity?: readonly (readonly [number, number])[];
    rhythm?: readonly (readonly [number, number])[];
    words: BackendWord[];
  };
}

/** Letter times are kept relative to the word, so moving or resizing a word in the editor keeps them in step with it. */
const letterFractions = (word: BackendWord): number[] | undefined => {
  const duration = word.end - word.start;
  const letters = word.letters ?? [];
  return letters.length === word.text.length && duration > 0
    ? letters.map((moment) =>
        Math.min(1, Math.max(0, (moment - word.start) / duration)),
      )
    : undefined;
};

const toEditorDocument = (value: BackendEditor): EditorDocument => {
  const words = value.document.words.map((word, wordIndex) => ({
    id: `word-${wordIndex}`,
    text: word.text,
    start: word.start,
    end: word.end,
    letters: letterFractions(word),
  }));
  const notes = value.document.words.flatMap((word, wordIndex) =>
    word.notes.map((note, noteIndex) => ({
      id: `word-${wordIndex}-note-${noteIndex}`,
      wordId: `word-${wordIndex}`,
      pitch: note.note,
      start: note.start,
      end: note.end,
      contour: note.contour,
    })),
  );
  return {
    revision: value.revision,
    bpm: value.document.bpm ?? undefined,
    key: value.document.key ?? undefined,
    words,
    notes,
    lyrics: value.document.lyrics,
    vocalActivity: value.document.vocalActivity,
    rhythm: value.document.rhythm,
  };
};

const wordCount = (lyrics: string): number =>
  lyrics.split(/\s+/).filter(Boolean).length;

const backendDocument = (song: SongDto, document: EditorDocument) => {
  const notesByWord = new Map<string, EditorNote[]>();
  for (const note of document.notes) {
    const notes = notesByWord.get(note.wordId);
    if (notes) notes.push(note);
    else notesByWord.set(note.wordId, [note]);
  }
  return {
    title: song.title,
    artist: song.artist,
    duration: song.durationSeconds,
    bpm: document.bpm ?? null,
    key: document.key ?? null,
    ...(document.vocalActivity ? { vocalActivity: document.vocalActivity } : {}),
    ...(document.rhythm ? { rhythm: document.rhythm } : {}),
    lyrics:
      document.lyrics && wordCount(document.lyrics) === document.words.length
        ? document.lyrics
        : document.words.map((word) => word.text).join(" "),
    words: document.words.map((word) => ({
      text: word.text,
      start: word.start,
      end: word.end,
      letters: word.letters?.map(
        (fraction) => Math.min(word.end, Math.max(word.start,
          word.start + fraction * (word.end - word.start),
        )),
      ),
      notes: (notesByWord.get(word.id) ?? [])
        .sort((a, b) => a.start - b.start)
        .map((note) => ({ note: note.pitch, start: note.start, end: note.end,
          ...(note.contour?.length ? { contour: note.contour } : {}),
        })),
    })),
  };
};

export const createEditorApi = (
  request: (value: PythonBridgeRequest) => Promise<unknown>,
) => ({
  async load(songId: string): Promise<EditorDocument> {
    return toEditorDocument(
      await request({
        method: "GET",
        path: `/songs/${encodeURIComponent(songId)}/editor`,
      }) as BackendEditor,
    );
  },

  async reset(songId: string, expectedRevision: number): Promise<number> {
    const result = await request({
      method: "POST",
      path: `/songs/${encodeURIComponent(songId)}/editor/reset`,
      body: { expectedRevision },
    });
    return (result as { revision: number }).revision;
  },

  async save(
    song: SongDto,
    document: EditorDocument,
    expectedRevision: number,
  ): Promise<number> {
    const result = await request({
      method: "PUT",
      path: `/songs/${encodeURIComponent(song.id)}/editor`,
      body: { expectedRevision, document: backendDocument(song, document) },
    });
    return (result as { revision: number }).revision;
  },
});

export const editorApi = createEditorApi(async (request) => {
  const result = await bridgedHttp("pythonRequest", request, "Editor backend request failed");
  if (request.method !== "GET") libraryChanged();
  return result;
});
