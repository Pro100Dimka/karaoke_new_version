import type { ServiceObserver } from "./ServiceProcess";

const maximumAnnouncementBytes = 128;
const requestTimeoutMilliseconds = 30_000;

/** The child announces its actual listening socket after Uvicorn startup. */
export class BackendEndpoint implements ServiceObserver {
  private port: number | null = null;
  private pending = "";
  private oversized = false;
  private lifetime = new AbortController();

  started(): void {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.port = null;
    this.pending = "";
    this.oversized = false;
  }

  stopped(): void { this.started(); }

  stdout(data: Buffer): void {
    if (this.port !== null) return;
    const text = data.toString("latin1");
    for (let offset = 0; offset < text.length;) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      if (!this.oversized) {
        this.oversized = this.pending.length + end - offset > maximumAnnouncementBytes;
        this.pending = this.oversized ? "" : this.pending + text.slice(offset, end);
      }
      if (newline < 0) break;
      const match = !this.oversized && /^AD_VOICE_BACKEND_READY:([0-9]{1,5})\r?$/.exec(this.pending);
      this.pending = "";
      this.oversized = false;
      if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) {
        this.port = Number(match[1]);
        return;
      }
      offset = end + 1;
    }
  }

  async request(path: string, init: RequestInit = {}): Promise<{ status: number; ok: boolean; body: unknown }> {
    if (this.port === null) throw new Error("Python backend is starting or stopped");
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(requestTimeoutMilliseconds)]);
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, { ...init, signal });
    const text = await response.text();
    // A reply belonging to a terminated process must not repopulate renderer state.
    signal.throwIfAborted();
    return { status: response.status, ok: response.ok, body: text ? JSON.parse(text) as unknown : null };
  }
}
