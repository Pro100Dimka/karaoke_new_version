import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RoomLatencyPanel } from "./RoomLatencyPanel";

const roomTiming = vi.hoisted(() => vi.fn());
vi.mock("../../services/audioClient", () => ({ audioClient: { roomTiming } }));
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
  render(<RoomLatencyPanel />);
  expect(await screen.findByText("millisecondsValue:22")).toBeInTheDocument();
  expect(screen.getByText("roomDelay")).toBeInTheDocument();
  expect(screen.getByText(/roomPing: millisecondsValue:48/)).toBeInTheDocument();
  expect(screen.queryByText("roomSyncEstimateHint")).not.toBeInTheDocument();
  fireEvent.mouseEnter(screen.getByRole("button", { name: "roomTimingDetails" }));
  expect(await screen.findByText("roomSyncEstimateHint")).toBeInTheDocument();
  expect(screen.getByText("roomQualityClose:22")).toBeInTheDocument();
});
