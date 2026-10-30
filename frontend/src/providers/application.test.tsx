import { subscribeAudioFocus } from "./application";
import { QueryProvider } from "../test/QueryProvider";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";


const audio = vi.hoisted(() => ({
  suspend: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
}));
const desktop = vi.hoisted(() => ({
  listener: undefined as ((state: WindowState) => void) | undefined,
  onWindowState: vi.fn((listener: (state: WindowState) => void) => {
    desktop.listener = listener;
    return () => {
      desktop.listener = undefined;
    };
  }),
}));

vi.mock("../services/audioClient", () => ({
  audioClient: {
    suspendSession: audio.suspend,
    resumeSession: audio.resume,
  },
}));

vi.mock("../services/desktopClient", () => ({
  desktopClient: {
    setAppIcon: vi.fn(async () => undefined),
    onWindowState: desktop.onWindowState,
  },
}));

vi.mock("../shared/preferences/preferences", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../shared/preferences/preferences")>();
  return {
    ...actual,
    loadPreferences: () => ({
      ...actual.defaultPreferences(),
      audio: {
        backend: "ASIO",
        sampleRate: 44100,
        periodFrames: 512,
        bufferFrames: 512,
      },
      releaseAsioInBackground: true,
    }),
    savePreferences: vi.fn(),
  };
});

const AudioFocus = ({ settingsOpen = false }: { settingsOpen?: boolean }) => {
  useEffect(() => subscribeAudioFocus(() => settingsOpen), [settingsOpen]);
  return null;
};

describe("ASIO background release", () => {
  it("releases ASIO after the app loses focus and restores it on return", async () => {
    render(
      <QueryProvider application>
        <AudioFocus />
      </QueryProvider>,
    );

    act(() => window.dispatchEvent(new Event("blur")));
    await waitFor(() => expect(audio.suspend).toHaveBeenCalledOnce());

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(audio.resume).toHaveBeenCalledOnce());
  });

  it("releases ASIO when the window is minimized even while settings are open", async () => {
    render(
      <QueryProvider application>
        <AudioFocus settingsOpen />
      </QueryProvider>,
    );
    await waitFor(() => expect(desktop.listener).toBeTypeOf("function"));

    act(() =>
      desktop.listener?.({
        maximized: false,
        fullscreen: false,
        minimized: true,
      }),
    );
    await waitFor(() => expect(audio.suspend).toHaveBeenCalled());
  });
});
