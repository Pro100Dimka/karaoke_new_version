import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waveformPeaks } from "./WavPeaks";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const wave = async (bits: number, tag: number, pcm: Buffer, junkBytes = 0, subtype = 1) => {
  const root = await mkdtemp(join(tmpdir(), "wave-layout-test-"));
  roots.push(root);
  const chunk = (id: string, data: Buffer) => {
    const result = Buffer.alloc(8 + data.length + data.length % 2);
    result.write(id); result.writeUInt32LE(data.length, 4); data.copy(result, 8);
    return result;
  };
  const format = Buffer.alloc(tag === 0xfffe ? 40 : 16);
  format.writeUInt16LE(tag, 0); format.writeUInt16LE(1, 2); format.writeUInt32LE(8000, 4);
  format.writeUInt32LE(8000 * bits / 8, 8); format.writeUInt16LE(bits / 8, 12); format.writeUInt16LE(bits, 14);
  if (tag === 0xfffe) {
    format.writeUInt16LE(22, 16); format.writeUInt16LE(bits, 18);
    Buffer.from("0000000000001000800000aa00389b71", "hex").copy(format, 24);
    format.writeUInt32LE(subtype, 24);
  }
  const body = Buffer.concat([Buffer.from("WAVE"), chunk("fmt ", format), chunk("JUNK", Buffer.alloc(junkBytes)), chunk("data", pcm)]);
  const header = Buffer.alloc(8); header.write("RIFF"); header.writeUInt32LE(body.length, 4);
  const file = join(root, "audio.wav");
  await writeFile(file, Buffer.concat([header, body]));
  return file;
};

it("decodes unsigned 8-bit PCM peaks", async () => {
  expect(await waveformPeaks(await wave(8, 1, Buffer.from([0, 128, 255])), 3)).toEqual([1, 0, 0.992]);
});
it("decodes 64-bit IEEE float peaks", async () => {
  const pcm = Buffer.alloc(24); pcm.writeDoubleLE(0.5, 8); pcm.writeDoubleLE(1, 16);
  expect(await waveformPeaks(await wave(64, 3, pcm), 3)).toEqual([0, 0.5, 1]);
});
it("locates PCM beyond a large metadata chunk without loading that chunk", async () => {
  const pcm = Buffer.alloc(4); pcm.writeInt16LE(16384, 0); pcm.writeInt16LE(32767, 2);
  expect(await waveformPeaks(await wave(16, 1, pcm, 65536), 2)).toEqual([0.5, 1]);
});
it("rejects unknown extensible subformats instead of interpreting them as PCM", async () => {
  const file = await wave(32, 0xfffe, Buffer.alloc(8), 0, 7);
  await expect(async () => waveformPeaks(file, 2)).rejects.toThrow("encoding");
});
