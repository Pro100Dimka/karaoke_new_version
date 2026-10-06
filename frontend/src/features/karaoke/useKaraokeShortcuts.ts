import { useEffect, useRef } from "react";
import { keyBelongsToControl } from "../../shared/ui/keyOwnership";
import { maxPlaybackRate, minPlaybackRate } from "./console/PracticeParameters";
import type { useKaraokeSession } from "./useKaraokeSession";

type Session = ReturnType<typeof useKaraokeSession>;

// Seek steps, as in media players: a short and (with Shift) a long jump.
const seekSeconds = 5;
const longSeekSeconds = 15;
// One key press moves the playback level and the tempo by 5%.
const levelStep = 0.05;
const tempoStep = 0.05;
// Knob values are shown in whole percent; a step keeps them there instead of accumulating 0.8500000001.
const percent = (value: number) => Math.round(value * 100) / 100;

/**
 * The karaoke keyboard: Space/K play or pause, arrows seek (Shift for longer) and set the playback
 * level, Home restarts, M toggles hearing yourself, N and T show notes and text, [ ] change the key,
 * - and + the tempo, Escape leaves. In a room the keys obey the same rights as the buttons.
 */
export const useKaraokeShortcuts = (
  session: Session,
  durationSeconds: number,
  onExit: () => void,
) => {
  const latest = useRef({ session, durationSeconds, onExit });
  latest.current = { session, durationSeconds, onExit };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      )
        return;
      if (keyBelongsToControl(event.target, event.key)) return;
      const {
        session: s,
        durationSeconds: duration,
        onExit: exit,
      } = latest.current;
      const canSeek = s.interactive;
      const canPractise = s.interactive && !s.practiceLocked;
      const seekBy = (seconds: number) =>
        void s.seek(
          Math.max(0, Math.min(duration || Infinity, s.position + seconds)),
        );
      const tempo = (delta: number) =>
        void s.changeSpeed(
          Math.max(
            minPlaybackRate,
            Math.min(maxPlaybackRate, percent(s.speed + delta)),
          ),
        );
      const actions: Record<string, (() => void) | undefined> = {
        " ": () => void s.togglePlay(),
        k: () => void s.togglePlay(),
        ArrowLeft: canSeek
          ? () => seekBy(-(event.shiftKey ? longSeekSeconds : seekSeconds))
          : undefined,
        ArrowRight: canSeek
          ? () => seekBy(event.shiftKey ? longSeekSeconds : seekSeconds)
          : undefined,
        Home: canSeek ? () => void s.seek(0) : undefined,
        ArrowUp: () =>
          void s.changeGain(
            "master",
            Math.min(1, percent(s.gains.master + levelStep)),
          ),
        ArrowDown: () =>
          void s.changeGain(
            "master",
            Math.max(0, percent(s.gains.master - levelStep)),
          ),
        m: () => void s.toggleMonitoring(),
        n: () => s.setShowNotes(!s.showNotes),
        t: () => s.setShowLyrics(!s.showLyrics),
        "[": canPractise ? () => void s.changeKey(-1) : undefined,
        "]": canPractise ? () => void s.changeKey(1) : undefined,
        "-": canPractise ? () => tempo(-tempoStep) : undefined,
        "+": canPractise ? () => tempo(tempoStep) : undefined,
        "=": canPractise ? () => tempo(tempoStep) : undefined,
        Escape: exit,
      };
      const action =
        actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
};
