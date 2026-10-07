import { expect, it, vi } from "vitest";
import { prepareKaraokeSession } from "./KaraokePreparation";

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
