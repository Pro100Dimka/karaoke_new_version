import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RoomLinkCard } from "./RoomLinkCard";

const roomTiming = vi.hoisted(() => vi.fn());
const setMonitoring = vi.hoisted(() => vi.fn());
vi.mock("../../services/audioClient", () => ({
  audioClient: { roomTiming, setMonitoring, monitoringEnabled: () => false },
}));
vi.mock("../../i18n/useText", () => ({
  useText: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}));

afterEach(() => vi.clearAllMocks());

it("shows the labelled room latency on its own, with the explanation behind the info icon", async () => {
  roomTiming.mockResolvedValue({
    roundTripMs: 48, deviceLatencyMs: 10, estimatedVoiceLatencyMs: 34,
    remotes: { friend: { jitterMs: 1.04, targetDelayMs: 22 } }, voiceDelayMs: 22.4, followMs: 0,
  });
  render(<RoomLinkCard />);
  expect(await screen.findByText("millisecondsValue:22")).toBeInTheDocument();
  expect(screen.getByText("roomLatencyLabel")).toBeInTheDocument();
  expect(screen.getByText("linkExcellent")).toBeInTheDocument();
  expect(screen.queryByText("roomSyncEstimateHint")).not.toBeInTheDocument();
  fireEvent.mouseEnter(screen.getByRole("button", { name: "roomTimingDetails" }));
  expect(await screen.findByText("roomSyncEstimateHint")).toBeInTheDocument();
  expect(screen.getByText(/roomPing: millisecondsValue:48/)).toBeInTheDocument();
  expect(screen.getByText("roomQualityClose:22")).toBeInTheDocument();
});

it("shows the voice route and warns about a stalling link", async () => {
  const timing = (lateCuts: number) => ({
    roundTripMs: 48, deviceLatencyMs: 10, estimatedVoiceLatencyMs: 34, voiceDelayMs: 50, followMs: 0,
    remotes: { friend: { jitterMs: 6, targetDelayMs: 50, relayPackets: 400 + 100 * lateCuts, directPackets: 0, lateCuts } },
  });
  roomTiming.mockResolvedValueOnce(timing(1)).mockResolvedValue(timing(4));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<RoomLinkCard />);
  await vi.advanceTimersByTimeAsync(2_100);
  expect(await screen.findByText("linkUnstable")).toBeInTheDocument();
  fireEvent.mouseEnter(screen.getByRole("button", { name: "roomTimingDetails" }));
  expect(await screen.findByText(/roomRoute: roomRouteRelay/)).toBeInTheDocument();
  expect(screen.getByText("roomUnstableLink")).toBeInTheDocument();
  vi.useRealTimers();
});


it("keeps the real room delay while voices pause instead of jumping to the rough estimate", async () => {
  const timing = (voiceDelayMs: number) => ({
    roundTripMs: 30, deviceLatencyMs: 1, estimatedVoiceLatencyMs: 16, voiceDelayMs, followMs: 0, remotes: {},
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
    roundTripMs: 30, deviceLatencyMs: 1, estimatedVoiceLatencyMs: 16, voiceDelayMs: 20, followMs: 0, remotes: {},
  });
  setMonitoring.mockResolvedValue({ monitoring: true });
  render(<RoomLinkCard />);
  const toggle = await screen.findByRole("switch", { name: "monitoring" });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  fireEvent.click(toggle);
  await vi.waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  expect(setMonitoring).toHaveBeenCalledWith(true);
});
