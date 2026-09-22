import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const developerBackend = process.env.AD_VOICE_SMOKE_DEVELOPER_BACKEND ?? "http://127.0.0.1:8767";
const installedBackend = process.env.AD_VOICE_SMOKE_INSTALLED_BACKEND ?? "http://127.0.0.1:8765";
const roomServer = process.env.AD_VOICE_ROOM_SERVER_API ?? "http://130.61.169.61:8081";

const json = async (base, route, init = {}) => {
  const response = await fetch(`${base}${route}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers }
  });
  if (!response.ok) throw new Error(`${route} failed (${response.status}): ${await response.text()}`);
  return response.status === 204 ? null : response.json();
};

const waitForJob = async (base, jobId) => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const job = await json(base, `/jobs/${encodeURIComponent(jobId)}`);
    if (job.state === "Succeeded") return job.report ?? {};
    if (["Failed", "Cancelled", "Interrupted"].includes(job.state)) {
      throw new Error(`Job ${jobId} ${job.state}: ${JSON.stringify(job.error ?? {})}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Job ${jobId} timed out`);
};

const unique = crypto.randomUUID().slice(0, 8);
const hostId = `project-smoke-host-${unique}`;
const guestId = `project-smoke-guest-${unique}`;
const temporaryRoot = path.join(os.tmpdir(), `ad-voice-room-project-${unique}`);
let roomId;
let importedSongId;

try {
  const [developerSongs, installedSongs] = await Promise.all([
    json(developerBackend, "/songs?limit=200"),
    json(installedBackend, "/songs?limit=200")
  ]);
  const installedIds = new Set(installedSongs.items.map(song => song.songId));
  const song = developerSongs.items.find(candidate =>
    candidate.status === "Ready" && candidate.activeRevision > 0 && !installedIds.has(candidate.songId));
  if (!song) throw new Error("No ready developer-only song is available for transfer");

  const room = await json(roomServer, "/rooms", {
    method: "POST", body: JSON.stringify({ participantId: hostId, displayName: "Project Host" })
  });
  roomId = room.roomId;
  await json(roomServer, `/rooms/${roomId}/join`, {
    method: "POST", body: JSON.stringify({ participantId: guestId, displayName: "Project Guest" })
  });
  const published = await json(roomServer, `/rooms/${roomId}/library`, {
    method: "POST",
    body: JSON.stringify({
      participantId: hostId,
      songs: [{
        songId: song.songId,
        revision: song.activeRevision,
        title: song.title,
        artist: song.artist,
        album: song.album,
        genre: song.genre,
        durationSeconds: song.duration
      }]
    })
  });

  const exportJob = await json(developerBackend,
    `/packages/export/${encodeURIComponent(song.songId)}?revision=${song.activeRevision}`, { method: "POST" });
  const exported = await waitForJob(developerBackend, exportJob.jobId);
  if (typeof exported.path !== "string") throw new Error("Export did not return an archive path");

  const uploadResponse = await fetch(
    `${roomServer}/rooms/${roomId}/projects/${encodeURIComponent(song.songId)}/${song.activeRevision}`,
    {
      method: "PUT",
      headers: { "X-Participant-Id": hostId, "Content-Type": "application/zip" },
      body: await import("node:fs").then(({ createReadStream }) => createReadStream(exported.path)),
      duplex: "half"
    }
  );
  if (!uploadResponse.ok) throw new Error(`Project upload failed (${uploadResponse.status})`);

  await mkdir(temporaryRoot, { recursive: true });
  const downloadedPath = path.join(temporaryRoot, `${song.songId}-r${song.activeRevision}.advoice.zip`);
  const downloadResponse = await fetch(
    `${roomServer}/rooms/${roomId}/projects/${encodeURIComponent(song.songId)}/${song.activeRevision}`,
    { headers: { "X-Participant-Id": guestId } }
  );
  if (!downloadResponse.ok) throw new Error(`Project download failed (${downloadResponse.status})`);
  await import("node:stream/promises").then(({ pipeline }) =>
    Promise.all([import("node:stream"), import("node:fs")]).then(([{ Readable }, { createWriteStream }]) =>
      pipeline(Readable.fromWeb(downloadResponse.body), createWriteStream(downloadedPath))));

  const importJob = await json(installedBackend, "/packages/import", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ path: downloadedPath, decision: "SafeOnly" })
  });
  const imported = await waitForJob(installedBackend, importJob.jobId);
  importedSongId = imported.songId;
  const installedSong = await json(installedBackend, `/songs/${encodeURIComponent(importedSongId)}`);
  const [exportedFile, downloadedFile] = await Promise.all([stat(exported.path), stat(downloadedPath)]);
  if (exportedFile.size !== downloadedFile.size) throw new Error("Downloaded archive size differs from the export");
  if (installedSong.title !== song.title || installedSong.artist !== song.artist) {
    throw new Error("Imported song metadata differs from the shared song");
  }

  console.log(JSON.stringify({
    roomId,
    publishedSongs: published.sharedSongs.length,
    song: `${song.artist} — ${song.title}`,
    revision: song.activeRevision,
    archiveBytes: exportedFile.size,
    importedStatus: installedSong.status,
    album: installedSong.album,
    genre: installedSong.genre
  }));
} finally {
  if (importedSongId) {
    await json(installedBackend, `/songs/${encodeURIComponent(importedSongId)}`, { method: "DELETE" }).catch(() => undefined);
  }
  if (roomId) {
    await json(roomServer, `/rooms/${roomId}/leave`, {
      method: "POST", body: JSON.stringify({ participantId: hostId })
    }).catch(() => undefined);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
