import { afterEach, expect, it, vi } from "vitest";
import type { RequestedAudioConfiguration } from "../../contracts/models";
import type { RoomSessionScope } from "./RoomSessionController";
import { RoomDiagnosticsCoordinator } from "./RoomDiagnosticsCoordinator";

afterEach(() => vi.useRealTimers());

it("does not publish diagnostics after the old session stops", async () => {
  let finish!: (value: Readonly<Record<string, string>>) => void;
  const scope = {
    code: "room-a", generation: 1, signal: new AbortController().signal,
    isCurrent: vi.fn(() => true),
  } as unknown as RoomSessionScope;
  const audio = {
    listDevices: vi.fn(async () => []),
    preferredConfiguration: vi.fn(() => ({ backend: "WASAPI Shared" }) as RequestedAudioConfiguration),
    diagnosticsDump: vi.fn(() => new Promise<Readonly<Record<string, string>>>((resolve) => { finish = resolve; })),
  };
  const room = { publishDiagnostics: vi.fn(async () => undefined) };
  vi.useFakeTimers();
  const coordinator = new RoomDiagnosticsCoordinator(scope, audio, room);
  coordinator.start({ backend: "WASAPI Shared" });
  await vi.advanceTimersByTimeAsync(5000);
  coordinator.stop();
  finish({ Backend: "Shared" });
  await Promise.resolve();
  expect(room.publishDiagnostics).not.toHaveBeenCalled();
});
