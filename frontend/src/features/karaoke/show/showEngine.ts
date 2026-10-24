import { MusicPulse, type MusicCue, type MusicState } from "./musicPulse";
import {
  PerformanceTracker,
  type EnergyLevel,
  type LiveNote,
  type ShowNote,
  type ShowPhrase,
} from "./performanceTracker";
import {
  ambientFor,
  VisualDirector,
  type Ambient,
  type FxCommand,
  type VisualIntensity,
} from "./visualDirector";

/** The lyric word a note is sung on: its line's text and its place in that line, to light the word on screen. */
export interface NoteWord {
  line: string;
  index: number;
}

export interface ShowSettings {
  intensity: VisualIntensity;
  /** Rewards stay, motion (beams swinging, sweeps, depth pulses) becomes glow and colour. */
  reducedMotion: boolean;
}

/** What the renderers read every frame; none of it goes through React state. */
export interface ShowState {
  energy: number;
  level: EnergyLevel;
  streakSeconds: number;
  live: LiveNote | undefined;
  music: MusicState;
  ambient: Ambient;
  playing: boolean;
  settings: ShowSettings;
}

interface VoiceObservation { position: number; pitchHz?: number }

type CommandListener = (command: FxCommand) => void;

/**
 * One show per karaoke screen: the performance tracker (what the voice earned), the music pulse (when the backing
 * track has its strong moments) and the visual director (what to show). Renderers subscribe to its commands and
 * read its state on their own animation frames.
 */
export class ShowEngine {
  private tracker = new PerformanceTracker();
  private pulse = new MusicPulse();
  private director = new VisualDirector();
  private cues: MusicCue[] = [];
  private listeners = new Set<CommandListener>();
  private words: ReadonlyMap<string, NoteWord> = new Map();
  readonly voiceHistory: VoiceObservation[] = [];
  /** Where the singer's voice is drawn now (page pixels), set by the melody roll's light layer when it is shown. */
  voicePoint: { x: number; y: number } | undefined;
  state: ShowState = {
    energy: 0,
    level: "calm",
    streakSeconds: 0,
    live: undefined,
    music: this.pulse.state,
    ambient: ambientFor(0, this.pulse.state, "full"),
    playing: false,
    settings: { intensity: "full", reducedMotion: false },
  };

  load(
    notes: readonly ShowNote[],
    phrases: readonly ShowPhrase[],
    words: ReadonlyMap<string, NoteWord> = new Map(),
    resetPerformance = true,
    vocalActivity?: readonly (readonly [number, number])[],
  ): void {
    this.words = words;
    this.tracker.load(notes, phrases, resetPerformance, vocalActivity);
    if (!resetPerformance) return;
    this.voiceHistory.length = 0;
    this.director.reset();
    this.pulse.reset();
  }

  configure(settings: ShowSettings): void {
    this.director.intensity = settings.intensity;
    this.state = { ...this.state, settings };
  }

  get hitNoteIds() { return this.tracker.hitNoteIds; }
  get noteScore() { return this.tracker.noteScore; }

  /** A backing-track spectrum frame from AudioService. */
  hear(backingBands: readonly number[], now: number): void {
    if (!this.state.playing) return;
    this.cues.push(...this.pulse.next(backingBands, now));
  }

  /** Called on every drawn song position: scores the voice and releases due effects. */
  advance(
    now: number,
    position: number,
    pitchHz: number | undefined,
    playing: boolean,
    sampleDuration?: number,
    scoreVoice = true,
    audioActive?: boolean,
  ): void {
    if (playing && scoreVoice) {
      const last = this.voiceHistory.at(-1)?.position;
      if (last !== undefined && (position < last || position > last + 1.5)) this.voiceHistory.length = 0;
      if (last !== position) this.voiceHistory.push({ position, pitchHz });
      while (this.voiceHistory.length > 0 && this.voiceHistory[0]!.position < position - 3) this.voiceHistory.shift();
    }
    const events = playing && scoreVoice ? this.tracker.update(position, pitchHz, sampleDuration, audioActive) : [];
    const music = this.pulse.state;
    const commands = this.director.plan(now, events, playing ? this.cues : [], {
      energy: this.tracker.energy,
      streakSeconds: this.tracker.streakSeconds,
      music,
      untilBeat: this.pulse.untilNextBeat(now),
    });
    this.cues = [];
    this.state = {
      ...this.state,
      energy: this.tracker.energy,
      level: this.tracker.level,
      streakSeconds: this.tracker.streakSeconds,
      live: playing ? this.tracker.live : undefined,
      music,
      ambient: ambientFor(
        this.tracker.energy,
        music,
        this.state.settings.intensity,
      ),
      playing,
    };
    for (const command of commands)
      for (const listener of this.listeners) listener(command);
  }

  wordOf(noteId: string): NoteWord | undefined {
    return this.words.get(noteId);
  }

  onCommand(listener: CommandListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
