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
    const header = Buffer.allocUnsafe(4);
    let headerBytes = 0;
    let payload: Buffer | undefined;
    let payloadBytes = 0;
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
      let offset = 0;
      while (offset < chunk.length && !closed && !stopped) {
        if (!payload) {
          const count = Math.min(4 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + count);
          headerBytes += count;
          offset += count;
          if (headerBytes < 4) break;
          const length = header.readUInt32LE(0);
          if (length === 0 || length > maxResponseBytes) return disconnect();
          headerBytes = 0;
          // Retain one bounded frame and copy each fragment once, even across tiny pipe reads.
          payload = Buffer.allocUnsafe(length);
          payloadBytes = 0;
        }
        const count = Math.min(
          payload.length - payloadBytes,
          chunk.length - offset,
        );
        chunk.copy(payload, payloadBytes, offset, offset + count);
        payloadBytes += count;
        offset += count;
        if (payloadBytes < payload.length) break;
        const frame = payload.toString('utf8');
        payload = undefined;
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
let tail:
  | {
      key: string | undefined;
      frame: string;
      deadline: number;
      result: Promise<AudioResponse>;
    }
  | undefined;

// A dragged knob may produce values faster than the pipe can apply them. Only adjacent,
// not-yet-started updates to the same continuous control can supersede each other.
// Any read or lifecycle command is an ordering barrier (including Play and Stop).
const continuousControlKey = ({
  command,
  args,
}: AudioRequest): string | undefined => {
  const field =
    command === 'SetGain'
      ? 'target'
      : command === 'SetDspParameter'
        ? 'name'
        : undefined;
  if (
    !args ||
    typeof args.value !== 'number' ||
    (field ? typeof args[field] !== 'string' : command !== 'SetRadioGain') ||
    Object.keys(args).some((key) => key !== 'value' && key !== field)
  )
    return undefined;
  return `${command}:${field ? args[field] : ''}`;
};

export const sendAudioRequest = async (
  request: AudioRequest,
  timeoutMs = 3000,
): Promise<AudioResponse> => {
  const frame = encode(request);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TypeError('Invalid AudioService timeout');
  const deadline = performance.now() + timeoutMs;
  const key = continuousControlKey(request);
  if (key && tail?.key === key && tail.deadline > performance.now()) {
    tail.frame = frame;
    // A newer slider event must never extend an already accepted request's deadline.
    tail.deadline = Math.min(tail.deadline, deadline);
    return tail.result;
  }
  if (pendingRequests >= maxPendingRequests)
    throw new Error('AudioService request queue is full');
  pendingRequests++;
  const pending = {
    key,
    frame,
    deadline,
    result: undefined as unknown as Promise<AudioResponse>,
  };
  const result = queue
    .then(() => {
      if (tail === pending) tail = undefined;
      return sendWithRetry(pending.frame, request.command, pending.deadline);
    })
    .finally(() => {
      pendingRequests--;
    });
  pending.result = result;
  tail = pending;
  queue = result.catch(() => undefined);
  return result;
};
