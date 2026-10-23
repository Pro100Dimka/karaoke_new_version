import { describe, expect, it, vi } from "vitest";
import { ipcChannels } from "./ipcChannels";
import { registerProjectFileHandlers } from "./ProjectFiles";

vi.mock("electron", () => ({ shell: { showItemInFolder: vi.fn() } }));

describe("recording peaks IPC", () => {
  it("reads the imported song waveform from the backend while no instrumental revision exists", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const request = vi.fn(async () => ({ ok: true, status: 200, body: [0, 0.7, 1] }));
    registerProjectFileHandlers(() => "E:/CodexTemp/advoice-missing-project", { request } as never, {
      handle: (channel, listener) => handlers.set(channel, listener as (...args: unknown[]) => unknown),
    });
    await expect(handlers.get(ipcChannels.waveformPeaks)?.({}, { songId: "imported", revision: 1, bins: 32 }))
      .resolves.toEqual([0, 0.7, 1]);
    expect(request).toHaveBeenCalledWith("/songs/imported/waveform?bins=32");
  });
  it("returns no peaks when the recording file no longer exists", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerProjectFileHandlers(
      () => "unused",
      {
        request: vi.fn(async () => ({
          ok: true,
          status: 200,
          body: { filePath: "Z:/missing/recording.wav" },
        })),
      } as never,
      {
        handle: (channel, listener) =>
          handlers.set(channel, listener as (...args: unknown[]) => unknown),
      },
    );

    const handler = handlers.get(ipcChannels.recordingPeaks);
    await expect(
      handler?.({}, { recordingId: "missing", bins: 64 }),
    ).resolves.toEqual([]);
  });
});
