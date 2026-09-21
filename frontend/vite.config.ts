import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const devServerPort = 5173;

/** The dev server injects an inline React Refresh preamble and talks over a websocket; production keeps the strict CSP. */
const relaxedDevCsp = (): Plugin => ({
  name: "relaxed-dev-csp",
  apply: "serve",
  transformIndexHtml: html =>
    html
      .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
      .replace("ws://localhost:5173;", `ws://127.0.0.1:${devServerPort} ws://localhost:${devServerPort};`)
});

export default defineConfig({
  base: "./",
  plugins: [react(), relaxedDevCsp()],
  server: { port: devServerPort },
  build: { outDir: "dist" }
});
