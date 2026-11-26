// Publishes the installer built by release.bat as a GitHub Release, where the installed app's
// updater (frontend/electron/AutoUpdate.ts) finds it: tag v<frontend version>, asset AD-Voice-Setup.exe.
// GitHub records the asset's SHA-256, which the updater verifies before installing.
//
// Usage: set GITHUB_TOKEN (a token with "contents: write" on the repository), then
//   node scripts/publish-github-release.mjs [--draft] [--target <commit SHA>]
//     [--notes "What changed" | --notes-file <UTF-8 file>]
import { openAsBlob, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseArtifacts } from "./ffmpeg-distribution.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "Pro100Dimka/karaoke_new_version";
const version = JSON.parse(readFileSync(path.join(root, "frontend", "package.json"), "utf8")).version;
const token = process.env.GITHUB_TOKEN;
const draft = process.argv.includes("--draft");
const notesIndex = process.argv.indexOf("--notes");
const notesFileIndex = process.argv.indexOf("--notes-file");
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex > 0 ? process.argv[targetIndex + 1] : undefined;
if (targetIndex > 0 && !/^[a-f0-9]{40}$/i.test(target ?? "")) {
  console.error("--target requires a full 40-character commit SHA.");
  process.exit(2);
}
let notes = notesIndex > 0 ? process.argv[notesIndex + 1] ?? "" : "";
if (notesFileIndex > 0) {
  const file = process.argv[notesFileIndex + 1];
  try {
    if (!file || file.startsWith("--")) throw new Error("a file path is required");
    notes = readFileSync(file, "utf8");
  } catch (error) {
    console.error(`Cannot read --notes-file: ${error.message}`);
    process.exit(2);
  }
}

if (!token) {
  console.error("GITHUB_TOKEN is not set: create a token with contents: write for the repository.");
  process.exit(2);
}
let artifacts;
try {
  artifacts = await releaseArtifacts(root);
} catch (error) {
  console.error(`Release files are incomplete or changed: ${error.message}. Run release.bat first.`);
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "AD-Voice-Release",
};
const tag = `v${version}`;
const sourceArchive = artifacts[1];
const sourceUrl = `https://github.com/${repository}/releases/download/${tag}/${sourceArchive.name}`;
const releaseNotes = [
  notes,
  `FFmpeg and FFprobe are separate programs distributed under the GNU GPL version 3 or later. [Complete corresponding source, dependencies and build instructions](${sourceUrl}). [License information](https://ffmpeg.org/legal.html).`,
].filter(Boolean).join("\n\n");
const existing = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
  headers,
  signal: AbortSignal.timeout(10_000),
});
if (existing.ok) {
  console.error(`Release ${tag} already exists. Raise "version" in frontend/package.json and rebuild.`);
  process.exit(1);
}
if (existing.status !== 404) {
  console.error(`Checking release ${tag} failed: HTTP ${existing.status}. No release was created.`);
  process.exit(1);
}
if (target) {
  const pinFailed = (message) => {
    console.error(`Cannot pin ${tag} to ${target}: ${message}. No release was created.`);
    process.exit(1);
  };
  const referenceUrl = `https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`;
  let reference = await fetch(referenceUrl, { headers, signal: AbortSignal.timeout(10_000) });
  if (reference.status === 404) {
    const pinned = await fetch(`https://api.github.com/repos/${repository}/git/refs`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: target }),
      signal: AbortSignal.timeout(10_000),
    });
    if (pinned.ok) reference = null;
    else if (pinned.status === 409 || pinned.status === 422)
      reference = await fetch(referenceUrl, { headers, signal: AbortSignal.timeout(10_000) });
    else pinFailed(`creating the tag returned HTTP ${pinned.status}`);
  }
  if (reference) {
    if (!reference.ok) pinFailed(`reading the tag returned HTTP ${reference.status}`);
    // Resolve annotated tags to their commit instead of comparing their tag-object SHA.
    const resolved = await fetch(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(tag)}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resolved.ok) pinFailed(`resolving the tag returned HTTP ${resolved.status}`);
    const commit = await resolved.json();
    if (typeof commit.sha !== "string" || commit.sha.toLowerCase() !== target.toLowerCase())
      pinFailed("the existing tag points to a different commit");
  }
}
const created = await fetch(`https://api.github.com/repos/${repository}/releases`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  // Keep the release hidden until the installer and its complete corresponding source are verified.
  body: JSON.stringify({ tag_name: tag, ...(target ? { target_commitish: target } : {}), name: `A&D Voice ${version}`, body: releaseNotes, draft: true, prerelease: false }),
});
if (!created.ok) {
  console.error(`Creating ${tag} failed: HTTP ${created.status} ${await created.text()}`);
  process.exit(1);
}
const release = await created.json();
const uploadedAssets = [];
for (const artifact of artifacts) {
  const size = statSync(artifact.path).size;
  const digest = `sha256:${artifact.sha256}`;
  const upload = await fetch(
    `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(artifact.name)}`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(size) },
      body: await openAsBlob(artifact.path),
    },
  );
  if (!upload.ok) {
    console.error(`Uploading ${artifact.name} failed: HTTP ${upload.status} ${await upload.text()}. Release ${tag} remains a draft.`);
    process.exit(1);
  }
  let asset = await upload.json();
  const assetId = asset.id;
  const verificationFailed = (message) => {
    console.error(`${artifact.name} verification failed: ${message}. Release ${tag} remains a draft.`);
    process.exit(1);
  };
  for (let attempt = 0; ; attempt += 1) {
    if (asset.name !== artifact.name || asset.size !== size || asset.state !== "uploaded")
      verificationFailed("the uploaded asset name, size or state does not match the local file");
    if (asset.digest != null) {
      if (typeof asset.digest !== "string" || asset.digest.toLowerCase() !== digest)
        verificationFailed("GitHub's SHA-256 does not match the local file");
      break;
    }
    if (attempt === 5) verificationFailed("GitHub's SHA-256 is still unavailable after five checks");
    if (!Number.isSafeInteger(assetId) || assetId <= 0)
      verificationFailed("GitHub did not return an asset ID for digest verification");
    // GitHub can finish digest metadata after the upload response. Keep the release hidden until
    // the original uploaded asset is verified; never publish merely because the wait has ended.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    try {
      const checked = await fetch(`https://api.github.com/repos/${repository}/releases/assets/${assetId}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!checked.ok) verificationFailed(`reading the uploaded asset returned HTTP ${checked.status}`);
      asset = await checked.json();
      if (asset.id !== assetId) verificationFailed("GitHub returned a different asset during verification");
    } catch (error) {
      verificationFailed(`cannot read the uploaded asset: ${error.message}`);
    }
  }
  uploadedAssets.push(asset);
}
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
for (const asset of uploadedAssets)
  console.log(`${asset.name}, ${asset.size} bytes, ${asset.digest}`);
