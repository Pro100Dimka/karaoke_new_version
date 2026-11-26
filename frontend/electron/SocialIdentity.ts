import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { hostname } from 'node:os';
import { pythonExecutable, pythonRoot } from './AppPaths';
import { roomServerApiBase } from './RoomServerTransport';
import { requireSecureRoomUrl } from './RoomIdentity';
import {
  transferConsents,
  transferConsentVersion,
  type TransferPurpose,
} from './PrivacySettings';

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

interface AccountIdentity {
  secret: string;
  enabled: boolean;
}
let identity: Promise<AccountIdentity> | undefined;

const readIdentity = (action = 'read'): Promise<AccountIdentity> =>
  machineGuid()
    .then((guid) => {
      const legacySecret = createHmac('sha256', guid || `host:${hostname()}`)
        .update(`ad-voice-account:${process.env.AD_VOICE_PROFILE ?? 'default'}`)
        .digest('hex');
      return new Promise<AccountIdentity>((resolve, reject) => {
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
            let value: Partial<AccountIdentity> = {};
            try {
              value = JSON.parse(stdout);
            } catch {
              /* Handled as an unavailable identity. */
            }
            // Never attach child output to an error: it may contain the credential.
            if (
              error ||
              !value ||
              typeof value.secret !== 'string' ||
              !/^[a-f0-9]{64}$/.test(value.secret) ||
              typeof value.enabled !== 'boolean'
            )
              reject(
                new Error(
                  'Windows account identity is unavailable; retry when connected',
                ),
              );
            else resolve({ secret: value.secret, enabled: value.enabled });
          },
        );
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(
          JSON.stringify({
            profile: process.env.AD_VOICE_PROFILE ?? 'default',
            server: roomServerApiBase,
            legacySecret,
            action,
            consents: Object.entries(transferConsents())
              .filter(([, choice]) => choice.enabled && !choice.pending)
              .map(([purpose]) => purpose),
            consentVersion: transferConsentVersion,
          }),
        );
      });
    })
    .catch((error: unknown) => {
      identity = undefined;
      throw error;
    });

export const deviceSecret = async (): Promise<string> =>
  (
    await (transferConsents().online.enabled
      ? (identity ??= readIdentity())
      : readIdentity('local'))
  ).secret;
export const onlineAccountEnabled = async (): Promise<boolean> =>
  transferConsents().online.enabled &&
  !transferConsents().online.pending &&
  (await (identity ??= readIdentity())).enabled;
export const accountIdentityEnabled = async (): Promise<boolean> =>
  (await readIdentity('local')).enabled;

export const recordTransferConsent = async (
  purpose: TransferPurpose,
  enabled: boolean,
): Promise<void> => {
  requireSecureRoomUrl(roomServerApiBase);
  const secret = (await readIdentity('local')).secret;
  const response = await fetch(
    `${roomServerApiBase}/social/privacy/${purpose}`,
    {
      method: 'PUT',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        'X-AD-Voice-Device': secret,
      },
      body: JSON.stringify({ enabled, version: transferConsentVersion }),
    },
  );
  if (!response.ok)
    throw new Error('Transfer consent could not be synchronized');
};
export const setOnlineAccountEnabled = async (
  enabled: boolean,
): Promise<void> => {
  identity = readIdentity(enabled ? 'create' : 'disable');
  await identity;
};

const deviceHeader = 'X-AD-Voice-Device';

/** Requests about friends and the profile say which computer asks; room requests need not. */
export const withDevice = async <
  T extends { path: string; method?: string; headers?: Record<string, string> },
>(
  request: T,
): Promise<T> => {
  const erasure = request.path === '/social/me' && request.method === 'DELETE';
  if (
    request.path.startsWith('/social/') &&
    !erasure &&
    !(await onlineAccountEnabled())
  )
    throw new Error('Online account is disabled');
  return request.path.startsWith('/social/')
    ? {
        ...request,
        headers: { ...request.headers, [deviceHeader]: await deviceSecret() },
      }
    : request;
};
