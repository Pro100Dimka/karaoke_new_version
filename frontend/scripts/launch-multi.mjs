import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
const electronExecutable = join(frontendRoot, "node_modules", "electron", "dist", "electron.exe");
if (!existsSync(electronExecutable)) throw new Error(`Electron executable was not found: ${electronExecutable}`);

const profiles = [
  // The first window is the exact same profile used by `npm run dev:app`, so it keeps
  // the developer's existing library and preferences. Only the guest is isolated.
  { name: "AD Voice Dev", port: "8767", endpoint: String.raw`\\.\pipe\ADVoice.AudioService.Dev.v1`, debugPort: "9341" },
  { name: "AD Voice Multi 2", port: "8772", endpoint: String.raw`\\.\pipe\ADVoice.AudioService.Multi2.v1`, debugPort: "9342" },
];

for (const profile of profiles) {
  const env = { ...process.env };
  delete env.AD_VOICE_DATA;
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    AD_VOICE_PROFILE: profile.name,
    AD_VOICE_PORT: profile.port,
    AD_VOICE_AUDIO_ENDPOINT: profile.endpoint,
  });
  const args = [frontendRoot, `--ad-voice-profile=${profile.name.replaceAll(" ", "-")}`];
  if (process.env.AD_VOICE_MULTI_DEBUG === "1") args.push(`--remote-debugging-port=${profile.debugPort}`);
  const child = spawn(electronExecutable, args, { cwd: frontendRoot, env, detached: true, stdio: "ignore" });
  child.unref();
  process.stdout.write(`[app] ${profile.name}: PID ${child.pid}, backend ${profile.port}\n`);
}
