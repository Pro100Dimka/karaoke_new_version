import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const roots = ["src", "electron"];
const sourceExtensions = new Set([".ts", ".tsx"]);
const checks = [
  { name: "any", pattern: /\bany\b/ },
  { name: "TypeScript suppression", pattern: /@ts-(?:ignore|expect-error)|eslint-disable/ },
  { name: "renderer browser audio", pattern: /\b(?:AudioContext|MediaRecorder|getUserMedia)\b/, rendererOnly: true },
  { name: "renderer Node access", pattern: /(?:node:fs|child_process|require\s*\()/, rendererOnly: true },
  { name: "renderer clipboard", pattern: /navigator\.clipboard/, rendererOnly: true },
  { name: "native confirm", pattern: /(?:window\.)?confirm\s*\(/, rendererOnly: true },
  { name: "unsafe HTML", pattern: /dangerouslySetInnerHTML/, rendererOnly: true },
  { name: "clickable div", pattern: /<div\b[^>]*\bonClick=/, rendererOnly: true },
  { name: "manual button role", pattern: /role=["']button["']/, rendererOnly: true },
  { name: "unstable list key", pattern: /key=\{[^}]*?(?:Math\.random|Date\.now|\b(?:index|idx)\b)[^}]*\}/, rendererOnly: true },
  { name: "hardcoded DOM id", pattern: /\bid=["'][^"']+["']/, rendererOnly: true },
  { name: "layout br", pattern: /<br\s*\/?>/, rendererOnly: true },
  { name: "nbsp spacing", pattern: /&nbsp;/, rendererOnly: true },
  { name: "direct browser storage (use shared/storage/localStore)", pattern: /(?:local|session)Storage/, rendererOnly: true, except: "shared/storage/" },
  { name: "console logging", pattern: /console\.(?:log|debug)\(/ },
  { name: "focused or skipped test", pattern: /(?:it|test|describe)\.(?:only|skip)\(/ },
  { name: "non-null assertion", pattern: /[\w)\]]!(?:\.|\[|\))/ }
];
const maxFileLines = 500;
const stylesheetChecks = [
  { name: "!important outside the theme kit", pattern: /!important/, except: "theme/" },
  { name: "z-index literal above the token scale", pattern: /z-index:\s*\d{4,}/ }
];

const files = [];
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (sourceExtensions.has(extname(entry.name))) files.push(path);
  }
};

for (const root of roots) walk(root);

const failures = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const renderer = file.startsWith(`src${process.platform === "win32" ? "\\" : "/"}`);
  const lines = source.split(/\r?\n/);

  for (const check of checks) {
    if (check.rendererOnly && !renderer) continue;
    if (check.except && file.replaceAll("\\", "/").includes(check.except)) continue;
    for (let index = 0; index < lines.length; index += 1) {
      if (check.pattern.test(lines[index])) {
        failures.push(`${relative(".", file)}:${index + 1} ${check.name}`);
      }
      check.pattern.lastIndex = 0;
    }
  }
}

const styleFiles = [];
const walkStyles = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkStyles(path);
    else if (extname(entry.name) === ".css") styleFiles.push(path);
  }
};
walkStyles("src");
for (const file of styleFiles) {
  const normalized = file.replaceAll("\\", "/");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const check of stylesheetChecks) {
    if (check.except && normalized.includes(check.except)) continue;
    lines.forEach((line, index) => {
      if (check.pattern.test(line)) failures.push(`${relative(".", file)}:${index + 1} ${check.name}`);
    });
  }
}

// The theme kit is the user's own design system and is kept as delivered.
for (const file of [...files, ...styleFiles.filter(file => !file.replaceAll("\\", "/").includes("theme/"))]) {
  const count = readFileSync(file, "utf8").split(/\r?\n/).length;
  if (count > maxFileLines) failures.push(`${relative(".", file)} has ${count} lines (limit ${maxFileLines})`);
}

if (failures.length > 0) {
  console.error("Rule check failed:\n" + failures.map(item => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`Rule check passed for ${files.length} TypeScript/TSX files.`);
