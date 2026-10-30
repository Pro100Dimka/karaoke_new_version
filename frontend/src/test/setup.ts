import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without globals, so Testing Library's automatic cleanup is not registered.
afterEach(cleanup);

// jsdom omits native pointer capture and SVG path measurement used by window dragging and motion.
if (typeof HTMLElement !== "undefined" && !("setPointerCapture" in HTMLElement.prototype))
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { value: () => undefined, writable: true, configurable: true });
if (typeof SVGElement !== "undefined" && !("getTotalLength" in SVGElement.prototype))
  Object.defineProperty(SVGElement.prototype, "getTotalLength", { value: () => 100 });

// jsdom has no canvas: drawing layers see no 2D context and simply stay idle instead of logging "not implemented".
if (typeof HTMLCanvasElement !== "undefined")
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;

// jsdom has no media output. Notification tests replace this with an observed Audio implementation.
if (typeof HTMLMediaElement !== "undefined") {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => undefined;
}
