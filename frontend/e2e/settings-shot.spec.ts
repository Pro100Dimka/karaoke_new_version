import { expect, test, type Page } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

const settleSettings = (page: Page) => page.screenshot({ animations: "disabled" });

const settingsTabs = [
  { name: /Внешний вид|Appearance/i, content: ".appearanceLayout", key: "appearance" },
  { name: /^Аудио$|^Audio$/i, content: ".audioConsole", key: "audio" },
  { name: /AI \/ Обработка|AI \/ Processing/i, content: ".aiModels", key: "ai" },
  { name: /Ключи ENV|ENV keys/i, content: ".environmentForm", key: "environment" },
  { name: /Дополнительно|Advanced/i, content: ".advancedGrid", key: "advanced" },
];

test("settings size to their contents without artificial scrolling or empty space", async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { e2eSettingsHistory: true }); });
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");
  await page.getByRole("button", { name: /Настройки|Settings/i }).first().click();
  const heights: number[] = [];
  for (const tab of settingsTabs.filter(({ key }) => key !== "environment")) {
    await page.getByRole("tab", { name: tab.name }).click();
    await expect(page.locator(tab.content)).toBeVisible();
    await settleSettings(page);
    const bounds = await page.locator(".settingsBody").evaluate((element) => ({
      overflow: element.scrollHeight - element.clientHeight,
      spare: element.getBoundingClientRect().bottom - element.firstElementChild!.getBoundingClientRect().bottom,
    }));
    expect(bounds.overflow, tab.key).toBeLessThanOrEqual(1);
    expect(bounds.spare, tab.key).toBeLessThanOrEqual(12);
    heights.push((await page.locator(".settingsDialog").boundingBox())!.height);
  }
  expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(80);
});

test("advanced navigation stays inside the tab track while selecting", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /Настройки|Settings/i }).first().click();
  await settleSettings(page);
  await page.getByRole("tab", { name: /Дополнительно|Advanced/i }).click();
  const overflow = await page.locator(".settingsNav").evaluate(async (element) => {
    const track = element.getBoundingClientRect();
    let maximum = 0;
    for (let frame = 0; frame < 45; frame++) {
      await new Promise(requestAnimationFrame);
      const blade = element.querySelector(".ad-tabs-indicator")!.getBoundingClientRect();
      maximum = Math.max(maximum, blade.right - track.right, track.left - blade.left);
    }
    return maximum;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  const widths = await page.locator(".settingsNav > .ad-tab").evaluateAll((tabs) =>
    tabs.map((tab) => tab.getBoundingClientRect().width),
  );
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(2);
});

