import { afterEach, describe, expect, it, vi } from "vitest";
import type { SongDto } from "../../contracts/models";
import { createEditorApi } from "./editorApi";

describe("editorApi music metadata", () => {
  afterEach(() => Reflect.deleteProperty(window, "desktop"));

  it("keeps BPM and key when an editor document is loaded and saved", async () => {
    const pythonRequest = vi.fn(async (request: PythonBridgeRequest) => ({
      ok: true,
      status: 200,
      body:
        request.method === "GET"
          ? {
              songId: "song-1",
              revision: 2,
              document: {
                title: "Song",
                artist: "Artist",
                duration: 20,
                bpm: 128,
                key: "Dm",
                lyrics: "la",
                words: [
                  { text: "la", start: 1, end: 2, letters: [], notes: [] },
                ],
              },
            }
          : { revision: 3 },
    }));
    const editorApi = createEditorApi(async (request) => {
      const result = await pythonRequest(request);
      return result.body;
    });

    const document = await editorApi.load("song-1");
    expect(document).toMatchObject({ bpm: 128, key: "Dm" });
    await editorApi.save(
      {
        id: "song-1",
        title: "Song",
        artist: "Artist",
        durationSeconds: 20,
      } as SongDto,
      document,
      2,
    );

    const save = pythonRequest.mock.calls.find(
      ([request]) => request.method === "PUT",
    )?.[0];
    expect(save?.body).toMatchObject({ document: { bpm: 128, key: "Dm" } });
  });

  it("keeps restored letter endpoints inside their word despite floating point rounding", async () => {
    const source = {
      songId: "song-1", revision: 1,
      document: {
        title: "Song", artist: "Artist", duration: 1, bpm: null, key: null, lyrics: "la",
        words: [{ text: "la", start: 0.017, end: 0.204, letters: [0.017, 0.204], notes: [] }],
      },
    };
    const request = vi.fn(async ({ method }: PythonBridgeRequest) => method === "GET" ? source : { revision: 2 });
    const api = createEditorApi(request);
    const document = await api.load("song-1");
    const song: SongDto = {
      id: "song-1", title: "Song", artist: "Artist", durationSeconds: 1, language: "Auto",
      status: "ready", createdAt: "2026-10-12", coverState: "Fallback", activeRevision: 1, projectFormatVersion: 1,
    };
    await api.save(song, document, 1);

    expect(request.mock.lastCall?.[0].body).toMatchObject({
      document: { words: [{ start: 0.017, end: 0.204, letters: [0.017, 0.204] }] },
    });
  });
});
