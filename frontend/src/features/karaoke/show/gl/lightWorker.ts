import { LightBatch } from "./lightBatch";
import { CanvasLightRenderer, type Rect } from "./canvasLightRenderer";

type Frame = {
  type: "frame";
  sprites: ArrayBuffer;
  beams: ArrayBuffer;
  spriteCount: number;
  beamCount: number;
  width: number;
  height: number;
  time: number;
  view: { width: number; height: number };
  protect: { lyrics?: Rect; roll?: Rect };
  bloom: number;
};

let canvas: OffscreenCanvas;
let renderer: CanvasLightRenderer | undefined;
const batch = new LightBatch(1400, 16);

self.onmessage = (event: MessageEvent<Frame | { type: "init"; canvas: OffscreenCanvas }>) => {
  const data = event.data;
  if (data.type === "init") {
    canvas = data.canvas;
    renderer = CanvasLightRenderer.create(canvas);
    self.postMessage({ type: renderer ? "ready" : "failed" });
    return;
  }
  if (canvas.width !== data.width) canvas.width = data.width;
  if (canvas.height !== data.height) canvas.height = data.height;
  batch.sprites.set(new Float32Array(data.sprites, 0, data.spriteCount * 10));
  batch.beams.set(new Float32Array(data.beams, 0, data.beamCount * 3 * 8));
  batch.spriteCount = data.spriteCount;
  batch.beamCount = data.beamCount;
  renderer?.render(batch, data.time, data.view, data.protect, data.bloom);
  self.postMessage({ type: "frame", sprites: data.sprites, beams: data.beams }, { transfer: [data.sprites, data.beams] });
};
