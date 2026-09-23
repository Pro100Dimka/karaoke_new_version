import { app, net, protocol } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

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

/** Called once the app is ready; serves files from sceneDirectory() under the scene:// scheme. */
export const registerSceneProtocol = (projectRoot: string): void => {
  protocol.handle("scene", request => {
    const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
    if (!name || name.includes("/") || name.includes("\\") || name.includes(".."))
      return new Response(null, { status: 400 });
    return net.fetch(pathToFileURL(path.join(sceneDirectory(projectRoot), name)).toString(), {
      headers: request.headers,
    });
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
