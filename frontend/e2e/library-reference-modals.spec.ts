import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

/** Replaces the bridge's empty job and recording lists with a busy queue and a song with six takes. */
const installBusyLibrary = (): void => {
  const original = window.desktop.pythonRequest;
  const states = ["Succeeded", "Succeeded", "Succeeded", "Running", "Queued", "Failed", "Queued"];
  window.desktop.pythonRequest = async request => {
    if (request.path.startsWith("/jobs?")) return { status: 200, ok: true, body: { items: states.map((state, index) => ({
      jobId: `job-${index}`, type: "SongProcessing", state, entityId: "song-1", stage: state === "Running" ? "Separation" : state,
      stageProgress: .56, overallProgress: state === "Succeeded" ? 1 : state === "Running" ? .56 : 0,
      error: state === "Failed" ? { message: "Operation requires more free disk space" } : null,
      report: { processingBackend: index === 3 ? "Kaggle" : "Local" },
      startedAt: "2026-09-30T12:00:00Z", finishedAt: state === "Succeeded" ? "2026-09-30T12:01:22Z" : null,
    })), total: 7, limit: 200, offset: 0 } };
    if (request.path.startsWith("/recordings?")) return { status: 200, ok: true, body: { items: Array.from({ length: 6 }, (_, index) => ({
      recordingId: `rec-${index}`, filePath: `D:/recording-${index}.wav`, duration: [67, 47, 220, 195, 220, 150][index],
      sampleRate: 48000, channels: 2, createdAt: `2026-09-${30 - index}T23:19:36Z`, songId: "song-1", songRevision: 1,
      displayName: `Recording ${index + 1}`, fileStatus: "Ready", analysisStatus: index % 2 ? "Succeeded" : "NotAnalyzed",
    })), total: 6, limit: 200, offset: 0 } };
    return original(request);
  };
};

test("processing queue and performances list the backend's jobs and takes", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.addInitScript(installBusyLibrary);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();

  await page.getByRole("button", { name: /Очередь обработки|Processing queue|Черга обробки/i }).click();
  const queue = page.getByRole("dialog", { name: /Очередь обработки|Processing queue|Черга обробки/i });
  await expect(queue.getByRole("list", { name: /Очередь обработки|Processing queue|Черга обробки/i }).getByRole("listitem")).toHaveCount(7);
  await page.screenshot({ path: "test-results/processing-modal.png" });
  await page.keyboard.press("Escape");
  await expect(queue).toBeHidden();

  await page.getByRole("button", { name: /^(Записи|Recordings)$/i }).first().click();
  const performances = page.getByRole("dialog", { name: /Люди/ });
  await expect(performances.getByText(/(Записей|Recordings|Записів): 6/)).toBeVisible();
  await page.screenshot({ path: "test-results/performances-modal.png" });
});
