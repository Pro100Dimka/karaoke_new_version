import * as net from "node:net";

export interface AudioRequest {
  command: string;
  args?: Readonly<Record<string, string | number | boolean | undefined>>;
}

export interface AudioResponse {
  status: number;
  text: string;
}

const defaultPipe = String.raw`\\.\pipe\ADVoice.AudioService.v1`;
const pipeEndpoint = (): string => process.env.AD_VOICE_AUDIO_ENDPOINT ?? defaultPipe;
const PROTOCOL_VERSION = 1;

const encode = ({ command, args = {} }: AudioRequest): string => {
  const fields = Object.entries(args)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  return [PROTOCOL_VERSION, command, ...fields].join("|") + "\n";
};

const decode = (buffer: string): AudioResponse => {
  const line = buffer.endsWith("\n") ? buffer.slice(0, -1) : buffer;
  const separator = line.indexOf("|");
  if (separator < 0) throw new Error("Malformed AudioService response");
  const status = Number(line.slice(0, separator));
  if (!Number.isInteger(status)) throw new Error("Malformed AudioService status");
  return { status, text: line.slice(separator + 1) };
};

const sendOnce = (request: AudioRequest, timeoutMs: number): Promise<AudioResponse> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeEndpoint());
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`AudioService request timed out: ${request.command}`));
    }, timeoutMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { resolve(decode(buffer)); }
      catch (error) { reject(error); }
    };

    socket.once("connect", () => socket.write(encode(request)));
    socket.on("data", (chunk: Buffer) => { buffer += chunk.toString("utf8"); });
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", (error: Error) => {
      if (settled) return;
      // The service answers and then closes the pipe; Windows may report that as EPIPE after the reply arrived.
      if (buffer.endsWith("\n")) return finish();
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });

// The service serves one request per pipe connection and re-creates the pipe between them, so a connection made
// in that gap fails with ENOENT/EBUSY. Requests are therefore strictly serialised and briefly retried.
const RETRYABLE_CODES = new Set(["ENOENT", "EBUSY"]);
const RETRY_ATTEMPTS = 20;
const RETRY_DELAY_MS = 25;

const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

const sendWithRetry = async (request: AudioRequest, timeoutMs: number): Promise<AudioResponse> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await sendOnce(request, timeoutMs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE_CODES.has(code) || attempt >= RETRY_ATTEMPTS) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
};

let queue: Promise<unknown> = Promise.resolve();

export const sendAudioRequest = (request: AudioRequest, timeoutMs = 3000): Promise<AudioResponse> => {
  const result = queue.then(() => sendWithRetry(request, timeoutMs));
  queue = result.catch(() => undefined);
  return result;
};
