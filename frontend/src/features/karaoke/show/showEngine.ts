import { MusicPulse, type MusicCue, type MusicState } from './musicPulse';
import {
  PerformanceTracker,
  type EnergyLevel,
  type LiveNote,
  type ShowNote,
  type ShowPhrase,
} from './performanceTracker';
import {
  ambientFor,
  VisualDirector,
  type Ambient,
  type FxCommand,
  type VisualIntensity,
} from './visualDirector';

export interface ShowSettings {
  intensity: VisualIntensity;
  /** Rewards stay, motion (beams swinging, sweeps, depth pulses) becomes glow and colour. */
  reducedMotion: boolean;
}

/** What the renderers read every frame; none of it goes through React state. */
interface ShowState {
  energy: number;
  level: EnergyLevel;
  streakSeconds: number;
  live: LiveNote | undefined;
  music: MusicState;
  musicBeat: number;
  ambient: Ambient;
  playing: boolean;
  settings: ShowSettings;
}

interface VoiceObservation {
  position: number;
  pitchHz?: number;
  confidence: number;
  audioActive: boolean;
}

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
  private listeners = new Set<CommandListener>();
  private rhythm: readonly (readonly [number, number])[] = [];
  private liveBeat: readonly [number, number] | undefined;
  private musicCues = new Map<MusicCue['kind'], MusicCue>();
  readonly voiceHistory: VoiceObservation[] = [];
  /** Where the singer's voice is drawn now (page pixels), set by the melody roll's light layer when it is shown. */
  voicePoint: { x: number; y: number } | undefined;
  state: ShowState = {
    energy: 0,
    level: 'calm',
    streakSeconds: 0,
    live: undefined,
    music: this.pulse.state,
    musicBeat: 0,
    ambient: ambientFor(0, this.pulse.state, 'full'),
    playing: false,
    settings: { intensity: 'full', reducedMotion: false },
  };

  load(
    notes: readonly ShowNote[],
    phrases: readonly ShowPhrase[],
    resetPerformance = true,
    vocalActivity?: readonly (readonly [number, number])[],
    rhythm: readonly (readonly [number, number])[] = [],
    ignoreSilence = false,
  ): void {
    this.rhythm = rhythm.filter(([time, strength], index) => {
      let peak = strength;
      for (const direction of [-1, 1]) {
        for (
          let i = index + direction;
          i >= 0 && i < rhythm.length;
          i += direction
        ) {
          const other = rhythm[i];
          if (!other) break;
          const [otherTime, otherStrength] = other;
          const distance = Math.abs(otherTime - time);
          if (distance > 0.75) break;
          peak = Math.max(peak, otherStrength);
          if (
            distance < 0.18 &&
            (otherStrength > strength ||
              (otherStrength === strength && i < index))
          )
            return false;
        }
      }
      return strength >= peak * 0.6;
    });
    if (resetPerformance || this.rhythm.length > 0) {
      this.liveBeat = undefined;
      this.musicCues.clear();
    }
    this.tracker.load(
      notes,
      phrases,
      resetPerformance,
      vocalActivity,
      ignoreSilence,
    );
    if (!resetPerformance) return;
    this.voiceHistory.length = 0;
    this.state = { ...this.state, musicBeat: 0 };
    this.director.reset();
    this.pulse.reset();
  }

  configure(settings: ShowSettings): void {
    this.director.intensity = settings.intensity;
    this.state = { ...this.state, settings };
  }

  get hitNoteIds() {
    return this.tracker.hitNoteIds;
  }
  get noteScore() {
    return this.tracker.noteScore;
  }

  /** A backing-track spectrum frame from AudioService. */
  hear(backingBands: readonly number[], now: number): void {
    if (!this.state.playing) return;
    const cues = this.pulse.next(backingBands, now);
    if (this.rhythm.length > 0) return;
    for (const cue of cues) {
      this.musicCues.set(cue.kind, cue);
      if (cue.kind === 'beat') this.liveBeat = [cue.at / 1000, cue.strength];
    }
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
    confidence = 1,
  ): void {
    if (playing && scoreVoice) {
      const last = this.voiceHistory.at(-1)?.position;
      if (last !== undefined && (position < last || position > last + 1.5))
        this.voiceHistory.length = 0;
      if (last !== position)
        this.voiceHistory.push({
          position,
          pitchHz,
          confidence,
          audioActive: audioActive ?? (pitchHz !== undefined && pitchHz > 0),
        });
      while (
        this.voiceHistory[0] &&
        this.voiceHistory[0].position < position - 3
      )
        this.voiceHistory.shift();
    }
    if (!playing) {
      this.liveBeat = undefined;
      this.musicCues.clear();
    }
    const events =
      playing && scoreVoice
        ? this.tracker.update(
            position,
            pitchHz,
            sampleDuration,
            audioActive,
            confidence,
          )
        : [];
    const music = this.pulse.state;
    const musicBeat = playing ? this.rhythmAt(position, now) : 0;
    const cues = [...this.musicCues.values()].filter(
      (cue) => cue.at <= now && now - cue.at < 100,
    );
    const commands = this.director.plan(now, events, cues, {
      energy: this.tracker.energy,
      streakSeconds: this.tracker.streakSeconds,
      music,
      untilBeat: this.pulse.untilNextBeat(now),
    });
    this.musicCues.clear();
    this.state = {
      ...this.state,
      energy: this.tracker.energy,
      level: this.tracker.level,
      streakSeconds: this.tracker.streakSeconds,
      live: playing ? this.tracker.live : undefined,
      music,
      musicBeat,
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

  private rhythmAt(position: number, now: number): number {
    let low = 0;
    let high = this.rhythm.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const beat = this.rhythm[middle];
      if (beat && beat[0] <= position) low = middle + 1;
      else high = middle;
    }
    const beat = this.rhythm.length > 0 ? this.rhythm[low - 1] : this.liveBeat;
    const age = beat
      ? (this.rhythm.length > 0 ? position : now / 1000) - beat[0]
      : Infinity;
    return beat && age >= 0 && age < 0.1 ? beat[1] * Math.exp(-age / 0.03) : 0;
  }

  onCommand(listener: CommandListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
