import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

for (const width of [1920, 1830, 1440, 1100, 800]) {
  test(`console controls remain clickable and contained at ${width}px`, async ({ page }) => {
    await page.addInitScript(installDesktopBridge);
    await page.addInitScript(() => localStorage.setItem("adVoice.preferences.v1", JSON.stringify({ karaokeAutoHideConsole: false })));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await page.getByLabel("Бумбокс — Люди", { exact: true }).getByRole("button", { name: /Запустить караоке|Play karaoke|Почати караоке/i }).click();
    await expect(page.locator(".consolePanels")).toBeVisible({ timeout: 25_000 });
    await expect(page.locator(".karaokeIntro")).toBeHidden({ timeout: 25_000 });
    const issues = await page.locator(".consolePanels").evaluate((panels) => {
      const problems: string[] = [];
      const sliders = panels.querySelectorAll<HTMLElement>('[role="slider"]');
      if (sliders.length < 4) problems.push("Missing mixer controls");
      for (const slider of sliders) {
        const box = slider.getBoundingClientRect();
        const section = slider.closest(".consoleSection")!.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        const label = slider.getAttribute("aria-label") ?? "knob";
        if (!hit || !slider.contains(hit)) problems.push(`${label}: centre covered`);
        if (box.left < section.left || box.right > section.right) problems.push(`${label}: outside section`);
      }
      for (const label of panels.querySelectorAll<HTMLElement>("button span")) {
        if (label.textContent?.trim() && label.clientWidth > 0 && label.scrollWidth > label.clientWidth + 1) problems.push(`${label.textContent}: clipped`);
      }
      return problems;
    });
    expect(issues).toEqual([]);
  });
}

test("the karaoke light canvas draws a highlight without allocating WebGL", async ({ page }) => {
  await page.route("**/stage-composition-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
  );
  await page.goto("/stage-composition-test");
  const composition = await page.evaluate(async () => {
    await import("/src/features/karaoke/show/show.css");
    const [{ CanvasLightRenderer }, { LightBatch, spriteKind }] = await Promise.all([
      import("/src/features/karaoke/show/gl/canvasLightRenderer.ts"),
      import("/src/features/karaoke/show/gl/lightBatch.ts"),
    ]);
    const canvas = document.createElement("canvas");
    canvas.className = "showFx";
    document.body.className = "karaokePage";
    canvas.width = canvas.height = 64;
    document.body.append(canvas);
    const renderer = CanvasLightRenderer.create(canvas);
    if (!renderer) throw new Error("Canvas2D unavailable");
    const batch = new LightBatch(1, 1);
    batch.sprite(32, 32, 10, spriteKind.glow, [1, 0.2, 0.4], 1);
    renderer.render(batch, 0, { width: 64, height: 64 }, {}, 0);
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, 64, 64).data;
    return { dark: pixels[3], light: pixels[(32 * 64 + 32) * 4 + 3], blend: getComputedStyle(canvas).mixBlendMode };
  });
  expect(composition.dark).toBe(0);
  expect(composition.light).toBeGreaterThan(0);
  expect(composition.blend).toBe("normal");
});

test("karaoke video does not allocate a fullscreen filter surface", async ({ page }) => {
  await page.route("**/stage-composition-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
  );
  await page.goto("/stage-composition-test");
  const filter = await page.evaluate(async () => {
    await import("/src/features/karaoke/show/show.css");
    const scene = document.createElement("main");
    scene.className = "karaokePage";
    const video = document.createElement("video");
    video.className = "sceneVideo";
    scene.append(video);
    document.body.append(scene);
    return getComputedStyle(video).filter;
  });
  expect(filter).toBe("none");
});

test("earned stage beams remain clearly visible away from the melody roll", async ({ page }) => {
  await page.route("**/stage-composition-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("/stage-composition-test");
  const alpha = await page.evaluate(async () => {
    const [{ CanvasLightRenderer }, { LightBatch }] = await Promise.all([
      import("/src/features/karaoke/show/gl/canvasLightRenderer.ts"),
      import("/src/features/karaoke/show/gl/lightBatch.ts"),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const batch = new LightBatch(1, 1);
    batch.beam(32, 0, Math.PI, 0.4, 64, [1, 0.2, 0.55], 0.4);
    CanvasLightRenderer.create(canvas)!.render(batch, 0, { width: 64, height: 64 }, {}, 0);
    return canvas.getContext("2d")!.getImageData(32, 32, 1, 1).data[3];
  });
  expect(alpha).toBeGreaterThanOrEqual(25);
});
