import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("processing queue and performances keep the reference geometry", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();
  await page.evaluate(() => {
    const original = window.desktop.pythonRequest;
    const states = ["Succeeded", "Succeeded", "Succeeded", "Running", "Queued", "Failed", "Queued"];
    window.desktop.pythonRequest = async request => {
      if (request.path.startsWith("/jobs?")) return { status: 200, ok: true, body: { items: states.map((state, index) => ({ jobId: `job-${index}`, type: "SongProcessing", state, entityId: "song-1", stage: state === "Running" ? "Separation" : state, stageProgress: .56, overallProgress: state === "Succeeded" ? 1 : state === "Running" ? .56 : 0, error: state === "Failed" ? { message: "Operation requires more free disk space" } : null, report: { processingBackend: index === 3 ? "Kaggle" : "Local" }, startedAt: "2026-09-30T12:00:00Z", finishedAt: state === "Succeeded" ? "2026-09-30T12:01:22Z" : null })), total: 7, limit: 200, offset: 0 } };
      if (request.path.startsWith("/recordings?")) return { status: 200, ok: true, body: { items: Array.from({ length: 6 }, (_, index) => ({ recordingId: `rec-${index}`, filePath: `D:/recording-${index}.wav`, duration: [67,47,220,195,220,150][index], sampleRate: 48000, channels: 2, createdAt: `2026-09-${30-index}T${index ? "23:19:36" : "00:57:03"}Z`, songId: "song-1", songRevision: 1, displayName: index % 2 ? `Recording · 29.09.2026, 23:${19-index}:36` : index ? "Studio Master · Take" : "Recording · 30.09.2026, 00:57:03", fileStatus: "Ready", analysisStatus: index % 2 ? "Succeeded" : "NotAnalyzed" })), total: 6, limit: 200, offset: 0 } };
      return original(request);
    };
  });

  await page.getByRole("button", { name: /Очередь обработки|Processing queue|Черга обробки/i }).click();
  await expect(page.locator(".processingJobCard")).toHaveCount(7, { timeout: 3000 });
  const queue = page.locator(".processingReferenceModal");
  await expect(queue).toBeVisible();
  const queueBox = await queue.boundingBox();
  expect((queueBox?.width ?? 0) / (queueBox?.height ?? 1)).toBeCloseTo(1013 / 1232, 2);
  await page.screenshot({ path: "test-results/processing-reference-modal.png" });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /Записи|Recordings|Записи/i }).first().click();
  await expect(page.locator(".performanceCard")).toHaveCount(6);
  const performances = page.locator(".performancesReferenceModal");
  const performancesBox = await performances.boundingBox();
  expect((performancesBox?.width ?? 0) / (performancesBox?.height ?? 1)).toBeCloseTo(1232 / 1184, 2);
  await page.screenshot({ path: "test-results/performances-reference-modal.png" });
});
