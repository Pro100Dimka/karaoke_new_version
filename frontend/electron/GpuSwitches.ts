import * as os from "node:os";

/**
 * Logical cores from which the interface is rasterized on the CPU. Measured on this app: with 20
 * the first modal of a session opens in ~60 ms instead of ~600 ms and the GPU process does less;
 * pinned to 2 cores, CPU rasterization made scrolling and smaller modals clearly worse than the GPU.
 * Nothing between was measured, so the line is drawn cautiously.
 */
export const cpuRasterizationMinimumCores = 8;

interface CommandLine {
  appendSwitch(name: string, value?: string): void;
}

/** Chromium switches for the GPU; must run before the app is ready. Returns what was applied. */
export const applyGpuSwitches = (
  commandLine: CommandLine,
  cores: number = os.availableParallelism(),
): string[] => {
  // Hybrid Windows laptops otherwise keep Chromium's compositor and WebGL work on the integrated GPU.
  const switches = ["force-high-performance-gpu"];
  // Electron keeps no Skia shader cache between launches, so with GPU rasterization the first modal of
  // every session compiled ~50 GPU programs through Direct3D and froze for ~0.6 s. On a CPU with room
  // to spare, rasterizing on its raster threads avoids that; compositing, video and WebGL stay on the GPU.
  if (cores >= cpuRasterizationMinimumCores) switches.push("disable-gpu-rasterization");
  for (const name of switches) commandLine.appendSwitch(name);
  return switches;
};
