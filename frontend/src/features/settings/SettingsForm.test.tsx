import { act, fireEvent, render, screen } from "@testing-library/react";
import { useFormContext } from "@ad-voice/ui";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { defaultPreferences } from "../../shared/preferences/preferences";
import type { Preferences } from "../../shared/preferences/preferences";
import SettingsModal from ".";
import { audioClient } from "../../services/audioClient";
import { useSettingsForm } from "./settingsForm";

const originalPreferences = { ...defaultPreferences(), displayName: "Central singer" };

const state = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  preferences: null as Preferences | null,
  tab: "appearance" as "appearance" | "audio",
  artRenders: 0,
  setInputLevel: null as null | ((value: number) => void),
}));

afterEach(() => {
  state.tab = "appearance";
  state.preferences = null;
});

vi.mock("../../shared/ui/Atmosphere", () => ({
  SettingsAtmosphere: () => {
    state.artRenders += 1;
    return null;
  },
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
    runtimeConfiguration: vi.fn(async () => ({
      backend: "WASAPI Shared",
      sampleRate: 48_000,
      periodFrames: 480,
      endpointBufferFrames: 960,
      estimatedLatencyMs: 30,
    })),
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
  useAudioTests: () => {
    const [inputLevel, setInputLevel] = useState(0);
    state.setInputLevel = setInputLevel;
    return {
    inputLevel,
    testingInput: false,
    setTestingInput: vi.fn(),
    playTestSound: vi.fn(),
    };
  },
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

it("opens appearance without waiting for or querying audio devices", async () => {
  state.tab = "appearance";
  state.preferences = null;
  const runtime = vi.mocked(audioClient.runtimeConfiguration);
  runtime.mockClear();
  const view = render(<SettingsModal />);
  expect(await screen.findByText("Central singer")).toBeInTheDocument();
  expect(runtime).not.toHaveBeenCalled();
  view.unmount();
});

it("keeps tabs usable while audio initialization is pending", async () => {
  state.tab = "appearance";
  const runtime = vi.mocked(audioClient.runtimeConfiguration);
  runtime.mockImplementationOnce(() => new Promise(() => undefined));
  render(<SettingsModal />);
  fireEvent.click(await screen.findByText("audio"));
  expect(screen.getByText("appearance")).toBeInTheDocument();
  fireEvent.click(screen.getByText("appearance"));
  expect(screen.getByText("Central singer")).toBeInTheDocument();
});

it("keeps the settings shell still while the audio meter updates", async () => {
  state.tab = "audio";
  const view = render(<SettingsModal />);
  await screen.findByTestId("audio-name");
  const artRenders = state.artRenders;
  act(() => state.setInputLevel?.(0.6));
  expect(state.artRenders).toBe(artRenders);
  view.unmount();
  state.tab = "appearance";
});

it("does not serialize unchanged preferences on an unrelated settings rerender", () => {
  const Harness = () => {
    useSettingsForm();
    return null;
  };
  const view = render(<Harness />);
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    view.rerender(<Harness />);
    expect(stringify.mock.calls.filter(([value]) => value && typeof value === "object" && "profilePhoto" in value)).toHaveLength(0);
  } finally {
    stringify.mockRestore();
    view.unmount();
  }
});

it("owns one settings form in SettingsModal and provides it to its tabs", async () => {
  render(<SettingsModal />);
  expect(await screen.findByText("Central singer")).toBeInTheDocument();
  fireEvent.click(screen.getByText("change name"));
  expect(state.updatePreferences).toHaveBeenCalledWith({
    displayName: "Saved singer",
  });
  fireEvent.click(screen.getByText("audio"));
  expect(await screen.findByTestId("audio-name")).toHaveTextContent("Saved singer");
});

it("keeps pending audio selection when an unrelated preference is saved", async () => {
  state.preferences = {
    ...defaultPreferences(),
    displayName: "Central singer",
  };
  const view = render(<SettingsModal />);
  await screen.findByText("Central singer");
  fireEvent.click(screen.getByText("audio"));
  await screen.findByTestId("audio-backend");
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
  expect(await screen.findByTestId("audio-backend")).toHaveTextContent("WASAPI Shared");
  state.tab = "appearance";
});
