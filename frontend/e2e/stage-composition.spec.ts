import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("leaving an unfinished solo song uses the saved-performance fade", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.goto("/");
  await page.getByLabel("Бумбокс — Люди", { exact: true }).getByRole("button", { name: /Запустить караоке|Play karaoke|Почати караоке/i }).click();
  await expect(page.locator(".karaokeIntro")).toBeHidden({ timeout: 25_000 });
  await expect(page.locator(".karaokeConsole")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('.sceneCurtain[data-phase="closing"]')).toBeVisible();
  await expect(page).not.toHaveURL(/karaoke/);
});

test("karaoke lyrics are one and a half times the original size for both displayed lines", async ({ page }) => {
  await page.route("**/stage-composition-test", (route) => route.fulfill({
    contentType: "text/html",
    body: '<div class="lyrics ad-karaoke-lyrics"><p class="ad-lyrics-current">Большая строка</p><p class="ad-lyrics-next">Следующая строка</p></div><p id="original-current" class="ad-lyrics-current">Original</p><p id="original-next" class="ad-lyrics-next">Original</p>',
  }));
  for (const width of [800, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/stage-composition-test");
    const sizes = await page.evaluate(async () => {
      await import("/node_modules/@neo-ui-kit/react/dist/styles.css");
      await import("/src/features/karaoke/karaoke.css");
      document.documentElement.style.setProperty("--ad-font-family-heading", "serif");
      const size = (selector: string) => parseFloat(getComputedStyle(document.querySelector(selector)!).fontSize);
      return ["current", "next"].map((line) => ({
        actual: size(`.lyrics .ad-lyrics-${line}`), original: size(`#original-${line}`),
      }));
    });
    for (const { actual, original } of sizes) expect(actual).toBeCloseTo(original * 1.5, 2);
  }
});

for (const width of [1920, 1830, 1440, 1100, 800]) {
  test(`console controls remain clickable and contained at ${width}px`, async ({ page }) => {
    await page.addInitScript(installDesktopBridge);
    await page.addInitScript(() => localStorage.setItem("adVoice.preferences.v1", JSON.stringify({ karaokeAutoHideConsole: false })));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await page.getByLabel("Бумбокс — Люди", { exact: true }).getByRole("button", { name: /Запустить караоке|Play karaoke|Почати караоке/i }).click();
    await expect(page.locator(".consolePanels")).toBeVisible({ timeout: 25_000 });
    await expect(page.locator(".karaokeIntro")).toBeHidden({ timeout: 25_000 });
    await expect.poll(() => page.locator(".ad-rotary-knob canvas").evaluateAll((canvases) =>
      canvases.every((node) => {
        const canvas = node as HTMLCanvasElement;
        return canvas.width === canvas.height && canvas.width > 0 &&
          canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data
            .some((value, index) => index % 4 === 3 && value > 0);
      })), { message: "Every rotary layer must finish painting after StrictMode setup" }).toBe(true);
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

test("the moving roll and lyric overlay avoid panel-wide filter surfaces", async ({ page }) => {
  await page.route("**/stage-composition-test", (route) =>
    route.fulfill({ contentType: "text/html", body: '<main class="karaokePage"><div class="pianoRollLane ad-melody-roll"></div><div class="lyrics lyricsFill ad-karaoke-lyrics"><p class="ad-lyrics-current">Text</p></div></main>' }));
  await page.goto("/stage-composition-test");
  const filters = await page.evaluate(async () => {
    await import("/node_modules/@neo-ui-kit/react/dist/styles.css");
    await import("/src/features/karaoke/show/show.css");
    return {
      roll: getComputedStyle(document.querySelector(".pianoRollLane")!, "::before").backdropFilter,
      lyrics: getComputedStyle(document.querySelector(".lyricsFill")!).filter,
    };
  });
  expect(filters).toEqual({ roll: "none", lyrics: "none" });
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

test("stage beams have soft lateral edges instead of solid triangles", async ({ page }) => {
  await page.route("**/stage-composition-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("/stage-composition-test");
  const pixels = await page.evaluate(async () => {
    const [{ CanvasLightRenderer }, { LightBatch }] = await Promise.all([
      import("/src/features/karaoke/show/gl/canvasLightRenderer.ts"),
      import("/src/features/karaoke/show/gl/lightBatch.ts"),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const batch = new LightBatch(1, 1);
    batch.beam(32, 0, Math.PI, 0.4, 64, [1, 0.2, 0.55], 0.6);
    CanvasLightRenderer.create(canvas)!.render(batch, 0, { width: 64, height: 64 }, {}, 0);
    const context = canvas.getContext("2d")!;
    return { centre: context.getImageData(32, 32, 1, 1).data[3], edge: context.getImageData(22, 32, 1, 1).data[3] };
  });
  expect(pixels.centre).toBeGreaterThanOrEqual(25);
  expect(pixels.edge).toBeLessThan(pixels.centre * 0.4);
});

test("animated light colours keep a bounded texture cache", async ({ page }) => {
  await page.route("**/stage-composition-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("/stage-composition-test");
  const cached = await page.evaluate(async () => {
    const [{ CanvasLightRenderer }, { LightBatch, spriteKind }] = await Promise.all([
      import("/src/features/karaoke/show/gl/canvasLightRenderer.ts"),
      import("/src/features/karaoke/show/gl/lightBatch.ts"),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const renderer = CanvasLightRenderer.create(canvas)!;
    const batch = new LightBatch(1, 1);
    for (let frame = 0; frame < 100; frame++) {
      batch.clear();
      batch.sprite(32, 32, 8, spriteKind.glow, [frame / 100, 0.2, 0.55], 1);
      renderer.render(batch, frame, { width: 64, height: 64 }, {}, 0);
    }
    return (renderer as unknown as { stamps: Map<string, unknown> }).stamps.size;
  });
  expect(cached).toBeLessThanOrEqual(64);
});

test("coloured and white words share one reacting lyric line", async ({ page }) => {
  const clock = new Date("2026-10-24T12:00:00Z");
  await page.clock.install({ time: clock });
  await page.clock.pauseAt(clock);
  await page.route("**/stage-composition-test", (route) =>
    route.fulfill({ contentType: "text/html", body: '<html><body><main class="karaokePage" id="stage-test"></main></body></html>' }));
  await page.goto("/stage-composition-test");
  await page.evaluate(async () => {
    const refresh = await import("/@react-refresh");
    refresh.default.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (value) => value;
    window.__vite_plugin_react_preamble_installed__ = true;
    await Promise.all([
      import("/node_modules/@neo-ui-kit/react/dist/styles.css"),
      import("/src/features/karaoke/karaoke.css"),
      import("/src/features/karaoke/show/show.css"),
    ]);
    const [{ default: { createElement } }, { default: { createRoot } }, { AppProvider }, { KaraokeStage }] = await Promise.all([
      import("/node_modules/.vite/deps/react.js"),
      import("/node_modules/.vite/deps/react-dom_client.js"),
      import("/src/app/AppContext.tsx"),
      import("/src/features/karaoke/KaraokeStage.tsx"),
    ]);
    const words = [
      { id: "a", text: "First", start: 0, end: 0.4 },
      { id: "b", text: "Second", start: 0.4, end: 0.8 },
      { id: "c", text: "Now", start: 1, end: 2 },
      { id: "d", text: "Future", start: 2.3, end: 4 },
    ];
    const root = createRoot(document.getElementById("stage-test")!);
    const render = (position: number, offset = 0) =>
      root.render(
        createElement(
          AppProvider,
          null,
          createElement(KaraokeStage, {
            songTitle: "Test",
            position,
            playing: true,
            rate: 1,
            document: {
              revision: 1,
              words: words.map((word) => ({
                ...word,
                start: word.start + offset,
                end: word.end + offset,
              })),
              notes: [],
              lyrics: "First Second Now Future",
              rhythm: [[2 + offset, 1]],
            },
            layers: { showLyrics: true, showNotes: false },
            vocalRange: "auto",
          }),
        ),
      );
    render(1.2);
    window.addEventListener("test-stage-position", (event) =>
      render((event as CustomEvent<number>).detail, 20),
    );
  });
  const filled = page.locator(".lyrics .ad-lyrics-current");
  await expect(filled).toHaveCount(1);
  await expect(page.locator(".lyrics")).toHaveCount(1);
  const words = filled.locator(".ad-lyric-word");
  await expect(words).toHaveCount(4);
  await page.clock.runFor(50);
  expect(await words.nth(0).evaluate((word) => word.style.getPropertyValue("--ad-lyric-fill"))).toBe("100%");
  expect(await words.nth(1).evaluate((word) => word.style.getPropertyValue("--ad-lyric-fill"))).toBe("100%");
  expect(await words.nth(3).evaluate((word) => word.style.getPropertyValue("--ad-lyric-fill"))).toBe("0%");
  const whiteWidth = (await words.nth(3).boundingBox())!.width;
  await page.evaluate(async () => {
    const { publishSpectrum } = await import("/src/app/backdrop/spectrumEvents.ts");
    publishSpectrum({ bands: [], backingBands: Array(18).fill(0), bass: 0, active: false });
    publishSpectrum({ bands: [], backingBands: Array(18).fill(1), bass: 1, active: true });
  });
  await page.clock.runFor(100);
  expect(
    await filled.evaluate((line) => new DOMMatrix(getComputedStyle(line).transform).a),
  ).toBeCloseTo(1, 3);
  expect((await words.nth(3).boundingBox())!.width).toBeCloseTo(whiteWidth, 1);
  await page.clock.runFor(600);
  let peakScale = 1;
  let peakWhiteWidth = whiteWidth;
  for (let frame = 0; frame < 12; frame++) {
    await page.clock.runFor(16);
    peakScale = Math.max(
      peakScale,
      await filled.evaluate((line) => new DOMMatrix(getComputedStyle(line).transform).a),
    );
    peakWhiteWidth = Math.max(
      peakWhiteWidth,
      (await words.nth(3).boundingBox())!.width,
    );
  }
  expect(peakScale).toBeGreaterThan(1.003);
  expect(peakScale).toBeLessThan(1.01);
  expect(peakWhiteWidth).toBeGreaterThan(whiteWidth * 1.003);
  for (const [position, count] of [
    [17.1, 3],
    [18.1, 2],
    [19.1, 1],
  ]) {
    await page.evaluate(
      (position) =>
        window.dispatchEvent(
          new CustomEvent("test-stage-position", { detail: position }),
        ),
      position,
    );
    await page.clock.runFor(16);
    await expect(page.getByRole("timer")).toHaveText(String(count));
    await expect(page.locator(".lyrics .ad-lyric-word")).toHaveCount(count === 1 ? 4 : 0);
    if (count !== 1) continue;
    expect(await words.evaluateAll((items) => items.map((word) => word.style.getPropertyValue("--ad-lyric-fill"))))
      .toEqual(["0%", "0%", "0%", "0%"]);
    const counter = (await page.getByRole("timer").boundingBox())!;
    const preview = (await filled.boundingBox())!;
    expect(counter.y + counter.height).toBeLessThan(preview.y);
  }
  await page.clock.runFor(300);
  await expect(page.getByRole("timer")).toHaveCount(0);
  await expect(page.locator(".lyrics .ad-lyric-word")).toHaveCount(4);
});
