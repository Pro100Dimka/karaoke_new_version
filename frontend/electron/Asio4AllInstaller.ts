import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Asio4AllRelease {
  version: string;
  url: string;
  fileName: string;
  sha256: string;
}

/** Pinned official release: a changed download is rejected until its checksum is reviewed. */
export const asio4AllRelease: Asio4AllRelease = {
  version: "2.22",
  url: "https://asio4all.org/downloads/ASIO4ALL_2_22.exe",
  fileName: "ASIO4ALL_2_22.exe",
  sha256: "0D4F0C63BF5DF077E4C74F18372F72B8E875A9ABEA499FEA78AAA9F56022AC7E",
};

const maximumInstallerBytes = 8 * 1024 * 1024;

export const launchAsio4AllInstaller = async (
  root: string,
  openPath: (path: string) => Promise<string>,
  release: Asio4AllRelease = asio4AllRelease,
  fetchInstaller: typeof fetch = fetch,
): Promise<void> => {
  const url = new URL(release.url);
  if (url.protocol !== "https:" || url.hostname !== "asio4all.org" || !url.pathname.startsWith("/downloads/"))
    throw new Error("ASIO4ALL download source is not trusted");
  const response = await fetchInstaller(url, { signal: AbortSignal.timeout(120_000), redirect: "error" });
  if (!response.ok) throw new Error(`ASIO4ALL download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximumInstallerBytes) throw new Error("ASIO4ALL installer is unexpectedly large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maximumInstallerBytes)
    throw new Error("ASIO4ALL installer has an invalid size");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum.toLowerCase() !== release.sha256.toLowerCase())
    throw new Error("ASIO4ALL installer checksum mismatch");

  await mkdir(root, { recursive: true });
  const target = join(root, release.fileName);
  const partial = `${target}.partial`;
  try {
    await writeFile(partial, bytes, { flag: "wx" }).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await rm(partial, { force: true });
      await writeFile(partial, bytes, { flag: "wx" });
    });
    await rm(target, { force: true });
    await rename(partial, target);
    const launchError = await openPath(target);
    if (launchError) throw new Error(`Could not launch ASIO4ALL installer: ${launchError}`);
  } finally {
    await rm(partial, { force: true });
  }
};
