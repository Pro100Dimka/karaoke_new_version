import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RoomLinkCard } from "./RoomLinkCard";

const roomTiming = vi.hoisted(() => vi.fn());
const setMonitoring = vi.hoisted(() => vi.fn());
vi.mock("../../services/audioClient", () => ({
  audioClient: { roomTiming, setMonitoring, monitoringEnabled: () => false },
}));
vi.mock("../../app/AppContext", () => {
  const voice = {
    monitoringEnabled: () => false,
    setMonitoring,
    subscribeTiming: (listener: (report: unknown) => void) => {
      const refresh = () => { void roomTiming().then(listener); };
      refresh();
      const timer = setInterval(refresh, 2000);
      return () => clearInterval(timer);
    },
  };
  return { useRoomVoice: () => voice };
});
vi.mock("../../i18n/useText", () => ({
  useText: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}));

afterEach(() => vi.clearAllMocks());

it("keeps the real room delay while voices pause instead of jumping to the rough estimate", async () => {
  const timing = (voiceDelayMs: number) => ({
    roundTripMs: 30,
    deviceLatencyMs: 1,
    estimatedVoiceLatencyMs: 16,
    voiceDelayMs,
    followMs: 0,
    remotes: {},
  });
  roomTiming.mockResolvedValueOnce(timing(82)).mockResolvedValue(timing(0));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<RoomLinkCard />);
  expect(await screen.findByText("millisecondsValue:82")).toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(2_100);
  expect(screen.getByText("millisecondsValue:82")).toBeInTheDocument();
  expect(screen.queryByText("millisecondsValue:16")).not.toBeInTheDocument();
  vi.useRealTimers();
});

it("turns monitoring on and off from its switch", async () => {
  roomTiming.mockResolvedValue({
    roundTripMs: 30,
    deviceLatencyMs: 1,
    estimatedVoiceLatencyMs: 16,
    voiceDelayMs: 20,
    followMs: 0,
    remotes: {},
  });
  setMonitoring.mockResolvedValue({ monitoring: true });
  render(<RoomLinkCard />);
  const toggle = await screen.findByRole("switch", { name: "monitoring" });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  await vi.waitFor(() => expect(toggle).toBeChecked());
  expect(setMonitoring).toHaveBeenCalledWith(true);
});
