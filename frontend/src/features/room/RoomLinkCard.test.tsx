import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoomLinkCard } from "./RoomLinkCard";
import { unverifiedAsioMonitoring } from "../../contracts/models";

const roomTiming = vi.hoisted(() => vi.fn());
const setMonitoring = vi.hoisted(() => vi.fn());
const monitoringStatus = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
vi.mock("../../providers/notifications", () => ({ useNotify: () => notify }));
vi.mock("../../services/audioClient", () => ({
  audioClient: { roomTiming, setMonitoring, monitoringEnabled: () => false },
}));
vi.mock("../../providers/application", () => {
  const voice = {
    monitoringEnabled: () => false,
    setMonitoring,
    monitoringStatus,
    subscribeTiming: (listener: (report: unknown) => void) => {
      const refresh = () => { void roomTiming().then(listener); };
      refresh();
      const timer = setInterval(refresh, 2000);
      return () => clearInterval(timer);
    },
  };
  return { useRoomVoice: () => voice };
});


beforeEach(() => monitoringStatus.mockResolvedValue({ monitoring: false, monitoringSafetyTripped: false }));
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
  expect(await screen.findByText("82 мс")).toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(2_100);
  expect(screen.getByText("82 мс")).toBeInTheDocument();
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
  const toggle = await screen.findByRole("switch", { name: "Мониторинг" });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  await vi.waitFor(() => expect(toggle).toBeChecked());
  expect(setMonitoring).toHaveBeenCalledWith(true);
});

it("reports an emergency monitoring disconnect while the room link is open", async () => {
  roomTiming.mockResolvedValue({
    roundTripMs: 30, deviceLatencyMs: 1, estimatedVoiceLatencyMs: 16,
    voiceDelayMs: 20, followMs: 0, remotes: {},
  });
  monitoringStatus.mockResolvedValue({ monitoring: false, monitoringSafetyTripped: true });
  render(<RoomLinkCard />);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Мониторинг микрофона отключён: входной сигнал долго оставался слишком громким. Уменьшите громкость колонок или используйте наушники перед повторным включением.", "error"));
});

it("shows the reason when monitoring is blocked before playback", async () => {
  roomTiming.mockResolvedValue({ roundTripMs: 30, deviceLatencyMs: 1,
    estimatedVoiceLatencyMs: 16, voiceDelayMs: 20, followMs: 0, remotes: {} });
  setMonitoring.mockRejectedValue(new Error(unverifiedAsioMonitoring));
  render(<RoomLinkCard />);
  fireEvent.click(await screen.findByRole("switch", { name: "Мониторинг" }));
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(
    "Мониторинг заблокирован: вход ASIO4ALL не подтверждён и может вызвать громкий свист. Для прослушивания нужны наушники и WASAPI Shared.", "error"));
});
