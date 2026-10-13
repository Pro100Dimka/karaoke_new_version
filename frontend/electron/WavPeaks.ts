import { open } from "node:fs/promises";
import { readWavLayout, type WavLayout } from "./WavFile";

const readChunkBytes = 1 << 20;
const maxBins = 4096;

/**
 * The samples of a chunk as numbers (a typed view over the bytes, no copying; 24-bit is unpacked)
 * and the factor that brings them to -1..1. Little-endian, as WAV and the machines it runs on.
 */
const samplesOf = (
  bytes: Uint8Array,
  length: number,
  layout: WavLayout,
): { samples: ArrayLike<number>; scale: number; offset: number } => {
  const { buffer, byteOffset } = bytes;
  const count = Math.floor(length / layout.bytesPerSample);
  if (layout.isFloat)
    return layout.bytesPerSample === 8
      ? { samples: new Float64Array(buffer, byteOffset, count), scale: 1, offset: 0 }
      : { samples: new Float32Array(buffer, byteOffset, count), scale: 1, offset: 0 };
  if (layout.bytesPerSample === 1)
    return { samples: bytes.subarray(0, count), scale: 1 / 128, offset: 128 };
  if (layout.bytesPerSample === 2)
    return { samples: new Int16Array(buffer, byteOffset, count), scale: 1 / 0x8000, offset: 0 };
  if (layout.bytesPerSample === 4)
    return { samples: new Int32Array(buffer, byteOffset, count), scale: 1 / 0x80000000, offset: 0 };
  const samples = new Int32Array(count);
  for (let index = 0, at = 0; index < count; index += 1, at += 3)
    samples[index] = ((bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)) << 8) >> 8;
  return { samples, scale: 1 / 0x800000, offset: 0 };
};

/**
 * Peak level per bin (0..1, normalised to the loudest bin) of a WAV file, for drawing a seekable
 * waveform. Reads the file in 1 MiB chunks through typed views: a four-minute take takes a few
 * tens of milliseconds (PeaksService runs it off the main process's thread).
 */
export const waveformPeaks = async (
  filePath: string,
  bins: number,
): Promise<number[]> => {
  if (!Number.isFinite(bins)) throw new TypeError("bins must be finite");
  const count = Math.max(1, Math.min(maxBins, Math.floor(bins)));
  const file = await open(filePath, "r");
  try {
    const layout = await readWavLayout(file);
    const frameBytes = layout.frameBytes;
    const totalFrames = Math.floor(layout.dataBytes / frameBytes);
    if (totalFrames === 0) throw new Error("WAV has no audio");

    const peaks = new Array<number>(count).fill(0);
    // An own, aligned buffer: the typed views need their element size's alignment.
    const chunk = new Uint8Array(
      new ArrayBuffer(readChunkBytes - (readChunkBytes % frameBytes)),
    );
    const { channels } = layout;
    // Frame f belongs to bin floor(f * count / totalFrames): bin b ends before ceil((b + 1) * totalFrames / count).
    const binEnd = (bin: number) => Math.ceil(((bin + 1) * totalFrames) / count);
    let bin = 0;
    let nextBin = binEnd(0);
    let binPeak = 0;
    let scale = 1;
    let frame = 0;
    while (frame < totalFrames) {
      const wanted = Math.min(chunk.length, (totalFrames - frame) * frameBytes);
      const { bytesRead: read } = await file.read(
        chunk,
        0,
        wanted,
        layout.dataOffset + frame * frameBytes,
      );
      if (read < frameBytes) break;
      const view = samplesOf(chunk, read, layout);
      const { samples, offset } = view;
      scale = view.scale;
      const frames = Math.floor(read / frameBytes);
      for (let index = 0; index < frames; index += 1, frame += 1) {
        while (frame >= nextBin && bin < count - 1) {
          peaks[bin] = binPeak * scale;
          binPeak = 0;
          bin += 1;
          nextBin = binEnd(bin);
        }
        const first = index * channels;
        for (let channel = 0; channel < channels; channel += 1) {
          const value = samples[first + channel]! - offset;
          const level = value < 0 ? -value : value;
          // NaN and infinities in a float file never become the loudest.
          if (level > binPeak && level !== Infinity) binPeak = level;
        }
      }
    }
    peaks[bin] = binPeak * scale;
    const loudest = Math.max(...peaks, 1e-9);
    return peaks.map((level) => Number((level / loudest).toFixed(3)));
  } finally {
    await file.close();
  }
};
