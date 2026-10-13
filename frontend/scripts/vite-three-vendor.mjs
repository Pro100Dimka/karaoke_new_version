// Serves the copy of three.js the Library backdrop (QuantumBackground) imports, so the scene works
// offline and never loads code from a CDN. The files are the closure of what the installed UI kit's
// scene imports: three's core plus each `three/addons/…` module and everything those import in turn.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the scene finds three.js; relative, so its import map (and CSP hash) is the same everywhere. */
export const threeVendorBase = "vendor/three/";

// Neither package exports its package.json, so they are found by their folders.
const modules = fileURLToPath(new URL("../node_modules/", import.meta.url));
// three@0.182.0, the version the scene is built and tested with, installed under its own name so the
// app's own `three` can follow its own version.
const packageRoot = path.join(modules, "three-quantum-scene");
const kitDist = path.join(modules, "@neo-ui-kit", "react");

const javascriptFiles = (folder) =>
  readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));

/** Package-relative paths of every file the scene needs, following relative imports. */
export const threeVendorFiles = () => {
  const addons = new Set();
  for (const file of javascriptFiles(path.join(kitDist, "dist")))
    for (const [, addon] of readFileSync(file, "utf8").matchAll(/three\/addons\/([\w/.-]+\.js)/g))
      addons.add(`examples/jsm/${addon}`);
  if (addons.size === 0) throw new Error("No three.js addons found in @neo-ui-kit/react; is QuantumBackground still shipped?");
  const queue = ["build/three.module.js", ...addons];
  const files = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    const absolute = path.join(packageRoot, file);
    if (!existsSync(absolute)) throw new Error(`three.js file missing: ${file}`);
    files.add(file);
    const source = readFileSync(absolute, "utf8");
    for (const [, specifier] of source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g))
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
  }
  return [...files].sort();
};

/** @returns {import("vite").Plugin} */
export const threeVendor = () => {
  let files = [];
  return {
    name: "three-vendor",
    buildStart() {
      files = threeVendorFiles();
    },
    configureServer(server) {
      files = threeVendorFiles();
      server.middlewares.use(`/${threeVendorBase}`, (request, response, next) => {
        const file = decodeURIComponent((request.url ?? "").split("?")[0]).replace(/^\//, "");
        // Only the computed closure is served, never arbitrary files from node_modules.
        if (!files.includes(file)) return next();
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(readFileSync(path.join(packageRoot, file)));
      });
    },
    generateBundle() {
      for (const file of files)
        this.emitFile({
          type: "asset",
          fileName: `${threeVendorBase}${file}`,
          source: readFileSync(path.join(packageRoot, file)),
        });
    },
  };
};