for (const width of [1440, 1280]) {
  test(`audio device layout remains usable across Windows and ASIO drivers at ${width}`, async ({ page }) => {
    await page.addInitScript(() => { Object.assign(window, { e2eAudioSettings: true }); });
    await page.addInitScript(installDesktopBridge);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: /Настройки|Settings/i }).first().click();
    await page.getByRole("tab", { name: /^Аудио$|^Audio$/i }).click();
    const backend = page.getByRole("button", { name: /^(Драйвер|Driver) / });
    const input = page.getByRole("button", { name: /^(Устройство ввода|Input device) / });
    const output = page.getByRole("button", { name: /^(Устройство вывода|Output device) / });
    await expect(backend).toContainText(/Windows/);
    await expect(page.getByRole("switch", { name: /Минимальная задержка микрофона|Minimum microphone latency/i })).toBeVisible();
    for (const state of ["windows", "audient-asio", "asio4all", "windows-return"]) {
      if (state === "audient-asio") {
        await backend.click();
        await page.getByRole("option", { name: "ASIO", exact: true }).click();
        await expect(page.getByRole("region", { name: "ASIO4ALL", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /Настроить устройства|Configure devices/i })).toBeVisible();
      }
      if (state === "audient-asio" || state === "asio4all") {
        const name = state === "audient-asio" ? "Audient USB Audio ASIO" : "ASIO4ALL v2";
        await input.click();
        await page.getByRole("option", { name, exact: true }).click();
        await expect(input).toContainText(name);
        await expect(output).toContainText(name);
        await expect(page.locator(".audioLatencyPanel").getByRole("button", { name: /^(Буфер|Buffer) / })).toBeVisible();
        await expect(page.locator(".audioDevicesPanel").getByRole("switch", { name: /Освобождать ASIO в фоне|Release ASIO in background/i })).toBeVisible();
        await expect(page.getByRole("region", { name: "ASIO4ALL", exact: true })).toHaveCount(state === "asio4all" ? 1 : 0);
      } else if (state === "windows-return") {
        await backend.click();
        await page.getByRole("option", { name: "Windows", exact: true }).click();
        await expect(page.getByRole("switch", { name: /Минимальная задержка микрофона|Minimum microphone latency/i })).toBeVisible();
        await expect(page.getByRole("switch", { name: /Освобождать ASIO в фоне|Release ASIO in background/i })).toHaveCount(0);
      }
      await settleSettings(page);
      const rateBox = (await page.getByRole("button", { name: /^(Частота дискретизации|Sample rate) / }).boundingBox())!;
      expect(Math.abs((await backend.boundingBox())!.y - rateBox.y)).toBeLessThan(1);
      const inputBox = (await input.boundingBox())!;
      const outputBox = (await output.boundingBox())!;
      expect(inputBox.width).toBeGreaterThan(260);
      expect(outputBox.y).toBeGreaterThan(inputBox.y + inputBox.height + 8);
      expect(await page.locator(".settingsBody").evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
      await page.mouse.move(0, 0);
      await page.screenshot({ animations: "disabled", path: `test-results/audio-${width}-${state}.png` });
    }
  });
}

