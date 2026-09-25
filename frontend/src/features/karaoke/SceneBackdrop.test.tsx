import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopClient } from "../../services/desktopClient";
import { SceneBackdrop } from "./SceneBackdrop";

vi.mock("../../services/desktopClient", () => ({
  desktopClient: { sceneVideoUrl: vi.fn().mockResolvedValue(null) }
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SceneBackdrop", () => {
  it("plays only a downloaded local clip and never embeds a YouTube page", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const view = render(
      <SceneBackdrop
        theme="dark"
        videoUrl="https://www.youtube.com/watch?v=HVfb25Jq-_A"
        positionSeconds={12}
        playing
        rate={1}
      />
    );

    expect(screen.queryByTitle("YouTube karaoke background")).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(document.querySelector("video")).not.toBeInTheDocument();
    view.rerender(
      <SceneBackdrop
        theme="dark"
        videoUrl="http://127.0.0.1:8765/songs/song-1/clip"
        positionSeconds={42}
        playing
        rate={1}
      />
    );
    expect(document.querySelector("video")).toHaveAttribute(
      "src",
      "http://127.0.0.1:8765/songs/song-1/clip",
    );
  });

  it("loops the generic scene fallback instead of freezing once the song outlasts the clip", async () => {
    vi.mocked(desktopClient.sceneVideoUrl).mockResolvedValueOnce("file:///media/scene/clip-00.webm");
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(300);
    let currentTime = 0;
    vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockImplementation(() => currentTime);
    vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(value => {
      currentTime = value;
    });

    render(<SceneBackdrop theme="dark" videoUrl="" positionSeconds={310} playing rate={1} />);

    // 310s into a 300s looping clip should land 10s into its next loop, not sit stuck at the clip's end.
    await waitFor(() => expect(currentTime).toBeCloseTo(10));
  });

  it("releases the local clip file when karaoke closes", () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const view = render(
      <SceneBackdrop
        theme="dark"
        videoUrl="http://127.0.0.1:8765/songs/song-1/clip"
        positionSeconds={0}
        playing={false}
        rate={1}
      />
    );

    view.unmount();

    expect(pause).toHaveBeenCalled();
    expect(load).toHaveBeenCalled();
  });

  it("keeps the song clip after background playback is temporarily rejected", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("backgrounded"))
      .mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);

    render(
      <SceneBackdrop
        theme="dark"
        videoUrl="http://127.0.0.1:8765/songs/song-1/clip"
        positionSeconds={12}
        playing
        rate={1}
      />
    );
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(document.querySelector("video")).toHaveAttribute(
      "src",
      "http://127.0.0.1:8765/songs/song-1/clip",
    );

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(document.querySelector("video")).toBeInTheDocument();
  });
});
