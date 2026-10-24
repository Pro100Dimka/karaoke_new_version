import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
});

test("library cards stay sharp and wide, stats have no glare, and only editable text selects", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const card = page.locator(".songCard").first();
  await expect(card).toBeVisible();
  expect((await card.boundingBox())!.width).toBeGreaterThanOrEqual(382);
  await expect(card.locator(".ad-equalizer, .ad-tilt")).toHaveCount(0);
  await card.hover();
  await expect(card).toHaveCSS("transform", "none");
  await expect(card.locator("img")).toHaveCSS("transform", "none");
  await expect(card.locator("img")).toHaveCSS("filter", "none");
  await expect(page.locator(".libraryHero .ad-tilt")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toHaveCSS("user-select", "none");
  await expect(page.locator(".searchInput input")).toHaveCSS("user-select", "text");
  await page.screenshot({ path: testInfo.outputPath("library-wide.png") });
  await page.setViewportSize({ width: 640, height: 900 });
  const hero = page.locator(".libraryHero");
  const stats = hero.locator(".ad-stat-tile");
  await expect.poll(async () => {
    const boxes = await Promise.all((await stats.all()).map((stat) => stat.boundingBox()));
    return Math.max(...boxes.map((box) => box!.y)) - Math.min(...boxes.map((box) => box!.y));
  }).toBeLessThan(2);
  expect(await page.locator(".libraryPage").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("library-narrow.png") });
});

test("artist headings use the user's selected heading font", async ({ page }) => {
  await page.goto("/");
  const card = page.locator(".songCard").first();
  await expect(card).toBeVisible();
  await card.evaluate((element) => {
    (element as HTMLElement).style.setProperty("--ad-font-family-heading", '"Selected Heading", serif');
  });
  const artist = card.getByRole("heading", { name: "Бумбокс", level: 4 });
  await expect(artist).toHaveCSS("font-family", '"Selected Heading", serif');
});

test("artwork leads the song information on the left at wide and narrow widths", async ({ page }) => {
  for (const width of [1440, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const card = page.locator(".songCard").first();
    await expect(card.locator(".songCardCover")).toBeVisible();
    const cover = (await card.locator(".songCardCover").boundingBox())!;
    const content = (await card.locator(".songCardContent").boundingBox())!;
    expect(cover.x + cover.width).toBeLessThanOrEqual(content.x + 1);
    await expect(card.locator(".songCardCover")).toHaveCSS("object-fit", "contain");
  }
});

test("complete artwork and processing waveform fit inside equal height song cards", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const request = window.desktop.pythonRequest;
    window.desktop.pythonRequest = async (...args) => {
      const response = await request(...args);
      if (args[0].path.split("?")[0] === "/songs") {
        const body = response.body as { items: Record<string, unknown>[] };
        response.body = { ...body, items: [...body.items,
          { ...body.items[0], songId: "song-2", title: "Ліхтарі", status: "Processing" }] };
      }
      return response;
    };
  });
  for (const width of [1440, 960, 640]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    const cards = page.locator(".songCard");
    await expect(cards).toHaveCount(2);
    const processing = cards.filter({ hasText: "Ліхтарі" });
    const waveform = processing.locator(".processingSignal .ad-waveform");
    await expect(waveform).toBeVisible();
    await expect.soft(cards.first().locator(".songCardCover")).toHaveCSS("object-fit", "contain");
    const readyBox = (await cards.first().boundingBox())!;
    const cardBox = (await processing.boundingBox())!;
    const waveBox = (await waveform.boundingBox())!;
    const actionsBox = (await processing.locator(".songCardActions").boundingBox())!;
    expect(Math.abs(cardBox.height - readyBox.height)).toBeLessThan(2);
    expect(waveBox.height).toBeLessThanOrEqual(36);
    expect(waveBox.y + waveBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height - 8);
    expect(waveBox.y).toBeGreaterThanOrEqual(actionsBox.y);
    expect(waveBox.y + waveBox.height).toBeLessThanOrEqual(actionsBox.y + actionsBox.height);
    const buttonBox = (await processing.locator(".songCardActions button").first().boundingBox())!;
    expect(waveBox.x).toBeGreaterThanOrEqual(buttonBox.x + buttonBox.width);
    await page.screenshot({ path: testInfo.outputPath(`cards-${width}.png`) });
  }
});