test("advanced history has full-width desktop columns and no inner vertical scroll", async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { e2eSettingsHistory: true }); });
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: /Настройки|Settings/i }).first().click();
  await page.getByRole("tab", { name: /Дополнительно|Advanced/i }).click();
  const history = page.locator(".advancedHistoryCard");
  await expect(history.getByRole("columnheader")).toHaveCount(3);
  await expect(history.getByRole("cell").first()).toBeVisible();
  await settleSettings(page);
  expect((await history.boundingBox())!.y).toBeLessThan(580);
  const headers = await history.getByRole("columnheader").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().y));
  expect(Math.max(...headers) - Math.min(...headers)).toBeLessThan(2);
  expect((await history.boundingBox())!.width).toBeGreaterThan(1100);
  const nestedScroll = await history.evaluate((element) => [...element.querySelectorAll("*")].filter((child) =>
    /auto|scroll/.test(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight + 1,
  ).length);
  expect(nestedScroll).toBe(0);
  await page.screenshot({ animations: "disabled", path: "test-results/advanced-history-desktop.png" });
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 760, height: 640 },
]) {
  test(`settings keep navigation anchored and content reachable at ${viewport.width}`, async ({ page }) => {
    await page.addInitScript(() => { Object.assign(window, { e2eSettingsHistory: true }); });
    await page.addInitScript(installDesktopBridge);
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByRole("button", { name: /Настройки|Settings/i }).first().click();
    const dialog = page.locator(".settingsDialog");
    const nav = page.locator(".settingsNav");
    const body = page.locator(".settingsBody");
    await expect(page.locator(".appearanceLayout")).toBeVisible();
    await settleSettings(page);
    const originalDialog = (await dialog.boundingBox())!;
    const originalNav = (await nav.boundingBox())!;

    for (const tab of settingsTabs) {
      await page.getByRole("tab", { name: tab.name }).click();
      await expect(page.locator(tab.content)).toBeVisible();
      await settleSettings(page);
      const currentDialog = (await dialog.boundingBox())!;
      const currentNav = (await nav.boundingBox())!;
      for (const dimension of ["x", "y", "width"] as const) {
        expect(Math.abs(currentDialog[dimension] - originalDialog[dimension]), tab.key).toBeLessThan(2);
        expect(Math.abs(currentNav[dimension] - originalNav[dimension]), tab.key).toBeLessThan(2);
      }
      const contentBounds = await body.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const content = element.firstElementChild!.getBoundingClientRect();
        return {
          horizontalOverflow: element.scrollWidth - element.clientWidth,
          topGap: content.top - bounds.top,
          bottomGap: bounds.bottom - content.bottom,
          navGap: bounds.top - document.querySelector(".settingsNav")!.getBoundingClientRect().bottom,
          shellScroll: element.closest(".ad-dialog-body")!.scrollHeight - element.closest(".ad-dialog-body")!.clientHeight,
          clippedControls: [...element.querySelectorAll(".ad-field, .ad-file-picker, .ad-rotary-knob")]
            .filter((control) => {
              const box = control.getBoundingClientRect();
              return box.width > 0 && (box.left < bounds.left || box.right > bounds.right + 1);
            })
            .map((control) => control.getAttribute("aria-label") ?? control.textContent?.slice(0, 80)),
        };
      });
      expect(contentBounds.horizontalOverflow, tab.key).toBeLessThanOrEqual(1);
      expect(contentBounds.shellScroll, tab.key).toBeLessThanOrEqual(1);
      expect(contentBounds.clippedControls, tab.key).toEqual([]);
      expect(contentBounds.navGap + contentBounds.topGap, tab.key).toBeGreaterThanOrEqual(16);
      if (tab.key === "appearance") {
        if (viewport.width >= 1280) {
          expect(contentBounds.bottomGap).toBeGreaterThanOrEqual(3);
          expect(contentBounds.bottomGap).toBeLessThanOrEqual(24);
        }
        const labelClearance = await page.locator(".appearanceInterfacePanel").evaluate((element) =>
          element.getBoundingClientRect().bottom - Math.max(...[...element.querySelectorAll(".ad-checkbox")]
            .map((label) => label.getBoundingClientRect().bottom)),
        );
        expect(labelClearance).toBeGreaterThanOrEqual(16);
      }
      if (tab.key === "appearance" && viewport.width <= 1120) {
        const compact = await page.locator(".appearanceLayout").evaluate((element) => ({
          themeHeights: [...element.querySelectorAll(".ad-theme-card")].map((card) => card.getBoundingClientRect().height),
          profileHeight: element.querySelector(".appearanceProfilePanel")!.getBoundingClientRect().height,
          stationWidth: element.querySelector(".appearanceRadioPanel .ad-field")!.getBoundingClientRect().width,
        }));
        expect(Math.max(...compact.themeHeights)).toBeLessThanOrEqual(130);
        expect(compact.profileHeight).toBeLessThanOrEqual(300);
        expect(compact.stationWidth).toBeGreaterThanOrEqual(200);
      }
      await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      const lastControl = body.locator("button:visible, input:visible, textarea:visible, [role=slider]:visible").last();
      if (await lastControl.count()) {
        await lastControl.scrollIntoViewIfNeeded();
        const box = (await lastControl.boundingBox())!;
        const bodyBox = (await body.boundingBox())!;
        expect(box.x, tab.key).toBeGreaterThanOrEqual(bodyBox.x);
        expect(box.x + box.width, tab.key).toBeLessThanOrEqual(bodyBox.x + bodyBox.width + 1);
        expect(box.y + box.height, tab.key).toBeLessThanOrEqual(bodyBox.y + bodyBox.height + 1);
      }
      await body.evaluate((element) => { element.scrollTop = 0; });
      await page.screenshot({ animations: "disabled", path: `test-results/settings-${viewport.width}-${tab.key}.png` });
    }
  });
}

test("appearance gives profile controls balanced breathing room", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /Настройки|Settings/i }).first().click();
  const profile = page.locator(".appearanceProfilePanel");
  await expect(profile).toBeVisible();
  await settleSettings(page);
  const geometry = await profile.evaluate((element) => {
    const panel = element.getBoundingClientRect();
    const header = element.querySelector(".ad-header")!.getBoundingClientRect();
    const avatar = element.querySelector(".ad-file-picker")!.getBoundingClientRect();
    const field = element.querySelector(".ad-field")!.getBoundingClientRect();
    return {
      top: avatar.top - header.bottom,
      bottom: panel.bottom - avatar.bottom,
      centerOffset: Math.abs(avatar.top + avatar.height / 2 - (field.top + field.height / 2)),
    };
  });
  expect(geometry.bottom).toBeGreaterThanOrEqual(16);
  expect(Math.abs(geometry.top - geometry.bottom)).toBeLessThanOrEqual(8);
  expect(geometry.centerOffset).toBeLessThanOrEqual(2);
});

