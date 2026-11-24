import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SongDto } from '../../contracts/models';
import { moveNotes } from '../../application/editor/editorModel';
import { createEditorApi } from './editorApi';

describe('editorApi music metadata', () => {
  afterEach(() => Reflect.deleteProperty(window, 'desktop'));

  it.each([
    {
      label: 'authoritative fingerprints',
      loaded: 'a'.repeat(64),
      saved: 'b'.repeat(64),
    },
    {
      label: 'an older backend without fingerprints',
      loaded: undefined,
      saved: undefined,
    },
  ])('retains revision metadata from $label', async ({ loaded, saved }) => {
    const source = {
      songId: 'song',
      revision: 7,
      documentFingerprint: loaded,
      document: {
        title: 'Song',
        artist: 'Singer',
        duration: 20,
        bpm: null,
        key: null,
        lyrics: '',
        words: [],
      },
    };
    const response = { revision: 8, documentFingerprint: saved };
    const request = vi.fn(async ({ method }: PythonBridgeRequest) =>
      method === 'GET' ? source : response,
    );
    const api = createEditorApi(request);

    const document = await api.load('song');
    expect(document).toMatchObject({
      revision: 7,
      documentFingerprint: loaded,
    });
    await expect(
      api.save({ id: 'song' } as SongDto, document, 7),
    ).resolves.toEqual(response);
    expect(request.mock.lastCall?.[0].body).toMatchObject({
      expectedRevision: 7,
    });
    expect(
      (request.mock.lastCall?.[0].body as { document: unknown }).document,
    ).not.toHaveProperty('documentFingerprint');
  });

  it('resets to the saved AI baseline using the exact confirmed revision', async () => {
    const request = vi.fn(async () => ({ revision: 8 }));
    const api = createEditorApi(request);
    expect(await api.reset('a/b', 7)).toBe(8);
    expect(request).toHaveBeenCalledExactlyOnceWith({
      method: 'POST',
      path: '/songs/a%2Fb/editor/reset',
      body: { expectedRevision: 7 },
    });
  });

  it('round-trips repeated phrases, absolute note gaps and relative letters late in a song', async () => {
    const source = {
      songId: 'song-1',
      revision: 7,
      document: {
        title: 'Song',
        artist: 'Artist',
        duration: 1810,
        bpm: null,
        key: null,
        lyrics: 'la\nla',
        vocalActivity: [
          [12, 14],
          [1800, 1806],
        ],
        rhythm: [
          [0.5, 1],
          [1, 0.6],
        ],
        words: [
          {
            text: 'la',
            start: 12,
            end: 14,
            letters: [12, 12.2],
            notes: [
              {
                note: 60,
                start: 12.2,
                end: 13.8,
                contour: [
                  [0, -0.25],
                  [0.5, 0.3],
                  [1, 0],
                ],
              },
            ],
          },
          {
            text: 'la',
            start: 1800,
            end: 1806,
            letters: [1800, 1800.4],
            lettersApproximate: true,
            notes: [
              { note: 62, start: 1800.4, end: 1802 },
              { note: 64, start: 1803, end: 1805.8 },
            ],
          },
        ],
      },
    };
    const request = vi.fn(async ({ method }: PythonBridgeRequest) =>
      method === 'GET' ? source : { revision: 8 },
    );
    const api = createEditorApi(request);
    const document = await api.load('song-1');
    expect(document.revision).toBe(7);
    expect(document.words.map((word) => word.id)).toEqual(['word-0', 'word-1']);
    expect(document.words[1]?.letters?.[1]).toBeCloseTo(0.4 / 6, 10);
    expect(document.words[1]).toMatchObject({ lettersApproximate: true });
    expect(document.notes.map((note) => note.wordId)).toEqual([
      'word-0',
      'word-1',
      'word-1',
    ]);
    expect(
      await api.save(
        {
          id: 'song-1',
          title: 'Song',
          artist: 'Artist',
          durationSeconds: 1810,
        } as SongDto,
        document,
        7,
      ),
    ).toEqual({ revision: 8 });
    expect(request.mock.lastCall?.[0].body).toMatchObject({
      expectedRevision: 7,
      document: {
        lyrics: 'la\nla',
        words: source.document.words,
        vocalActivity: source.document.vocalActivity,
        rhythm: source.document.rhythm,
      },
    });
  });

  it('keeps BPM and key when an editor document is loaded and saved', async () => {
    const pythonRequest = vi.fn(async (request: PythonBridgeRequest) => ({
      ok: true,
      status: 200,
      body:
        request.method === 'GET'
          ? {
              songId: 'song-1',
              revision: 2,
              document: {
                title: 'Song',
                artist: 'Artist',
                duration: 20,
                bpm: 128,
                key: 'Dm',
                lyrics: 'la',
                words: [
                  { text: 'la', start: 1, end: 2, letters: [], notes: [] },
                ],
              },
            }
          : { revision: 3 },
    }));
    const editorApi = createEditorApi(async (request) => {
      const result = await pythonRequest(request);
      return result.body;
    });

    const document = await editorApi.load('song-1');
    expect(document).toMatchObject({ bpm: 128, key: 'Dm' });
    await editorApi.save(
      {
        id: 'song-1',
        title: 'Song',
        artist: 'Artist',
        durationSeconds: 20,
      } as SongDto,
      document,
      2,
    );

    const save = pythonRequest.mock.calls.find(
      ([request]) => request.method === 'PUT',
    )?.[0];
    expect(save?.body).toMatchObject({ document: { bpm: 128, key: 'Dm' } });
  });

  it('keeps restored letter endpoints inside their word despite floating point rounding', async () => {
    const source = {
      songId: 'song-1',
      revision: 1,
      document: {
        title: 'Song',
        artist: 'Artist',
        duration: 1,
        bpm: null,
        key: null,
        lyrics: 'la',
        words: [
          {
            text: 'la',
            start: 0.017,
            end: 0.204,
            letters: [0.017, 0.204],
            notes: [],
          },
        ],
      },
    };
    const request = vi.fn(async ({ method }: PythonBridgeRequest) =>
      method === 'GET' ? source : { revision: 2 },
    );
    const api = createEditorApi(request);
    const document = await api.load('song-1');
    const song: SongDto = {
      id: 'song-1',
      title: 'Song',
      artist: 'Artist',
      durationSeconds: 1,
      language: 'Auto',
      status: 'ready',
      createdAt: '2026-10-12',
      coverState: 'Fallback',
      activeRevision: 1,
      projectFormatVersion: 1,
    };
    await api.save(song, document, 1);

    expect(request.mock.lastCall?.[0].body).toMatchObject({
      document: {
        words: [{ start: 0.017, end: 0.204, letters: [0.017, 0.204] }],
      },
    });
  });

  it.each([
    { label: 'emoji', text: 'la😊', letters: [12, 12.5, 13] },
    { label: 'BMP text', text: 'ля', letters: [12, 13] },
    { label: 'combining accent', text: 'a\u0301', letters: [12, 13] },
  ])(
    'preserves existing letter timings after a note edit in $label',
    async ({ text, letters }) => {
      const word = {
        text,
        start: 12,
        end: 14,
        letters,
        notes: [{ note: 60, start: 12.25, end: 13.75 }],
      };
      const source = {
        songId: 'song-1',
        revision: 7,
        document: {
          title: 'Song',
          artist: 'Artist',
          duration: 20,
          bpm: null,
          key: null,
          lyrics: text,
          words: [word],
        },
      };
      const request = vi.fn(async ({ method }: PythonBridgeRequest) =>
        method === 'GET' ? source : { revision: 8 },
      );
      const api = createEditorApi(request);
      const document = await api.load('song-1');
      const edited = moveNotes(
        document,
        new Set(document.notes.map((note) => note.id)),
        1,
        0,
      );
      expect(edited.notes[0]?.pitch).toBe(61);
      const song: SongDto = {
        id: 'song-1',
        title: 'Song',
        artist: 'Artist',
        durationSeconds: 20,
        language: 'Auto',
        status: 'ready',
        createdAt: '2026-11-20',
        coverState: 'Fallback',
        activeRevision: 7,
        projectFormatVersion: 1,
      };

      expect(await api.save(song, edited, 7)).toEqual({ revision: 8 });

      expect(request.mock.lastCall?.[0]).toEqual({
        method: 'PUT',
        path: '/songs/song-1/editor',
        body: {
          expectedRevision: 7,
          document: {
            ...source.document,
            words: [
              { ...word, notes: [{ note: 61, start: 12.25, end: 13.75 }] },
            ],
          },
        },
      });
    },
  );

  it.each([
    { label: 'zero', end: 12 },
    { label: 'negative', end: 11 },
  ])(
    'omits relative letter timings for a $label word duration',
    async ({ end }) => {
      const api = createEditorApi(async () => ({
        songId: 'song-1',
        revision: 7,
        document: {
          title: 'Song',
          artist: 'Artist',
          duration: 20,
          bpm: null,
          key: null,
          lyrics: 'la',
          words: [{ text: 'la', start: 12, end, letters: [12, 12], notes: [] }],
        },
      }));

      const document = await api.load('song-1');

      expect(document.words).toHaveLength(1);
      expect(document.words[0]?.letters).toBeUndefined();
    },
  );
});
