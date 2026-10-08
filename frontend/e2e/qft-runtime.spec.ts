import { expect, test } from "@playwright/test";

test.use({ deviceScaleFactor: 1 });

test.beforeEach(async ({ page }) => {
  await page.route("**/qft-runtime-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><script type="module" src="/src/app/backdrop/qftRuntime.js"></script></body></html>',
    }),
  );
  await page.addInitScript(() => {
    const prototype = WebGL2RenderingContext.prototype;
    const framebufferTexture2D = prototype.framebufferTexture2D;
    const deleteFramebuffer = prototype.deleteFramebuffer;
    const framebuffers = new Set<WebGLFramebuffer>();
    const publishBuffers = () =>
      (document.documentElement.dataset.framebuffers = String(
        framebuffers.size,
      ));
    prototype.framebufferTexture2D = function (...args) {
      framebufferTexture2D.apply(this, args);
      const buffer: WebGLFramebuffer | null = this.getParameter(
        this.FRAMEBUFFER_BINDING,
      );
      if (buffer && args[3]) framebuffers.add(buffer);
      publishBuffers();
    };
    prototype.deleteFramebuffer = function (buffer) {
      if (buffer) framebuffers.delete(buffer);
      publishBuffers();
      deleteFramebuffer.call(this, buffer);
    };
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const pending = new Set<number>();
    let requested = 0;
    const publish = () =>
      (document.documentElement.dataset.pendingFrames = String(pending.size));
    window.requestAnimationFrame = (callback) => {
      document.documentElement.dataset.requestedFrames = String(++requested);
      const id = request((time) => {
        pending.delete(id);
        publish();
        callback(time);
      });
      pending.add(id);
      publish();
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      pending.delete(id);
      publish();
      cancel(id);
    };
  });
  await page.goto("/qft-runtime-test");
  await expect(page.locator("canvas")).toBeVisible();
});

test("uses the display pixel ratio and updates buffers when it changes", async ({
  page,
}) => {
  // The backdrop scales its own resolution down on a slow GPU (as headless Chromium's is), so the
  // canvas is compared with its own width at ratio 1; above 1.45 the ratio is clamped.
  const canvasWidth = async () =>
    Number(await page.locator("canvas").getAttribute("width"));
  const base = await canvasWidth();
  for (const ratio of [1.5, 3, 1]) {
    await page.evaluate((value) => {
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        value,
      });
      window.dispatchEvent(new Event("resize"));
    }, ratio);
    await expect
      .poll(async () => (await canvasWidth()) / base)
      .toBeCloseTo(Math.min(ratio, 1.45), 1);
  }
});

test("stops scheduling while hidden and resumes one loop when visible", async ({
  page,
}) => {
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-pending-frames",
    "0",
  );
  const beforeVisible = Number(await page.locator("html").getAttribute("data-requested-frames"));
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(async () =>
    Number(await page.locator("html").getAttribute("data-requested-frames")),
  ).toBeGreaterThan(beforeVisible);
  await expect(page.locator("html")).toHaveAttribute("data-pending-frames", "0");
});

test("sleeps after a silent scene settles and wakes for theme and audio", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute(
    "data-pending-frames",
    "0",
    { timeout: 5000 },
  );
  const initial = Number(await page.locator("html").getAttribute("data-requested-frames"));
  await page.evaluate(() => window.postMessage({ type: "QFT_TICK" }, "*"));
  await page.waitForTimeout(100);
  expect(Number(await page.locator("html").getAttribute("data-requested-frames"))).toBe(initial);
  await page.evaluate(() => window.postMessage({
    type: "QFT_THEME",
    theme: "dark",
    backgroundColor: "transparent",
    backgroundImage: "none",
    palette: {
      primary: "#00ff88",
      primaryHover: "#33ffaa",
      secondary: "#00ffcc",
      accent: "#66ffbb",
      highlight: "#99ffdd",
    },
  }, "*"));
  await expect.poll(async () =>
    Number(await page.locator("html").getAttribute("data-requested-frames")),
  ).toBeGreaterThan(initial);
  await expect(page.locator("html")).toHaveAttribute(
    "data-pending-frames",
    "0",
    { timeout: 5000 },
  );
  const afterTheme = Number(await page.locator("html").getAttribute("data-requested-frames"));
  await page.evaluate(() => window.postMessage({
    type: "QFT_AUDIO", bands: Array(18).fill(0.4), bass: 0.4, active: true,
  }, "*"));
  await expect.poll(async () =>
    Number(await page.locator("html").getAttribute("data-requested-frames")),
  ).toBeGreaterThan(afterTheme);
  await expect(page.locator("html")).toHaveAttribute("data-pending-frames", "1");
});

test("suspends a lost WebGL context and resumes after restoration", async ({
  page,
}) => {
  await page
    .locator("canvas")
    .dispatchEvent("webglcontextlost", { cancelable: true });
  await expect(page.locator("html")).toHaveAttribute(
    "data-pending-frames",
    "0",
  );
  const beforeRestore = Number(await page.locator("html").getAttribute("data-requested-frames"));
  await page.locator("canvas").dispatchEvent("webglcontextrestored");
  await expect.poll(async () =>
    Number(await page.locator("html").getAttribute("data-requested-frames")),
  ).toBeGreaterThan(beforeRestore);
  await expect(page.locator("html")).toHaveAttribute("data-pending-frames", "0");
});

test("disposes every postprocessing pass and cancels the animation", async ({
  page,
}) => {
  await expect
    .poll(async () =>
      Number(await page.locator("html").getAttribute("data-framebuffers")),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => window.postMessage({ type: "QFT_DISPOSE" }, "*"));
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-framebuffers", "0");
  await expect(page.locator("html")).toHaveAttribute(
    "data-pending-frames",
    "0",
  );
});
