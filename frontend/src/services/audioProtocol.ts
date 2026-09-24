import type { AudioBackendName, DeviceDto } from "../contracts/models";
import type { RoomTimingReport } from "../contracts/clients";

export const parseKeyValues = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split(/[;\n]/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const separator = line.indexOf(":") >= 0 ? line.indexOf(":") : line.indexOf("=");
        return separator < 0
          ? [line, ""]
          : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      })
  );

export const backendCode = (backend: AudioBackendName): string =>
  backend === "ASIO" ? "asio" : backend === "WASAPI Exclusive" ? "wasapi-exclusive" : "wasapi-shared";

export const backendName = (value: string): AudioBackendName =>
  value === "ASIO" ? "ASIO" : value === "WASAPI Exclusive" ? "WASAPI Exclusive" : "WASAPI Shared";

export interface RawDevice extends DeviceDto {
  backendIndex: number;
}

export const parseDevices = (raw: string): RawDevice[] => raw
  .split("\n")
  .map(line => line.trim())
  .filter(Boolean)
  .map(line => {
    const [id = "", name = "", backend = "1", direction = "0", channels = "0"] = line.split(",");
    return {
      id,
      name,
      backendIndex: Number(backend) || 1,
      kind: direction === "1" ? "output" as const : "input" as const,
      channels: Number(channels) || 0
    };
  });

export const roomTimingFromDiagnostics = (values: Readonly<Record<string, string>>): RoomTimingReport => {
  const sampleRate = Number(values.RuntimeOutputSampleRate || values.RequestedSampleRate || 0) || 0;
  const roundTripMs = Math.max(0, Number(values.NetworkRoundTripMs || 0) || 0);
  const milliseconds = (frames: number): number => sampleRate > 0 ? frames * 1000 / sampleRate : 0;
  const deviceLatencyMs = Math.max(0, milliseconds(Number(values.EstimatedLatencyFrames || 0) || 0));
  const remotes: Record<string, { jitterMs: number; targetDelayMs: number }> = {};
  for (const [name, raw] of Object.entries(values)) {
    if (!name.startsWith("RemoteJitterMs.")) continue;
    const id = name.slice("RemoteJitterMs.".length);
    const targetFrames = Number(values[`RemoteTargetDelayFrames.${id}`] || 0) || 0;
    remotes[id] = {
      jitterMs: Math.max(0, Number(raw) || 0),
      targetDelayMs: Math.max(0, milliseconds(targetFrames))
    };
  }
  return { roundTripMs, deviceLatencyMs, remotes,
    // Start scheduling compensates only physical capture/route latency. Adaptive playout queues
    // are not added here because doing so used to feed a dynamic backing-track stretcher.
    estimatedVoiceLatencyMs: roundTripMs / 2 + deviceLatencyMs };
};
