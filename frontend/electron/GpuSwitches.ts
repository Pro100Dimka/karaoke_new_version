import * as os from 'node:os';

/**
 * CPU rasterization avoids repeated Skia shader compilation on the measured 20-thread desktop.
 * With GPU-rendered borders, the 8-thread Ryzen 3 7320U laptop holds about 60 FPS in settings;
 * GPU rasterization leaves the ENV panel around 56 FPS. At 2 cores, CPU rasterization was slower.
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
  const switches = ['force-high-performance-gpu'];
  // Electron keeps no Skia shader cache between launches, so with GPU rasterization the first modal of
  // every session compiled ~50 GPU programs through Direct3D and froze for ~0.6 s. On a CPU with room
  // to spare, rasterizing on its raster threads avoids that; compositing, video and WebGL stay on the GPU.
  if (cores >= cpuRasterizationMinimumCores)
    switches.push('disable-gpu-rasterization');
  for (const name of switches) commandLine.appendSwitch(name);
  return switches;
};
