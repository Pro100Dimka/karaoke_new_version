// Prints how many threads this machine can give release.bat: "<copyThreads> <compressThreads>".
// Usage: node scripts/machine-threads.mjs <lzmaDictionaryKb>
// Copying runs one thread per logical processor (robocopy accepts at most 128). Compression takes
// only as many processors as its memory allows: each LZMA2 block thread of Inno Setup's islzma
// holds its match finder and block buffers, measured at about 15.4 bytes per dictionary byte
// (16 threads with a 64 MB dictionary used 15.4 GB). Only half of the free memory goes to it, so
// the computer stays usable while the release builds.
import os from "node:os";

const RobocopyMaximumThreads = 128;
const LzmaBytesPerDictionaryByte = 15.4;
const CompressionShareOfFreeMemory = 0.5;

const dictionaryKb = Number(process.argv[2]);
if (!Number.isFinite(dictionaryKb) || dictionaryKb <= 0) {
  console.error("Usage: node scripts/machine-threads.mjs <lzmaDictionaryKb>");
  process.exit(2);
}
const processors = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
const bytesPerCompressThread = dictionaryKb * 1024 * LzmaBytesPerDictionaryByte;
const compressionBudget = os.freemem() * CompressionShareOfFreeMemory;
const copyThreads = Math.min(RobocopyMaximumThreads, processors);
const compressThreads = Math.max(1, Math.min(processors, Math.floor(compressionBudget / bytesPerCompressThread)));
console.log(`${copyThreads} ${compressThreads}`);
