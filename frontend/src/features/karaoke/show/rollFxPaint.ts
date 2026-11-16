import { approach, easeOutCubic, rgba } from './fxPalette';
import { levelProgress, type ShowNote } from './performanceScoring';
import type { ShowEngine } from './showEngine';
import type { FxCommand } from './visualDirector';
import { pitchHzToMidi, reliablePitchHz } from '../karaokeLyrics';
export interface RollView {
  notes: readonly ShowNote[];
  position: number;
  /** Seconds across the lane. */
  span: number;
  /** Playhead position across the lane, 0–1. */
  lead: number;
  low: number;
  high: number;
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Geometry {
  row: number;
  x: (seconds: number) => number;
  /** Centre line of a pitch's row, exactly where MelodyRoll centres its capsule. */
  y: (pitch: number) => number;
  box: (note: ShowNote) => Box;
}
export interface Moment {
  start: number;
  strength: number;
  noteId?: string;
}
export type PaintContext =
  CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type PaintCanvas = HTMLCanvasElement | OffscreenCanvas;
export const paintContext = (
  canvas: PaintCanvas | undefined,
): PaintContext | null => {
  const context = canvas?.getContext('2d');
  return context && 'fillRect' in context ? context : null;
};
export type RollEngine = Pick<
  ShowEngine,
  'state' | 'voiceHistory' | 'voicePoint' | 'onCommand'
>;
export interface RollLayout {
  lane: { left: number; top: number; width: number; height: number };
  page: { left: number; top: number };
  ratio: number;
  glow?: { width: number; height: number; radius: number[]; blur: number };
}
export interface RollFrame {
  type: 'frame';
  now: number;
  layout?: RollLayout;
  state: ShowEngine['state'];
  history: ShowEngine['voiceHistory'];
  resetHistory: boolean;
  historyFrom: number;
  view: (Omit<RollView, 'notes'> & { notes?: readonly ShowNote[] }) | undefined;
  commands: FxCommand[];
}
export const paintCanvas = (): PaintCanvas =>
  typeof document === 'undefined'
    ? new OffscreenCanvas(1, 1)
    : document.createElement('canvas');
export const margin = 24;
export const sparkleMs = 420;
export const glintMs = 380;
export const starMs = 700;
export const waveMs = 1000;
export const passMs = 900;
export const burstMs = 600;
export const phase = (now: number, start: number, duration: number): number =>
  Math.min(1, Math.max(0, (now - start) / duration));
export const traceHoldSeconds = 2.4;
export class RollVoicePainter {
  constructor(
    private engine: RollEngine,
    private layout: RollLayout,
  ) {}
  private displayedVoice:
    { pitch: number; at: number; position: number } | undefined;
  private bursts: Moment[] = [];
  private level = '';
  drawVoice(
    context: PaintContext,
    view: RollView,
    geometry: Geometry,
    now: number,
  ): void {
    const state = this.engine.state;
    const observation = this.engine.voiceHistory.at(-1);
    const x = geometry.x(observation?.position ?? view.position);
    const live = state.live;
    const measured =
      observation?.audioActive &&
      state.playing &&
      Math.abs(view.position - observation.position) <= 0.5
        ? pitchHzToMidi(
            reliablePitchHz(observation.pitchHz, observation.confidence),
          )
        : undefined;
    const previous = this.displayedVoice;
    const midi =
      measured !== undefined &&
      previous &&
      observation &&
      observation.position >= previous.position &&
      observation.position - previous.position < 0.2
        ? approach(
            previous.pitch,
            measured,
            Math.max(0, now - previous.at) / 1000,
            0.035,
          )
        : measured;
    this.displayedVoice =
      midi !== undefined && observation
        ? { pitch: midi, at: now, position: observation.position }
        : undefined;
    const boundedMidi = Math.max(
      view.low,
      Math.min(view.high, midi ?? (view.low + view.high) / 2),
    );
    const y = geometry.y(boundedMidi);
    const visible = midi !== undefined && midi === boundedMidi;
    this.engine.voicePoint = visible
      ? { x: this.layout.page.left + x, y: this.layout.page.top + y }
      : undefined;
    if (state.level !== this.level) {
      if (this.level !== '' && state.energy > 1)
        this.bursts.push({ start: now, strength: 1 });
      this.level = state.level;
    }
    if (midi === undefined) return;
    const markerY = Math.max(
      margin + 10,
      Math.min(margin + this.layout.lane.height - 10, y),
    );
    context.strokeStyle = rgba('white', 0.95);
    context.fillStyle = context.strokeStyle;
    context.lineWidth = 2;
    context.setLineDash([]);
    context.beginPath();
    if (!visible) {
      const direction = Math.sign(boundedMidi - midi);
      context.moveTo(x - 6, markerY - direction * 4);
      context.lineTo(x, markerY + direction * 4);
      context.lineTo(x + 6, markerY - direction * 4);
    } else {
      context.arc(x, markerY, 6, 0, Math.PI * 2);
      context.fill();
    }
    context.stroke();
    if (!visible) return;
    const radius = Math.max(15, geometry.row * 1.25);
    const accuracy = live?.deviation === undefined ? 0 : live.accuracy;
    if (accuracy > 0.2) {
      const core = context.createRadialGradient(x, y, 0, x, y, radius * 1.4);
      core.addColorStop(0, rgba('white', accuracy));
      core.addColorStop(0.18, rgba('pink', accuracy * 0.7));
      core.addColorStop(1, rgba('magenta', 0));
      context.fillStyle = core;
      context.fillRect(
        x - radius * 1.4,
        y - radius * 1.4,
        radius * 2.8,
        radius * 2.8,
      );
    }
    // The ring: a faint track and the filled share of the way to the next level.
    const ringAlpha = live ? 0.9 : 0.45;
    context.lineWidth = 1.6;
    context.strokeStyle = rgba('white', 0.12 * ringAlpha);
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = rgba('pink', 0.85 * ringAlpha);
    context.beginPath();
    context.arc(
      x,
      y,
      radius,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * levelProgress(state.energy),
    );
    context.stroke();
    for (const burst of this.bursts) {
      const p = phase(now, burst.start, burstMs);
      context.strokeStyle = rgba('white', (1 - p) ** 1.5);
      context.lineWidth = 2.5 * (1 - p) + 0.5;
      context.beginPath();
      context.arc(x, y, radius * (1 + 1.8 * easeOutCubic(p)), 0, Math.PI * 2);
      context.stroke();
    }
  }
  drawVoiceTrail(
    context: PaintContext,
    view: RollView,
    geometry: Geometry,
  ): void {
    context.lineWidth = Math.max(1.5, geometry.row * 0.1);
    context.strokeStyle = rgba('white', 0.85);
    context.beginPath();
    let previous: number | undefined;
    for (const observation of this.engine.voiceHistory) {
      const midi = pitchHzToMidi(
        reliablePitchHz(observation.pitchHz, observation.confidence),
      );
      if (midi === undefined || midi < view.low || midi > view.high) {
        previous = undefined;
        continue;
      }
      const x = geometry.x(observation.position),
        y = geometry.y(midi);
      if (previous === undefined || observation.position - previous > 0.1)
        context.moveTo(x, y);
      else context.lineTo(x, y);
      previous = observation.position;
    }
    context.stroke();
  }
  expire(now: number): void {
    this.bursts = this.bursts.filter((m) => now - m.start < burstMs);
  }
}
