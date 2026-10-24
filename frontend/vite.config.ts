import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { threeVendor } from "./scripts/vite-three-vendor.mjs";

const devServerPort = 5173;

// UI kit 1.2.1 starts painting asynchronously. StrictMode can interrupt it after only the base
// canvas was sized; checking every layer lets the next setup finish the original knob artwork.
const rotaryCanvasLifecycle = (): Plugin => ({
  name: "rotary-canvas-lifecycle",
  enforce: "pre",
  transform(source, id) {
    if (!id.replaceAll("\\", "/").includes("/node_modules/@neo-ui-kit/react/")) return;
    return source.replace(
      "canvas.width === size && canvas.height === size",
      "[canvas, rotor, feedback].every(layer => layer.width === size && layer.height === size)",
    );
  },
});

/** The dev server injects an inline React Refresh preamble and talks over a websocket; production keeps the strict CSP. */
const relaxedDevCsp = (): Plugin => ({
  name: "relaxed-dev-csp",
  apply: "serve",
  transformIndexHtml: (html) =>
    html
      .replace(/script-src [^;]*;/, "script-src 'self' 'unsafe-inline';")
      .replace(
        "connect-src 'self' http://127.0.0.1:8765;",
        `connect-src 'self' http://127.0.0.1:8765 ws://127.0.0.1:${devServerPort} ws://localhost:${devServerPort};`,
      ),
});

export default defineConfig({
  base: "./",
  // three.js for the Library backdrop is served locally (see scripts/vite-three-vendor.mjs).
  plugins: [rotaryCanvasLifecycle(), react(), relaxedDevCsp(), threeVendor()],
  // Keep the kit visible to the lifecycle correction in development as well as production.
  optimizeDeps: { exclude: ["@neo-ui-kit/react"] },
  server: { port: devServerPort },
  build: { outDir: "dist" },
});
