import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

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
  exited?(code: number | null, signal: NodeJS.Signals | null): void;
}

export class ServiceProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private finishStop: (() => void) | null = null;
  private forcing = false;
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
      stdio: 'pipe',
    });
    this.child = child;
    this.startedAt = Date.now();
    this.observer.started?.();
    child.stdout.on('data', (data: Buffer) => {
      if (this.child !== child || this.stopping) return;
      this.observer.stdout?.(data);
      process.stdout.write(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      if (this.child !== child || this.stopping) return;
      this.observer.stderr?.(data);
      process.stderr.write(data);
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child || this.stopping) return;
      this.observer.exited?.(code, signal);
      this.restartAfter(child);
    });
    // A failed launch (missing executable) emits "error" and never "exit"; unhandled it would abort the main process.
    child.once('error', (error) => {
      const message = Buffer.from(
        `Service failed to start: ${this.command}: ${error.message}\n`,
      );
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
          child.removeListener('exit', onExit);
          if (this.child === child) this.child = null;
          this.finishStop = null;
          resolve();
        };
        const onExit = () => {
          // A venv launcher can exit before taskkill has finished its descendants.
          if (!this.forcing) finish();
        };
        const timer = setTimeout(() => {
          void this.stop();
        }, 10_000);
        this.finishStop = finish;
        child.once('exit', onExit);
        void Promise.resolve()
          .then(shutdown)
          .catch(() => {
            void this.stop();
          });
      });
      return this.stopPromise;
    }
    this.child = null;
    this.forcing = true;
    const terminated = this.terminateChild(child);
    if (!this.stopPromise) this.stopPromise = terminated;
    else void terminated.then(() => this.finishStop?.());
    return this.stopPromise;
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const killChild = () => {
      try {
        child.kill();
      } catch {
        // An already-exited or inaccessible process cannot hold shutdown open.
      }
    };
    if (process.platform !== 'win32') {
      killChild();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (failed: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (failed) killChild();
        resolve();
      };
      try {
        // Keep the tree kill off Electron's main thread, including stalled taskkill launches.
        const killer = spawn(
          'taskkill',
          ['/pid', String(child.pid), '/T', '/F'],
          {
            windowsHide: true,
            stdio: 'ignore',
          },
        );
        killer.once('error', () => finish(true));
        killer.once('close', (code) => finish(code !== 0));
        timer = setTimeout(() => {
          try {
            killer.kill();
          } catch {
            // Fall back to the service handle even if the helper is inaccessible.
          }
          finish(true);
        }, 5_000);
      } catch {
        finish(true);
      }
    });
  }
}
