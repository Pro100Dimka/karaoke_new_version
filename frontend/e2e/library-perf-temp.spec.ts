import { test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("measure library renders", async ({ page }) => {
  page.on("pageerror", (error) => console.log("PAGE ERROR", error.message));
  await page.addInitScript({
    content: `
      window.__renderCounts = {};
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject(renderer) { this.renderers.set(1, renderer); return 1; },
        onCommitFiberRoot(_id, root) {
          const visit = (fiber) => {
            if (!fiber) return;
            const name = fiber.type?.name || fiber.elementType?.name;
            if ((fiber.flags & 1) && ["LibraryPage", "VirtualGrid", "SongCard", "LibraryActions"].includes(name)) {
              window.__renderCounts[name] = (window.__renderCounts[name] || 0) + 1;
            }
            visit(fiber.child);
            visit(fiber.sibling);
          };
          visit(root.current.child);
        },
      };
      (${installDesktopBridge.toString()})();
      const original = window.desktop.pythonRequest;
      window.desktop.pythonRequest = async (request) => {
        if (request.path.split("?")[0] === "/songs") {
          const seed = (await original(request)).body.items[0];
          return {status: 200, ok: true, body: {items: Array.from({length: 500}, (_, i) => ({
            ...seed, songId: "song-" + i, title: "Песня " + i, artist: "Исполнитель " + (i % 30),
          })), nextCursor: null}};
        }
        return original(request);
      };
    `,
  });
  await page.goto("/");
  await page.waitForTimeout(1500);
  console.log("BODY", (await page.locator("body").innerText()).slice(0, 500));
  await page.getByRole("heading", { name: "A&D Voice" }).waitFor();
  await page.waitForTimeout(1000);
  await page.evaluate(() => ((window as any).__renderCounts = {}));
  await page.waitForTimeout(5300);
  const idle = await page.evaluate(() => ({
    renders: (window as any).__renderCounts,
    mountedCards: document.querySelectorAll(".songCard").length,
  }));
  console.log("IDLE", JSON.stringify(idle));
  await page.evaluate(() => ((window as any).__renderCounts = {}));
  const search = page.locator("input").first();
  await search.fill("Песня 42");
  await page.waitForTimeout(500);
  const typed = await page.evaluate(() => ({
    renders: (window as any).__renderCounts,
    mountedCards: document.querySelectorAll(".songCard").length,
  }));
  console.log(JSON.stringify({ idle, typed }));
});