test("switching settings tabs starts at the top of the new section", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  await page.getByRole("button", { name: /Настройки|Settings/i }).first().click();
  await page.getByRole("tab", { name: /Ключи ENV|ENV keys/i }).click();
  const body = page.locator(".settingsBody");
  await expect(page.locator(".environmentForm")).toBeVisible();
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  await page.getByRole("tab", { name: /Дополнительно|Advanced/i }).click();
  await expect(page.locator(".advancedGrid")).toBeVisible();
  expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
});

test("settings screenshot", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("button", { name: /Настройки|Settings/i })
    .first()
    .click();
  await expect(page.getByRole("radio", { name: /Тёмная|Dark/i })).toHaveCSS(
    "cursor",
    "pointer",
  );
  await page.getByRole("radio", { name: /Зелёная|Green/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "green");
  await page.getByRole("radio", { name: /Тёмная|Dark/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("radio", { name: /Тёмная|Dark/i })).toBeChecked();
  const appearancePanels = await Promise.all(
    ["Theme", "Profile", "Radio", "Interface"].map((name) =>
      page.locator(`.appearance${name}Panel`).boundingBox(),
    ),
  );
  expect(appearancePanels.every(Boolean)).toBe(true);
  const [theme, profile, radio, interfacePanel] = appearancePanels.map((box) => box!);
  expect(theme.x).toBeLessThan(profile.x);
  expect(Math.abs(profile.y - radio.y)).toBeLessThan(2);
  expect(interfacePanel.y).toBeGreaterThan(profile.y + profile.height);
  expect(Math.abs(interfacePanel.x - profile.x)).toBeLessThan(2);
  expect(
    Math.abs(interfacePanel.x + interfacePanel.width - (radio.x + radio.width)),
  ).toBeLessThan(2);
  const themeCards = page.locator(".appearanceThemePanel .ad-theme-card");
  await expect(themeCards).toHaveCount(4);
  const themeCardBoxes = await themeCards.evaluateAll((cards) =>
    cards.map((card) => {
      const box = card.getBoundingClientRect();
      const picture = card.querySelector<HTMLElement>(
        ".ad-theme-card-preview > :is(img, svg, .ad-image-shine)",
      )?.getBoundingClientRect();
      return { height: box.height, width: box.width, pictureWidth: picture?.width ?? 0 };
    }),
  );
  expect(
    Math.max(...themeCardBoxes.map(({ height }) => height)) -
      Math.min(...themeCardBoxes.map(({ height }) => height)),
  ).toBeLessThan(2);
  expect(
    themeCardBoxes.every(({ width, pictureWidth }) => pictureWidth > width * 0.8),
  ).toBe(true);
  const layoutBox = await page.locator(".appearanceLayout").boundingBox();
  expect(layoutBox).not.toBeNull();
  expect(layoutBox!.height).toBeLessThanOrEqual(512);
  const interfaceRows = await page
    .locator(".appearanceInterfaceCard .ad-form-fields")
    .evaluateAll((rows) =>
      rows.map((row) => {
        const box = row.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      }),
    );
  expect(interfaceRows).toHaveLength(2);
  expect(interfaceRows[1].top - interfaceRows[0].bottom).toBeLessThan(56);
  await expect(page.locator(".appearanceInterfacePanel .ad-divider")).toHaveCount(1);
  for (const feedback of await page.locator(".appearanceRadioPanel .knob__feedback").all()) {
    await expect(feedback).toBeHidden();
  }
  await page.screenshot({ animations: "disabled", path: "test-results/shot-settings.png" });
});

test("appearance settings use compact balanced desktop geometry", async ({
  page,
}) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("button", { name: /Настройки|Settings/i })
    .first()
    .click();

  const [layout, profile, radio, interfacePanel, radioVolumeLabel, toggles] = await Promise.all([
    page.locator(".appearanceLayout").boundingBox(),
    page.locator(".appearanceProfilePanel").boundingBox(),
    page.locator(".appearanceRadioPanel").boundingBox(),
    page.locator(".appearanceInterfacePanel").boundingBox(),
    page.locator(".appearanceRadioPanel .knob__label").boundingBox(),
    page.locator('.appearanceInterfaceCard input[type="checkbox"]').first().boundingBox(),
  ]);
  expect(layout).not.toBeNull();
  expect(profile).not.toBeNull();
  expect(radio).not.toBeNull();
  expect(interfacePanel).not.toBeNull();
  expect(radioVolumeLabel).not.toBeNull();
  expect(toggles).not.toBeNull();

  expect(layout!.height).toBeLessThanOrEqual(512);
  expect(Math.abs(profile!.width - radio!.width)).toBeLessThan(2);
  expect(radioVolumeLabel!.y + radioVolumeLabel!.height).toBeLessThanOrEqual(
    radio!.y + radio!.height - 12,
  );
  expect(toggles!.y + toggles!.height).toBeLessThanOrEqual(
    interfacePanel!.y + interfacePanel!.height - 12,
  );
  await expect(page.locator(".appearanceRadioPanel .ad-rotary-knob")).toHaveAttribute(
    "style",
    expect.stringContaining("--size: 7rem"),
  );
});

