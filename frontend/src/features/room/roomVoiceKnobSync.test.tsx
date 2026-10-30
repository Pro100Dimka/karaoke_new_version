import { observer } from "mobx-react-lite";
import { store } from "../../providers/store";
import { QueryProvider } from "../../test/QueryProvider";
import { render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { TestRouter } from "../../test/QueryProvider";
import { expect, it, vi } from "vitest";
import { roomSession } from "../../providers/application";
import type { RoomStateDto } from "../../contracts/models";
import { audioClient } from "../../services/audioClient";
import { clearStorage } from "../../shared/storage/localStore";
import { useVoiceChain } from "../karaoke/console/voiceChain";
import AudioPanel from "../../pages/library/modals/settings/audio";
import { RoomDock } from "./RoomDock";
vi.mock("../../providers/social", () => {
  const offline = { type: "offline" };
  const directory = { people: vi.fn(async () => []) };
  return {
    friendRelations: { befriend: vi.fn(async () => undefined) },
    useSocial: () => offline,
    useSocialDirectory: () => directory,
  };
});

vi.mock("../../providers/radio", () => ({ useRadio: () => ({ canControl: true }) }));
vi.mock("../../providers/dialog", () => ({ ask: vi.fn() }));
vi.mock("../../providers/notifications", () => ({
  useNotify: () => vi.fn(),
}));

vi.mock("../../services/roomClient", () => ({
  roomClient: { roomControl: vi.fn(), setRoomReadiness: vi.fn() },
}));
vi.mock("../../services/desktopClient", () => ({
  desktopClient: { copyText: vi.fn(), setAppIcon: vi.fn() },
}));
vi.mock("../../services/audioClient", () => ({
  audioClient: {
    runtimeConfiguration: vi.fn(async () => ({ backend: "WASAPI Shared", sampleRate: 48000,
      periodFrames: 480, endpointBufferFrames: 480, estimatedLatencyMs: 10 })),
    listDevices: vi.fn(async () => []),
    capabilities: vi.fn(async () => ({ microphone: "missing" })),
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
  const session = roomSession;
  useEffect(() => session.setSnapshot(room), [session]);
  return null;
};

const RoomSwitch = ({ inRoom, voiceGain }: { inRoom: boolean; voiceGain: number }) => {
  const session = roomSession;
  const { updatePreferences } = store;
  useEffect(() => updatePreferences({ voiceGain }), [voiceGain, updatePreferences]);
  useEffect(() => session.setSnapshot(inRoom ? room : null), [inRoom, session]);
  return null;
};

const VoiceChain = observer(() => {
  useVoiceChain();
  return null;
});


it.each([0.68, 4])("keeps the stored microphone gain %s when joining and leaving a room", async (voiceGain) => {
  clearStorage();
  const tree = (inRoom: boolean) => (
    <TestRouter>
      <QueryProvider application>
        <RoomSwitch inRoom={inRoom} voiceGain={voiceGain} />
        <VoiceChain />
      </QueryProvider>
    </TestRouter>
  );
  const view = render(tree(true));
  await waitFor(() =>
    expect(vi.mocked(audioClient.setMixer)).toHaveBeenLastCalledWith(
      "mic",
      voiceGain,
    ),
  );
  view.rerender(tree(false));
  await waitFor(() =>
    expect(vi.mocked(audioClient.setMixer)).toHaveBeenLastCalledWith(
      "mic",
      voiceGain,
    ),
  );
});

it("never shows a knob for your own microphone in the room, whatever the settings hold", async () => {
  clearStorage();
  render(
    <TestRouter>
      <QueryProvider application>
        <InRoom />
        <AudioPanel />
        <RoomDock />
      </QueryProvider>
    </TestRouter>,
  );
  expect(
    await screen.findByRole("slider", { name: "microphoneKnob" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("slider", { name: "mixerMicrophone" }),
  ).not.toBeInTheDocument();
});
