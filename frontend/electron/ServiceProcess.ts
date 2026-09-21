import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

const restartDelayMilliseconds = 1000;
const failedStartDelayMilliseconds = 3000;

export class ServiceProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv = process.env
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
    child.stdout.on("data", data => process.stdout.write(data));
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
    if (this.child === child) this.child = null;
    if (!this.stopping) setTimeout(() => this.start(), delayMilliseconds);
  }

  stop(): void {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (!child?.pid) return;
    if (process.platform === "win32") {
      // A venv python.exe is a launcher; kill the whole tree so no orphan keeps the port or lock.
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill();
    }
  }
}
