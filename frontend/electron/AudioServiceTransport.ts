import * as net from 'node:net';
import { StringDecoder } from 'node:string_decoder';

export interface AudioRequest {
  command: string;
  args?: Readonly<Record<string, string | number | boolean | undefined>>;
}

interface AudioResponse {
  status: number;
  text: string;
}

export interface AudioNotification extends AudioResponse {
  observedAt: number;
}

const audioNotificationCommands = [
  'GetPlaybackSnapshot',
  'GetSpectrum',
  'GetInputLevel',
] as const;

/** Read-only stream; control commands retain their existing queue and deadlines. */
export const subscribeAudioNotifications = (
  command: string,
  intervalMs: number,
  listener: (notification: AudioNotification | null) => void,
): (() => void) => {
  if (
    !audioNotificationCommands.some((value) => value === command) ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 16 ||
    intervalMs > 1000
  )
    throw new TypeError('Invalid AudioService subscription');
  let stopped = false;
  let connection: net.Socket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let cancelWatchdog: (() => void) | undefined;
  const connect = () => {
    if (stopped) return;
    const socket = net.createConnection(pipeEndpoint() + '.events');
    connection = socket;
    let buffer = Buffer.alloc(0);
    let closed = false;
    let watchdog: ReturnType<typeof setTimeout>;
    const disconnect = () => {
      if (closed) return;
      closed = true;
      clearTimeout(watchdog);
      socket.destroy();
      if (!stopped) {
        listener(null);
        retry = setTimeout(connect, 250);
      }
    };
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(disconnect, 3000);
    };
    cancelWatchdog = () => clearTimeout(watchdog);
    armWatchdog();
    socket.once('connect', () =>
      socket.write(encode({ command, args: { intervalMs } })),
    );
    socket.on('data', (chunk: Buffer) => {
      if (closed || stopped) return;
      if (buffer.length + chunk.length > maxResponseBytes + 4)
        return disconnect();
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (length === 0 || length > maxResponseBytes) return disconnect();
        if (buffer.length < length + 4) break;
        const frame = buffer.subarray(4, length + 4).toString('utf8');
        buffer = buffer.subarray(length + 4);
        const separator = frame.indexOf('|');
        const observedAt = Number(frame.slice(0, separator));
        try {
          if (separator < 1 || !Number.isFinite(observedAt) || observedAt <= 0)
            return disconnect();
          const response = decode(frame.slice(separator + 1));
          armWatchdog();
          listener({ ...response, observedAt });
        } catch {
          return disconnect();
        }
      }
    });
    socket.once('end', disconnect);
    socket.once('close', disconnect);
    socket.once('error', disconnect);
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    cancelWatchdog?.();
    connection?.destroy();
  };
};

const defaultPipe = String.raw`\\.\pipe\ADVoice.AudioService.v1`;
const pipeEndpoint = (): string =>
  process.env.AD_VOICE_AUDIO_ENDPOINT ?? defaultPipe;
const PROTOCOL_VERSION = 1;
// Wire limit from AudioService's ControlProtocol.hpp; the newline is framing.
const maxRequestBytes = 4096;
const maxResponseBytes = 1 << 20;
const maxPendingRequests = 128;
const identifier = /^[A-Za-z][A-Za-z0-9]*$/;

const encode = ({ command, args = {} }: AudioRequest): string => {
  if (
    !identifier.test(command) ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args)
  ) {
    throw new TypeError('Invalid AudioService request');
  }
  const fields = Object.entries(args)
    .filter(
      (entry): entry is [string, string | number | boolean] =>
        entry[1] !== undefined,
    )
    .map(([key, value]) => {
      const valid = {
        string: () => !/[|\r\n\0]/.test(String(value)),
        number: () => Number.isFinite(value),
        boolean: () => true,
      };
      if (
        !identifier.test(key) ||
        !valid[typeof value as keyof typeof valid]?.()
      ) {
        throw new TypeError('Invalid AudioService argument');
      }
      return `${key}=${String(value)}`;
    });
  const line = [PROTOCOL_VERSION, command, ...fields].join('|');
  if (Buffer.byteLength(line, 'utf8') > maxRequestBytes)
    throw new Error('AudioService request is too large');
  return line + '\n';
};

const decode = (buffer: string): AudioResponse => {
  if (!buffer.endsWith('\n'))
    throw new Error('Malformed AudioService response');
  const line = buffer.slice(0, -1);
  const separator = line.indexOf('|');
  const statusText = line.slice(0, separator);
  const status = Number(statusText);
  if (
    separator < 1 ||
    !/^-?\d+$/.test(statusText) ||
    !Number.isSafeInteger(status)
  ) {
    throw new Error('Malformed AudioService status');
  }
  return { status, text: line.slice(separator + 1) };
};

const timeoutError = (command: string): Error =>
  new Error(`AudioService request timed out: ${command}`);
const sendOnce = (
  frame: string,
  command: string,
  timeoutMs: number,
): Promise<AudioResponse> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeEndpoint());
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let receivedBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    };
    const timeout = setTimeout(() => fail(timeoutError(command)), timeoutMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      buffer += decoder.end();
      socket.destroy();
      try {
        resolve(decode(buffer));
      } catch (error) {
        reject(error);
      }
    };

    socket.once('connect', () => socket.write(frame));
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      receivedBytes += chunk.length;
      if (receivedBytes > maxResponseBytes)
        return fail(new Error('AudioService response is too large'));
      buffer += decoder.write(chunk);
    });
    socket.once('end', finish);
    socket.once('close', finish);
    socket.once('error', (error: Error) => {
      if (settled) return;
      // The service answers and then closes the pipe; Windows may report that as EPIPE after the reply arrived.
      if (buffer.endsWith('\n')) return finish();
      fail(error);
    });
  });

// The service serves one request per pipe connection and re-creates the pipe between them, so a connection made
// in that gap fails with ENOENT/EBUSY. Requests are therefore strictly serialised and briefly retried.
const RETRYABLE_CODES = new Set(['ENOENT', 'EBUSY']);
const RETRY_ATTEMPTS = 20;
const RETRY_DELAY_MS = 25;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const sendWithRetry = async (
  frame: string,
  command: string,
  deadline: number,
): Promise<AudioResponse> => {
  for (let attempt = 1; ; attempt += 1) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw timeoutError(command);
    try {
      return await sendOnce(frame, command, remaining);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE_CODES.has(code) || attempt >= RETRY_ATTEMPTS) throw error;
      await sleep(
        Math.min(RETRY_DELAY_MS, Math.max(0, deadline - performance.now())),
      );
    }
  }
};

let queue: Promise<unknown> = Promise.resolve();
let pendingRequests = 0;

export const sendAudioRequest = async (
  request: AudioRequest,
  timeoutMs = 3000,
): Promise<AudioResponse> => {
  const frame = encode(request);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TypeError('Invalid AudioService timeout');
  if (pendingRequests >= maxPendingRequests)
    throw new Error('AudioService request queue is full');
  const deadline = performance.now() + timeoutMs;
  pendingRequests++;
  const result = queue
    .then(() => sendWithRetry(frame, request.command, deadline))
    .finally(() => {
      pendingRequests--;
    });
  queue = result.catch(() => undefined);
  return result;
};
