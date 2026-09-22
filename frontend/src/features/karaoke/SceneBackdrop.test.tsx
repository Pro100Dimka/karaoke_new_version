import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SceneBackdrop } from "./SceneBackdrop";

vi.mock("../../services/desktopClient", () => ({
  desktopClient: { sceneVideoUrl: vi.fn().mockResolvedValue(null) }
}));

describe("SceneBackdrop", () => {
  it("embeds a recognized YouTube clip instead of passing its watch page to a video element", () => {
    const view = render(
      <SceneBackdrop
        theme="dark"
        videoUrl="https://www.youtube.com/watch?v=HVfb25Jq-_A"
        positionSeconds={12}
        playing
        rate={1}
      />
    );

    const clip = screen.getByTitle("YouTube karaoke background");
    expect(clip).toBeInstanceOf(HTMLIFrameElement);
    expect(clip).toHaveAttribute("src", expect.stringContaining("youtube-nocookie.com/embed/HVfb25Jq-_A"));
    expect(document.querySelector('video[src*="youtube.com/watch"]')).not.toBeInTheDocument();

    const initialSource = clip.getAttribute("src");
    view.rerender(
      <SceneBackdrop
        theme="dark"
        videoUrl="https://www.youtube.com/watch?v=HVfb25Jq-_A"
        positionSeconds={42}
        playing
        rate={1}
      />
    );
    expect(screen.getByTitle("YouTube karaoke background")).toHaveAttribute("src", initialSource);
  });
});
