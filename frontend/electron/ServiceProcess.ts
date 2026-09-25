import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

const restartDelayMilliseconds = 1000;
const failedStartDelayMilliseconds = 3000;

export interface ServiceObserver {
  started?(): void;
  stdout?(data: Buffer): void;
  stopped?(): void;
}

export class ServiceProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private finishStop: (() => void) | null = null;

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
      stdio: "pipe"
    });
    this.child = child;
    this.observer.started?.();
    child.stdout.on("data", (data: Buffer) => {
      if (this.child !== child || this.stopping) return;
      this.observer.stdout?.(data);
      process.stdout.write(data);
    });
    child.stderr.on("data", data => process.stderr.write(data));
    child.once("exit", () => this.restartAfter(child, restartDelayMilliseconds));
    // A failed launch (missing executable) emits "error" and never "exit"; unhandled it would abort the main process.
    child.once("error", error => {
      process.stderr.write(`Service failed to start: ${this.command}: ${error.message}
`);
      this.restartAfter(child, failedStartDelayMilliseconds);
    });
  }

  private restartAfter(child: ChildProcessWithoutNullStreams, delayMilliseconds: number): void {
    if (this.child !== child || this.stopping) return;
    this.child = null;
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
      this.stopPromise = new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timer);
          child.removeListener("exit", finish);
          if (this.child === child) this.child = null;
          this.finishStop = null;
          resolve();
        };
        const timer = setTimeout(() => { void this.stop(); }, 10_000);
        this.finishStop = finish;
        child.once("exit", finish);
        void Promise.resolve().then(shutdown).catch(() => { void this.stop(); });
      });
      return this.stopPromise;
    }
    this.child = null;
    if (process.platform === "win32") {
      // A venv python.exe is a launcher; kill the whole tree so no orphan keeps the port or lock.
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill();
    }
    this.finishStop?.();
    return Promise.resolve();
  }
}
