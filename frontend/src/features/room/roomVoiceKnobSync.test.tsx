import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { AppProvider, useApp } from "../../app/AppContext";
import type { RoomStateDto } from "../../contracts/models";
import { AudioTests } from "../settings/tabs/Audio/AudioTests";
import { RoomDock } from "./RoomDock";

vi.mock("../../app/DialogProvider", () => ({ useAsk: () => vi.fn() }));
vi.mock("../../app/NotificationsProvider", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));
vi.mock("../../services/roomClient", () => ({ roomClient: { roomControl: vi.fn(), setRoomReadiness: vi.fn() } }));
vi.mock("../../services/desktopClient", () => ({ desktopClient: { copyText: vi.fn(), setAppIcon: vi.fn() } }));
vi.mock("../../services/audioClient", () => ({
  audioClient: {
    setMixer: vi.fn(async () => undefined),
    setDspParameter: vi.fn(async () => undefined),
    setDspEnabled: vi.fn(async () => undefined),
    setParticipantVolume: vi.fn(),
    monitoringEnabled: () => false,
    microphoneEnabled: () => true,
    participantMuted: () => false,
    roomTiming: vi.fn(async () => ({ roundTripMs: 0, deviceLatencyMs: 0, estimatedVoiceLatencyMs: 0, voiceDelayMs: 0, followMs: 0, remotes: {} })),
  },
}));

const room = {
  code: "ROOM42", hostId: "me", role: "host", playbackLocked: false,
  participants: [{ id: "me", name: "Me", role: "host", self: true, connected: true, muted: false, speakingLevel: 0, volume: 1, readiness: "ready" }],
} as unknown as RoomStateDto;

const InRoom = () => {
  const { setRoom } = useApp();
  useEffect(() => setRoom(room), [setRoom]);
  return null;
};

it("shows the microphone volume set in the settings on your own row in the room", async () => {
  window.localStorage.clear();
  render(
    <MemoryRouter>
      <AppProvider>
        <InRoom />
        <AudioTests
          runtime={{ backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480, endpointBufferFrames: 480, estimatedLatencyMs: 10 }}
          audioAvailable microphoneIssue={false} inputLevel={0} testingInput={false}
          onToggleInputTest={() => undefined} onPlayTestSound={() => undefined}
        />
        <RoomDock />
      </AppProvider>
    </MemoryRouter>,
  );
  // The settings knob takes a typed percentage from its readout.
  const knob = screen.getByRole("slider", { name: "microphoneKnob" }).closest(".ad-rotary-knob");
  fireEvent.click(knob?.querySelector(".knob__value") as HTMLElement);
  const input = screen.getByLabelText("microphoneKnob, значение");
  fireEvent.change(input, { target: { value: "42" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const own = await screen.findByRole("slider", { name: "mixerMicrophone" });
  expect(own).toHaveAttribute("aria-valuenow", "0.42");
});
