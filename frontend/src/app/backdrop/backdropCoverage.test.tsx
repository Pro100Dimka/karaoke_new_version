import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBackdropCover, useBackdropCovered } from "./backdropCoverage";
import { QuantumFieldBackdrop } from "./QuantumFieldBackdrop";
import { useSpectrumFeed } from "./useSpectrumFeed";

vi.mock("../AppContext", () => ({ useApp: () => ({ preferences: { reducedMotion: false } }) }));
vi.mock("./useSpectrumFeed", () => ({ useSpectrumFeed: vi.fn() }));

const images: { onload: (() => void) | null; src: string }[] = [];
const Cover = ({ url = "scene.webp" }: { url?: string }) => {
  useBackdropCover(url);
  return null;
};
const Status = () => <output>{String(useBackdropCovered())}</output>;
const load = (index: number) => act(() => images[index]?.onload?.());

describe("opaque scene backdrop coverage", () => {
  beforeEach(() => {
    images.length = 0;
    vi.stubGlobal("Image", class {
      onload = null;
      src = "";
      constructor() { images.push(this); }
    });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("keeps the animation until the cover loads, then releases it without stopping the spectrum", () => {
    const view = render(<><Cover /><QuantumFieldBackdrop /></>);
    expect(screen.getByTitle("Quantum Fields visualizer")).toBeInTheDocument();
    load(0);
    expect(screen.queryByTitle("Quantum Fields visualizer")).not.toBeInTheDocument();
    expect(useSpectrumFeed).toHaveBeenLastCalledWith(true, expect.any(Function));
    view.rerender(<QuantumFieldBackdrop />);
    expect(screen.getByTitle("Quantum Fields visualizer")).toBeInTheDocument();
  });

  it("resumes only after the last overlapping cover is removed", () => {
    render(<Status />);
    const first = render(<Cover />);
    const second = render(<Cover />);
    load(0); load(1);
    first.unmount();
    expect(screen.getByRole("status")).toHaveTextContent("true");
    second.unmount();
    expect(screen.getByRole("status")).toHaveTextContent("false");
  });

  it("ignores a late load after unmount and waits for a replacement image", () => {
    render(<Status />);
    const view = render(<Cover />);
    const lateLoad = images[0]?.onload;
    view.rerender(<Cover url="other.webp" />);
    act(() => lateLoad?.());
    expect(screen.getByRole("status")).toHaveTextContent("false");
    load(1);
    expect(screen.getByRole("status")).toHaveTextContent("true");
    view.unmount();
    load(1);
    expect(screen.getByRole("status")).toHaveTextContent("false");
  });
});
