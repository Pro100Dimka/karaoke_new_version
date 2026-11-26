import { StringDecoder } from 'node:string_decoder';
import { format } from 'node:util';
import { readFileSync } from 'node:fs';
import { writeFile, rename, rm } from 'node:fs/promises';
import { roomParticipantId } from './RoomIdentity';
import {
  roomServerRequest,
  serverLogUploadsDisabled,
} from './RoomServerTransport';
import { randomUUID } from 'node:crypto';
import { requestFileDeclaration } from './TransferPermissions';

interface AppLogEntry {
  timestamp: string;
  source: string;
  level: string;
  message: string;
  declaration?: string;
}

const uploadMilliseconds = 2_000;
const maximumQueued = 1_000;
const maximumBatch = 100;
const maximumMessage = 4_096;
const maximumUploadBytes = 480 * 1024;
const uploadEnvelopeBytes = Buffer.byteLength(
  JSON.stringify({ clientId: '0'.repeat(32), entries: [] }),
);

const redact = (message: string): string =>
  message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '<url>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>')
    .replace(/\b[a-f0-9]{32,64}\b/gi, '<identifier>')
    .replace(/[A-Z]:[\\/][^\r\n"'<>]+/gi, '<path>')
    .replace(/([A-Z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))[^\\/\s]+/gi, '$1<user>')
    .replace(/(\/(?:home|Users)\/)[^/\s]+/g, '$1<user>')
    .replace(
      /((?:["']?(?:X-AD-Voice-(?:Room-Key|Device|Local-Token)|AD_VOICE_LOCAL_API_TOKEN|accessToken|voiceToken|api[_-]?key|authorization)["']?)\s*[=:]\s*["']?(?:(?:Bearer|Basic)\s+)?)[^"'\s,;}]+/gi,
      '$1<redacted>',
    )
    .replace(
      /([?&](?:token|key|secret|authorization|auth|access_token)=)[^&\s]+/gi,
      '$1<redacted>',
    );

const technicalMessage = (message: string): string => {
  const exception =
    /\b(?:TypeError|ValueError|RuntimeError|TimeoutError|ConnectionError|OSError|SyntaxError|Error)\b/.exec(
      message,
    )?.[0];
  const status = /\b(?:status|code)\s*[=:]\s*(-?\d{1,5})\b/i.exec(message)?.[1];
  return [exception ?? 'Application event', status ? `status=${status}` : '']
    .filter(Boolean)
    .join(' ');
};

export const sendAppLogs = async (entries: AppLogEntry[]): Promise<void> => {
  const response = await roomServerRequest({
    method: 'POST',
    path: '/app-logs',
    body: { clientId: await roomParticipantId(), entries },
  });
  if (!response.ok)
    throw new Error(`App log upload failed (${response.status})`);
};

/** Bounded, best-effort upload of text logs from this application profile. */
export class AppLogUploader {
  private readonly queue: AppLogEntry[] = [];
  private readonly recent: AppLogEntry[] = [];
  private readonly lines = new Map<
    string,
    { decoder: StringDecoder; pending: string }
  >();
  private timer: NodeJS.Timeout | undefined;
  private uploading = false;
  private inFlightCount = 0;
  private inFlight: Promise<void> | undefined;
  private dropped = 0;
  private stopping?: Promise<void>;
  private persistenceStarted = false;
  private persistAgain = false;
  private persisting?: Promise<void>;
  private reportingPersistenceFailure = false;

  constructor(
    private readonly send: (entries: AppLogEntry[]) => Promise<unknown>,
    private readonly queuePath?: string,
  ) {}

  start(): void {
    if (this.timer || this.stopping) return;
    if (serverLogUploadsDisabled()) void this.discard();
    if (this.queuePath && !serverLogUploadsDisabled()) {
      try {
        const saved: unknown = JSON.parse(readFileSync(this.queuePath, 'utf8'));
        if (Array.isArray(saved)) {
          for (const entry of saved.slice(-maximumQueued)) {
            if (
              entry &&
              ['timestamp', 'source', 'level', 'message'].every(
                (key) => typeof entry[key] === 'string',
              )
            ) {
              this.add(entry.source, entry.level, entry.message);
              const added = this.queue.at(-1);
              if (added) added.timestamp = entry.timestamp;
            }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.warn('Could not restore pending application logs', error);
      }
    }
    this.timer ??= setInterval(() => void this.flush(), uploadMilliseconds);
    this.timer.unref();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopping = (async () => {
      const deadline = Date.now() + 1200;
      do {
        const count = this.queue.length;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.flush(),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (this.queue.length >= count) break;
      } while (this.queue.length && Date.now() < deadline);
      await this.persist();
    })();
    return this.stopping;
  }

  private persist(): Promise<void> {
    const file = this.queuePath;
    if (!file) return Promise.resolve();
    this.persistenceStarted = true;
    this.persistAgain = true;
    // Shutdown drains online batches first. A late upload may supersede an
    // in-flight save; serialize it so an older rename cannot restore sent logs.
    this.persisting ??= Promise.resolve().then(async () => {
      try {
        while (this.persistAgain) {
          this.persistAgain = false;
          try {
            if (!this.queue.length) await rm(file, { force: true });
            else {
              await writeFile(
                file + '.tmp',
                JSON.stringify(this.queue),
                'utf8',
              );
              await rename(file + '.tmp', file);
            }
          } catch (error) {
            // Console capture must not turn a disk failure into endless saves.
            this.reportingPersistenceFailure = true;
            try {
              console.warn('Could not save pending application logs', error);
            } finally {
              this.reportingPersistenceFailure = false;
            }
          }
        }
      } finally {
        this.persisting = undefined;
      }
    });
    return this.persisting;
  }

  captureConsole(
    target: Partial<
      Record<
        'log' | 'info' | 'warn' | 'error' | 'debug',
        (...args: unknown[]) => void
      >
    >,
  ): void {
    const levels = {
      log: 'info',
      info: 'info',
      warn: 'warning',
      error: 'error',
      debug: 'debug',
    } as const;
    for (const [method, level] of Object.entries(levels) as [
      keyof typeof levels,
      string,
    ][]) {
      const original = target[method];
      if (!original) continue;
      target[method] = (...args: unknown[]) => {
        this.add('electron', level, format(...args));
        original.apply(target, args);
      };
    }
  }

  add(source: string, level: string, message: string): void {
    if (!message) return;
    if (source === 'python') {
      const uvicornLevel = /^(DEBUG|INFO|WARNING|ERROR|CRITICAL):\s/.exec(
        message,
      )?.[1];
      if (uvicornLevel) level = uvicornLevel.toLowerCase();
      else if (message.startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(message);
          const severity =
            parsed && typeof parsed === 'object' && 'level' in parsed
              ? parsed.level
              : undefined;
          if (
            typeof severity === 'string' &&
            /^(debug|info|warning|error|critical)$/i.test(severity)
          )
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
    const entry = {
      timestamp: new Date().toISOString(),
      source: source.slice(0, 64),
      level: level.slice(0, 16),
      message: technicalMessage(message),
    };
    if (!serverLogUploadsDisabled()) this.queue.push(entry);
    if (this.persisting && !this.reportingPersistenceFailure)
      this.persistAgain = true;
    this.recent.push(entry);
    if (this.recent.length > 60) this.recent.shift();
  }

  addSnapshot(source: string, text: string): void {
    const id = randomUUID();
    const report = redact(text);
    const parts = Math.ceil(report.length / 3000);
    for (let index = 0; index < parts; index++)
      this.add(
        source,
        'error',
        `${id} (${index + 1}/${parts})\n${report.slice(index * 3000, (index + 1) * 3000)}`,
      );
  }

  /** Explicit reports keep recent service logs even after the periodic upload consumed them. */
  async sendReport(text: string): Promise<string> {
    if (serverLogUploadsDisabled())
      throw new Error('Server log uploads are disabled');
    if (!text.trim() || text.length > 128_000)
      throw new TypeError('Invalid error report size');
    const declaration = await requestFileDeclaration(
      'diagnostics',
      '/app-logs',
    );
    const id = randomUUID();
    const report = redact(text);
    const timestamp = new Date().toISOString();
    const parts = Math.ceil(report.length / 3_000);
    const entries = Array.from({ length: parts }, (_, index) => ({
      timestamp,
      source: 'error-report',
      level: 'error',
      message: `${id} (${index + 1}/${parts})\n${report.slice(index * 3_000, (index + 1) * 3_000)}`,
      declaration,
    }));
    const logs = this.recent.map((entry) => ({
      ...entry,
      message: `${id}\n${entry.message}`.slice(0, maximumMessage),
    }));
    const batch = [...entries, ...logs];
    for (let offset = 0; offset < batch.length; offset += 20)
      await this.send(batch.slice(offset, offset + 20));
    return id;
  }

  /** Child stdout/stderr may split both lines and UTF-8 characters at arbitrary byte offsets. */
  write(source: string, level: string, data: Buffer): void {
    const key = `${source}:${level}`;
    let line = this.lines.get(key);
    if (!line) {
      line = { decoder: new StringDecoder('utf8'), pending: '' };
      this.lines.set(key, line);
    }
    const parts = (line.pending + line.decoder.write(data)).split(/\r?\n/);
    line.pending = parts.pop() ?? '';
    for (const part of parts) this.add(source, level, part);
    while (line.pending.length > maximumMessage) {
      this.add(source, level, line.pending.slice(0, maximumMessage));
      line.pending = line.pending.slice(maximumMessage);
    }
  }

  async flush(): Promise<void> {
    if (serverLogUploadsDisabled()) return this.discard();
    if (this.uploading) return this.inFlight;
    for (const [key, line] of this.lines) {
      if (!line.pending) continue;
      const [source, level] = key.split(':');
      this.add(source ?? 'service', level ?? 'info', line.pending);
      line.pending = '';
    }
    if (!this.queue.length && !this.dropped) return;
    this.uploading = true;
    const dropped = this.dropped;
    const batch: AppLogEntry[] = [];
    let bytes = uploadEnvelopeBytes;
    if (dropped) {
      const notice = {
        timestamp: new Date().toISOString(),
        source: 'electron',
        level: 'warning',
        message: `Dropped ${dropped} old log entries while offline`,
      };
      batch.push(notice);
      bytes += Buffer.byteLength(JSON.stringify(notice));
    }
    let count = 0;
    for (const entry of this.queue) {
      if (batch.length >= maximumBatch) break;
      const entryBytes =
        Buffer.byteLength(JSON.stringify(entry)) + Number(batch.length > 0);
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
        this.dropped = Math.max(0, this.dropped - dropped);
        if (this.persistenceStarted) await this.persist();
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

  async discard(): Promise<void> {
    this.queue.length = 0;
    this.dropped = 0;
    this.recent.length = 0;
    this.lines.clear();
    await this.inFlight;
    await this.persist();
  }
}
