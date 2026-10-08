import { expect, test } from "@playwright/test";

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
