import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { hostname } from 'node:os';
import { pythonExecutable, pythonRoot } from './AppPaths';
import { roomServerApiBase } from './RoomServerTransport';

/**
 * Legacy identity is used only to migrate the existing account to a random Windows credential.
 */
const machineGuid = (): Promise<string> =>
  new Promise((resolve) => {
    execFile(
      'reg',
      [
        'query',
        String.raw`HKLM\SOFTWARE\Microsoft\Cryptography`,
        '/v',
        'MachineGuid',
        '/reg:64',
      ],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout) =>
        resolve(
          error
            ? ''
            : (/MachineGuid\s+REG_SZ\s+(\S+)/i.exec(stdout)?.[1] ?? ''),
        ),
    );
  });

let secret: Promise<string> | undefined;

export const deviceSecret = (): Promise<string> => {
  secret ??= machineGuid()
    .then((guid) => {
      const legacySecret = createHmac('sha256', guid || `host:${hostname()}`)
        .update(`ad-voice-account:${process.env.AD_VOICE_PROFILE ?? 'default'}`)
        .digest('hex');
      return new Promise<string>((resolve, reject) => {
        const child = execFile(
          pythonExecutable(),
          ['-B', '-X', 'utf8', '-m', 'backend.infrastructure.account_identity'],
          {
            cwd: pythonRoot(),
            windowsHide: true,
            timeout: 60_000,
            maxBuffer: 8192,
          },
          (error, stdout) => {
            const value = stdout.trim();
            // Never attach child output to an error: it may contain the credential.
            if (error || !/^[a-f0-9]{64}$/.test(value))
              reject(
                new Error(
                  'Windows account identity is unavailable; retry when connected',
                ),
              );
            else resolve(value);
          },
        );
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(
          JSON.stringify({
            profile: process.env.AD_VOICE_PROFILE ?? 'default',
            server: roomServerApiBase,
            legacySecret,
          }),
        );
      });
    })
    .catch((error: unknown) => {
      secret = undefined;
      throw error;
    });
  return secret;
};

const deviceHeader = 'X-AD-Voice-Device';

/** Requests about friends and the profile say which computer asks; room requests need not. */
export const withDevice = async <
  T extends { path: string; headers?: Record<string, string> },
>(
  request: T,
): Promise<T> =>
  request.path.startsWith('/social/')
    ? {
        ...request,
        headers: { ...request.headers, [deviceHeader]: await deviceSecret() },
      }
    : request;
