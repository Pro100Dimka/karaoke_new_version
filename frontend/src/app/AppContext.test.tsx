import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "./AppContext";

const audio = vi.hoisted(() => ({ suspend: vi.fn(async () => undefined), resume: vi.fn(async () => undefined) }));

vi.mock("../services/audioClient", () => ({ audioClient: {
  suspendSession: audio.suspend,
  resumeSession: audio.resume,
} }));

vi.mock("../services/desktopClient", () => ({ desktopClient: {
  setAppIcon: vi.fn(async () => undefined),
} }));

vi.mock("../shared/preferences/preferences", async importOriginal => {
  const actual = await importOriginal<typeof import("../shared/preferences/preferences")>();
  return {
    ...actual,
    loadPreferences: () => ({
      ...actual.defaultPreferences(),
      audio: { backend: "ASIO", sampleRate: 44100, periodFrames: 512, bufferFrames: 512 },
      releaseAsioInBackground: true,
    }),
    savePreferences: vi.fn(),
  };
});

describe("ASIO background release", () => {
  it("releases ASIO after the app loses focus and restores it on return", async () => {
    render(<AppProvider><div>app</div></AppProvider>);

    act(() => window.dispatchEvent(new Event("blur")));
    await waitFor(() => expect(audio.suspend).toHaveBeenCalledOnce());

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(audio.resume).toHaveBeenCalledOnce());
  });
});
