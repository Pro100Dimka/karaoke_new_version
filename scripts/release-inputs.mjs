// Prints one fingerprint of everything release.bat packs into the installer, so an unchanged
// release skips copying and compressing (minutes) and keeps the installer it already built.
// Built and project files are hashed by content (builds rewrite them with new timestamps); the large
// third-party trees (Python runtime, packages, Electron, FFmpeg) only change by being reinstalled,
// so their file names, sizes and modification times are enough.
//
// Usage: node scripts/release-inputs.mjs <releaseEnvFile> <pythonBase> <ffmpeg> <ffprobe>
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [releaseEnv, pythonBase, ffmpeg, ffprobe] = process.argv.slice(2);
if (!ffprobe) {
  console.error("Usage: node scripts/release-inputs.mjs <releaseEnvFile> <pythonBase> <ffmpeg> <ffprobe>");
  process.exit(2);
}
const at = (...parts) => path.join(root, ...parts);
const skipped = new Set(["__pycache__"]);

const files = (target) => {
  if (!existsSync(target)) return [];
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { withFileTypes: true })
    .filter((entry) => !skipped.has(entry.name))
    .flatMap((entry) => files(path.join(target, entry.name)))
    .sort();
};

const hash = createHash("sha256");
const byContent = (target) => {
  for (const file of files(target)) hash.update(`${path.relative(root, file)}\0`).update(readFileSync(file));
};
const byMetadata = (target) => {
  for (const file of files(target)) {
    const { size, mtimeMs } = statSync(file);
    hash.update(`${file}\0${size}\0${mtimeMs}\0`);
  }
};

[
  at("frontend", "dist"),
  at("frontend", "dist-electron"),
  at("frontend", "package.json"),
  at("frontend", "electron", "splash.html"),
  at("frontend", "scripts", "stamp-exe-icon.mjs"),
  at("frontend", "src", "assets", "theme-icons"),
  at("AudioService", "build-release", "Release", "AudioService.exe"),
  at("python", "backend"),
  at("python", ".env.example"),
  releaseEnv,
  at("kaggle"),
  at("installer"),
  at("release.bat"),
].forEach(byContent);
[
  pythonBase,
  at("python", ".venv", "Lib", "site-packages"),
  at("frontend", "node_modules", "electron", "dist"),
  at("frontend", "media"),
  ffmpeg,
  ffprobe,
].forEach(byMetadata);
console.log(hash.digest("hex"));
