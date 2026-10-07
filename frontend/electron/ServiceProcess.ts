import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

/**
 * How a crashed service is restarted. The first restart comes quickly (a one-off crash costs half a
 * second); every further crash in a row doubles the wait up to half a minute, so a service that
 * dies at once on start (a broken driver, a bad build) cannot spin the CPU or flood the logs. Only a
 * service that then runs for a full minute counts as recovered: starting alone proves nothing.
 */
export const restartBackoff = {
  initialMilliseconds: 500,
  maximumMilliseconds: 30_000,
  stableMilliseconds: 60_000,
} as const;

export const restartDelay = (consecutiveFailures: number): number =>
  Math.min(
    restartBackoff.maximumMilliseconds,
    restartBackoff.initialMilliseconds * 2 ** Math.max(0, consecutiveFailures),
  );

export interface ServiceObserver {
  started?(): void;
  stdout?(data: Buffer): void;
  stderr?(data: Buffer): void;
  stopped?(): void;
}

export class ServiceProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private finishStop: (() => void) | null = null;
  private consecutiveFailures = 0;
  private startedAt = 0;

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly observer: ServiceObserver = {},
  ) {}

  start(): void {
    if (this.child || this.stopping) return;
    const child = spawn(this.command, [...this.args], {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: "pipe",
    });
    this.child = child;
    this.startedAt = Date.now();
    this.observer.started?.();
    child.stdout.on("data", (data: Buffer) => {
      if (this.child !== child || this.stopping) return;
      this.observer.stdout?.(data);
      process.stdout.write(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      if (this.child !== child || this.stopping) return;
      this.observer.stderr?.(data);
      process.stderr.write(data);
    });
    child.once("exit", () => this.restartAfter(child));
    // A failed launch (missing executable) emits "error" and never "exit"; unhandled it would abort the main process.
    child.once("error", (error) => {
      const message = Buffer.from(`Service failed to start: ${this.command}: ${error.message}\n`);
      this.observer.stderr?.(message);
      process.stderr.write(message);
      this.restartAfter(child);
    });
  }

  /** An exit or failed launch that nobody asked for: restart after the current backoff. */
  private restartAfter(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child || this.stopping) return;
    this.child = null;
    if (Date.now() - this.startedAt >= restartBackoff.stableMilliseconds)
      this.consecutiveFailures = 0;
    const delayMilliseconds = restartDelay(this.consecutiveFailures);
    this.consecutiveFailures += 1;
    this.observer.stopped?.();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delayMilliseconds);
    this.restartTimer.unref();
  }

  endInput(): void {
    this.child?.stdin.end();
  }

  stop(shutdown?: () => Promise<unknown>): Promise<void> {
    if (!this.stopping) this.observer.stopped?.();
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child?.pid) return this.stopPromise ?? Promise.resolve();
    if (shutdown) {
      if (this.stopPromise) return this.stopPromise;
      this.stopPromise = new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          child.removeListener("exit", finish);
          if (this.child === child) this.child = null;
          this.finishStop = null;
          resolve();
        };
        const timer = setTimeout(() => {
          void this.stop();
        }, 10_000);
        this.finishStop = finish;
        child.once("exit", finish);
        void Promise.resolve()
          .then(shutdown)
          .catch(() => {
            void this.stop();
          });
      });
      return this.stopPromise;
    }
    this.child = null;
    if (process.platform === "win32") {
      // A venv python.exe is a launcher; kill the whole tree so no orphan keeps the port or lock.
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } else {
      child.kill();
    }
    this.finishStop?.();
    return Promise.resolve();
  }
}
