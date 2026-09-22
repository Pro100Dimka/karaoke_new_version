import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuantumFieldBackdrop } from "./QuantumFieldBackdrop";

let reducedMotion = false;

vi.mock("../AppContext", () => ({
  useApp: () => ({ preferences: { reducedMotion } }),
}));
vi.mock("./useSpectrumFeed", () => ({ useSpectrumFeed: vi.fn() }));

describe("QuantumFieldBackdrop reduced motion", () => {
  beforeEach(() => {
    reducedMotion = false;
  });

  it("keeps the themed picture but does not mount the animated WebGL frame", () => {
    reducedMotion = true;
    const { container } = render(<QuantumFieldBackdrop />);

    expect(container.querySelector(".qft-original-backdrop")).toBeInTheDocument();
    expect(screen.queryByTitle("Quantum Fields visualizer")).not.toBeInTheDocument();
  });
});
