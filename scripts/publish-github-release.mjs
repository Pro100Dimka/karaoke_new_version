// Publishes the installer built by release.bat as a GitHub Release, where the installed app's
// updater (frontend/electron/AutoUpdate.ts) finds it: tag v<frontend version>, asset AD-Voice-Setup.exe.
// GitHub records the asset's SHA-256, which the updater verifies before installing.
//
// Usage: set GITHUB_TOKEN (a token with "contents: write" on the repository), then
//   node scripts/publish-github-release.mjs [--draft] [--notes "What changed"]
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "Pro100Dimka/karaoke_new_version";
const installer = path.join(root, "release", "AD-Voice-Setup.exe");
const version = JSON.parse(readFileSync(path.join(root, "frontend", "package.json"), "utf8")).version;
const token = process.env.GITHUB_TOKEN;
const draft = process.argv.includes("--draft");
const notesIndex = process.argv.indexOf("--notes");
const notes = notesIndex > 0 ? process.argv[notesIndex + 1] ?? "" : "";

if (!token) {
  console.error("GITHUB_TOKEN is not set: create a token with contents: write for the repository.");
  process.exit(2);
}
let size;
try {
  size = statSync(installer).size;
} catch {
  console.error(`No installer at ${installer}: run release.bat first.`);
  process.exit(2);
}
// The full installer the small AD-Voice-Setup.exe downloads (scripts/web-installer.mjs).
const fullInstaller = path.join(root, "release", "AD-Voice-Setup-Full.exe");

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "AD-Voice-Release",
};
const tag = `v${version}`;
const existing = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, { headers });
if (existing.ok) {
  console.error(`Release ${tag} already exists. Raise "version" in frontend/package.json and rebuild.`);
  process.exit(1);
}
const created = await fetch(`https://api.github.com/repos/${repository}/releases`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  // Created as a draft and published once the installer is attached: nobody (and no updater) ever
  // sees a release without its installer while the upload is still running.
  body: JSON.stringify({ tag_name: tag, name: `A&D Voice ${version}`, body: notes, draft: true, prerelease: false }),
});
if (!created.ok) {
  console.error(`Creating ${tag} failed: HTTP ${created.status} ${await created.text()}`);
  process.exit(1);
}
const release = await created.json();
const uploadAsset = (file, name) =>
  fetch(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${name}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(statSync(file).size) },
    body: readFileSync(file),
  });
if (existsSync(fullInstaller)) {
  const full = await uploadAsset(fullInstaller, "AD-Voice-Setup-Full.exe");
  if (!full.ok) {
    console.error(`Uploading the full installer failed: HTTP ${full.status} ${await full.text()}`);
    process.exit(1);
  }
  const asset = await full.json();
  console.log(`Full installer ${asset.name}, ${asset.size} bytes, ${asset.digest ?? "digest pending"}`);
}
const upload = await fetch(
  `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=AD-Voice-Setup.exe`,
  {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(size) },
    body: readFileSync(installer),
  },
);
if (!upload.ok) {
  console.error(`Uploading the installer failed: HTTP ${upload.status} ${await upload.text()}`);
  process.exit(1);
}
const asset = await upload.json();
let published = release;
if (!draft) {
  const shown = await fetch(`https://api.github.com/repos/${repository}/releases/${release.id}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ draft: false }),
  });
  if (!shown.ok) {
    console.error(`Publishing ${tag} failed: HTTP ${shown.status} ${await shown.text()}`);
    process.exit(1);
  }
  published = await shown.json();
}
console.log(`Published ${tag}${draft ? " (draft)" : ""}: ${published.html_url}`);
console.log(`Installer ${asset.name}, ${asset.size} bytes, ${asset.digest ?? "digest pending"}`);
