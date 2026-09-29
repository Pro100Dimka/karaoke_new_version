// Prints how many threads this machine can give release.bat: "<copyThreads> <compressThreads>".
// Usage: node scripts/machine-threads.mjs <lzmaDictionaryKb>
// Copying runs one thread per logical processor (robocopy accepts at most 128). Every LZMA2
// compression thread keeps its own match finder, about 11.5 bytes per dictionary byte, so
// compression takes only as many processors as the currently free memory can feed.
import os from "node:os";

const RobocopyMaximumThreads = 128;
const LzmaBytesPerDictionaryByte = 11.5;

const dictionaryKb = Number(process.argv[2]);
if (!Number.isFinite(dictionaryKb) || dictionaryKb <= 0) {
  console.error("Usage: node scripts/machine-threads.mjs <lzmaDictionaryKb>");
  process.exit(2);
}
const processors = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
const bytesPerCompressThread = dictionaryKb * 1024 * LzmaBytesPerDictionaryByte;
const copyThreads = Math.min(RobocopyMaximumThreads, processors);
const compressThreads = Math.max(1, Math.min(processors, Math.floor(os.freemem() / bytesPerCompressThread)));
console.log(`${copyThreads} ${compressThreads}`);
