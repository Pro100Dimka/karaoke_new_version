import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("room border controls stay in place above the border with an opaque contrasting surface", async ({
  page,
}, testInfo) => {
  await page.addInitScript(installDesktopBridge);
  await page.goto("/");
  await page.evaluate(async () => {
    const reactPath = "/node_modules/.vite/deps/react.js";
    const domPath = "/node_modules/.vite/deps/react-dom_client.js";
    const appPath = "/src/app/AppContext.tsx";
    const cardPath = "/src/features/room/RoomHeadCard.tsx";
    const [react, dom, { AppProvider }, { RoomHeadCard }] = await Promise.all([
      import(reactPath),
      import(domPath),
      import(appPath),
      import(cardPath),
    ]);
    const { createElement } = react.default ?? react;
    const { createRoot } = dom.default ?? dom;
    const surface = document.createElement("aside");
    surface.className = "roomDock";
    surface.style.top = "70px";
    surface.style.left = "30px";
    surface.style.bottom = "auto";
    document.body.append(surface);
    const clicks = Object.assign(window, {
      borderControlClicks: [] as string[],
    });
    const actions = Object.fromEntries(
      [
        "onCopy",
        "onCollapse",
        "onCancelTransfer",
        "onRetryTransfer",
        "onReplaceProject",
        "onLeave",
      ].map((name) => [name, () => clicks.borderControlClicks.push(name)]),
    );
    createRoot(surface).render(
      createElement(
        AppProvider,
        null,
        createElement(RoomHeadCard, {
          room: {
            code: "176436fb-9a21-43b5-ba04",
            participants: [],
            connectionStatus: "connected",
          },
          actions: { ...actions, copied: false, detached: false },
        }),
      ),
    );
  });
  const controls = page.locator(".roomFrameControls");
  await expect(controls).toBeVisible();
  const metrics = await controls.evaluate((element) => {
    const style = getComputedStyle(element);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return {
      top: parseFloat(style.top) / rem,
      right: parseFloat(style.right) / rem,
      layer: Number(style.zIndex) || 0,
      borderLayer:
        Number(
          getComputedStyle(
            element.closest(".roomHead")!.querySelector(".ad-border")!,
          ).zIndex,
        ) || 0,
      background: style.backgroundColor,
      iconSizes: [...element.querySelectorAll("button")].map((button) =>
        parseFloat(getComputedStyle(button).fontSize),
      ),
      hits: [...element.querySelectorAll("button")].map((button) => {
        const box = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ),
        );
      }),
    };
  });
  expect(metrics.top).toBeCloseTo(-0.7, 2);
  expect(metrics.right).toBeCloseTo(0.65, 2);
  expect(metrics.hits).toEqual([true, true]);
  expect(metrics.layer, JSON.stringify(metrics)).toBeGreaterThan(
    metrics.borderLayer,
  );
  expect(metrics.background).toMatch(/^rgb\(/);
  expect(metrics.iconSizes.every((size) => size >= 14)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("room-controls.png") });
  await controls
    .getByRole("button", { name: "Свернуть комнату", exact: true })
    .click();
  await controls
    .getByRole("button", { name: "Выйти из комнаты", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as any).borderControlClicks),
  ).toEqual(["onCollapse", "onLeave"]);
});

test("room modal offers creating a room and joining one by code", async ({
  page,
}) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("button", { name: /Онлайн-комната|Online room|Онлайн-кімната/i })
    .click();
  const dialog = page.getByRole("dialog", {
    name: /Пойте вместе|Sing together|Співайте разом/i,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: /^(Имя|Name|Ім'я)$/i }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: /Создать комнату|Create room|Створити кімнату/i,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: /Код комнаты|Room code|Код кімнати/i }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: /Войти в комнату|Join room|Увійти в кімнату/i,
    }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/shot-room-modal.png" });
});

test("room modal stays above fixed application chrome when native modal top-layer is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: undefined,
    });
  });
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("button", { name: /Онлайн-комната|Online room|Онлайн-кімната/i })
    .click();

  const dialog = page.getByRole("dialog", {
    name: /Пойте вместе|Sing together|Співайте разом/i,
  });
  const create = dialog.getByRole("button", {
    name: /Создать комнату|Create room|Створити кімнату/i,
  });
  await expect(dialog).toBeVisible();
  await expect(create).toBeVisible();

  const layers = await page.evaluate(() => ({
    dialog: Number.parseInt(
      getComputedStyle(document.querySelector(".roomEntryDialog")!).zIndex,
      10,
    ),
    system: Number.parseInt(
      getComputedStyle(document.querySelector(".titleBar")!).zIndex,
      10,
    ),
  }));
  expect(layers.dialog).toBeGreaterThan(layers.system);
  await create.click();
});
