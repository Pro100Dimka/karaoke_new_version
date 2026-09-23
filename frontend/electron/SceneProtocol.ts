import { app, protocol } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";

const sceneDirectory = (projectRoot: string): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "media", "scene")
    : path.join(projectRoot, "frontend", "media", "scene");

// The renderer's CSP has no `file:` in media-src (loosening that would let embedded content probe
// arbitrary paths on disk); this scheme only ever resolves inside sceneDirectory(), so the one
// legitimate local asset it serves stays reachable without widening that boundary. Must run before 'ready'.
protocol.registerSchemesAsPrivileged([
  { scheme: "scene", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const rangeHeaderPattern = /^bytes=(\d*)-(\d*)$/;

const streamResponse = (filePath: string, size: number, rangeHeader: string | null): Response => {
  const match = rangeHeader ? rangeHeaderPattern.exec(rangeHeader) : null;
  if (!match) {
    const body = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: { "content-type": "video/webm", "accept-ranges": "bytes", "content-length": String(size) }
    });
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1);
  const body = Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream;
  return new Response(body, {
    status: 206,
    headers: {
      "content-type": "video/webm",
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1)
    }
  });
};

/**
 * Called once the app is ready; serves files from sceneDirectory() under the scene:// scheme, with
 * byte-range support. A <video> element only treats a source as seekable once its server answers Range
 * requests with 206 responses -- net.fetch() on a file:// URL does not do this reliably, so the range is
 * parsed and streamed by hand instead.
 */
export const registerSceneProtocol = (projectRoot: string): void => {
  protocol.handle("scene", request => {
    const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
    if (!name || name.includes("/") || name.includes("\\") || name.includes(".."))
      return new Response(null, { status: 400 });
    const filePath = path.join(sceneDirectory(projectRoot), name);
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return new Response(null, { status: 404 });
    }
    return streamResponse(filePath, size, request.headers.get("range"));
  });
};

// Several short clips, not one long file too heavy to seek within; one picked at random for variety.
export const pickSceneClip = (projectRoot: string): string | null => {
  const directory = sceneDirectory(projectRoot);
  const clips = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith(".webm")) : [];
  const chosen = clips[Math.floor(Math.random() * clips.length)];
  if (!chosen) return null;
  return `scene://local/${encodeURIComponent(chosen)}`;
};