test("theme backdrop covers the title bar as well as the library", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();
  const backdrop = page.locator(".appTheme");
  const titleBar = page.locator(".titleBar");
  const backgroundBox = await backdrop.boundingBox();
  const titleBox = await titleBar.boundingBox();
  expect(backgroundBox?.y).toBe(0);
  expect(titleBox?.y).toBe(0);
  expect(backgroundBox?.width).toBe(page.viewportSize()?.width);
  await expect(backdrop).toHaveCSS("background-image", new RegExp("dark(?:-[\\w-]+)?\\.webp"));
  await expect(backdrop).toHaveCSS("background-size", "cover");
  await expect(backdrop).toHaveCSS("background-attachment", "fixed");
  await expect(titleBar).toHaveCSS("background-image", "none");
  await expect(page.locator(".app")).toHaveCSS("background-image", "none");
});

for (const theme of ["dark", "light", "green", "violet"]) {
  test(`library displays the ${theme} theme picture under QuantumBackground`, async ({ page }) => {
    await page.addInitScript((theme) => {
      localStorage.setItem("adVoice.preferences.v1", JSON.stringify({ theme }));
    }, theme);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();
    const backdrop = page.locator(".appTheme");
    await expect(backdrop).toHaveCSS("background-image", new RegExp(`${theme}(?:-[\\w-]+)?\\.webp`));
    await expect(backdrop).toHaveCSS("background-size", "cover");
    await expect(backdrop).toHaveCSS("background-repeat", "no-repeat");
    await expect(page.locator(".titleBar")).toHaveCSS("background-image", "none");
    await expect(page.locator(".app")).toHaveCSS("background-image", "none");
    await expect(page.locator(".libraryPage")).toHaveCSS("background-image", "none");
    await expect(page.getByTitle("Quantum Fields visualizer")).toHaveCount(0);
    expect(await backdrop.evaluate(async (element) => {
      const url = getComputedStyle(element).backgroundImage.match(/^url\("?(.*?)"?\)$/)?.[1];
      if (!url) return false;
      const image = new Image();
      image.src = url;
      await image.decode();
      return image.naturalWidth > 0;
    })).toBe(true);
    await expect(page.locator('[data-ad-component="QuantumField"]')).toHaveCount(0);
    await expect(page.locator(".quantumFieldBackdrop")).toHaveCount(0);
    // The theme picture stays the backdrop; the field is drawn over it, edge to edge.
    await expect(page.locator(".libraryBackdrop")).toHaveCount(1);
    await expect(page.getByTitle("Quantum Background visualizer")).toHaveCount(1);
  });
}

test("library shows the backend song and opens Karaoke with real lyrics", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A&D Voice" })).toBeVisible();
  await expect(page.getByText("Люди").first()).toBeVisible();

  await page
    .getByRole("button", {
      name: /Запустить караоке|Play karaoke|Почати караоке/i,
    })
    .first()
    .click();

  await expect(page).toHaveURL(/karaoke\/song-1/);
  await expect(page.getByRole("region", { name: "Люди" })).toContainText(
    "Люди",
  );
});

test("song card controls stay still long enough to receive a real pointer click", async ({
  page,
}) => {
  await page.goto("/");
  const play = page
    .getByRole("button", {
      name: /Запустить караоке|Play karaoke|Почати караоке/i,
    })
    .first();

  await expect(play).toBeVisible();
  await play.click();

  await expect(page).toHaveURL(/karaoke\/song-1/);
});

