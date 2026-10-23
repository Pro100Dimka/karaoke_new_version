import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

/** Replaces the bridge's empty job and recording lists with a busy queue and a song with six takes. */
const installBusyLibrary = (): void => {
  const original = window.desktop.pythonRequest;
  const states = [
    "Succeeded",
    "Succeeded",
    "Succeeded",
    "Running",
    "Queued",
    "Failed",
    "Queued",
  ];
  window.desktop.pythonRequest = async (request) => {
    if (request.path.startsWith("/jobs?"))
      return {
        status: 200,
        ok: true,
        body: {
          items: states.map((state, index) => ({
            jobId: `job-${index}`,
            type: "SongProcessing",
            state,
            entityId: "song-1",
            stage: state === "Running" ? "Separation" : state,
            stageProgress: 0.56,
            overallProgress:
              state === "Succeeded" ? 1 : state === "Running" ? 0.56 : 0,
            error:
              state === "Failed"
                ? { code: "ManualLyricsConflict", message: "Manual lyrics must be preserved before processing can continue" }
                : null,
            report: { processingBackend: index === 3 ? "Kaggle" : "Local" },
            startedAt: "2026-09-30T12:00:00Z",
            finishedAt: state === "Succeeded" ? "2026-09-30T12:01:22Z" : null,
          })),
          total: 7,
          limit: 200,
          offset: 0,
        },
      };
    if (request.path.startsWith("/recordings?"))
      return {
        status: 200,
        ok: true,
        body: {
          items: Array.from({ length: 7 }, (_, index) => ({
            recordingId: `rec-${index}`,
            filePath: `D:/recording-${index}.wav`,
            duration: [67, 47, 220, 195, 220, 150][index % 6],
            sizeBytes: 12_000_000,
            sampleRate: 48000,
            channels: 2,
            createdAt: `2026-09-${30 - index}T23:19:36Z`,
            songId: "song-1",
            songRevision: 1,
            displayName: index === 6 ? "" : `Recording ${index + 1}`,
            sourceRecordingId: index === 6 ? "rec-0" : undefined,
            fileStatus: "Ready",
            analysisStatus: index % 2 ? "Succeeded" : "NotAnalyzed",
          })),
          total: 7,
          limit: 200,
          offset: 0,
        },
      };
    return original(request);
  };
};

test("processing queue and performances list the backend's jobs and takes", async ({
  page,
}, testInfo) => {
  await page.addInitScript(installDesktopBridge);
  await page.addInitScript(installBusyLibrary);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();

  await page
    .getByRole("button", {
      name: /Очередь обработки|Processing queue|Черга обробки/i,
    })
    .click();
  const queue = page.getByRole("dialog", {
    name: /Очередь обработки|Processing queue|Черга обробки/i,
  });
  await expect(
    queue
      .getByRole("list", {
        name: /Очередь обработки|Processing queue|Черга обробки/i,
      })
      .locator(":scope > li"),
  ).toHaveCount(7);
  await expect(queue.locator(".processingSteps > li")).toHaveCount(35);
  await page.screenshot({ path: testInfo.outputPath("processing-modal.png") });
  await page.keyboard.press("Escape");
  await expect(queue).toBeHidden();

  await page
    .getByRole("button", { name: /^(Записи|Recordings)$/i })
    .first()
    .click();
  const performances = page.getByRole("dialog", { name: /Люди/ });
  await expect(
    performances.getByText(/(Записей|Recordings|Записів): 6/),
  ).toBeVisible();
  await expect(performances.locator(".recordingsList > li")).toHaveCount(6);
  await performances.getByRole("tab", { name: "A&D Studio Master", exact: true }).click();
  await expect(performances.getByRole("tab", { name: "A&D Studio Master", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: testInfo.outputPath("performances-modal.png") });
});

test("processing cleanup survives reloads and controls fit wide and narrow queues", async ({ page }, testInfo) => {
  await page.addInitScript(installDesktopBridge);
  await page.addInitScript(installBusyLibrary);
  await page.addInitScript(() => localStorage.setItem("adVoice.preferences.v1", JSON.stringify({ language: "en", reducedMotion: true })));
  await page.goto("/");
  const openQueue = () => page.getByRole("button", { name: "Processing queue", exact: true }).click();
  await openQueue();
  const queue = page.getByRole("dialog", { name: "Processing queue", exact: true });
  const jobs = queue.locator(".processingList > li");
  await expect(jobs).toHaveCount(7);

  for (const width of [1280, 720, 400]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await queue.evaluate((dialog) => {
      const bounds = dialog.getBoundingClientRect();
      const errors: string[] = [];
      const textEdges: number[] = [];
      for (const card of dialog.querySelectorAll(".processingJob")) {
        const main = card.querySelector(".processingJobMain")!.getBoundingClientRect();
        textEdges.push(main.right);
        const actions = card.querySelector(".processingJobActions")!.getBoundingClientRect();
        if (main.right > actions.left + 1 && main.bottom > actions.top + 1)
          errors.push("text and actions overlap");
        for (const button of card.querySelectorAll("button")) {
          const box = button.getBoundingClientRect();
          if (box.left < bounds.left || box.right > bounds.right)
            errors.push("action outside dialog");
        }
      }
      if (Math.max(...textEdges) - Math.min(...textEdges) > 1)
        errors.push("job progress columns do not line up");
      const footer = dialog.querySelector(".processingFooter")!.getBoundingClientRect();
      if (bounds.bottom - footer.bottom - parseFloat(getComputedStyle(dialog).paddingBottom) > 16)
        errors.push(`unused space below footer; children: ${[...dialog.children].map((child) => child.className).join(", ")}`);
      if (dialog.scrollWidth > dialog.clientWidth + 1) errors.push("horizontal dialog overflow");
      return errors;
    });
    expect(overflow, `queue at ${width}px`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`queue-${width}.png`) });
  }

  const clear = async (choice: string, title: string) => {
    await queue.locator(".processingFooter .ad-split-button-trigger").click();
    await page.getByRole("menuitem", { name: choice, exact: true }).click();
    await page.getByRole("dialog", { name: title, exact: true })
      .getByRole("button", { name: "Clear", exact: true }).click();
  };
  await clear("Completed", "Clear completed jobs?");
  await expect(jobs).toHaveCount(4);
  await page.reload();
  await openQueue();
  await expect(jobs).toHaveCount(4);
  await clear("Failed", "Clear failed jobs?");
  await expect(jobs).toHaveCount(3);
  await clear("All", "Clear the entire queue?");
  await expect(jobs).toHaveCount(0);
  await page.reload();
  await openQueue();
  await expect(jobs).toHaveCount(0);

  await page.evaluate(() => {
    const original = window.desktop.pythonRequest;
    window.desktop.pythonRequest = async (request) => {
      const response = await original(request);
      if (request.path.startsWith("/jobs?")) {
        const body = response.body as { items: Record<string, unknown>[] };
        body.items.push({ ...body.items[0], jobId: "new-job", state: "Running", overallProgress: 0.22 });
      }
      return response;
    };
  });
  await page.keyboard.press("Escape");
  await openQueue();
  await expect(jobs).toHaveCount(1);
  await expect(queue.getByText("22%", { exact: true })).toHaveCount(0);
  await expect(queue.locator(".processingJobProgress")).toHaveCount(0);
});
