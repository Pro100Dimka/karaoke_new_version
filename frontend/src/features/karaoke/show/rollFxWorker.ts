import { RollFxRenderer, type RollEngine, type RollFrame, type RollView } from './rollFxRenderer';
import type { FxCommand } from './visualDirector';

let canvas: OffscreenCanvas;
let glow: OffscreenCanvas;
let renderer: RollFxRenderer | undefined;
let engine: RollEngine;
let command: ((value: FxCommand) => void) | undefined;
const view: { current: RollView | undefined } = { current: undefined };

self.onmessage = ({ data }: MessageEvent<RollFrame | { type: 'init'; canvas: OffscreenCanvas; glow: OffscreenCanvas }>) => {
  try {
    if (data.type === 'init') {
      canvas = data.canvas;
      glow = data.glow;
      if (!canvas.getContext('2d') || !glow.getContext('2d')) throw new Error('Canvas rendering is unavailable');
      self.postMessage({ type: 'ready' });
      return;
    }
    if (!renderer) {
      engine = {
        state: data.state, voiceHistory: [], voicePoint: undefined,
        onCommand(listener) { command = listener; return () => { command = undefined; }; },
      };
      renderer = new RollFxRenderer(canvas, engine, undefined, view, glow);
    }
    engine.state = data.state;
    if (data.resetHistory) engine.voiceHistory.length = 0;
    engine.voiceHistory.push(...data.history);
    while (engine.voiceHistory.length && engine.voiceHistory[0]!.position < data.historyFrom) engine.voiceHistory.shift();
    view.current = data.view ? { ...data.view, notes: data.view.notes ?? view.current?.notes ?? [] } : undefined;
    if (data.layout) renderer.resize(data.layout);
    for (const value of data.commands) command?.(value);
    renderer.draw(data.now - performance.timeOrigin);
    self.postMessage({ type: 'frame', voicePoint: engine.voicePoint });
  } catch {
    self.postMessage({ type: 'failed' });
  }
};