test("audio settings arrange latency, levels and devices in three columns", async ({
  page,
}) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("button", { name: /Настройки|Settings/i })
    .first()
    .click();
  await page.getByRole("tab", { name: /Аудио|Audio/i }).click();

  const panels = [
    page.locator(".audioLatencyPanel"),
    page.locator(".audioLevelsPanel"),
    page.locator(".audioDevicesPanel"),
  ];
  await expect(panels[2]).toBeVisible();
  await expect(page.locator(".audioSettingsGrid > .ad-card")).toHaveCount(0);
  await expect(
    panels[0].getByRole("button", { name: /^(Драйвер|Driver) / }),
  ).toBeVisible();
  await expect(
    panels[0].getByRole("button", {
      name: /^(Частота дискретизации|Sample rate) /,
    }),
  ).toBeVisible();
  await expect(
    panels[0].getByText(/Работает в наушниках|Works in headphones/i),
  ).toHaveCount(0);
  await expect(panels[0].getByText(/^Фактически:/)).toHaveCount(0);
  const latencyValueBox = await panels[0]
    .locator(".audioLatencyValue")
    .boundingBox();
  const latencyStatusBox = await panels[0]
    .locator(".ad-status-indicator")
    .boundingBox();
  expect(latencyValueBox).not.toBeNull();
  expect(latencyStatusBox).not.toBeNull();
  expect(
    Math.abs(
      latencyValueBox!.y + latencyValueBox!.height / 2 -
        (latencyStatusBox!.y + latencyStatusBox!.height / 2),
    ),
  ).toBeLessThan(2);
  expect(latencyStatusBox!.x).toBeGreaterThan(
    latencyValueBox!.x + latencyValueBox!.width,
  );
  await expect(
    panels[2].getByRole("button", {
      name: /^(Устройство ввода|Input device) /,
    }),
  ).toBeVisible();
  await expect(
    panels[2].getByRole("button", {
      name: /^(Устройство вывода|Output device) /,
    }),
  ).toBeVisible();
  await expect(panels[0].locator(".ad-divider")).toHaveCount(0);
  await expect(panels[2].locator(".ad-divider")).toHaveCount(0);
  const boxes = await Promise.all(panels.map((panel) => panel.boundingBox()));

  expect(boxes.every(Boolean)).toBe(true);
  expect(
    Math.max(...boxes.map((box) => box!.y)) -
      Math.min(...boxes.map((box) => box!.y)),
  ).toBeLessThan(2);
  expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
  expect(boxes[1]!.x).toBeLessThan(boxes[2]!.x);
  const columnDividerBoxes = await page
    .locator(".audioSettingsGrid > .audioColumnDivider")
    .evaluateAll((dividers) =>
      dividers.map((divider) => divider.getBoundingClientRect().height),
    );
  expect(columnDividerBoxes).toHaveLength(2);
  expect(
    columnDividerBoxes.every((height) => height > boxes[0]!.height * 0.8),
  ).toBe(true);
  const levelControlsBox = await page.locator(".audioLevelControls").boundingBox();
  const deviceDescriptionBox = await panels[2]
    .locator(".audioFieldDescription")
    .boundingBox();
  const deviceTopRowBox = await panels[2]
    .locator(".audioFieldsTopRow")
    .boundingBox();
  const lowLatencyBox = await panels[2]
    .getByRole("switch", {
      name: /Минимальная задержка микрофона|Minimum microphone latency/i,
    })
    .boundingBox();
  expect(levelControlsBox).not.toBeNull();
  expect(deviceDescriptionBox).not.toBeNull();
  expect(deviceTopRowBox).not.toBeNull();
  expect(lowLatencyBox).not.toBeNull();
  expect(lowLatencyBox!.y - (deviceTopRowBox!.y + deviceTopRowBox!.height)).toBeLessThan(65);
  expect(
    boxes[2]!.y + boxes[2]!.height -
      (deviceDescriptionBox!.y + deviceDescriptionBox!.height),
  ).toBeLessThan(65);
  await expect(
    page.getByRole("button", {
      name: /Прослушать|Listen/i,
    }),
  ).toHaveClass(/ad-icon-button/);
  const monitoring = page.getByRole("button", {
    name: /Мониторинг входа|Input monitoring/i,
  });
  await expect(monitoring).toHaveClass(/ad-icon-button/);
  await expect(monitoring).toHaveAttribute("aria-pressed", "false");
  const levelBoxes = await Promise.all([
    page.getByRole("slider", { name: /^(Микрофон|Microphone)$/ }).boundingBox(),
    monitoring.boundingBox(),
    page
      .getByRole("slider", { name: /^(Шум|Noise suppression)$/ })
      .boundingBox(),
  ]);
  expect(levelBoxes[0]!.x).toBeLessThan(levelBoxes[1]!.x);
  expect(levelBoxes[1]!.x).toBeLessThan(levelBoxes[2]!.x);
  expect(levelBoxes[0]!.height).toBeGreaterThan(80);
  expect(levelBoxes[2]!.height).toBeGreaterThan(80);
  const knobLabels = page.locator(".audioLevelsPanel .knob__label");
  const knobValues = page.locator(".audioLevelsPanel .knob__value");
  await expect(knobLabels).toHaveCount(2);
  await expect(knobValues).toHaveCount(2);
  const knobPresentation = await page
    .locator(".audioLevelsPanel .ad-rotary-knob")
    .evaluateAll((knobs) =>
      knobs.map((knob) => ({
        size: knob.getAttribute("data-ad-size"),
        labelled: knob.getAttribute("data-labelled"),
        diameter: knob.getAttribute("style"),
      })),
    );
  expect(knobPresentation).toEqual([
    { size: "sm", labelled: "true", diameter: expect.stringContaining("--size: 7.75rem") },
    { size: "sm", labelled: "true", diameter: expect.stringContaining("--size: 7.75rem") },
  ]);
  for (const feedback of await page.locator(".audioLevelsPanel .knob__feedback").all()) {
    await expect(feedback).toBeHidden();
  }
  await page.screenshot({ animations: "disabled", path: "test-results/shot-audio-layout.png" });
});

