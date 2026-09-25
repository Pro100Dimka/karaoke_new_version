import { open } from "node:fs/promises";
import { readWavLayout, type WavLayout } from "./WavFile";

const readChunkBytes = 1 << 20;
const maxBins = 4096;

const sampleAt = (buffer: Buffer, offset: number, layout: WavLayout): number => {
  if (layout.isFloat) return layout.bytesPerSample === 8 ? buffer.readDoubleLE(offset) : buffer.readFloatLE(offset);
  if (layout.bytesPerSample === 1) return (buffer.readUInt8(offset) - 128) / 128;
  if (layout.bytesPerSample === 2) return buffer.readInt16LE(offset) / 0x8000;
  if (layout.bytesPerSample === 3) return buffer.readIntLE(offset, 3) / 0x800000;
  return buffer.readInt32LE(offset) / 0x80000000;
};

/** Peak level per bin (0..1, normalised to the loudest bin) of a WAV file, for drawing a seekable waveform. */
export const waveformPeaks = async (filePath: string, bins: number): Promise<number[]> => {
  if (!Number.isFinite(bins)) throw new TypeError("bins must be finite");
  const count = Math.max(1, Math.min(maxBins, Math.floor(bins)));
  const file = await open(filePath, "r");
  try {
    const layout = await readWavLayout(file);
    const frameBytes = layout.frameBytes;
    const totalFrames = Math.floor(layout.dataBytes / frameBytes);
    if (totalFrames === 0) throw new Error("WAV has no audio");

    const peaks = new Array<number>(count).fill(0);
    const chunk = Buffer.alloc(readChunkBytes - (readChunkBytes % frameBytes));
    let frame = 0;
    while (frame < totalFrames) {
      const wanted = Math.min(chunk.length, (totalFrames - frame) * frameBytes);
      const { bytesRead: read } = await file.read(chunk, 0, wanted, layout.dataOffset + frame * frameBytes);
      if (read < frameBytes) break;
      for (let position = 0; position + frameBytes <= read; position += frameBytes, frame += 1) {
        const bin = Math.min(count - 1, Math.floor((frame * count) / totalFrames));
        for (let channel = 0; channel < layout.channels; channel += 1) {
          const level = Math.abs(sampleAt(chunk, position + channel * layout.bytesPerSample, layout));
          if (Number.isFinite(level) && level > (peaks[bin] ?? 0)) peaks[bin] = level;
        }
      }
    }
    const loudest = Math.max(...peaks, 1e-9);
    return peaks.map(level => Number((level / loudest).toFixed(3)));
  } finally {
    await file.close();
  }
};
