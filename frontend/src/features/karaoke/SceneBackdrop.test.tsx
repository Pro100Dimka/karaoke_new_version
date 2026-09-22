import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SceneBackdrop } from "./SceneBackdrop";

vi.mock("../../services/desktopClient", () => ({
  desktopClient: { sceneVideoUrl: vi.fn().mockResolvedValue(null) }
}));

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
});
