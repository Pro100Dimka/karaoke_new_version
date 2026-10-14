// Builds the small AD-Voice-Setup.exe of a release (installer/ad-voice-web.iss) around the full
// installer release.bat made: it downloads AD-Voice-Setup-Full.exe of the same GitHub release,
// checked against the SHA-256 computed here.
//
// Usage: node scripts/web-installer.mjs <ISCC.exe> <release dir> <icon.ico>
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [iscc, releaseDir, icon] = process.argv.slice(2);
if (!iscc || !releaseDir) {
  console.error("Usage: node scripts/web-installer.mjs <ISCC.exe> <release dir> <icon.ico>");
  process.exit(2);
}
const repository = "Pro100Dimka/karaoke_new_version";
const version = JSON.parse(readFileSync(path.join(root, "frontend", "package.json"), "utf8")).version;
const full = path.join(releaseDir, "AD-Voice-Setup-Full.exe");
if (!existsSync(full)) {
  console.error(`No full installer at ${full}`);
  process.exit(1);
}
const sha256 = await new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(full)
    .on("data", (chunk) => hash.update(chunk))
    .on("end", () => resolve(hash.digest("hex")))
    .on("error", reject);
});
// AD_VOICE_FULL_INSTALLER_URL points a test build at another server.
const fullUrl =
  process.env.AD_VOICE_FULL_INSTALLER_URL ??
  `https://github.com/${repository}/releases/download/v${version}/AD-Voice-Setup-Full.exe`;
execFileSync(
  iscc,
  [
    "/Q",
    `/DAppVersion=${version}`,
    `/DFullUrl=${fullUrl}`,
    `/DFullSha256=${sha256}`,
    `/DOutputDir=${releaseDir}`,
    ...(icon && existsSync(icon) ? [`/DAppIcon=${icon}`] : []),
    path.join(root, "installer", "ad-voice-web.iss"),
  ],
  { stdio: "inherit" },
);
console.log(`Web installer for ${version}: downloads ${fullUrl} (sha256 ${sha256})`);
