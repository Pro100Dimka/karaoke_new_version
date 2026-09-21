import * as fs from "node:fs";

const readChunkBytes = 1 << 20;
const headerScanBytes = 4096;
const formatPcm = 1;
const formatFloat = 3;
const formatExtensible = 0xfffe;
const maxBins = 4096;

interface WavLayout {
  dataOffset: number;
  dataBytes: number;
  channels: number;
  bytesPerSample: number;
  isFloat: boolean;
}

const layoutOf = (header: Buffer, fileSize: number): WavLayout => {
  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  let format: { channels: number; bytesPerSample: number; isFloat: boolean } | null = null;
  let offset = 12;
  while (offset + 8 <= header.length) {
    const id = header.toString("ascii", offset, offset + 4);
    const size = header.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      const tag = header.readUInt16LE(offset + 8);
      const bits = header.readUInt16LE(offset + 22);
      const isFloat = tag === formatFloat || (tag === formatExtensible && header.readUInt16LE(offset + 32) === formatFloat);
      if (tag !== formatPcm && !isFloat && tag !== formatExtensible) throw new Error("Unsupported WAV encoding");
      format = { channels: header.readUInt16LE(offset + 10), bytesPerSample: bits / 8, isFloat };
    } else if (id === "data" && format) {
      // A streamed file may declare a size larger than what is on disk.
      const available = fileSize - (offset + 8);
      return { ...format, dataOffset: offset + 8, dataBytes: Math.min(size, available) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV data chunk not found");
};

const sampleAt = (buffer: Buffer, offset: number, layout: WavLayout): number => {
  if (layout.isFloat) return buffer.readFloatLE(offset);
  if (layout.bytesPerSample === 2) return buffer.readInt16LE(offset) / 0x8000;
  if (layout.bytesPerSample === 3) return buffer.readIntLE(offset, 3) / 0x800000;
  return buffer.readInt32LE(offset) / 0x80000000;
};

/** Peak level per bin (0..1, normalised to the loudest bin) of a WAV file, for drawing a seekable waveform. */
export const waveformPeaks = (filePath: string, bins: number): number[] => {
  const count = Math.max(1, Math.min(maxBins, Math.floor(bins)));
  const file = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(file).size;
    const header = Buffer.alloc(Math.min(headerScanBytes, size));
    fs.readSync(file, header, 0, header.length, 0);
    const layout = layoutOf(header, size);
    const frameBytes = layout.channels * layout.bytesPerSample;
    const totalFrames = Math.floor(layout.dataBytes / frameBytes);
    if (totalFrames === 0) throw new Error("WAV has no audio");

    const peaks = new Array<number>(count).fill(0);
    const chunk = Buffer.alloc(readChunkBytes - (readChunkBytes % frameBytes));
    let frame = 0;
    while (frame < totalFrames) {
      const wanted = Math.min(chunk.length, (totalFrames - frame) * frameBytes);
      const read = fs.readSync(file, chunk, 0, wanted, layout.dataOffset + frame * frameBytes);
      if (read < frameBytes) break;
      for (let position = 0; position + frameBytes <= read; position += frameBytes, frame += 1) {
        const bin = Math.min(count - 1, Math.floor((frame * count) / totalFrames));
        for (let channel = 0; channel < layout.channels; channel += 1) {
          const level = Math.abs(sampleAt(chunk, position + channel * layout.bytesPerSample, layout));
          if (level > (peaks[bin] ?? 0)) peaks[bin] = level;
        }
      }
    }
    const loudest = Math.max(...peaks, 1e-9);
    return peaks.map(level => Number((level / loudest).toFixed(3)));
  } finally {
    fs.closeSync(file);
  }
};
