import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { hostname } from "node:os";

/**
 * Who this computer is to the room server, so friends, room history and the photo come back after
 * the app is removed and installed again. Windows keeps MachineGuid for the life of the Windows
 * installation; the app never stores it. Only a keyed hash of it leaves this computer, and each app
 * profile (the isolated guest of start-multy.bat) is a person of its own.
 */
const machineGuid = (): Promise<string> =>
  new Promise((resolve) => {
    execFile(
      "reg",
      [
        "query",
        String.raw`HKLM\SOFTWARE\Microsoft\Cryptography`,
        "/v",
        "MachineGuid",
        "/reg:64",
      ],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout) =>
        resolve(
          error
            ? ""
            : (/MachineGuid\s+REG_SZ\s+(\S+)/i.exec(stdout)?.[1] ?? ""),
        ),
    );
  });

let secret: Promise<string> | undefined;

export const deviceSecret = (): Promise<string> => {
  secret ??= machineGuid().then((guid) =>
    createHmac("sha256", guid || `host:${hostname()}`)
      .update(`ad-voice-account:${process.env.AD_VOICE_PROFILE ?? "default"}`)
      .digest("hex"),
  );
  return secret;
};

export const deviceHeader = "X-AD-Voice-Device";

/** Requests about friends and the profile say which computer asks; room requests need not. */
export const withDevice = async <
  T extends { path: string; headers?: Record<string, string> },
>(
  request: T,
): Promise<T> =>
  request.path.startsWith("/social/")
    ? {
        ...request,
        headers: { ...request.headers, [deviceHeader]: await deviceSecret() },
      }
    : request;
