import { defineConfig } from "@playwright/test";

const testServerPort = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
if (!Number.isInteger(testServerPort) || testServerPort < 1 || testServerPort > 65535)
  throw new Error("PLAYWRIGHT_PORT must be an integer between 1 and 65535");
const testServerUrl = `http://127.0.0.1:${testServerPort}`;

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? testServerUrl,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "msedge",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: `npm run dev -- --host 127.0.0.1 --port ${testServerPort} --strictPort`,
    url: testServerUrl,
    reuseExistingServer: false,
  },
});
