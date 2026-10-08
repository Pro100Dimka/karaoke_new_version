import { expect, test } from "@playwright/test";

test("the karaoke light canvas leaves unlit pixels transparent", async ({ page }) => {
  await page.route("**/stage-composition-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
  );
  await page.goto("/stage-composition-test");
  const composition = await page.evaluate(async () => {
    await import("/src/features/karaoke/show/show.css");
    const [{ LightRenderer }, { LightBatch }] = await Promise.all([
      import("/src/features/karaoke/show/gl/lightRenderer.ts"),
      import("/src/features/karaoke/show/gl/lightBatch.ts"),
    ]);
    const canvas = document.createElement("canvas");
    canvas.className = "showFx";
    document.body.className = "karaokePage";
    canvas.width = canvas.height = 64;
    document.body.append(canvas);
    const renderer = LightRenderer.create(canvas);
    if (!renderer) throw new Error("WebGL2 unavailable");
    renderer.render(new LightBatch(1, 1), 0, { width: 64, height: 64 }, {}, 0);
    const pixel = new Uint8Array(4);
    canvas.getContext("webgl2")?.readPixels(32, 32, 1, 1, WebGL2RenderingContext.RGBA,
      WebGL2RenderingContext.UNSIGNED_BYTE, pixel);
    renderer.dispose();
    return { alpha: pixel[3], blend: getComputedStyle(canvas).mixBlendMode };
  });
  expect(composition).toEqual({ alpha: 0, blend: "normal" });
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
