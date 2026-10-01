import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (name: string) => readFileSync(resolve(process.cwd(), `src/features/library/${name}`), "utf8");

describe("library reference modals", () => {
  it("keeps the analysis modal inside the viewport at the reference aspect ratio", () => {
    const styles = source("analysis.css");
    expect(styles).toContain("--pa-height:min(1036px,calc(100dvh - 24px),calc((100vw - 28px)*.84091))");
    expect(styles).toContain("inline-size:calc(var(--pa-height)*1.18919) !important");
    expect(styles).toContain("block-size:var(--pa-height) !important");
  });

  it("uses the reference background, header art, and panel skins", () => {
    const modal = source("PerformanceAnalysisModal.tsx");
    expect(modal).toContain("performance-analysis-defs.svg?raw");
    expect(modal).toContain("performance-analysis-header.svg?raw");
    expect(modal).toContain("performance-analysis-landscape.svg?raw");
    expect(modal).toContain("performance-analysis-skins.svg?raw");
    expect(modal).toContain('className="paHeaderArt"');
    expect(modal).toContain('className="paLandscapeArt paLandscapeStatic"');
    expect(modal).toContain('className="paSkinArt"');
  });

  it("does not overlay the reference recommendation art with invented contour lines", () => {
    const styles = source("analysis.css");
    expect(styles).not.toContain("repeating-radial-gradient");
    expect(styles).toContain(".paLandscape{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}");
  });

  it("isolates the animated reference strokes from the heavy static landscape", () => {
    const modal = source("PerformanceAnalysisModal.tsx");
    expect(modal).toContain("performanceLandscapeStatic");
    expect(modal).toContain("performanceLandscapeMotion");
    expect(modal).toContain('className="paLandscapeArt paLandscapeStatic"');
    expect(modal).toContain('className="paLandscapeArt paLandscapeMotion"');
  });

  it("uses every structural region from the processing queue reference", () => {
    const modal = source("ProcessingModal.tsx");
    expect(modal).toContain("processingReferenceModal");
    expect(modal).toContain("processingQueueHeader");
    expect(modal).toContain("processingJobCard");
    expect(modal).toContain("processingQueueFooter");
    expect(modal).toContain("SettingsNeonFrame");
    expect(modal).toContain("processingQueueBackground");
    expect(modal).toContain("processingQueueHeaderArt");
    expect(modal).not.toContain('src="/processing-queue-');
  });

  it("uses every structural region from the song performances reference", () => {
    const modal = source("RecordingsModal.tsx");
    const styles = source("reference-modals.css");
    expect(modal).toContain("performancesReferenceModal");
    expect(modal).toContain("performancesHeader");
    expect(modal).toContain("performanceCard");
    expect(modal).toContain("performancesFooter");
    expect(modal).toContain("SettingsNeonFrame");
    expect(modal).toContain("PerformancesSignature");
    expect(modal).toContain("performancesHeaderTexture");
    expect(modal).toContain("sphere(context, 1230, 390, 506, 1230, 156, true)");
    expect(modal).toContain("performanceTileSpark");
    expect(modal).toContain("performanceAddMain");
    expect(modal).toContain("performanceAddMore");
    expect(modal).toContain("data-view={view}");
    expect(styles).toContain("--performance-surface-card");
    expect(styles).toContain('.performancesList[data-view="grid"]');
  });
});
