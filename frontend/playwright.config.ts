import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:5173",
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "msedge"
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    port: 5173,
    reuseExistingServer: true
  }
});
