import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

test("settings screenshot", async ({ page }) => {
  await page.addInitScript(installDesktopBridge);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("button", { name: /Настройки|Settings/i })
    .first()
    .click();
  await expect(page.getByRole("button", { name: /Тёмная|Dark/i })).toHaveCSS(
    "cursor",
    "pointer",
  );
  await page.getByRole("button", { name: /Зелёная|Green/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "green");
  await page.getByRole("button", { name: /Тёмная|Dark/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "test-results/shot-settings.png" });
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
  await page.screenshot({ path: "test-results/shot-environment-settings.png" });
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
  await page.screenshot({ path: "test-results/shot-environment-json.png" });
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
    .getByText(/Мониторинг и уровень сигнала|Monitoring and signal level/i)
    .waitFor();
  await page.screenshot({ path: "test-results/shot-audio-settings.png" });
  const monitoring = page.getByRole("switch", {
    name: /Мониторинг входа|Input monitoring/i,
  });
  // The kit draws the switch as a track over its input; a pointer user clicks that track.
  await monitoring.click({ force: true });
  await expect(monitoring).toBeChecked();
  await page.waitForTimeout(350);
  await page.screenshot({ path: "test-results/shot-audio-monitor-on.png" });

  await page
    .getByRole("tab", { name: /AI \/ Обработка|AI \/ Processing/i })
    .click();
  await page
    .getByText(/AI и обработка аудио|AI and audio processing/i)
    .waitFor();
  await page.screenshot({ path: "test-results/shot-ai-settings.png" });

  await page.getByRole("tab", { name: /Ключи ENV|ENV keys/i }).click();
  await page.getByText(/Технический JSON|Technical JSON/i).waitFor();
  await page.screenshot({ path: "test-results/shot-environment-settings.png" });
});
