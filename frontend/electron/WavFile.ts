import { open, type FileHandle } from "node:fs/promises";

export interface WavLayout {
  dataOffset: number;
  dataBytes: number;
  sampleRate: number;
  channels: number;
  bytesPerSample: number;
  frameBytes: number;
  isFloat: boolean;
}

const readAt = async (file: FileHandle, bytes: number, position: number): Promise<Buffer> => {
  const buffer = Buffer.alloc(bytes);
  let filled = 0;
  while (filled < bytes) {
    const { bytesRead } = await file.read(buffer, filled, bytes - filled, position + filled);
    if (!bytesRead) throw new Error("Truncated WAV header");
    filled += bytesRead;
  }
  return buffer;
};

/** Chunk sizes are offsets, never allocation sizes; metadata can precede audio. */
export const readWavLayout = async (file: FileHandle): Promise<WavLayout> => {
  const size = (await file.stat()).size;
  const header = await readAt(file, 12, 0);
  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("Not a WAV file");
  const end = Math.min(size, header.readUInt32LE(4) + 8);
  let format: Omit<WavLayout, "dataOffset" | "dataBytes"> | undefined;
  for (let offset = 12; offset + 8 <= end;) {
    const chunk = await readAt(file, 8, offset);
    const id = chunk.toString("ascii", 0, 4);
    const bytes = chunk.readUInt32LE(4);
    const dataOffset = offset + 8;
    if (id === "fmt ") {
      if (bytes < 16 || dataOffset + bytes > end) throw new Error("Invalid WAV format chunk");
      const data = await readAt(file, Math.min(bytes, 40), dataOffset);
      let encoding = data.readUInt16LE(0);
      const channels = data.readUInt16LE(2);
      const sampleRate = data.readUInt32LE(4);
      const frameBytes = data.readUInt16LE(12);
      const bits = data.readUInt16LE(14);
      if (encoding === 0xfffe) {
        if (bytes < 40 || data.readUInt16LE(16) < 22 || data.readUInt16LE(18) > bits
          || !data.subarray(28, 40).equals(Buffer.from("00001000800000aa00389b71", "hex")))
          throw new Error("Unsupported WAV encoding");
        encoding = data.readUInt32LE(24);
      }
      const widths: Record<number, readonly number[]> = { 1: [8, 16, 24, 32], 3: [32, 64] };
      if (!widths[encoding]?.includes(bits)) throw new Error("Unsupported WAV encoding");
      const bytesPerSample = bits / 8;
      if (!channels || !sampleRate || frameBytes !== channels * bytesPerSample
        || data.readUInt32LE(8) !== sampleRate * frameBytes) throw new Error("Invalid WAV format");
      format = { channels, sampleRate, bytesPerSample, frameBytes, isFloat: encoding === 3 };
    } else if (id === "data" && format) {
      const available = Math.min(bytes, end - dataOffset);
      return { ...format, dataOffset, dataBytes: available - available % format.frameBytes };
    }
    offset = dataOffset + bytes + bytes % 2;
  }
  throw new Error("WAV data chunk not found");
};

export const inspectWave = async (filePath: string): Promise<{ sampleRate: number; channels: number; durationSeconds: number }> => {
  const file = await open(filePath, "r");
  try {
    const layout = await readWavLayout(file);
    return { sampleRate: layout.sampleRate, channels: layout.channels,
      durationSeconds: layout.dataBytes / layout.frameBytes / layout.sampleRate };
  } finally { await file.close(); }
};
