import { expect, it, vi } from "vitest";
import type { RoomSessionScope } from "./RoomSessionController";
import { RoomVoiceCoordinator } from "./RoomVoiceCoordinator";

const setup = () => {
  let active = true;
  const scope: RoomSessionScope = { code: "A", generation: 1,
    signal: new AbortController().signal, isCurrent: () => active,
    getRoom: () => null, setSnapshot: () => false, disconnect: () => false };
  const audio = {
    microphoneEnabled: vi.fn(() => true), participantMuted: vi.fn(() => false),
    setMicrophoneEnabled: vi.fn(async () => undefined),
    setParticipantMuted: vi.fn(async () => undefined),
    setParticipantVolume: vi.fn(async () => undefined),
    setParticipantEffect: vi.fn(async () => undefined),
    monitoringEnabled: vi.fn(() => false),
    setMonitoring: vi.fn(async () => ({ monitoring: true })),
    roomTiming: vi.fn(async () => ({ roundTripMs: 10, remotes: {} })),
  };
  return { scope, audio, voice: new RoomVoiceCoordinator(scope, audio as never, "self"),
    leave: () => { active = false; } };
};

it("does not change a participant's mixer after its room session ends", async () => {
  const { voice, audio, leave } = setup();
  leave();
  await voice.setParticipantVolume("other", 0.5);
  expect(audio.setParticipantVolume).not.toHaveBeenCalled();
});

it("restores a muted local microphone when the voice session stops", () => {
  const { voice, audio } = setup();
  audio.microphoneEnabled.mockReturnValue(false);
  voice.stop();
  expect(audio.setMicrophoneEnabled).toHaveBeenCalledWith(true);
});