test("environment settings screenshot", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("button", { name: /Настройки|Settings/i })
    .first()
    .click();
  await page.getByRole("tab", { name: /Ключи ENV|ENV keys/i }).click();
  await page.getByRole("region", { name: /Ключи ENV|ENV keys/i }).waitFor();
  await page.screenshot({ animations: "disabled", path: "test-results/shot-environment-settings.png" });
  const kaggleCard = page
    .locator(".environmentGroupCard")
    .filter({ hasText: "Kaggle GPU" });
  const roomCard = page
    .locator(".environmentGroupCard")
    .filter({ has: page.getByText(/^(Сервер комнат|Room Server)$/i) });
  const deploymentCard = page
    .locator(".environmentGroupCard")
    .filter({
      has: page.getByText(/^(Обновление Room Server|Room Server update)$/i),
    });
  const [kaggleBox, roomBox, deploymentBox] = await Promise.all([
    kaggleCard.boundingBox(),
    roomCard.boundingBox(),
    deploymentCard.boundingBox(),
  ]);
  // Kaggle and the room server share the first row; Room Server update sits below them.
  expect(Math.abs((roomBox?.y ?? 0) - (kaggleBox?.y ?? Infinity))).toBeLessThan(
    2,
  );
  expect(deploymentBox?.y ?? 0).toBeGreaterThan(roomBox?.y ?? Infinity);
  await expect(page.getByText(/^(Готово к работе|Ready to use)$/i)).toHaveCount(
    0,
  );
  await expect(page.getByText(/^(Настроено|Configured):/i)).toHaveCount(0);
  await expect(
    page.getByText(/^(Сейчас не используется|Not currently used)$/i),
  ).toHaveCount(0);
  await expect(
    page.getByText(/^(Компоненты приложения|Application components)$/i),
  ).toHaveCount(0);
  await expect(deploymentCard).toBeVisible();
  await expect(
    roomCard.getByLabel(/Адрес сервера|Server address/i),
  ).toHaveValue("rooms.example.com");
  await expect(roomCard.getByLabel(/Порт комнат|Room port/i)).toHaveValue(
    "8081",
  );
  await expect(
    roomCard.getByLabel(/Порт передачи голоса|Voice relay port/i),
  ).toHaveValue("40000");
  await expect(
    roomCard.getByLabel(/Адрес сервера комнат|Room server address/i),
  ).toHaveCount(0);
  await expect(
    deploymentCard.getByLabel(/Приватный SSH-ключ|Private SSH key/i),
  ).toHaveValue("D:/secrets/room_server");
  await expect(page.getByText("Oracle Cloud")).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/shot-environment-settings-expanded.png",
  });
  // Secrets are write-only: saved ones show as such and never reach the technical JSON.
  await expect(
    page.getByRole("textbox", { name: /Токен AudD|AudD token/i }),
  ).toHaveValue("");
  await page.getByText(/Технический JSON|Technical JSON/i).click();
  const json = page.getByRole("textbox", {
    name: /Технический JSON|Technical JSON/i,
  });
  await expect(json).toHaveValue(/AD_VOICE_ROOM_SERVER_HOST/);
  await expect(json).not.toHaveValue(
    /KAGGLE_URL|KAGGLE_API_TOKEN|AD_VOICE_AUDD_TOKEN/,
  );
  await page.screenshot({ animations: "disabled", path: "test-results/shot-environment-json.png" });
});

test("remaining settings tabs screenshots", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("button", { name: /Настройки|Settings/i })
    .first()
    .click();

  await page.getByRole("tab", { name: /Аудио|Audio/i }).click();
  await page
    .getByText(/Аудиоустройства и параметры|Audio devices and parameters/i)
    .first()
    .waitFor();
  await page.screenshot({ animations: "disabled", path: "test-results/shot-audio-settings.png" });
  const monitoring = page.getByRole("button", {
    name: /Мониторинг входа|Input monitoring/i,
  });
  await monitoring.click();
  await expect(monitoring).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(350);
  await page.screenshot({ animations: "disabled", path: "test-results/shot-audio-monitor-on.png" });

  await page
    .getByRole("tab", { name: /AI \/ Обработка|AI \/ Processing/i })
    .click();
  await page
    .getByText(/AI и обработка аудио|AI and audio processing/i)
    .waitFor();
  await page.screenshot({ animations: "disabled", path: "test-results/shot-ai-settings.png" });

  await page.getByRole("tab", { name: /Ключи ENV|ENV keys/i }).click();
  await page.getByText(/Технический JSON|Technical JSON/i).waitFor();
  await page.screenshot({ animations: "disabled", path: "test-results/shot-environment-settings.png" });
});
