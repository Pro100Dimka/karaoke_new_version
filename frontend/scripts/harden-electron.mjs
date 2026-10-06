// Locks the released Electron binary down (official @electron/fuses): the shipped "AD Voice.exe"
// can no longer be started as a plain Node.js runtime (ELECTRON_RUN_AS_NODE), take NODE_OPTIONS or
// open a debugger port (--inspect), and its cookies are encrypted at rest. The app needs none of
// that at run time. The asar fuses stay off because the app is shipped as a folder, not app.asar.
import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";

const executable = process.argv[2];
if (!executable) {
  console.error("Usage: node harden-electron.mjs <path to the app executable>");
  process.exit(2);
}

await flipFuses(executable, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
});
console.log(`Electron fuses locked: ${executable}`);
