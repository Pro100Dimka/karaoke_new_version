import { StringDecoder } from "node:string_decoder";
import { format } from "node:util";
import { roomParticipantId } from "./RoomIdentity";
import { roomServerRequest } from "./RoomServerTransport";

export interface AppLogEntry {
  timestamp: string;
  source: string;
  level: string;
  message: string;
}

const uploadMilliseconds = 2_000;
const maximumQueued = 1_000;
const maximumBatch = 100;
const maximumMessage = 4_096;
const maximumUploadBytes = 480 * 1024;
const uploadEnvelopeBytes = Buffer.byteLength(JSON.stringify({ clientId: "0".repeat(32), entries: [] }));

const redact = (message: string): string =>
  message
    .replace(/([A-Z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))[^\\/\s]+/gi, "$1<user>")
    .replace(/(\/(?:home|Users)\/)[^/\s]+/g, "$1<user>")
    .replace(/(X-AD-Voice-Room-Key\s*[:=]\s*)[^\s,;}]+/gi, "$1<redacted>")
    .replace(/((?:"?(?:voiceToken|api[_-]?key|authorization)"?)\s*[=:]\s*["']?(?:Bearer\s+)?)[^"'\s,;}]+/gi, "$1<redacted>")
    .replace(/([?&](?:token|key|secret|authorization|auth|access_token)=)[^&\s]+/gi, "$1<redacted>");

export const sendAppLogs = async (entries: AppLogEntry[]): Promise<void> => {
  const response = await roomServerRequest({
    method: "POST",
    path: "/app-logs",
    body: { clientId: await roomParticipantId(), entries },
  });
  if (!response.ok) throw new Error(`App log upload failed (${response.status})`);
};

/** Bounded, best-effort upload of text logs from this application profile. */
export class AppLogUploader {
  private readonly queue: AppLogEntry[] = [];
  private readonly lines = new Map<string, { decoder: StringDecoder; pending: string }>();
  private timer: NodeJS.Timeout | undefined;
  private uploading = false;
  private inFlightCount = 0;
  private inFlight: Promise<void> | undefined;
  private dropped = 0;

  constructor(private readonly send: (entries: AppLogEntry[]) => Promise<unknown>) {}

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), uploadMilliseconds);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
    if (this.queue.length) await this.flush();
  }

  captureConsole(target: Partial<Record<"log" | "info" | "warn" | "error" | "debug", (...args: unknown[]) => void>>): void {
    const levels = { log: "info", info: "info", warn: "warning", error: "error", debug: "debug" } as const;
    for (const [method, level] of Object.entries(levels) as [keyof typeof levels, string][]) {
      const original = target[method];
      if (!original) continue;
      target[method] = (...args: unknown[]) => {
        this.add("electron", level, format(...args));
        original.apply(target, args);
      };
    }
  }

  add(source: string, level: string, message: string): void {
    if (!message) return;
    if (source === "python") {
      const uvicornLevel = /^(DEBUG|INFO|WARNING|ERROR|CRITICAL):\s/.exec(message)?.[1];
      if (uvicornLevel) level = uvicornLevel.toLowerCase();
      else if (message.startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(message);
          const severity = parsed && typeof parsed === "object" && "level" in parsed ? parsed.level : undefined;
          if (typeof severity === "string" && /^(debug|info|warning|error|critical)$/i.test(severity))
            level = severity.toLowerCase();
        } catch {
          // Plain child output remains a normal info/error line.
        }
      }
    }
    if (this.queue.length >= maximumQueued) {
      this.queue.splice(this.uploading ? this.inFlightCount : 0, 1);
      this.dropped += 1;
    }
    this.queue.push({
      timestamp: new Date().toISOString(),
      source: source.slice(0, 64),
      level: level.slice(0, 16),
      message: redact(message).slice(0, maximumMessage),
    });
  }

  /** Child stdout/stderr may split both lines and UTF-8 characters at arbitrary byte offsets. */
  write(source: string, level: string, data: Buffer): void {
    const key = `${source}:${level}`;
    let line = this.lines.get(key);
    if (!line) {
      line = { decoder: new StringDecoder("utf8"), pending: "" };
      this.lines.set(key, line);
    }
    const parts = (line.pending + line.decoder.write(data)).split(/\r?\n/);
    line.pending = parts.pop() ?? "";
    for (const part of parts) this.add(source, level, part);
    while (line.pending.length > maximumMessage) {
      this.add(source, level, line.pending.slice(0, maximumMessage));
      line.pending = line.pending.slice(maximumMessage);
    }
  }

  async flush(): Promise<void> {
    if (this.uploading) return this.inFlight;
    for (const [key, line] of this.lines) {
      if (!line.pending) continue;
      const [source, level] = key.split(":");
      this.add(source ?? "service", level ?? "info", line.pending);
      line.pending = "";
    }
    if (!this.queue.length && !this.dropped) return;
    this.uploading = true;
    const dropped = this.dropped;
    const batch: AppLogEntry[] = [];
    let bytes = uploadEnvelopeBytes;
    if (dropped) {
      const notice = {
        timestamp: new Date().toISOString(),
        source: "electron",
        level: "warning",
        message: `Dropped ${dropped} old log entries while offline`,
      };
      batch.push(notice);
      bytes += Buffer.byteLength(JSON.stringify(notice));
    }
    let count = 0;
    for (const entry of this.queue) {
      if (batch.length >= maximumBatch) break;
      const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + Number(batch.length > 0);
      if (bytes + entryBytes > maximumUploadBytes) break;
      batch.push(entry);
      bytes += entryBytes;
      count += 1;
    }
    this.inFlightCount = count;
    this.inFlight = (async () => {
      try {
        await this.send(batch);
        this.queue.splice(0, count);
        this.dropped -= dropped;
      } catch {
        // Upload failures stay local. The next interval retries the same entries.
      } finally {
        this.uploading = false;
        this.inFlightCount = 0;
        this.inFlight = undefined;
      }
    })();
    await this.inFlight;
  }
}
