import {
  QuantumBackground,
  quantumBackgroundFullscreenFieldSize,
} from "@neo-ui-kit/react";
import { useEffect, useRef, useState } from "react";
import { microphoneLevel } from "../../services/inputLevel";
import { useOnBattery } from "../desktop/shellBus";
import {
  backdropSpectrum,
  backdropSpectrumRange,
  voiceLevel,
} from "./backdropSpectrum";
import { subscribeSpectrum } from "./spectrumEvents";

// The build ships three.js beside the app (scripts/vite-three-vendor.mjs): the scene works offline and
// loads no code from a CDN. Relative, so the scene's import map and CSP hash are the same everywhere.
const threeUrl = "./vendor/three/";
// On battery the scene draws at a calmer frame rate, so a laptop is not drained by decoration.
const batteryFrameRate = 30;
const voicePollMilliseconds = 50;
const quietVoicePollMilliseconds = 200;

/**
 * The radio and everything else AudioService plays (from the shared spectrum feed) plus the singer's
 * microphone, as one spectrum. The microphone is polled on its own clock: when the speakers are
 * silent the spectrum feed slows down, but a voice must still move the field at once.
 */
const useBackdropSpectrum = (listening: boolean): number[] | undefined => {
  const [bands, setBands] = useState<number[]>();
  const output = useRef<readonly number[]>([]);
  const voice = useRef(0);

  useEffect(() => {
    if (!listening) {
      setBands(undefined);
      return;
    }
    let stopped = false;
    let timer = 0;
    const publish = () =>
      setBands(backdropSpectrum(output.current, voice.current));
    const pollVoice = async () => {
      try {
        const next = voiceLevel(await microphoneLevel());
        if (!stopped && (next > 0 || voice.current > 0)) {
          voice.current = next;
          publish();
        }
      } catch {
        // Without AudioService there is no voice; the service banner reports the outage.
        voice.current = 0;
      }
      if (!stopped)
        timer = window.setTimeout(
          () => void pollVoice(),
          voice.current > 0
            ? voicePollMilliseconds
            : quietVoicePollMilliseconds,
        );
    };
    void pollVoice();
    const unsubscribe = subscribeSpectrum((frame) => {
      output.current = frame.bands;
      publish();
    });
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [listening]);
  return bands;
};

/**
 * The Library's moving backdrop. It lives in its own component so the 20 Hz spectrum updates
 * re-render only the scene, never the page above it. While a window covers it, `listening` is off
 * and the stylesheet hides it, which also stops the scene's frames (see app.css).
 */
export const LibraryBackdrop = ({
  listening = true,
}: {
  listening?: boolean;
}) => {
  const spectrum = useBackdropSpectrum(listening);
  const battery = useOnBattery();
  return (
    <QuantumBackground
      field="Neutrino"
      className="libraryBackdrop"
      aria-hidden
      inert
      particleCount={10750}
      onsetSensitivity={3}
      adaptiveQualityEnabled={false}
      interactive={false}
      fieldSize={quantumBackgroundFullscreenFieldSize}
      spectrum={spectrum}
      spectrumRange={backdropSpectrumRange}
      threeUrl={threeUrl}
      targetFPS={battery ? batteryFrameRate : undefined}
    />
  );
};
