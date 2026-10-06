import { render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { Form, useForm } from "@ad-voice/ui";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { AppProvider, useApp } from "../../app/AppContext";
import type { RoomStateDto } from "../../contracts/models";
import { AudioTests } from "../settings/tabs/Audio/AudioTests";
import { RoomDock } from "./RoomDock";
import { audioClient } from "../../services/audioClient";
import {
  roomMicrophoneGain,
  useVoiceChain,
} from "../karaoke/console/voiceChain";
import { clearStorage } from "../../shared/storage/localStore";

vi.mock("../../app/DialogProvider", () => ({ useAsk: () => vi.fn() }));
vi.mock("../../app/NotificationsProvider", () => ({
  useNotify: () => vi.fn(),
}));
vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));
vi.mock("../../services/roomClient", () => ({
  roomClient: { roomControl: vi.fn(), setRoomReadiness: vi.fn() },
}));
vi.mock("../../services/desktopClient", () => ({
  desktopClient: { copyText: vi.fn(), setAppIcon: vi.fn() },
}));
vi.mock("../../services/audioClient", () => ({
  audioClient: {
    setMixer: vi.fn(async () => undefined),
    setDspParameter: vi.fn(async () => undefined),
    setDspEnabled: vi.fn(async () => undefined),
    setParticipantVolume: vi.fn(),
    monitoringEnabled: () => false,
    microphoneEnabled: () => true,
    participantMuted: () => false,
    roomTiming: vi.fn(async () => ({
      roundTripMs: 0,
      deviceLatencyMs: 0,
      estimatedVoiceLatencyMs: 0,
      voiceDelayMs: 0,
      followMs: 0,
      remotes: {},
    })),
  },
}));

const room = {
  code: "ROOM42",
  hostId: "me",
  role: "host",
  playbackLocked: false,
  participants: [
    {
      id: "me",
      name: "Me",
      role: "host",
      self: true,
      connected: true,
      muted: false,
      volume: 1,
      readiness: "ready",
    },
  ],
} as unknown as RoomStateDto;

const InRoom = () => {
  const { setRoom } = useApp();
  useEffect(() => setRoom(room), [setRoom]);
  return null;
};

const RoomSwitch = ({ inRoom }: { inRoom: boolean }) => {
  const { setRoom } = useApp();
  useEffect(() => setRoom(inRoom ? room : null), [inRoom, setRoom]);
  return null;
};

const VoiceChain = () => {
  useVoiceChain();
  return null;
};

const SettingsForm = ({ children }: { children: ReactNode }) => {
  const { preferences } = useApp();
  const form = useForm({ initialValues: { ...preferences } });
  return <Form form={form}>{children}</Form>;
};

it("sends your microphone at full level in a room and brings the stored volume back when you leave", async () => {
  clearStorage();
  const tree = (inRoom: boolean) => (
    <MemoryRouter>
      <AppProvider>
        <RoomSwitch inRoom={inRoom} />
        <VoiceChain />
      </AppProvider>
    </MemoryRouter>
  );
  const view = render(tree(true));
  await waitFor(() =>
    expect(vi.mocked(audioClient.setMixer)).toHaveBeenLastCalledWith(
      "mic",
      roomMicrophoneGain,
    ),
  );
  view.rerender(tree(false));
  await waitFor(() =>
    expect(vi.mocked(audioClient.setMixer)).toHaveBeenLastCalledWith(
      "mic",
      0.68,
    ),
  );
});

it("never shows a knob for your own microphone in the room, whatever the settings hold", async () => {
  clearStorage();
  render(
    <MemoryRouter>
      <AppProvider>
        <InRoom />
        <SettingsForm>
          <AudioTests
            runtime={{
              backend: "WASAPI Shared",
              sampleRate: 48000,
              periodFrames: 480,
              endpointBufferFrames: 480,
              estimatedLatencyMs: 10,
            }}
            audioAvailable
            microphoneIssue={false}
            inputLevel={0}
            testingInput={false}
            onToggleInputTest={() => undefined}
            onPlayTestSound={() => undefined}
          />
        </SettingsForm>
        <RoomDock />
      </AppProvider>
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("slider", { name: "microphoneKnob" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("slider", { name: "mixerMicrophone" }),
  ).not.toBeInTheDocument();
});
