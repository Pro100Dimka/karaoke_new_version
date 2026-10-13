import { expect, it, vi } from "vitest";
import { applyGpuSwitches, cpuRasterizationMinimumCores } from "./GpuSwitches";

it("rasterizes on the CPU only where the CPU has room for it", () => {
  const strong = { appendSwitch: vi.fn() };
  expect(applyGpuSwitches(strong, 20)).toEqual(["force-high-performance-gpu", "disable-gpu-rasterization"]);
  expect(strong.appendSwitch.mock.calls).toEqual([["force-high-performance-gpu"], ["disable-gpu-rasterization"]]);

  const weak = { appendSwitch: vi.fn() };
  // Measured: on 2 cores CPU rasterization made scrolling and smaller modals worse than the GPU.
  expect(applyGpuSwitches(weak, 2)).toEqual(["force-high-performance-gpu"]);
  expect(applyGpuSwitches({ appendSwitch: vi.fn() }, cpuRasterizationMinimumCores - 1)).not.toContain("disable-gpu-rasterization");
  expect(applyGpuSwitches({ appendSwitch: vi.fn() }, cpuRasterizationMinimumCores)).toContain("disable-gpu-rasterization");
});
