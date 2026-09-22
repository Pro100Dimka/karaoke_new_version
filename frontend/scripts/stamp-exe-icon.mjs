import { access } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { rcedit } from "rcedit";

const [, , executableArgument, iconArgument, versionArgument = "1.0.0"] = process.argv;

if (!executableArgument || !iconArgument) {
  throw new Error("Usage: node stamp-exe-icon.mjs <executable> <icon.ico> [version]");
}

const executable = resolve(executableArgument);
const icon = resolve(iconArgument);

await Promise.all([access(executable), access(icon)]);
await rcedit(executable, {
  icon,
  "file-version": versionArgument,
  "product-version": versionArgument,
  "version-string": {
    CompanyName: "A&D Voice",
    FileDescription: "A&D Voice",
    InternalName: "AD Voice",
    OriginalFilename: "AD Voice.exe",
    ProductName: "A&D Voice",
  },
});

console.log(`Embedded A&D Voice icon into ${executable}`);
