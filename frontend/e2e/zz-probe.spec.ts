import { test, type Page } from "@playwright/test";
import { installDesktopBridge } from "./desktopBridge";

const countCalls = () => {
  const calls: Record<string, number> = {};
  (window as unknown as { __calls: typeof calls }).__calls = calls;
  const desktop = window.desktop as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(desktop)) {
    if (typeof value !== "function") continue;
    desktop[name] = (...args: unknown[]) => {
      const first = args[0] as { path?: string; command?: string } | undefined;
      const key = `${name}${first?.path ? " " + first.path.split("?")[0] : ""}${first?.command ? " " + first.command : ""}`;
      calls[key] = (calls[key] ?? 0) + 1;
      if (
        first?.command === "GetDiagnostics" ||
        first?.command === "GetSpectrum"
      ) {
        const stack = (new Error().stack ?? "")
          .split("\n")
          .slice(2, 9)
          .map((line) =>
            line
              .replace(/https?:\/\/[^/]+\//, "")
              .replace(/\?[^:)]*/, "")
              .trim(),
          )
          .join(" < ");
        const traces = ((window as any).__traces ??= {}) as Record<
          string,
          number
        >;
        const traceKey = `${first.command}: ${stack}`;
        traces[traceKey] = (traces[traceKey] ?? 0) + 1;
      }
      return (value as (...a: unknown[]) => unknown)(...args);
    };
  }
};

const measure = async (page: Page, label: string, seconds: number) => {
  await page.evaluate(() => {
    for (const key of Object.keys((window as any).__calls))
      delete (window as any).__calls[key];
  });
  await page.waitForTimeout(seconds * 1000);
  const calls: Record<string, number> = await page.evaluate(() => ({
    ...(window as any).__calls,
  }));
  const total = Object.values(calls).reduce((sum, value) => sum + value, 0);
  const top = Object.entries(calls)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${(v / seconds).toFixed(1)}/s`)
    .join(", ");
  console.log(`${label}: ${(total / seconds).toFixed(1)} calls/s :: ${top}`);
};

test("probe", async ({ page }) => {
  test.setTimeout(120_000);
  const messages: string[] = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      messages.push(`${message.type()}: ${message.text().slice(0, 300)}`);
  });
  page.on("pageerror", (error) =>
    messages.push(`pageerror: ${String(error).slice(0, 300)}`),
  );
  await page.addInitScript(installDesktopBridge);
  await page.addInitScript(countCalls);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForTimeout(2000);
  await measure(page, "LIBRARY idle", 5);
  const traces = await page.evaluate(() => (window as any).__traces ?? {});
  console.log(
    "TRACES\n" +
      Object.entries(traces)
        .sort((a: any, b: any) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => `${v} ${k}`)
        .join("\n"),
  );
  await page
    .getByRole("button", { name: /Настройки/i })
    .first()
    .click();
  await measure(page, "SETTINGS appearance", 4);
  await page.getByRole("tab", { name: /Аудио/i }).click();
  await measure(page, "SETTINGS audio", 4);
  await page.keyboard.press("Escape");
  await page.goto("/#/karaoke/song-1");
  await page.waitForTimeout(2500);
  await measure(page, "KARAOKE ready", 5);
  await page.goto("/#/editor/song-1");
  await page.waitForTimeout(1500);
  await measure(page, "EDITOR idle", 4);
  console.log("MESSAGES\n" + [...new Set(messages)].join("\n"));
});
