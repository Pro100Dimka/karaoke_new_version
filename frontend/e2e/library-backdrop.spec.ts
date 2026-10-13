import { expect, test, type Page } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
});

/**
 * How much of the backdrop moves: the share of pixels whose brightness changes between frames a
 * quarter of a second apart. The static theme picture cancels out; reaction lines, flashes and the
 * field's response to sound remain.
 */
const motion = async (page: Page, frames = 8) => {
  const backdrop = page.locator(".libraryBackdrop");
  // Each frame is compared with the previous one inside the page; only the share comes back.
  const changedSincePrevious = async () => {
    const png = await backdrop.screenshot();
    return page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const luma = new Float32Array(pixels.length / 4);
      for (let p = 0; p < luma.length; p++)
        luma[p] = 0.2126 * pixels[p * 4]! + 0.7152 * pixels[p * 4 + 1]! + 0.0722 * pixels[p * 4 + 2]!;
      const store = window as unknown as { e2ePreviousFrame?: Float32Array };
      const previous = store.e2ePreviousFrame;
      store.e2ePreviousFrame = luma;
      if (!previous || previous.length !== luma.length) return null;
      let changed = 0;
      for (let p = 0; p < luma.length; p++) if (Math.abs(luma[p]! - previous[p]!) > 40) changed++;
      return (changed / luma.length) * 100;
    }, png.toString("base64"));
  };
  await page.evaluate(() => { delete (window as unknown as { e2ePreviousFrame?: unknown }).e2ePreviousFrame; });
  await changedSincePrevious();
  const samples: number[] = [];
  for (let i = 0; i < frames; i++) {
    await page.waitForTimeout(250);
    samples.push((await changedSincePrevious()) ?? 0);
  }
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
};

test("the Library backdrop reacts to the radio and to the singer's voice", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();
  const frame = page.frameLocator(".libraryBackdrop iframe");
  await expect(frame.locator("canvas")).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(4000);
  const silent = await motion(page);

  // Radio: AudioService's 18 output bands with a beat.
  await page.evaluate(() => {
    let t = 0;
    setInterval(() => {
      t += 50;
      const kick = Math.max(0, 1 - (t % 500) / 140);
      const bands = Array.from({ length: 18 }, (_, band) =>
        Math.min(1, band < 4 ? 0.45 + kick * 0.5 : 0.35 + 0.3 * Math.max(0, Math.sin(t / 300 + band / 2))));
      Object.assign(window, { e2eAudio: { ...(window as unknown as { e2eAudio?: object }).e2eAudio, bands } });
    }, 50);
  });
  await page.waitForTimeout(2500);
  const radio = await motion(page);
  await page.screenshot({ path: "test-results/library-backdrop-radio.png" });

  // Radio off, monitoring off: only the microphone hears the singer.
  await page.reload();
  await expect(frame.locator("canvas")).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    let t = 0;
    setInterval(() => {
      t += 50;
      // Sung phrases: about −12 dBFS with syllables, then a breath.
      const phrase = (t % 1600) < 1200 ? 0.25 + 0.15 * Math.abs(Math.sin(t / 90)) : 0.002;
      Object.assign(window, { e2eAudio: { bands: Array(18).fill(0), rms: phrase } });
    }, 50);
  });
  await page.waitForTimeout(2500);
  const voice = await motion(page);
  await page.screenshot({ path: "test-results/library-backdrop-voice.png" });

  test.info().annotations.push({ type: "motion", description: JSON.stringify({ silent, radio, voice }) });
  console.log(JSON.stringify({ silent, radio, voice }));
  expect(radio).toBeGreaterThan(silent * 2);
  expect(voice).toBeGreaterThan(silent * 2);
});
