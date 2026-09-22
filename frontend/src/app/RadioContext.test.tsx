import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../services/audioClient";
import { RadioProvider, useRadio } from "./RadioContext";

vi.mock("../services/audioClient", () => ({
  audioClient: {
    loadRadio: vi.fn(async () => undefined),
    playRadio: vi.fn(async () => undefined),
    pauseRadio: vi.fn(async () => undefined),
    stopRadio: vi.fn(async () => undefined),
    setRadioGain: vi.fn(async () => undefined),
  },
}));

vi.mock("./AppContext", () => ({
  useApp: () => ({
    preferences: { radioStation: "groove-salad", radioVolume: 35 },
    updatePreferences: vi.fn(),
  }),
}));

vi.mock("./NotificationsProvider", () => {
  const notify = vi.fn();
  return { useNotify: () => notify };
});

const Controls = () => {
  const radio = useRadio();
  return <button onClick={radio.toggle}>{radio.enabled ? "on" : "off"}</button>;
};

describe("RadioProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prepares the station once and reuses it for instant pause and resume", async () => {
    render(
      <RadioProvider libraryActive>
        <Controls />
      </RadioProvider>,
    );

    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalledTimes(1));
    expect(audioClient.playRadio).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "on" }));
    await waitFor(() => expect(audioClient.pauseRadio).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(2));
    expect(audioClient.loadRadio).toHaveBeenCalledTimes(1);
  });
});
