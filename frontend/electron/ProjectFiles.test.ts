import { describe, expect, it, vi } from "vitest";
import { ipcChannels } from "./ipcChannels";
import { registerProjectFileHandlers } from "./ProjectFiles";

vi.mock("electron", () => ({ shell: { showItemInFolder: vi.fn() } }));

describe("recording peaks IPC", () => {
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
