import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuantumBackground } from "@neo-ui-kit/react";

const policy =
  readFileSync(join(__dirname, "..", "index.html"), "utf8").match(
    /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/,
  )?.[1] ?? "";

it("ships a strict policy without the development server or arbitrary inline scripts", () => {
  expect(policy).toContain("default-src 'self'");
  expect(policy).toMatch(/script-src 'self' /);
  expect(policy.match(/script-src ([^;]+)/)?.[1]).not.toContain("unsafe-inline");
  expect(policy).not.toMatch(/localhost|5173|unsafe-eval/);
});

it("allows only the pinned QuantumBackground scripts, with three.js shipped beside the app", () => {
  const host = document.createElement("div");
  // As the Library renders it: three.js from the app's own vendor folder.
  host.innerHTML = renderToStaticMarkup(createElement(QuantumBackground, { threeUrl: "./vendor/three/" }));
  const source = host.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
  const frame = new DOMParser().parseFromString(source, "text/html");
  const scripts = [...frame.querySelectorAll("script")];
  expect(scripts).toHaveLength(3);
  for (const script of scripts) {
    const hash = createHash("sha256").update(script.textContent ?? "").digest("base64");
    expect(policy).toContain(`'sha256-${hash}'`);
  }
  // No CDN: the scene's code comes only from the app itself.
  expect(policy).not.toContain("unpkg.com");
  expect(source).toContain('"three": "./vendor/three/build/three.module.js"');
  expect(policy).toContain("frame-src 'self';");
});