test("system window buttons stay clickable above an open modal", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    for (const action of ["minimize", "toggleFullscreen", "close"] as const) {
      window.desktop[action] = async () => {
        document.documentElement.dataset.windowAction = action;
        const key = `calls${action}`;
        document.documentElement.dataset[key] = String(Number(document.documentElement.dataset[key] ?? 0) + 1);
        return false;
      };
    }
  });
  await page
    .getByRole("button", { name: /Настройки|Settings|Налаштування/i })
    .first()
    .click();
  const dialog = page.locator("dialog:modal");
  await expect(dialog).toBeVisible();
  const close = page.getByRole("button", {
    name: /Закрыть окно|Close window|Закрити вікно/i,
  });
  await expect(close).toBeVisible();
  const box = await close.boundingBox();
  const topElement = await page.evaluate(
    ({ x, y }) =>
      document
        .elementFromPoint(x, y)
        ?.closest("button")
        ?.getAttribute("aria-label") ?? "",
    { x: (box?.x ?? 0) + 4, y: (box?.y ?? 0) + 4 },
  );
  expect(topElement).toMatch(/Закрыть окно|Close window|Закрити вікно/i);
  const toolbar = page.locator(".titleBarControls");
  await expect(toolbar).toHaveCount(1);
  const bounds = await toolbar.boundingBox();
  expect(bounds?.y).toBe(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBe(page.viewportSize()?.width);
  expect(bounds?.height).toBeLessThan(60);
  for (const [name, action] of [
    [/Свернуть|Minimize|Згорнути/i, "minimize"],
    [/На весь экран|Full screen|На весь екран/i, "toggleFullscreen"],
    [/Закрыть окно|Close window|Закрити вікно/i, "close"],
  ] as const) {
    const button = toolbar.getByRole("button", { name });
    await button.click();
    await expect(page.locator("html")).toHaveAttribute("data-window-action", action);
    await expect(button).toBeFocused();
    await button.press("Enter");
    expect(await page.locator("html").evaluate((element, action) => (element as HTMLElement).dataset[`calls${action}`], action)).toBe("2");
    await expect(dialog).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".titleBar > .titleBarControls")).toHaveCount(1);
  await expect(page.locator(".titleBarControls:popover-open")).toHaveCount(0);
});

test("window controls follow modal opening order and survive top modal removal", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".titleBarControls")).toBeVisible();
  await page.evaluate(() => {
    for (const id of ["top-modal", "lower-modal"]) {
      const dialog = document.createElement("dialog");
      dialog.id = id;
      dialog.innerHTML = '<button autofocus>Dialog action</button>';
      dialog.style.cssText = "width: 200px; height: 100px; overflow: hidden; transform: scale(.9)";
      document.body.append(dialog);
    }
    (document.getElementById("lower-modal") as HTMLDialogElement).showModal();
    (document.getElementById("top-modal") as HTMLDialogElement).showModal();
  });
  const close = page.getByRole("button", { name: /Закрыть окно|Close window|Закрити вікно/i });
  await expect(page.locator("#top-modal .titleBarControls")).toBeVisible();
  await expect(page.locator("#top-modal > button")).toBeFocused();
  await page.setViewportSize({ width: 640, height: 480 });
  const bounds = await page.locator(".titleBarControls").boundingBox();
  expect(bounds?.y).toBe(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBe(640);
  await close.click();
  await expect(close).toBeFocused();
  await page.evaluate(() => document.getElementById("top-modal")?.remove());
  await expect(page.locator("#lower-modal .titleBarControls")).toBeVisible();
  await close.click();
  await expect(close).toBeFocused();
  await page.evaluate(() => (document.getElementById("lower-modal") as HTMLDialogElement).close());
  await expect(page.locator(".titleBar > .titleBarControls")).toBeVisible();
  await expect(page.locator(".titleBarControls")).toHaveCount(1);
  await expect(page.locator(".titleBarControls:popover-open")).toHaveCount(0);
});

test("song import opens the native picker and karaoke piano roll matches the user flow", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const pickAudioFiles = window.desktop.pickAudioFiles;
    window.desktop.pickAudioFiles = async () => {
      document.documentElement.dataset.audioPickerOpened = "true";
      return pickAudioFiles();
    };
  });
  await page
    .getByRole("button", { name: /Добавить песню|Add song|Додати пісню/i })
    .first()
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-audio-picker-opened",
    "true",
  );
  // Picking a file imports it at once; no in-app picker dialog is shown in between.
  await expect(
    page.getByRole("dialog", { name: /Добавить песню|Add song|Додати пісню/i }),
  ).toBeHidden();

  await page
    .getByRole("button", {
      name: /Запустить караоке|Play karaoke|Почати караоке/i,
    })
    .first()
    .click();
  const keyboard = page.getByRole("img", {
    name: /Клавиатура|Keyboard|Клавіатура/i,
  });
  await expect(keyboard).toBeVisible();
  const keys = (await keyboard.innerText())
    .split(/\s+/)
    .filter((name) => /^[A-G]#?\d$/.test(name));
  expect(keys.length).toBeGreaterThan(4);
});
