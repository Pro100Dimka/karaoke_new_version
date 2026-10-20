import { expect, it, vi } from "vitest";
import type { SongDto } from "../../contracts/models";
import type { EditorDocument } from "../editor/editorModel";
import { prepareKaraokeSession } from "./KaraokePreparation";

it("reloads a newly published revision before preparing its audio and lyrics together", async () => {
  const song: SongDto = {
    id: "song", title: "Song", artist: "Artist", status: "ready", activeRevision: 7,
    durationSeconds: 200, language: "Auto", coverState: "Fallback", createdAt: "2026-10-20",
    projectFormatVersion: 1,
  };
  const nextSong = { ...song, activeRevision: 8 };
  const nextDocument: EditorDocument = {
    revision: 8, words: [{ id: "w", text: "new", start: 10, end: 11 }], notes: [],
  };
  let release!: (value: EditorDocument) => void;
  const backend = {
    getSong: vi.fn().mockResolvedValueOnce(song).mockResolvedValue(nextSong),
    projectCompatibility: vi.fn().mockResolvedValue("Current"), diagnostics: vi.fn(),
  };
  const repository = { load: vi.fn()
    .mockImplementationOnce(() => new Promise<EditorDocument>((resolve) => { release = resolve; }))
    .mockResolvedValue(nextDocument) };
  const audio = { capabilities: vi.fn().mockResolvedValue({ microphone: "ready", keyboardLighting: false }),
    prepareSong: vi.fn(), setPlaybackRate: vi.fn(), setPitchShift: vi.fn(), setMixer: vi.fn() };
  const onResolved = vi.fn();
  const onDocument = vi.fn();
  const onPrepared = vi.fn();
  const preparing = prepareKaraokeSession({
    songId: "song", backend, audio, repository,
    gains: { music: 1, mic: 1, reference: 0, melody: 0, master: 1 },
    isCurrent: () => true, onResolved, onDocument,
    onCapabilities: vi.fn(), onPrepared, onFailure: vi.fn(),
  });
  await vi.waitFor(() => expect(repository.load).toHaveBeenCalledOnce());
  // A generated revision is published while the first editor request is in flight.
  expect(audio.prepareSong).not.toHaveBeenCalled();
  expect(onPrepared).not.toHaveBeenCalled();
  release(nextDocument);
  await preparing;
  expect(audio.prepareSong).toHaveBeenCalledExactlyOnceWith(nextSong);
  expect(onResolved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    load: { kind: "ready", song: nextSong },
  }));
  expect(onDocument).toHaveBeenCalledExactlyOnceWith(nextDocument);
  expect(onPrepared).toHaveBeenCalledOnce();
});

it("does not release readiness when revisions continue changing during the retry", async () => {
  const backend = {
    getSong: vi.fn().mockResolvedValue({ id: "song", status: "ready", activeRevision: 7 }),
    projectCompatibility: vi.fn().mockResolvedValue("Current"), diagnostics: vi.fn(),
  };
  const document: EditorDocument = { revision: 8, words: [], notes: [] };
  const audio = { capabilities: vi.fn().mockResolvedValue({ microphone: "ready", keyboardLighting: false }),
    prepareSong: vi.fn(), setPlaybackRate: vi.fn(),
    setPitchShift: vi.fn(), setMixer: vi.fn() };
  const onPrepared = vi.fn();
  const onDocument = vi.fn();
  const onFailure = vi.fn();
  await prepareKaraokeSession({
    songId: "song", backend, audio, repository: { load: vi.fn().mockResolvedValue(document) },
    gains: { music: 1, mic: 1, reference: 0, melody: 0, master: 1 },
    isCurrent: () => true, onResolved: vi.fn(), onDocument,
    onCapabilities: vi.fn(), onPrepared, onFailure,
  });
  expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "RevisionConflict" }));
  expect(audio.prepareSong).not.toHaveBeenCalled();
  expect(onDocument).not.toHaveBeenCalled();
  expect(onPrepared).not.toHaveBeenCalled();
  expect(backend.getSong).toHaveBeenCalledTimes(2);
});

it("does not prepare audio or publish a stale document after the session ends", async () => {
  let release!: (value: null) => void;
  let current = true;
  const audio = { capabilities: vi.fn(), prepareSong: vi.fn() };
  const document = vi.fn(() => new Promise<null>((resolve) => { release = resolve; }));
  const onDocument = vi.fn();
  const onPrepared = vi.fn();
  const backend = {
    getSong: vi.fn(async () => ({ id: "song", status: "ready", activeRevision: 1 })),
    projectCompatibility: vi.fn(async () => "Current"),
  };
  const preparing = prepareKaraokeSession({
    songId: "song", backend, audio, repository: { load: document },
    gains: { music: 1, mic: 1, reference: 0, melody: 0, master: 1 },
    isCurrent: () => current, onResolved: vi.fn(), onDocument,
    onCapabilities: vi.fn(), onPrepared, onFailure: vi.fn(),
  } as never);
  await vi.waitFor(() => expect(document).toHaveBeenCalledOnce());
  current = false;
  release(null);
  await preparing;
  expect(onDocument).not.toHaveBeenCalled();
  expect(audio.prepareSong).not.toHaveBeenCalled();
  expect(onPrepared).not.toHaveBeenCalled();
});

it("reports AudioService preparation failure without publishing readiness", async () => {
  const error = new Error("audio unavailable");
  const onFailure = vi.fn();
  const onPrepared = vi.fn();
  await prepareKaraokeSession({
    songId: "song",
    backend: {
      getSong: vi.fn(async () => ({ id: "song", status: "ready", activeRevision: 1 })),
      projectCompatibility: vi.fn(async () => "Current"),
    },
    repository: { load: vi.fn(async () => null) },
    audio: { capabilities: vi.fn(async () => ({ microphone: "ready" })),
      prepareSong: vi.fn(async () => { throw error; }) },
    gains: { music: 1, mic: 1, reference: 0, melody: 0, master: 1 },
    isCurrent: () => true, onResolved: vi.fn(), onDocument: vi.fn(),
    onCapabilities: vi.fn(), onPrepared, onFailure,
  } as never);
  expect(onFailure).toHaveBeenCalledWith(error);
  expect(onPrepared).not.toHaveBeenCalled();
});
