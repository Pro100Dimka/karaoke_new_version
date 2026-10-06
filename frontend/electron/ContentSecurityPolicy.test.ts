import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const policy =
  readFileSync(join(__dirname, "..", "index.html"), "utf8").match(
    /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/,
  )?.[1] ?? "";

it("ships a strict policy without the development server or inline scripts", () => {
  expect(policy).toContain("default-src 'self'");
  expect(policy).toMatch(/script-src 'self';/);
  expect(policy).not.toMatch(/localhost|5173|unsafe-eval/);
});
