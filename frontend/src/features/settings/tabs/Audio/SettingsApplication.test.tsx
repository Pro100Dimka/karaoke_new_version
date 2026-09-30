import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeAudioConfiguration } from "../../../../contracts/models";
import { SettingsModal } from "../../SettingsModal";

const state = vi.hoisted(() => ({
  audio: { backend: "WASAPI Exclusive", sampleRate: 48000, periodFrames: 480 },
  runtime: { backend: "WASAPI Exclusive", sampleRate: 48000, periodFrames: 480,
    endpointBufferFrames: 480, estimatedLatencyMs: 17 },
  apply: vi.fn<() => Promise<RuntimeAudioConfiguration>>(),
  capabilities: vi.fn(async () => ({ sampleRates: [48000], periodFrames: [480] })),
  updatePreferences: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("../../../../app/AppContext", () => ({ useApp: () => ({
  settingsOpen: true, settingsTab: "audio", language: "ru", preferences: { audio: state.audio },
  setSettingsOpen: vi.fn(), updatePreferences: state.updatePreferences,
}) }));
vi.mock("../../../../app/NotificationsProvider", () => ({ useNotify: () => state.notify }));
vi.mock("../../../../services/audioClient", () => ({ audioClient: {
  runtimeConfiguration: async () => state.runtime,
  listDevices: async () => [], capabilities: async () => ({ microphone: "ready" }),
  configurationCapabilities: state.capabilities,
  applyConfiguration: state.apply,
} }));
vi.mock("./useAudioTests", () => ({ useAudioTests: () => ({}) }));
vi.mock("../../SettingsContent", () => ({ SettingsContent: ({ formik, onAudioCommit }: {
  formik: { values: { backend: string }; setFieldValue(name: string, value: string): void };
  onAudioCommit(name: string, value: string): void;
}) => <><output>{formik.values.backend}</output><button onClick={() => {
  formik.setFieldValue("backend", "WASAPI Shared");
  onAudioCommit("backend", "WASAPI Shared");
}}>select shared</button></> }));

beforeEach(() => {
  vi.clearAllMocks();
  state.audio = { backend: "WASAPI Exclusive", sampleRate: 48000, periodFrames: 480 };
  state.runtime = { backend: "WASAPI Exclusive", sampleRate: 48000, periodFrames: 480,
    endpointBufferFrames: 480, estimatedLatencyMs: 17 };
  state.apply.mockRejectedValue(new Error("endpoint busy"));
  state.capabilities.mockResolvedValue({ sampleRates: [48000], periodFrames: [480] });
});

it("restores the accepted selection when switching fails", async () => {
  render(<SettingsModal />);
  fireEvent.click(await screen.findByText("select shared"));
  await waitFor(() => expect(state.notify).toHaveBeenCalled());
  expect(screen.getByRole("status")).toHaveTextContent("WASAPI Exclusive");
});

it("keeps the accepted mode when only capabilities refresh fails", async () => {
  render(<SettingsModal />);
  const button = await screen.findByText("select shared");
  state.apply.mockResolvedValue({ ...state.runtime, backend: "WASAPI Shared" });
  state.capabilities.mockRejectedValue(new Error("query failed"));
  fireEvent.click(button);
  await waitFor(() => expect(state.updatePreferences).toHaveBeenCalledWith({ audio:
    expect.objectContaining({ backend: "WASAPI Shared" }) }));
  expect(screen.getByRole("status")).toHaveTextContent("WASAPI Shared");
  expect(state.notify).not.toHaveBeenCalled();
});

it("shows the active backend when saved preferences differ from AudioService", async () => {
  state.audio = { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480 };
  state.runtime = { ...state.runtime, backend: "WASAPI Exclusive" };
  render(<SettingsModal />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("WASAPI Exclusive"));
  await waitFor(() => expect(state.capabilities).toHaveBeenLastCalledWith(
    expect.objectContaining({ backend: "WASAPI Exclusive" })));
  expect(state.updatePreferences).not.toHaveBeenCalled();
});

it("updates the shown backend when AudioService switches while settings stay open", async () => {
  render(<SettingsModal />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("WASAPI Exclusive"));
  state.runtime = { ...state.runtime, backend: "WASAPI Shared" };
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("WASAPI Shared"),
    { timeout: 2500 });
  await waitFor(() => expect(state.capabilities).toHaveBeenLastCalledWith(
    expect.objectContaining({ backend: "WASAPI Shared" })));
  expect(state.updatePreferences).not.toHaveBeenCalled();
});

it("does not replace a pending selection with the previous runtime mode", async () => {
  let accept: (runtime: RuntimeAudioConfiguration) => void = () => undefined;
  state.apply.mockImplementation(() => new Promise((resolve) => { accept = resolve; }));
  render(<SettingsModal />);
  fireEvent.click(await screen.findByText("select shared"));
  await waitFor(() => expect(state.apply).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(screen.getByRole("status")).toHaveTextContent("WASAPI Shared");
  accept({ ...state.runtime, backend: "WASAPI Shared" });
  await waitFor(() => expect(state.updatePreferences).toHaveBeenCalled());
});
