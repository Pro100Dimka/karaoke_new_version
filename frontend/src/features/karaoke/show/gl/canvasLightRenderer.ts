import { beamVertexFloats, spriteFloats, spriteKind, type LightBatch } from "./lightBatch";
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Canvas = HTMLCanvasElement | OffscreenCanvas;

/** Cached light stamps keep the stage's soft shapes without allocating a second WebGL context. */
export class CanvasLightRenderer {
  private stamps = new Map<string, Canvas>();

  static create(canvas: Canvas): CanvasLightRenderer | undefined {
    const context = canvas.getContext("2d", { alpha: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    return context ? new CanvasLightRenderer(canvas, context) : undefined;
  }

  private constructor(
    private canvas: Canvas,
    private context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  ) {}

  private stamp(red: number, green: number, blue: number): Canvas {
    const color = [red, green, blue].map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255));
    const key = color.join(",");
    const cached = this.stamps.get(key);
    if (cached) return cached;
    const stamp = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(128, 128)
      : document.createElement("canvas");
    stamp.width = stamp.height = 128;
    const context = stamp.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    const rgb = color.join(",");
    gradient.addColorStop(0, `rgba(${rgb},0.9)`);
    gradient.addColorStop(0.12, `rgba(${rgb},0.62)`);
    gradient.addColorStop(0.42, `rgba(${rgb},0.13)`);
    gradient.addColorStop(1, `rgba(${rgb},0)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    this.stamps.set(key, stamp);
    return stamp;
  }

  render(
    batch: LightBatch,
    _time: number,
    view: { width: number; height: number },
    protect: { lyrics?: Rect; roll?: Rect },
    _bloom: number,
  ): void {
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.setTransform(this.canvas.width / view.width, 0, 0, this.canvas.height / view.height, 0, 0);
    context.globalCompositeOperation = "lighter";

    for (let i = 0; i < batch.beamCount; i++) {
      const offset = i * 3 * beamVertexFloats;
      const beams = batch.beams;
      const x = beams[offset]!, y = beams[offset + 1]!;
      const leftX = beams[offset + 8]!, leftY = beams[offset + 9]!;
      const rightX = beams[offset + 16]!, rightY = beams[offset + 17]!;
      const color = [beams[offset + 4]!, beams[offset + 5]!, beams[offset + 6]!]
        .map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255));
      const strength = Math.min(0.28, beams[offset + 7]! * 0.18);
      const gradient = context.createLinearGradient(x, y, (leftX + rightX) / 2, (leftY + rightY) / 2);
      gradient.addColorStop(0, `rgba(${color.join(",")},${strength})`);
      gradient.addColorStop(1, `rgba(${color.join(",")},0)`);
      context.fillStyle = gradient;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(leftX, leftY);
      context.lineTo(rightX, rightY);
      context.fill();
    }

    for (let i = 0; i < batch.spriteCount; i++) {
      const offset = i * spriteFloats;
      const sprites = batch.sprites;
      const x = sprites[offset]!, y = sprites[offset + 1]!, size = sprites[offset + 2]!;
      const kind = sprites[offset + 3]!, intensity = sprites[offset + 7]!;
      if (kind === spriteKind.ring) {
        const color = [sprites[offset + 4]!, sprites[offset + 5]!, sprites[offset + 6]!]
          .map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255));
        context.strokeStyle = `rgba(${color.join(",")},${Math.min(0.7, intensity * 0.45)})`;
        context.lineWidth = Math.max(1.5, size * sprites[offset + 9]! * 0.5);
        context.beginPath();
        context.arc(x, y, size * sprites[offset + 8]!, 0, Math.PI * 2);
        context.stroke();
        continue;
      }
      const stamp = this.stamp(sprites[offset + 4]!, sprites[offset + 5]!, sprites[offset + 6]!);
      context.globalAlpha = Math.min(0.8, intensity * (kind === spriteKind.bokeh ? 0.25 : 0.45));
      context.drawImage(stamp, x - size, y - size, size * 2, size * 2);
    }
    context.globalAlpha = 1;
    for (const rect of [protect.lyrics, protect.roll]) {
      if (rect) context.clearRect(rect.left, rect.top, rect.width, rect.height);
    }
    context.globalCompositeOperation = "source-over";
  }

  dispose(): void {
    this.stamps.clear();
  }
}
