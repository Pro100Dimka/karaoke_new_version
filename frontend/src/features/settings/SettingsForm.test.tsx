import { fireEvent, render, screen } from "@testing-library/react";
import { useFormContext } from "@ad-voice/ui";
import { expect, it, vi } from "vitest";
import { defaultPreferences } from "../../shared/preferences/preferences";
import type { Preferences } from "../../shared/preferences/preferences";
import SettingsModal from ".";

const originalPreferences = { ...defaultPreferences(), displayName: "Central singer" };

const state = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  preferences: null as Preferences | null,
  tab: "appearance" as "appearance" | "audio",
}));

vi.mock("../../app/AppContext", () => ({
  useApp: () => ({
    language: "en",
    preferences: state.preferences ?? originalPreferences,
    updatePreferences: state.updatePreferences,
  }),
  useSettingsDialog: () => ({
    settingsOpen: true,
    settingsTab: state.tab,
    setSettingsOpen: vi.fn(),
  }),
}));

vi.mock("../../app/RadioContext", () => ({
  useRadio: () => ({ stationId: "groove-salad" }),
}));

vi.mock("../../app/NotificationsProvider", () => ({
  useNotify: () => vi.fn(),
}));

vi.mock("../../i18n/useText", () => ({
  useText: () => (key: string) => key,
}));

vi.mock("../../services/audioClient", () => ({
  audioClient: {
    runtimeConfiguration: async () => ({
      backend: "WASAPI Shared",
      sampleRate: 48_000,
      periodFrames: 480,
      endpointBufferFrames: 960,
      estimatedLatencyMs: 30,
    }),
    listDevices: async () => [],
    capabilities: async () => ({
      microphone: "ready",
      keyboardLighting: false,
    }),
    configurationCapabilities: async () => ({
      sampleRates: [48_000],
      periodFrames: [480],
      defaultSampleRate: 48_000,
      defaultPeriodFrames: 480,
    }),
  },
}));

vi.mock("./tabs/Audio/useAudioTests", () => ({
  useAudioTests: () => ({
    inputLevel: 0,
    testingInput: false,
    setTestingInput: vi.fn(),
    playTestSound: vi.fn(),
  }),
}));

vi.mock("./tabs/Appearance", () => ({
  AppearanceSettings: () => {
    const form = useFormContext<Record<string, unknown>>();
    return (
      <>
        <output>{String(form.values.displayName)}</output>
        <button onClick={() => form.setValue("displayName", "Saved singer")}>
          change name
        </button>
      </>
    );
  },
}));

vi.mock("./tabs/Audio", () => ({
  AudioSettings: ({
    form,
  }: {
    form: {
      values: { displayName: string; backend: string };
      setValue(name: string, value: unknown): void;
    };
  }) => (
    <>
      <output data-testid="audio-name">{form.values.displayName}</output>
      <output data-testid="audio-backend">{form.values.backend}</output>
      <button onClick={() => form.setValue("backend", "ASIO")}>
        select pending ASIO
      </button>
    </>
  ),
}));
vi.mock("./tabs/Ai", () => ({ AiSettings: () => null }));
vi.mock("./tabs/Secrets", () => ({ SecretsSettings: () => null }));
vi.mock("./tabs/Advanced", () => ({ AdvancedSettings: () => null }));

it("owns one settings form in SettingsModal and provides it to its tabs", async () => {
  render(<SettingsModal />);
  expect(await screen.findByText("Central singer")).toBeInTheDocument();
  fireEvent.click(screen.getByText("change name"));
  expect(state.updatePreferences).toHaveBeenCalledWith({
    displayName: "Saved singer",
  });
  fireEvent.click(screen.getByText("audio"));
  expect(screen.getByTestId("audio-name")).toHaveTextContent("Saved singer");
});

it("keeps pending audio selection when an unrelated preference is saved", async () => {
  state.preferences = {
    ...defaultPreferences(),
    displayName: "Central singer",
  };
  const view = render(<SettingsModal />);
  await screen.findByText("Central singer");
  fireEvent.click(screen.getByText("audio"));
  fireEvent.click(screen.getByText("select pending ASIO"));
  state.preferences = { ...state.preferences, theme: "light" };
  view.rerender(<SettingsModal />);
  expect(screen.getByTestId("audio-backend")).toHaveTextContent("ASIO");
  state.preferences = null;
});

it("honors an external tab request while the settings are already open", async () => {
  const view = render(<SettingsModal />);
  await screen.findByText("Central singer");
  state.tab = "audio";
  view.rerender(<SettingsModal />);
  expect(screen.getByTestId("audio-backend")).toHaveTextContent("WASAPI Shared");
  state.tab = "appearance";
});
