import { LightBatch, spriteFloats } from './lightBatch';
import { CanvasLightRenderer, type Rect } from './canvasLightRenderer';

type Frame = {
  type: 'frame';
  sprites: ArrayBuffer;
  spriteCount: number;
  width: number;
  height: number;
  view: { width: number; height: number };
  protect: { lyrics?: Rect; roll?: Rect };
};

let canvas: OffscreenCanvas;
let renderer: CanvasLightRenderer | undefined;
const batch = new LightBatch(1400);

self.onmessage = (
  event: MessageEvent<Frame | { type: 'init'; canvas: OffscreenCanvas }>,
) => {
  const data = event.data;
  if (data.type === 'init') {
    canvas = data.canvas;
    renderer = CanvasLightRenderer.create(canvas);
    self.postMessage({ type: renderer ? 'ready' : 'failed' });
    return;
  }
  if (canvas.width !== data.width) canvas.width = data.width;
  if (canvas.height !== data.height) canvas.height = data.height;
  batch.sprites.set(
    new Float32Array(data.sprites, 0, data.spriteCount * spriteFloats),
  );
  batch.spriteCount = data.spriteCount;
  renderer?.render(batch, data.view, data.protect);
  self.postMessage(
    { type: 'frame', sprites: data.sprites },
    { transfer: [data.sprites] },
  );
};
