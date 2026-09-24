import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface KeyboardLightingCapabilities {
  available: boolean;
  provider?: "OpenRGB";
  deviceCount: number;
}

export interface KeyboardLightingRequest {
  enabled: boolean;
  brightness: number;
  color: string;
}

export interface OpenRgbKeyboard {
  index: number;
  name: string;
}

type Runner = (args: readonly string[]) => Promise<string>;

export const parseOpenRgbKeyboards = (output: string): OpenRgbKeyboard[] => {
  const devices: Array<OpenRgbKeyboard & { type?: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const heading = /^\s*(\d+):\s*(.+?)\s*$/.exec(line);
    if (heading) {
      devices.push({ index: Number(heading[1]), name: heading[2] ?? "" });
      continue;
    }
    const type = /^\s*Type:\s*(.+?)\s*$/i.exec(line);
    const current = devices.at(-1);
    if (type && current) current.type = type[1];
  }
  return devices
    .filter(device => device.type?.toLowerCase() === "keyboard")
    .map(({ index, name }) => ({ index, name }));
};

const clampPercentage = (value: number): number =>
  Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));

export class OpenRgbKeyboardLighting {
  private keyboards: OpenRgbKeyboard[] = [];

  constructor(
    private readonly executable: string,
    private readonly run: Runner = (args) => new Promise((resolve, reject) => {
      execFile(executable, [...args], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    }),
  ) {}

  async capabilities(): Promise<KeyboardLightingCapabilities> {
    try {
      this.keyboards = parseOpenRgbKeyboards(await this.run(["--list-devices"]));
    } catch {
      this.keyboards = [];
    }
    return {
      available: this.keyboards.length > 0,
      provider: this.keyboards.length ? "OpenRGB" : undefined,
      deviceCount: this.keyboards.length,
    };
  }

  async apply(request: KeyboardLightingRequest): Promise<void> {
    if (!this.keyboards.length && !(await this.capabilities()).available) return;
    const color = request.enabled && /^[0-9a-f]{6}$/i.test(request.color)
      ? request.color.toUpperCase()
      : "000000";
    const args = this.keyboards.flatMap(keyboard => [
      "--device", String(keyboard.index), "--mode", "direct", "--color", color,
      "--brightness", String(clampPercentage(request.brightness)),
    ]);
    await this.run(args);
  }
}

const executableNames = process.platform === "win32" ? ["OpenRGB.exe"] : ["openrgb", "OpenRGB"];

export const findOpenRgbExecutable = (): string | undefined => {
  const candidates = [
    process.env.AD_VOICE_OPENRGB,
    ...String(process.env.PATH ?? "").split(path.delimiter).flatMap(root => executableNames.map(name => path.join(root, name))),
    ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
      .filter((root): root is string => Boolean(root))
      .map(root => path.join(root, "OpenRGB", "OpenRGB.exe")),
  ];
  return candidates.find((candidate): candidate is string =>
    typeof candidate === "string" && candidate.length > 0 && fs.existsSync(candidate),
  );
};

export const createKeyboardLightingProvider = (): OpenRgbKeyboardLighting | undefined => {
  const executable = findOpenRgbExecutable();
  return executable ? new OpenRgbKeyboardLighting(executable) : undefined;
};
