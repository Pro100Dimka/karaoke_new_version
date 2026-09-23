import { afterEach, describe, expect, it, vi } from "vitest";
import type { SongDto } from "../../contracts/models";
import { editorApi } from "./editorApi";

describe("editorApi music metadata", () => {
  afterEach(() => Reflect.deleteProperty(window, "desktop"));

  it("keeps BPM and key when an editor document is loaded and saved", async () => {
    const pythonRequest = vi.fn(async (request: PythonBridgeRequest) => ({
      ok: true,
      status: 200,
      body: request.method === "GET"
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
              words: [{ text: "la", start: 1, end: 2, letters: [], notes: [] }]
            }
          }
        : { revision: 3 }
    }));
    Object.assign(window, { desktop: { pythonRequest } });

    const document = await editorApi.load("song-1");
    expect(document).toMatchObject({ bpm: 128, key: "Dm" });
    await editorApi.save({ id: "song-1", title: "Song", artist: "Artist", durationSeconds: 20 } as SongDto, document, 2);

    const save = pythonRequest.mock.calls.find(([request]) => request.method === "PUT")?.[0];
    expect(save?.body).toMatchObject({ document: { bpm: 128, key: "Dm" } });
  });
});
