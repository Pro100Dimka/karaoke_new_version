import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("melody editor reference layout", () => {
  it("uses every primary visual layer from the supplied reference", () => {
    const page = ["EditorPage.tsx", "EditorHeader.tsx", "EditorTransport.tsx", "EditorSurface.tsx"]
      .map(source)
      .join("\n");
    for (const asset of ["melody-editor-defs.svg?raw", "melody-editor-header.svg?raw", "melody-editor-cover.svg?raw", "melody-editor-wordmark.svg?raw", "melody-editor-waveform.svg?raw", "melody-editor-grid.svg?raw", "melody-editor-roll-art.svg?raw"]) {
      expect(page).toContain(asset);
    }
    for (const className of ["me-header", "me-transport", "me-toolbar", "me-roll", "me-footer"]) {
      expect(page).toContain(className);
    }
  });

  it("owns the complete window chrome instead of rendering below the shared title bar", () => {
    const shell = source("../../app/AppShell.tsx");
    expect(shell).toContain("!isEditor && <TitleBar />");
  });

  it("keeps the 1280 by 698 reference coordinate system", () => {
    const styles = source("editor.css");
    expect(styles).toContain("width: 1280px; height: 698px");
    expect(styles).toContain(".me-roll { left: 14px; top: 215px; width: 1252px; height: 391px");
  });
});
